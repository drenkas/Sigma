import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { Storage } from "./storage.js";
import { PiHost } from "./pi-host.js";
const exec = promisify(execFile), root = resolve(`.scratch/git-push-${Date.now()}-${process.pid}`);
process.env.PI_OFFLINE = "1";
process.env.SIGMA_DEMO = "1";
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
async function git(cwd: string, ...args: string[]) { return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim(); }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => Promise<boolean> | boolean, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await sleep(20); } return false; }
async function fixture(name: string) {
    const cwd = join(root, name), data = join(root, `${name}-data`), remote = join(root, `${name}-remote.git`);
    await mkdir(cwd, { recursive: true }); await mkdir(data);
    await exec("git", ["init", "--bare", "-b", "main", remote]);
    await git(cwd, "init", "-b", "main"); await git(cwd, "config", "user.name", "Fixture"); await git(cwd, "config", "user.email", "fixture@example.invalid"); await git(cwd, "config", "commit.gpgSign", "false");
    await writeFile(join(cwd, "a.txt"), "base\n"); await git(cwd, "add", "."); await git(cwd, "commit", "-m", "Base");
    await git(cwd, "remote", "add", "origin", remote); await git(cwd, "push", "-u", "origin", "main");
    await git(cwd, "commit", "--allow-empty", "-m", "To push");
    const pidFile = join(root, `${name}-hook.pid`), log = join(root, `${name}-hook.log`), hook = join(remote, "hooks", "pre-receive");
    await writeFile(hook, `#!/bin/sh\necho $$ >> '${pidFile}'\necho run >> '${log}'\nexec sleep 30\n`); await chmod(hook, 0o755);
    const storage = new Storage(join(data, "state.sqlite")), host = new PiHost(storage, data, async () => { });
    await host.init();
    const id = await host.create(cwd, "sigma-demo/offline", crypto.randomUUID(), "read");
    await host.snapshot(id);
    return { cwd, data, remote, storage, host, id, pidFile, log };
}
const hookPid = async (file: string) => { await until(async () => (await readFile(file, "utf8").catch(() => "")).trim() !== ""); return Number((await readFile(file, "utf8")).trim().split("\n")[0]); };
test("Stop during Git push kills the supervised group quickly and leaves an explicit unknown", async () => {
    const f = await fixture("stop");
    try {
        const commandId = crypto.randomUUID(), pushing = f.host.gitAction(f.id, "push", {}, commandId).then(() => "ok", e => String(e));
        const pid = await hookPid(f.pidFile), started = Date.now();
        assert.ok(alive(pid));
        await f.host.abort(f.id);
        assert.ok(Date.now() - started < 2000, "Stop resolves quickly");
        assert.ok(await until(() => !alive(pid), 2000), "hook process group is gone");
        assert.match(await pushing, /git push failed|Git push/);
        await assert.rejects(f.host.gitAction(f.id, "push", {}, commandId), /Previous.*unknown/);
        const recovery = await f.host.gitRecovery(f.id);
        assert.equal(recovery.length, 1);
        assert.equal(recovery[0].kind, "push");
        assert.equal((await readFile(f.log, "utf8")).trim().split("\n").length, 1);
    }
    finally { await f.host.close(); await f.storage.close(); }
});
test("a same command ID with a different request is rejected for Git push", async () => {
    const f = await fixture("conflict");
    try {
        await writeFile(join(f.remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 0\n");
        const commandId = crypto.randomUUID();
        await f.host.gitAction(f.id, "push", {}, commandId);
        assert.equal(await git(f.remote, "rev-parse", "main"), await git(f.cwd, "rev-parse", "HEAD"));
        await assert.rejects(f.host.gitAction(f.id, "push", {}, commandId), /Previous.*completed/);
        await assert.rejects(f.host.gitAction(f.id, "pull", {}, commandId), /conflict/);
        await assert.rejects(f.host.gitAction(f.id, "push", {}, ""), /X-Command-Id required/);
    }
    finally { await f.host.close(); await f.storage.close(); }
});
test("SIGKILL of the server mid-push reaps the group, reopens unknown and never replays the push", async () => {
    const f = await fixture("crash");
    await f.host.close(); await f.storage.close();
    const commandId = crypto.randomUUID(), before = await git(f.remote, "rev-parse", "main");
    const child = spawn(process.execPath, ["--import", "tsx", resolve("apps/server/git-push-crash.fixture.ts"), f.data, f.id, commandId], { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
    let error = ""; child.stderr.on("data", d => error += d);
    const exited = new Promise<string | null>(r => child.on("close", (_c, signal) => r(signal)));
    try {
        const pid = await hookPid(f.pidFile);
        assert.ok(alive(pid), error);
        child.kill("SIGKILL");
        assert.equal(await exited, "SIGKILL");
        assert.ok(await until(() => !alive(pid), 3000), "orphaned push group is reaped after the server dies");
    }
    finally { child.kill("SIGKILL"); }
    const storage = new Storage(join(f.data, "state.sqlite")), host = new PiHost(storage, f.data, async () => { });
    await host.init();
    try {
        await host.snapshot(f.id);
        const recovery = await host.gitRecovery(f.id);
        assert.equal(recovery.length, 1);
        assert.equal(recovery[0].kind, "push");
        assert.equal(recovery[0].state, "observed");
        await assert.rejects(host.gitAction(f.id, "push", {}, commandId), /Previous.*unknown/);
        await assert.rejects(host.gitAction(f.id, "pull", {}, crypto.randomUUID()), /unknown Git/);
        assert.equal((await readFile(f.log, "utf8")).trim().split("\n").length, 1, "push hook ran once");
        assert.equal(await git(f.remote, "rev-parse", "main"), before);
        await host.reconcileGit(f.id, recovery[0].id, { acknowledge: true, digest: recovery[0].digest });
        assert.deepEqual(await host.gitRecovery(f.id), []);
    }
    finally { await host.close(); await storage.close(); }
});
