import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { realpath, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Storage } from "./storage.js";
import type { PiHost } from "./pi-host.js";
import { git, gitSupervised, worktreeRecords } from "./editing.js";

// Guarded cleanup of per-session scratch for ARCHIVED owners only: registered clean worktrees plus Sigma-owned checks/reviews scratch copies.
// Never touches DB rows, Pi history, source-applies/, worker-merges/, git-intents/ or branches; anything unproven is a blocker, not a candidate.
export type CleanupCandidate = { kind: "worktree" | "check" | "review"; path: string; sessionId: string; sourceCwd?: string; head?: string; ignored?: { count: number; bytes: number; sample: string[] }; dev: number; ino: number };
export type CleanupBlocker = { kind: string; path: string; reason: string };
export type CleanupPreview = { candidates: CleanupCandidate[]; blockers: CleanupBlocker[]; digest: string };
type Session = { id: string; cwd: string; parentId: string | null; status: string; policy: any; archived: boolean | null; rootId: string | null; taskStatus: string | null };
type Evidence = { id: string; sessionId: string; status: string; cwd: string | null };
type Facts = { sessions: Session[]; checks: Evidence[]; reviews: Evidence[]; busy: Array<{ sessionId?: string; cwd?: string; reason: string }>; cleanups: Array<{ id: string; status: string; targets: string | null }> };
const TERMINAL: Record<string, string[]> = { check: ["passed", "failed", "timed_out", "invalidated", "denied", "expired", "cancelled"], review: ["completed", "interrupted", "error"] };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class CleanupError extends Error { }
export class Cleanup {
    constructor(private storage: Storage, private host: PiHost, private dataDir: string) { }
    private async inspectWorktree(path: string, row: Session): Promise<{ head: string; dev: number; ino: number; ignored: NonNullable<CleanupCandidate["ignored"]> } | string> {
        const workspace = row.policy?.workspace as { sourceCwd: string; baseCommit: string } | undefined;
        try {
            if (!workspace || await realpath(path) !== path) return "Workspace path changed";
            const source = workspace.sourceCwd;
            if (await realpath(source) !== source) return "Source repository path changed";
            if (await realpath((await git(path, ["rev-parse", "--show-toplevel"])).trim()) !== path) return "Not a worktree root";
            const common = await realpath(resolve(path, (await git(path, ["rev-parse", "--git-common-dir"])).trim())), sourceCommon = await realpath(resolve(source, (await git(source, ["rev-parse", "--git-common-dir"])).trim()));
            if (common !== sourceCommon) return "Worktree belongs to a different repository";
            const records = worktreeRecords(await git(source, ["worktree", "list", "--porcelain", "-z"])).filter(item => item.path === path);
            if (records.length !== 1) return "Not a registered worktree of its source repository";
            if (records[0].locked) return "Worktree is locked";
            const head = (await git(path, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
            if (head !== workspace.baseCommit) return "HEAD moved from its base commit; commits would be lost";
            if (await git(path, ["status", "--porcelain=v2", "--untracked-files=all"])) return "Uncommitted, untracked or index changes";
            // Ignored files are not a blocker, but `git worktree remove` deletes them, so the preview (and digest) must show them.
            const names = (await git(path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], 256 * 1024 * 1024)).split("\0").filter(Boolean).sort();
            let bytes = 0; for (const name of names) { try { bytes += lstatSync(join(path, name)).size; } catch { } }
            const info = await stat(path);
            return { head, dev: info.dev, ino: info.ino, ignored: { count: names.length, bytes, sample: names.slice(0, 5) } };
        }
        catch { return "Cannot inspect worktree"; }
    }
    private busy(row: Session, facts: Facts, held: Set<string>, path: string, self: string): string | null {
        if (row.archived !== true) return row.archived === null ? "Owner lineage is unknown or partial" : "Owner is not archived";
        if (row.taskStatus && ["creating", "unknown", "continuing"].includes(row.taskStatus)) return `Task setup is ${row.taskStatus}`;
        const byId = new Map(facts.sessions.map(item => [item.id, item])), tree = new Set(facts.sessions.filter(item => item.rootId === row.rootId).map(item => item.id));
        const hit = facts.busy.find(item => item.sessionId ? tree.has(item.sessionId) || byId.get(item.sessionId)?.rootId === row.rootId : item.cwd === row.cwd || item.cwd === row.policy?.workspace?.sourceCwd);
        if (hit) return `Unresolved work: ${hit.reason}`;
        if (held.has(path)) return "A previous cleanup of this path has an unknown outcome";
        return this.host.cleanupBusy(tree, self);
    }
    private async classify(kind: CleanupCandidate["kind"], name: string, facts: Facts, held: Set<string>, self: string, data: string): Promise<CleanupCandidate | CleanupBlocker> {
        const base = join(data, kind === "worktree" ? "workspaces" : `${kind}s`), path = join(base, name), blocked = (reason: string): CleanupBlocker => ({ kind, path, reason });
        let info; try { info = lstatSync(path); } catch { return blocked("Directory is unavailable"); }
        if (!info.isDirectory() || info.isSymbolicLink()) return blocked("Not a real directory");
        if (info.uid !== process.getuid?.()) return blocked("Directory is not owned by this user");
        try { if (await realpath(path) !== path) return blocked("Directory resolves elsewhere"); } catch { return blocked("Directory is unavailable"); }
        const byId = new Map(facts.sessions.map(item => [item.id, item]));
        if (kind === "worktree") {
            const row = byId.get(name);
            if (!row) return blocked("No saved session owns this directory (unknown or partial setup)");
            if (row.cwd !== path || row.policy?.workspace?.kind !== "worktree") return blocked("Saved session does not own this worktree");
            const reason = this.busy(row, facts, held, path, self); if (reason) return blocked(reason);
            const seen = await this.inspectWorktree(path, row); if (typeof seen === "string") return blocked(seen);
            return { kind, path, sessionId: row.id, sourceCwd: row.policy.workspace.sourceCwd, head: seen.head, ignored: seen.ignored, dev: seen.dev, ino: seen.ino };
        }
        const row = (kind === "check" ? facts.checks : facts.reviews).find(item => item.id === name), owner = row && byId.get(row.sessionId);
        if (!row || !owner) return blocked("No saved evidence row owns this directory");
        if (row.cwd !== path) return blocked("Evidence row references another directory");
        if (!TERMINAL[kind].includes(row.status)) return blocked(`${kind} is ${row.status}`);
        const reason = this.busy(owner, facts, held, path, self); if (reason) return blocked(reason);
        return { kind, path, sessionId: owner.id, dev: info.dev, ino: info.ino };
    }
    async preview(self = ""): Promise<CleanupPreview> {
        const data = await realpath(this.dataDir), facts = await this.storage.call<Facts>("cleanupFacts"), candidates: CleanupCandidate[] = [], blockers: CleanupBlocker[] = [];
        const held = new Set(facts.cleanups.filter(item => !["completed", "rejected"].includes(item.status)).flatMap(item => { try { return JSON.parse(item.targets ?? "[]") as string[]; } catch { return []; } }));
        for (const [kind, folder] of [["worktree", "workspaces"], ["check", "checks"], ["review", "reviews"]] as const) {
            let names: string[] = []; try { names = readdirSync(join(data, folder)).sort(); } catch { }
            for (const name of names) { const item = await this.classify(kind, name, facts, held, self, data); "reason" in item ? blockers.push(item) : candidates.push(item); }
        }
        return { candidates, blockers, digest: hash({ candidates, blockers }) };
    }
    private async remove(item: CleanupCandidate, check: () => void) {
        if (item.kind === "worktree") await gitSupervised(item.sourceCwd!, ["worktree", "remove", item.path], check); // never --force, never branch deletion
        else { check(); await rm(item.path, { recursive: true }); }
        try { lstatSync(item.path); throw new CleanupError("Directory still exists after removal"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    async run(commandId: string, digest: unknown, approve: unknown) {
        if (approve !== true) throw new CleanupError("Explicit approval required");
        if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) throw new CleanupError("Preview digest required");
        return this.host.withPromptAdmission(commandId, async admission => {
            admission.unresolvedOwner = true; admission.cleanup = true;
            const prior = await this.storage.call<{ kind: string; status: string } | undefined>("commandSetupGet", { id: commandId });
            if (prior) { if (prior.kind === "cleanup" && prior.status === "completed") return { status: "completed", removed: [] as string[], replayed: true }; throw new CleanupError(`Previous cleanup is ${prior.status}; it will not be replayed`); }
            const preview = await this.preview(commandId); admission.check();
            if (preview.digest !== digest) throw new CleanupError("Cleanup preview changed; review it again");
            if (!preview.candidates.length) throw new CleanupError("Nothing to clean up");
            await this.storage.call("command", { id: commandId, sessionId: "cleanup", kind: "cleanup", requestHash: digest, inputText: JSON.stringify(preview.candidates.map(item => item.path)) });
            let attempted = false; const removed: string[] = [], data = await realpath(this.dataDir);
            try {
                for (const item of preview.candidates) {
                    admission.check();
                    const facts = await this.storage.call<Facts>("cleanupFacts"), now = await this.classify(item.kind, basename(item.path), facts, new Set(), commandId, data);
                    if (JSON.stringify(now) !== JSON.stringify(item)) throw new CleanupError(`${item.path} changed before removal; nothing further was removed`);
                    attempted = true; await this.remove(item, admission.check); removed.push(item.path);
                }
                await this.storage.call("commandStatus", { id: commandId, status: "completed" });
                return { status: "completed", removed, replayed: false };
            }
            catch (error) { await this.storage.call("commandStatus", { id: commandId, status: attempted ? "unknown" : "rejected" }).catch(() => { }); throw error; }
        }, true);
    }
}
