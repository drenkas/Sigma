import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { Storage } from "./storage.js";
import { PiHost } from "./pi-host.js";
const exec = promisify(execFile), root = resolve(`.scratch/workspace-alloc-${Date.now()}-${process.pid}`);
process.env.PI_OFFLINE = "1"; process.env.SIGMA_DEMO = "1"; process.env.HOME = root; process.env.PI_CODING_AGENT_DIR = join(root, "agent");
async function git(cwd: string, ...args: string[]) { return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim(); }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => Promise<boolean> | boolean, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await sleep(20); } return false; }
// A repo-local slow smudge filter makes `git checkout` hang mid-allocation; the filter records its shell PID.
async function fixture(name: string) {
    const cwd = join(root, name), data = join(root, `${name}-data`), pidFile = join(root, `${name}.pid`);
    await mkdir(cwd, { recursive: true }); await mkdir(data);
    await git(cwd, "init", "-b", "main"); await git(cwd, "config", "user.name", "Fixture"); await git(cwd, "config", "user.email", "fixture@example.invalid"); await git(cwd, "config", "commit.gpgSign", "false");
    await writeFile(join(cwd, "a.txt"), "base\n"); await writeFile(join(cwd, ".gitattributes"), "*.txt filter=slow\n"); await git(cwd, "add", "."); await git(cwd, "commit", "-m", "Base");
    await git(cwd, "config", "filter.slow.smudge", `sh -c 'echo $$ >> "${pidFile}"; sleep 30; cat'`);
    return { cwd, data, pidFile };
}
const pidOf = async (file: string) => { await until(async () => (await readFile(file, "utf8").catch(() => "")).trim() !== ""); return Number((await readFile(file, "utf8")).trim().split("\n")[0]); };
const open = async (data: string) => { const storage = new Storage(join(data, "state.sqlite")), host = new PiHost(storage, data, async () => { }); await host.init(); return { storage, host, close: async () => { await host.close(); await storage.close(); } }; };
test("Stop during worktree allocation returns quickly, reaps the Git group and keeps the partial worktree", async () => {
    const f = await fixture("stop"), { storage, host, close } = await open(f.data);
    try {
        const id = crypto.randomUUID(), creating = host.create(f.cwd, "sigma-demo/offline", id, "code", { workspaceMode: "worktree" }).then(() => "ok", e => String(e));
        const pid = await pidOf(f.pidFile), started = Date.now();
        assert.ok(alive(pid));
        await host.abort(id);
        assert.ok(await until(() => !alive(pid), 2000), "filter group is gone");
        assert.ok(Date.now() - started < 2500, "Stop resolves quickly");
        assert.match(await creating, /worktree|stopped/i);
        assert.ok(existsSync(join(f.data, "workspaces", id)), "partial worktree is retained, never auto-deleted");
        assert.match(await git(f.cwd, "worktree", "list"), new RegExp(id));
    }
    finally { await close(); }
});
test("SIGKILL of the server mid-allocation reaps the Git group; restart keeps the same IDs, stays inspect-only and keeps the partial worktree", async () => {
    const f = await fixture("crash"), id = crypto.randomUUID();
    const child = spawn(process.execPath, ["--import", "tsx", resolve("apps/server/workspace-alloc-crash.fixture.ts"), f.data, f.cwd, id], { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
    let error = ""; child.stderr.on("data", d => error += d);
    const exited = new Promise<string | null>(r => child.on("close", (_c, signal) => r(signal)));
    try {
        const pid = await pidOf(f.pidFile);
        assert.ok(alive(pid), error);
        child.kill("SIGKILL");
        assert.equal(await exited, "SIGKILL");
        assert.ok(await until(() => !alive(pid), 2000), "orphaned allocation group is reaped after the server dies");
    }
    finally { child.kill("SIGKILL"); }
    const { storage, host, close } = await open(f.data);
    try {
        const item = (await host.workspaceRecovery()).find(value => value.setup?.sessionId === id)!;
        assert.ok(item, "setup is visible to recovery");
        assert.equal(item.setup?.sessionId, id);
        assert.equal(item.canContinue, false, "a half-checked-out worktree is inspect-only");
        assert.equal(await storage.call("session", { id }), undefined);
        assert.equal(item.setup?.phase, "allocating");
        assert.ok(existsSync(join(f.data, "workspaces", id)), "partial worktree is retained, never auto-deleted");
        await assert.rejects(host.continueWorkspaceSetup(item.id, item.observedRevision), /differs from descriptor|identity|base tree|observation/);
        assert.equal(await storage.call("session", { id }), undefined, "no session was registered under a new ID");
        assert.ok(existsSync(join(f.data, "workspaces", id)), "refused Continue still keeps the partial worktree");
    }
    finally { await close(); }
});
