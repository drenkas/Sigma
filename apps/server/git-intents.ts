import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, lstatSync, openSync, readFileSync, closeSync, fstatSync, renameSync, unlinkSync } from "node:fs";
import { mkdir, readFile, writeFile, open, unlink, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { checkWorkspacePath, readCheckedFile, type PathGuard } from "./tool-boundary.js";
const exec = promisify(execFile), hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const environment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", LC_ALL: "C" });
const options = ["--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false"];
export type GitIdentity = {
    cwd: string;
    dev: number;
    ino: number;
    gitDir: string;
    gitDev: number;
    gitIno: number;
    commonDir: string;
    commonDev: number;
    commonIno: number;
    index: string;
    head: string;
    ref: string;
    indexState: Artifact | null;
    status: string;
};
export type Artifact = {
    path: string;
    dev: number;
    ino: number;
    mode: number;
    hash: string;
};
export type GitIntent = {
    id: string;
    kind: "commit" | "pull" | "switch" | "push" | "stash";
    identity: GitIdentity;
    message?: string;
    files?: Array<{
        path: string;
        chain: unknown;
        hash: string;
        mode: number;
        oid: string | null;
    }>;
    tree?: string;
    diff?: string;
    dir?: string;
    indexAfter?: Artifact;
    lock?: Artifact;
    sha?: string;
    process?: {
        pid: number;
        identity: string;
        quiescent: boolean;
    };
    dispatch?: boolean;
    output?: string;
};
export type GitRecovery = {
    id: string;
    kind: string;
    head: string | null;
    tree: string | null;
    indexHash: string | null;
    lockHash: string | null;
    expectedHead: string | null;
    expectedTree: string | null;
    state: "committed" | "before" | "observed" | "inspect-only";
    canReconcile: boolean;
    reason?: string;
    digest: string;
};
export function artifact(path: string): Artifact | null { try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw new Error("Git artifact must be an unlinked regular file");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = fstatSync(fd);
        if (opened.ino !== info.ino || opened.dev !== info.dev)
            throw new Error("Git artifact identity changed");
        const bytes = readFileSync(fd);
        if (lstatSync(path).ino !== info.ino)
            throw new Error("Git artifact changed");
        return { path, dev: info.dev, ino: info.ino, mode: info.mode & 0o777, hash: hash(bytes) };
    }
    finally {
        closeSync(fd);
    }
}
catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return null;
    throw error;
} }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
async function run(cwd: string, args: string[], input?: Buffer | string, extra: Record<string, string> = {}): Promise<string> { return new Promise((yes, no) => { const child = spawn("git", [...options, ...args], { cwd, env: { ...environment(), ...extra }, detached:true, stdio: ["pipe", "pipe", "pipe"] }); let out = "", err = ""; const terminate=()=>{if(child.pid)try{process.kill(-child.pid,"SIGKILL");}catch{}};const timer = setTimeout(terminate, 60000); child.stdout.on("data", data => { out += data; if (out.length > 8 * 1024 * 1024)
    terminate(); }); child.stderr.on("data", data => { err += data; if (err.length > 1024 * 1024)
    terminate(); }); child.on("error", no); child.on("close", code => { clearTimeout(timer); code === 0 ? yes(out) : no(new Error(`git ${args[0]} failed`)); }); child.stdin.on("error",()=>{});child.stdin.end(input); }); }
export async function gitIdentity(path: string): Promise<GitIdentity> { const cwd = await realpath(path); if ((await realpath((await run(cwd, ["rev-parse", "--show-toplevel"])).trim())) !== cwd)
    throw new Error("Git action requires the canonical repository root"); const gitDir = await realpath(resolve(cwd, (await run(cwd, ["rev-parse", "--git-dir"])).trim())), commonDir = await realpath(resolve(cwd, (await run(cwd, ["rev-parse", "--git-common-dir"])).trim())), index = resolve(cwd, (await run(cwd, ["rev-parse", "--git-path", "index"])).trim()), root = await stat(cwd), g = await stat(gitDir), c = await stat(commonDir); return { cwd, dev: root.dev, ino: root.ino, gitDir, gitDev: g.dev, gitIno: g.ino, commonDir, commonDev: c.dev, commonIno: c.ino, index, head: (await run(cwd, ["rev-parse", "HEAD^{commit}"])).trim(), ref: (await run(cwd, ["symbolic-ref", "HEAD"]).catch(() => "HEAD")).trim(), indexState: artifact(index), status: await run(cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]) }; }
