import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { Storage } from "./storage.js";
import { PiHost } from "./pi-host.js";
import { Cleanup } from "./cleanup.js";
const exec = promisify(execFile), root = resolve(`.scratch/cleanup-${Date.now()}-${process.pid}`);
process.env.PI_OFFLINE = "1"; process.env.SIGMA_DEMO = "1"; process.env.HOME = root; process.env.PI_CODING_AGENT_DIR = join(root, "agent");
async function git(cwd: string, ...args: string[]) { return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim(); }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => Promise<boolean> | boolean, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await sleep(20); } return false; }
async function fixture(name: string) {
    const cwd = join(root, name), data = join(root, `${name}-data`);
    await mkdir(cwd, { recursive: true }); await mkdir(data);
    await git(cwd, "init", "-b", "main"); await git(cwd, "config", "user.name", "Fixture"); await git(cwd, "config", "user.email", "fixture@example.invalid"); await git(cwd, "config", "commit.gpgSign", "false");
    await writeFile(join(cwd, "a.txt"), "base\n"); await git(cwd, "add", "."); await git(cwd, "commit", "-m", "Base");
    const storage = new Storage(join(data, "state.sqlite")), host = new PiHost(storage, data, async () => { });
    await host.init();
    const cleanup = new Cleanup(storage, host, data);
    // A session in an isolated worktree; `archive` archives it, `check` adds a terminal check row plus its scratch directory.
    const session = async (archive = true) => {
        const id = await host.create(cwd, "sigma-demo/offline", crypto.randomUUID(), "code", { workspaceMode: "worktree" });
        const checkId = crypto.randomUUID(), checkDir = join(data, "checks", checkId);
        await mkdir(checkDir, { recursive: true }); await writeFile(join(checkDir, "input.txt"), "scratch\n");
        await storage.call("addCheck", { id: checkId, sessionId: id, status: "passed", cwd: checkDir });
        if (archive) await host.archiveOwner(id, true);
        return { id, wt: join(data, "workspaces", id), checkId, checkDir };
    };
    return { cwd, data, storage, host, cleanup, session, close: async () => { await host.close(); await storage.close(); } };
}
const reasons = (preview: { blockers: Array<{ path: string; reason: string }> }, path: string) => preview.blockers.filter(item => item.path === path).map(item => item.reason).join("|");
test("clean archived worktree and check scratch are removed; rows, history, branches and source files stay", async () => {
    const f = await fixture("clean");
    try {
        const s = await f.session(), file = join(f.cwd, "unrelated.txt"); await writeFile(file, "mine\n");
        const preview = await f.cleanup.preview();
        const branches = await git(f.cwd, "branch", "--list"), history = (await f.storage.call<any>("session", { id: s.id })).file, historyBefore = existsSync(history);
        await assert.rejects(f.cleanup.run(crypto.randomUUID(), preview.digest, false), /approval/);
        const id = crypto.randomUUID(), done = await f.cleanup.run(id, preview.digest, true);
        assert.equal(done.status, "completed"); assert.equal(done.removed.length, 2);
        assert.equal(existsSync(s.wt), false); assert.equal(existsSync(s.checkDir), false);
        assert.equal(await git(f.cwd, "branch", "--list"), branches);
        assert.equal(await readFile(file, "utf8"), "mine\n");
        assert.ok(await f.storage.call("session", { id: s.id }), "session row kept"); assert.ok(await f.storage.call("check", { id: s.checkId }), "check evidence row kept");
        assert.equal(existsSync(history), historyBefore, "Pi history file untouched");
        assert.equal((await f.host.snapshot(s.id)).id, s.id, "archived session still opens after cleanup");
        assert.doesNotMatch(await git(f.cwd, "worktree", "list"), new RegExp(s.id));
        assert.equal((await f.cleanup.run(id, preview.digest, true)).replayed, true, "same command ID is a replay, not a second removal");
        assert.equal((await f.cleanup.preview()).candidates.length, 0);
    } finally { await f.close(); }
});
test("dirty, untracked and staged worktrees, unarchived owners, active work and unknown setups are blockers", async () => {
    const f = await fixture("blocked");
    try {
        const dirty = await f.session(), untracked = await f.session(), staged = await f.session(), live = await f.session(false), unknown = await f.session(), moved = await f.session();
        await writeFile(join(dirty.wt, "a.txt"), "changed\n"); await writeFile(join(untracked.wt, "new.txt"), "x\n");
        await writeFile(join(staged.wt, "b.txt"), "x\n"); await git(staged.wt, "add", "b.txt");
        await git(moved.wt, "-c", "user.name=F", "-c", "user.email=f@example.invalid", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "extra");
        await f.storage.call("commandStatus", { id: unknown.id, status: "unknown" });
        await mkdir(join(f.data, "workspaces", crypto.randomUUID()));
        const preview = await f.cleanup.preview();
        assert.match(reasons(preview, dirty.wt), /Uncommitted/); assert.match(reasons(preview, untracked.wt), /untracked/); assert.match(reasons(preview, staged.wt), /index/);
        assert.match(reasons(preview, live.wt), /not archived/); assert.match(reasons(preview, unknown.wt), /Unresolved work/); assert.match(reasons(preview, moved.wt), /HEAD moved/);
        assert.equal(preview.blockers.filter(item => /No saved session owns/.test(item.reason)).length, 1);
        assert.deepEqual(preview.candidates.map(item => item.path).sort(), [dirty, untracked, staged, moved].map(item => item.checkDir).sort(), "only terminal check scratch of archived owners remains a candidate");
        // Admitted owner work blocks everything.
        let release = () => { }; const held = f.host.withPromptAdmission(crypto.randomUUID(), () => new Promise<void>(r => release = r), true);
        await sleep(20); const busy = await f.cleanup.preview(); release(); await held;
        assert.equal(busy.candidates.length, 0); assert.match(reasons(busy, dirty.checkDir), /admitted/);
        // Ignored/untracked source files are never candidates; the guarded dirs stay on disk.
        for (const item of [dirty, untracked, staged, live, unknown, moved]) assert.ok(existsSync(item.wt));
    } finally { await f.close(); }
});
test("a stale preview digest is rejected and nothing is removed", async () => {
    const f = await fixture("stale");
    try {
        await writeFile(join(f.cwd, ".git", "info", "exclude"), "*.log\n");
        const s = await f.session(); await writeFile(join(s.wt, "build.log"), "12345");
        const preview = await f.cleanup.preview(), seen = preview.candidates.find(item => item.path === s.wt);
        assert.deepEqual(seen?.ignored, { count: 1, bytes: 5, sample: ["build.log"] }, "ignored files are shown, not blocking");
        await writeFile(join(s.wt, "build.log"), "123456789");
        await assert.rejects(f.cleanup.run(crypto.randomUUID(), preview.digest, true), /preview changed/);
        assert.ok(existsSync(s.wt));
        const again = await f.cleanup.preview(); await writeFile(join(s.wt, "other.log"), "x");
        await assert.rejects(f.cleanup.run(crypto.randomUUID(), again.digest, true), /preview changed/);
        await rm(join(s.wt, "other.log")); await rm(join(s.wt, "build.log"));
        const fresh = await f.cleanup.preview(); assert.equal(fresh.candidates.find(item => item.path === s.wt)?.ignored?.count, 0);
        const stale = fresh;
        assert.ok(stale.candidates.some(item => item.path === s.wt));
        await writeFile(join(s.wt, "late.txt"), "x\n");
        await assert.rejects(f.cleanup.run(crypto.randomUUID(), preview.digest, true), /preview changed/);
        assert.ok(existsSync(s.wt)); assert.ok(existsSync(s.checkDir));
        await assert.rejects(f.cleanup.run(crypto.randomUUID(), "nonsense", true), /digest/);
    } finally { await f.close(); }
});
test("SIGKILL mid-removal leaves an unknown cleanup that is never replayed or retried", async () => {
    const f = await fixture("crash"), s = await f.session();
    const preview = await f.cleanup.preview();
    await f.close();
    const realGit = (await exec("which", ["git"], { encoding: "utf8" })).stdout.trim(), shim = join(root, "shim"), log = join(root, "shim.log"), pids = join(root, "shim.pid");
    await mkdir(shim); await writeFile(join(shim, "git"), `#!/bin/sh\ncase " $* " in *" worktree remove "*) echo run >> '${log}'; echo $$ >> '${pids}'; exec sleep 30;; esac\nexec '${realGit}' "$@"\n`); await chmod(join(shim, "git"), 0o755);
    const id = crypto.randomUUID(), child = spawn(process.execPath, ["--import", "tsx", resolve("apps/server/cleanup-crash.fixture.ts"), f.data, id, preview.digest], { env: { ...process.env, PATH: `${shim}:${process.env.PATH}` }, stdio: ["ignore", "ignore", "pipe"] });
    let error = ""; child.stderr.on("data", d => error += d);
    const exited = new Promise<string | null>(r => child.on("close", (_c, signal) => r(signal)));
    try {
        assert.ok(await until(async () => (await readFile(pids, "utf8").catch(() => "")).trim() !== "", 60000), error);
        const pid = Number((await readFile(pids, "utf8")).trim().split("\n")[0]);
        child.kill("SIGKILL"); assert.equal(await exited, "SIGKILL");
        assert.ok(await until(() => !alive(pid), 3000), "removal group is reaped after the server dies");
    } finally { child.kill("SIGKILL"); }
    const storage = new Storage(join(f.data, "state.sqlite")), host = new PiHost(storage, f.data, async () => { }), cleanup = new Cleanup(storage, host, f.data);
    await host.init();
    try {
        assert.equal((await storage.call<any>("commandSetupGet", { id })).status, "unknown");
        await assert.rejects(cleanup.run(id, preview.digest, true), /Previous cleanup is unknown/);
        const again = await cleanup.preview();
        assert.match(reasons(again, s.wt), /unknown outcome/); assert.ok(!again.candidates.some(item => item.path === s.wt));
        assert.match(reasons(again, s.checkDir), /unknown outcome/, "every target of the unknown cleanup stays blocked");
        assert.deepEqual(again.candidates, []);
        await assert.rejects(cleanup.run(crypto.randomUUID(), again.digest, true), /Nothing to clean up/);
        assert.ok(existsSync(s.wt), "the half-removed worktree is never retried or deleted"); assert.ok(existsSync(s.checkDir));
        assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1, "removal was attempted once");
    } finally { await host.close(); await storage.close(); }
});