function snapshot(cwd: string, path: string, guard: PathGuard) { const checked = checkWorkspacePath(cwd, path, guard, true); if (checked.info && !checked.info.isFile())
    throw new Error("Commit file type changed"); if (!checked.info)
    return { chain: checked.chain, hash: "missing", mode: 0, bytes: null }; const { bytes, mode } = readCheckedFile(cwd, checked, guard, 128 * 1024); if (bytes.includes(0))
    throw new Error("Commit only supports UTF-8 text"); new TextDecoder("utf-8", { fatal: true }).decode(bytes); return { chain: checked.chain, hash: hash(bytes), mode: mode & 0o111 ? 100755 : 100644, bytes }; }
function objectEnv(intent: GitIntent) { return { GIT_OBJECT_DIRECTORY: join(intent.dir!, "objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: join(intent.identity.commonDir, "objects"), GIT_INDEX_FILE: join(intent.dir!, "tree-index") }; }
export async function prepareCommit(id: string, cwd: string, message: string, paths: string[], dataDir: string, guard: PathGuard): Promise<GitIntent> {
    const identity = await gitIdentity(cwd), dir = join(dataDir, "git-intents", hash(id));
    await mkdir(join(dir, "objects"), { recursive: true, mode: 0o700 });
    if (await realpath(dir) !== dir)
        throw new Error("Git intent directory changed");
    if (identity.ref === "HEAD")
        throw new Error("HEAD is detached; switch to a branch first");
    const intent: GitIntent = { id, kind: "commit", identity, message, dir, files: [] }, env = objectEnv(intent);
    await run(cwd, ["read-tree", identity.head], undefined, env);
    const entries = (await run(cwd, ["ls-files", "-z"])).split("\0").filter(Boolean);
    if (paths.some(path => entries.some(entry => entry !== path && (entry.startsWith(`${path}/`) || path.startsWith(`${entry}/`)))))
        throw new Error("Commit scope conflicts with staged paths; inspect the index first");
    for (const path of paths) {
        const value = snapshot(cwd, path, guard), oid = value.bytes === null ? null : (await run(cwd, ["hash-object", "-w", "--stdin"], value.bytes, env)).trim();
        intent.files!.push({ path, chain: value.chain, hash: value.hash, mode: value.mode, oid });
        if (oid)
            await run(cwd, ["update-index", "--add", "--cacheinfo", `${value.mode},${oid},${path}`], undefined, env);
        else
            await run(cwd, ["update-index", "--force-remove", "--", path], undefined, env);
    }
    intent.tree = (await run(cwd, ["write-tree"], undefined, env)).trim();
    intent.diff = await run(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", identity.head, intent.tree, "--"], undefined, env);
    if (!intent.diff)
        throw new Error("Nothing to commit");
    await validateCommit(intent, guard);
    return intent;
}
export async function validateCommit(intent: GitIntent, guard: PathGuard) { if (!same(await gitIdentity(intent.identity.cwd), intent.identity))
    throw new Error("Git HEAD, index or scope changed after approval; request a new approval"); for (const file of intent.files!) {
    const now = snapshot(intent.identity.cwd, file.path, guard);
    if (!same(now.chain, file.chain) || now.hash !== file.hash || now.mode !== file.mode)
        throw new Error("Commit content or path identity changed after approval; request a new approval");
} }
async function processIdentity(pid: number) { try {
    return (await exec("ps", ["-o", "pid=,pgid=,lstart=", "-p", String(pid)], { encoding: "utf8" })).stdout.trim();
}
catch {
    return "";
} }
async function quiescent(intent: GitIntent) { if (!intent.dispatch)
    return true; if (!intent.process)
    return false; if (intent.process.quiescent)
    return true; const group = (await exec("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" })).stdout.split("\n").filter(line => Number(line.trim().split(/\s+/)[1]) === intent.process!.pid); return group.length === 0; }
// Shared detached supervisor: it dies with the server's stdin (EOF/SIGKILL) and takes its whole process group (git + filters/hooks) with it.
const SUPERVISOR_SCRIPT = 'const {spawn}=require("node:child_process");let input="",started=false;const stop=()=>{try{process.kill(-process.pid,"SIGKILL");}catch{}process.exit(1);};process.stdin.on("data",d=>{input+=d;if(started||!input.includes("\\n"))return;started=true;const spec=JSON.parse(input);const c=spawn("git",spec.args,{env:spec.env,stdio:["pipe","inherit","inherit"]});c.stdin.end(spec.input);c.on("error",()=>process.exit(1));c.on("close",code=>process.exit(code??1));});process.stdin.on("end",stop);process.stdin.on("error",stop);';
// Runs one mutating Git command in a supervised group; `check` throwing (Stop/Quit) kills the group. Never leaves the group alive on return.
export async function runSupervised(cwd: string, args: string[], env: Record<string, string | undefined>, check: () => void, timeout = 120000): Promise<string> { check(); const child = spawn(process.execPath, ["-e", SUPERVISOR_SCRIPT], { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] }); child.stdin.on("error", () => { }); let out = "", err = ""; const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { } }; const timer = setTimeout(kill, timeout); child.stdout.on("data", d => { out += d; if (out.length > 4 * 1024 * 1024) kill(); }); child.stderr.on("data", d => { err += d; if (err.length > 1024 * 1024) kill(); }); const done = new Promise<number | null>((yes, no) => { child.on("error", no); child.on("close", yes); }); let watcher: ReturnType<typeof setInterval> | undefined; try { child.stdin.write(JSON.stringify({ args, env }) + "\n"); watcher = setInterval(() => { try { check(); } catch { kill(); } }, 25); const code = await done; check(); if (code !== 0) throw new Error(`git ${args.find(a => !a.startsWith("-") && !a.includes("=")) ?? ""} failed`); return out; } finally { clearTimeout(timer); if (watcher) clearInterval(watcher); kill(); child.stdin.destroy(); } }
// A waiting supervisor provides a durable PID/process-group record before Git receives its command.
export async function dispatchGit(intent: GitIntent, args: string[], save: (intent: GitIntent) => Promise<void>, check: () => void, input?: string, beforeDispatch?: () => Promise<void>, cancellable = false) { check(); intent.dispatch = true; await save(intent); const script = SUPERVISOR_SCRIPT; const child = spawn(process.execPath, ["-e", script], { cwd: intent.identity.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] }); child.stdin.on("error",()=>{});let output = "", error = "", watcher: ReturnType<typeof setInterval> | undefined; const terminate = () => { try {
    process.kill(-child.pid!, "SIGKILL");
}
catch { } }; const timer = setTimeout(terminate, args[0] === "switch" ? 15000 : 60000); child.stdout.on("data", data => { output += data; if (output.length > 4 * 1024 * 1024)
    terminate(); }); child.stderr.on("data", data => { error += data; if (error.length > 1024 * 1024)
    terminate(); }); const done = new Promise<number | null>((yes, no) => { child.on("error", no); child.on("close", yes); }); try {
    intent.process = { pid: child.pid!, identity: await processIdentity(child.pid!), quiescent: false };
    if (!intent.process.identity)
        throw new Error("Git supervisor identity unavailable");
    await save(intent);
    if(beforeDispatch)await beforeDispatch();
    check();
    child.stdin.write(JSON.stringify({ args: [...options, ...args], env: environment(), input }) + "\n");
    if (cancellable)
        watcher = setInterval(() => { try {
            check();
        }
        catch {
            terminate();
        } }, 25);
    const code = await done;
    intent.process.quiescent = await quiescent(intent);
    await save(intent);
    if (!intent.process.quiescent)
        throw new Error("Git process group remains active; inspect unknown outcome");
    if (code !== 0)
        throw new Error(`git ${args[0]} failed or timed out`);
    return output.trim();
}
catch (error) {
    child.stdin.destroy();
    if (child.exitCode === null) {
        try {
            process.kill(-child.pid!, "SIGKILL");
        }
        catch { }
        await done.catch(() => { });
    }
    throw error;
}
finally {
    clearTimeout(timer);
    if (watcher)
        clearInterval(watcher);
    child.stdin.destroy();
} }
export async function executeCommit(intent: GitIntent, save: (intent: GitIntent) => Promise<void>, check: () => void, guard: PathGuard) {
    const { cwd, index, head, ref } = intent.identity;
    check();
    await validateCommit(intent, guard);
    const lockPath = `${index}.lock`, lock = await open(lockPath, "wx", intent.identity.indexState?.mode ?? 0o600);
    let irreversible = false;
    try {
        await lock.chmod(intent.identity.indexState?.mode??0o600);
        intent.lock = artifact(lockPath)!;
        await save(intent);
        await validateCommit(intent, guard);
        const env = objectEnv(intent), publication = join(intent.dir!, "publication-index");
        if (intent.identity.indexState)
            await writeFile(publication, await readFile(index), { flag: "wx", mode: 0o600 });
        else
            await run(cwd, ["read-tree", head], undefined, { ...env, GIT_INDEX_FILE: publication });
        for (const file of intent.files!) {
            if (file.oid)
                await run(cwd, ["update-index", "--add", "--cacheinfo", `${file.mode},${file.oid},${file.path}`], undefined, { ...env, GIT_INDEX_FILE: publication });
            else
                await run(cwd, ["update-index", "--force-remove", "--", file.path], undefined, { ...env, GIT_INDEX_FILE: publication });
        }
        intent.indexAfter = artifact(publication)!;
        await lock.writeFile(await readFile(publication));
        await lock.sync();
        intent.lock = artifact(lockPath)!;
        await save(intent);
        const signed = (await run(cwd, ["config", "--bool", "commit.gpgSign"]).catch(() => "false")).trim() === "true";
        intent.sha = (await run(cwd, ["commit-tree", intent.tree!, "-p", head, ...(signed ? ["-S"] : [])], `${intent.message}\n`, env)).trim();
        await save(intent);
        check();
        await validateCommit(intent, guard);
        if (!same(artifact(lockPath), intent.lock))
            throw new Error("Owned index lock changed");
        // Materialize the frozen objects only after Allow. pack-objects/index-pack never reopen worktree paths or execute filters.
        const pack = join(intent.dir!, "approved-pack");
        await run(cwd, ["pack-objects", "--revs", pack], `${intent.sha}\n^${head}\n`, env);
        const names = (await import("node:fs/promises")).readdir;
        for (const file of await names(intent.dir!)) {
            if (file.startsWith("approved-pack-") && file.endsWith(".pack"))
                await run(cwd, ["index-pack", join(intent.dir!, file)]);
        }
        // Copy the self-contained pack into the repository through index-pack --stdin.
        for (const file of await names(intent.dir!)) {
            if (file.startsWith("approved-pack-") && file.endsWith(".pack"))
                await run(cwd, ["index-pack", "--stdin"], await readFile(join(intent.dir!, file)));
        }
        check();
        irreversible = true;
        await dispatchGit(intent, ["update-ref", "--stdin"], save, check, `update ${ref} ${intent.sha} ${head}\n`,()=>validateCommit(intent,guard));
        const observed=await gitIdentity(cwd);
        if(!same(observed,{...intent.identity,head:intent.sha,status:observed.status}))throw new Error("Repository owner, branch, HEAD or index changed after commit CAS; inspect unknown outcome");
        await lock.close();
        if (!same(artifact(lockPath), intent.lock) || !same(artifact(index), intent.identity.indexState))
            throw new Error("Owned index lock or original index replaced before publication");
        renameSync(lockPath, index);
        return intent.sha;
    }
    finally {
        await lock.close().catch(() => { });
        if ((!irreversible || !intent.dispatch) && intent.lock && same(artifact(lockPath), intent.lock))
            await unlink(lockPath);
    }
}
export async function inspectGit(intent: GitIntent): Promise<GitRecovery> {
    let observation: unknown;
    let head: string | null = null, tree: string | null = null, indexHash: string | null = null, lockHash: string | null = null, state: GitRecovery["state"] = "inspect-only", reason: string | undefined;
    try {
        const now = await gitIdentity(intent.identity.cwd), { status, indexState, head: observedHead, ref, ...owner } = now, { status: oldStatus, indexState: oldIndex, head: oldHead, ref: oldRef, ...expectedOwner } = intent.identity;
        head = observedHead;
        tree = (await run(now.cwd, ["rev-parse", `${head}^{tree}`])).trim();
        const lock = artifact(`${now.index}.lock`);
        observation = { identity: now, lock };
        indexHash = indexState?.hash ?? null;
        lockHash = lock?.hash ?? null;
        if (!same(owner, expectedOwner))
            throw new Error("Repository ownership changed");
        if (!await quiescent(intent))
            throw new Error("Git process group is live or dispatch identity is unproven");
        if (intent.kind === "commit") {
            if (head === intent.sha && tree === intent.tree && ref === oldRef) {
                if (same(lock, intent.lock) && same(indexState, oldIndex) || !lock && same(indexState, { ...intent.lock, path: now.index }))
                    state = "committed";
                else
                    throw new Error("Index or owned lock changed; inspect-only");
            }
            else if (head === oldHead && ref === oldRef && same(indexState, oldIndex) && (!lock || same(lock, intent.lock)))
                state = "before";
            else
                throw new Error("HEAD, tree or index differs from the saved intent");
        }
        else {
            if (lock)
                throw new Error("Foreign index lock present");
            if (intent.kind === "push")
                observation = { identity: now, lock, upstream: (await run(now.cwd, ["rev-parse", "--verify", "-q", "@{upstream}"]).catch(() => "")).trim() };
            state = "observed";
        }
    }
    catch (error) {
        reason = error instanceof Error ? error.message : "Git observations unavailable";
    }
    const view = { id: intent.id, kind: intent.kind, head, tree, indexHash, lockHash, expectedHead: intent.sha ?? intent.identity.head, expectedTree: intent.tree ?? null, state, canReconcile: state !== "inspect-only", reason };
    return { ...view, digest: hash(JSON.stringify({ view, observation })) };
}
export async function finalizeGit(intent: GitIntent, observed: GitRecovery) { if (observed.state === "committed" && intent.lock && same(artifact(`${intent.identity.index}.lock`), intent.lock))
    renameSync(intent.lock.path, intent.identity.index); if (observed.state === "before" && intent.lock && same(artifact(intent.lock.path), intent.lock))
    unlinkSync(intent.lock.path); }
