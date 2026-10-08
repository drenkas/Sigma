import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile, readFile, chmod, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { Storage } from "./storage.js";
import { PiHost } from "./pi-host.js";
const exec = promisify(execFile), root = resolve(`.scratch/git-intents-${Date.now()}-${process.pid}`);
process.env.PI_OFFLINE = "1";
process.env.SIGMA_DEMO = "1";
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
async function git(cwd: string, ...args: string[]) { return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim(); }
async function fixture(name: string) { const cwd = join(root, name), data = join(root, `${name}-data`); await mkdir(cwd, { recursive: true }); await mkdir(data); await git(cwd, "init", "-b", "main"); await git(cwd, "config", "user.name", "Fixture"); await git(cwd, "config", "user.email", "fixture@example.invalid"); await git(cwd, "config", "commit.gpgSign", "false"); await writeFile(join(cwd, "safe.txt"), "base\n"); await writeFile(join(cwd, "outside.txt"), "outside base\n"); await git(cwd, "add", "."); await git(cwd, "commit", "-m", "Base"); const storage = new Storage(join(data, "state.sqlite")), host = new PiHost(storage, data, async () => { }); await host.init(); const id = await host.create(cwd, "sigma-demo/offline", crypto.randomUUID(), "code"); await host.snapshot(id); const tool = (host as any).active.get(id).session.getToolDefinition("git_commit"); await writeFile(join(cwd, "safe.txt"), "approved bytes\n"); return { cwd, data, storage, host, id, tool }; }
async function pending(host: PiHost, id: string) { for (let i = 0; i < 300; i++) {
    const item = (await host.snapshot(id)).approvals.find(a => a.status === "pending");
    if (item)
        return item;
    await new Promise(r => setTimeout(r, 20));
} throw new Error("No approval"); }
test("Git approval exposes the complete multiline message and native exact tree diff", async () => {
    const f = await fixture("preview");
    try {
        const running = f.tool.execute("preview-call", { message: "Subject\n\nComplete body" });
        const a = await pending(f.host, f.id);
        await f.host.decide(f.id, a.id, false);
        await assert.rejects(running);
        assert.equal((a as any).git?.message, "Subject\n\nComplete body");
        assert.match((a as any).git?.diff ?? "", /\+approved bytes/);
        assert.ok((a as any).commandId);
    }
    finally {
        await f.host.close();
        await f.storage.close();
    }
});
for (const drift of ["bytes", "index", "HEAD", "mode"]) {
    test(`Git rejects ${drift} drift after Allow before mutation`, async () => {
        const f = await fixture(drift);
        try {
            const running = f.tool.execute(`${drift}-call`, { message: "Approved" });
            const a = await pending(f.host, f.id);
            if (drift === "bytes")
                await writeFile(join(f.cwd, "safe.txt"), "later bytes\n");
            if (drift === "mode")
                await chmod(join(f.cwd, "safe.txt"), 0o755);
            if (drift === "index")
                await git(f.cwd, "add", "safe.txt");
            if (drift === "HEAD")
                await git(f.cwd, "commit", "--allow-empty", "-m", "External");
            const head = await git(f.cwd, "rev-parse", "HEAD");
            await f.host.decide(f.id, a.id, true);
            await assert.rejects(running, /changed|drift/);
            assert.equal(await git(f.cwd, "rev-parse", "HEAD"), head);
        }
        finally {
            await f.host.close();
            await f.storage.close();
        }
    });
}
test("receipt failure preserves unknown command and same toolCallId never commits again", async () => {
    const f = await fixture("receipt");
    try {
        const call = f.storage.call.bind(f.storage);
        f.storage.call = (async (op: string, args?: any) => { if (op === "repinDirect" || op === "gitComplete")
            throw new Error("Synthetic persistence failure"); return call(op, args); }) as any;
        const running = f.tool.execute("receipt-call", { message: "Once" });
        const a = await pending(f.host, f.id);
        await f.host.decide(f.id, a.id, true);
        await assert.rejects(running, /persistence/);
        const head = await git(f.cwd, "rev-parse", "HEAD");
        f.storage.call = call;
        await writeFile(join(f.cwd, "safe.txt"), "another change\n");
        const repeat = f.tool.execute("receipt-call", { message: "Once" });
        const outcome = await Promise.race([repeat.then(() => "executed", () => "rejected"), new Promise<string>(r => setTimeout(() => r("approval replay"), 30000))]);
        if (outcome === "approval replay") {
            const replay = await pending(f.host, f.id);
            await f.host.decide(f.id, replay.id, false);
            await assert.rejects(repeat);
        }
        assert.equal(outcome, "rejected");
        const rows = await call("gitRecoveries", { cwd: f.cwd });
        assert.equal(rows.length, 1);
        assert.equal(await git(f.cwd, "rev-parse", "HEAD"), head);
    }
    finally {
        await f.host.close();
        await f.storage.close();
    }
});
test("an actual process crash after HEAD movement reopens unknown, preserves outside index, blocks writes and reconciles without replay", async () => {
    const f = await fixture("crash");
    await writeFile(join(f.cwd, "outside.txt"), "outside staged\n");
    await git(f.cwd, "add", "outside.txt");
    await writeFile(join(f.cwd, "outside.txt"), "outside base\n");
    const outside = await git(f.cwd, "ls-files", "--stage", "--", "outside.txt"), before = await git(f.cwd, "rev-parse", "HEAD"), marker = join(f.data, "crash-marker");
    await f.host.close();
    await f.storage.close();
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["--import", "tsx", resolve("apps/server/git-crash.fixture.ts"), f.data, f.id, marker], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let error = "";
    child.stderr.on("data", d => error += d);
    const exit = await new Promise<{
        code: number | null;
        signal: string | null;
    }>(r => child.on("close", (code, signal) => r({ code, signal })));
    assert.equal(exit.signal, "SIGKILL", error);
    assert.equal(await readFile(marker, "utf8"), "HEAD moved; index not published\n");
    const head = await git(f.cwd, "rev-parse", "HEAD");
    assert.notEqual(head, before);
    const storage = new Storage(join(f.data, "state.sqlite")), host = new PiHost(storage, f.data, async () => { });
    await host.init();
    try {
        await host.snapshot(f.id);
        const recovery = await host.gitRecovery(f.id);
        assert.equal(recovery.length, 1);
        assert.equal(recovery[0].state, "committed");
        assert.equal(recovery[0].head, head);
        const writer = (host as any).active.get(f.id).session.getToolDefinition("write");
        await assert.rejects(writer.execute("blocked-write-call", { path: "safe.txt", content: "must not write\n" }), /unknown Git|unknown outcomes|Git activity/);
        await assert.rejects(host.gitAction(f.id, "switch", { branch: "main" }, crypto.randomUUID()), /unknown Git/);
        const tool = (host as any).active.get(f.id).session.getToolDefinition("git_commit");
        await assert.rejects(tool.execute("actual-crash-call", { message: "Crash once\n\nFrozen receipt" }), /Previous.*unknown/);
        await assert.rejects(tool.execute("actual-crash-call", { message: "Different" }), /Command ID conflict/);
        await assert.rejects(host.reconcileGit(f.id, recovery[0].id, { acknowledge: true, digest: "stale" }), /observations changed/);
        await host.reconcileGit(f.id, recovery[0].id, { acknowledge: true, digest: recovery[0].digest });
        assert.equal((await host.snapshot(f.id)).policy?.workspace?.baseCommit, head);
        assert.deepEqual(await host.gitRecovery(f.id), []);
        assert.equal(await git(f.cwd, "ls-files", "--stage", "--", "outside.txt"), outside);
        assert.equal(await git(f.cwd, "rev-parse", "HEAD"), head);
        assert.equal(await git(f.cwd, "rev-list", "--count", "HEAD"), "2");
        assert.equal(await git(f.cwd, "status", "--porcelain", "--", "safe.txt"), "");
    }
    finally {
        await host.close();
        await storage.close();
    }
});
test("Read-owned switch and pull IDs do not replay and unknown outcome blocks a Code owner", async () => {
    const f = await fixture("read-git");
    try {
        await git(f.cwd, "branch", "feature");
        const read = await f.host.create(f.cwd, "sigma-demo/offline", crypto.randomUUID(), "read");
        const switchId = crypto.randomUUID();
        await f.host.gitAction(read, "switch", { branch: "feature" }, switchId);
        await assert.rejects(f.host.gitAction(read, "switch", { branch: "feature" }, switchId), /Previous.*completed/);
        await assert.rejects(f.host.gitAction(read, "switch", { branch: "main" }, switchId), /conflict/);
        const original = f.storage.call.bind(f.storage);
        f.storage.call = (async (op: string, args?: any) => { if (op === "gitComplete")
            throw new Error("Synthetic persistence failure"); return original(op, args); }) as any;
        const pullId = crypto.randomUUID();
        await assert.rejects(f.host.gitAction(read, "pull", {}, pullId), /git pull failed/);
        f.storage.call = original;
        await assert.rejects(f.host.gitAction(read, "pull", {}, pullId), /Previous.*unknown/);
        const writer = (f.host as any).active.get(f.id).session.getToolDefinition("write");
        await assert.rejects(writer.execute("blocked-read-owner-write", { path: "safe.txt", content: "must not write\n" }), /unknown Git|Git activity/);
        const recovery = await f.host.gitRecovery(f.id);
        assert.equal(recovery.length, 1);
        assert.equal(recovery[0].kind, "pull");
        assert.equal(recovery[0].state, "observed");
        await f.host.reconcileGit(f.id, recovery[0].id, { acknowledge: true, digest: recovery[0].digest });
        assert.deepEqual(await f.host.gitRecovery(read), []);
    }
    finally {
        await f.host.close();
        await f.storage.close();
    }
});
test("Stop waits for an admitted Git receipt finalizer, and does not replay its commit", async () => {
    const f = await fixture("drain");
    try {
        const original = f.storage.call.bind(f.storage);
        let entered = false, release = () => { };
        f.storage.call = (async (op: string, args?: any) => { if (op === "gitComplete") {
            entered = true;
            await new Promise<void>(r => release = r);
        } return original(op, args); }) as any;
        const running = f.tool.execute("drain-call", { message: "Drain once" });
        const a = await pending(f.host, f.id);
        await f.host.decide(f.id, a.id, true);
        for (let i = 0; i < 300 && !entered; i++)
            await new Promise(r => setTimeout(r, 20));
        assert.equal(entered, true);
        let stopped = false;
        const stop = f.host.abort(f.id).then(() => stopped = true);
        await new Promise(r => setTimeout(r, 50));
        assert.equal(stopped, false);
        release();
        await Promise.all([running, stop]);
        assert.equal(await git(f.cwd, "rev-list", "--count", "HEAD"), "2");
        assert.equal(await f.storage.call("gitBlocked", { cwd: f.cwd }), false);
    }
    finally {
        await f.host.close();
        await f.storage.close();
    }
});
test("GET to acknowledgement identity drift keeps a same-bytes replacement index inspect-only", async () => {
    const f = await fixture("artifact-drift");
    try {
        const original = f.storage.call.bind(f.storage);
        f.storage.call = (async (op: string, args?: any) => { if (op === "gitComplete")
            throw new Error("Synthetic persistence failure"); return original(op, args); }) as any;
        const running = f.tool.execute("artifact-call", { message: "Known commit" });
        const a = await pending(f.host, f.id);
        await f.host.decide(f.id, a.id, true);
        await assert.rejects(running, /persistence/);
        f.storage.call = original;
        const view = (await f.host.gitRecovery(f.id))[0];
        assert.equal(view.state, "committed");
        const reader=(f.host as any).active.get(f.id).session.getToolDefinition("read");const reading=reader.execute("reconcile-pending-read",{path:"safe.txt"});const denied=assert.rejects(reading);const readApproval=await pending(f.host,f.id);
        try{await assert.rejects(f.host.reconcileGit(f.id,view.id,{acknowledge:true,digest:view.digest}),/waiting for an approval/);}finally{await f.host.decide(f.id,readApproval.id,false);await denied;}
        const index = join(f.cwd, ".git", "index"), bytes = await readFile(index);
        await rename(index, `${index}.foreign-original`);
        await writeFile(index, bytes);
        await assert.rejects(f.host.reconcileGit(f.id, view.id, { acknowledge: true, digest: view.digest }), /Index or owned lock changed/);
        assert.equal((await f.host.gitRecovery(f.id))[0].state, "inspect-only");
        assert.deepEqual(await readFile(index), bytes);
    }
    finally {
        await f.host.close();
        await f.storage.close();
    }
});
test("a durable completed receipt survives delivery failure and same-ID message conflict", async () => {
    const f = await fixture("receipt-delivery");
    try {
        const original = f.storage.call.bind(f.storage);
        f.storage.call = (async (op: string, args?: any) => { const value = await original(op, args); if (op === "gitComplete")
            throw new Error("Synthetic receipt delivery failure"); return value; }) as any;
        const running = f.tool.execute("delivery-call", { message: "Once" });
        const a = await pending(f.host, f.id);
        await f.host.decide(f.id, a.id, true);
        await assert.rejects(running, /delivery/);
        f.storage.call = original;
        await assert.rejects(f.tool.execute("delivery-call", { message: "Once" }), /Previous.*completed/);
        await assert.rejects(f.tool.execute("delivery-call", { message: "Changed message" }), /Command ID conflict/);
        assert.deepEqual(await f.host.gitRecovery(f.id), []);
        assert.equal(await git(f.cwd, "rev-list", "--count", "HEAD"), "2");
        assert.equal((await f.host.snapshot(f.id)).policy?.workspace?.baseCommit, await git(f.cwd, "rev-parse", "HEAD"));
    }
    finally {
        await f.host.close();
        await f.storage.close();
    }
});

async function gitWrapper(name:string,body:string){
  const dir=join(root,name);await mkdir(dir);const native=(await exec("which",["git"],{encoding:"utf8"})).stdout.trim();await writeFile(join(dir,"git"),`#!${process.execPath}\nimport {spawnSync,spawn} from "node:child_process";import {writeFileSync} from "node:fs";\nconst args=process.argv.slice(2);\nconst native=${JSON.stringify(native)};\n${body}\n`,{mode:0o700});return dir;
}

test("late branch movement after actual CAS keeps original index and unknown receipt",async()=>{
  const f=await fixture("late-ref");try{await git(f.cwd,"branch","feature");const old=await git(f.cwd,"rev-parse","HEAD"),index=await readFile(join(f.cwd,".git","index"));const wrapper=await gitWrapper("late-ref-wrapper",`const r=spawnSync(native,args,{stdio:"inherit"});if(args.includes("update-ref")&&r.status===0)spawnSync(native,["symbolic-ref","HEAD","refs/heads/feature"],{stdio:"inherit"});process.exit(r.status??1);`);const running=f.tool.execute("late-ref-call",{message:"Approved main only"});const a=await pending(f.host,f.id),path=process.env.PATH;process.env.PATH=`${wrapper}:${path}`;try{await f.host.decide(f.id,a.id,true);await assert.rejects(running,/changed after commit CAS/);}finally{process.env.PATH=path;}assert.equal(await git(f.cwd,"rev-parse","HEAD"),old);assert.notEqual(await git(f.cwd,"rev-parse","main"),old);assert.deepEqual(await readFile(join(f.cwd,".git","index")),index);assert.equal((await f.host.gitRecovery(f.id))[0].state,"inspect-only");}finally{await f.host.close();await f.storage.close();}
});

test("live descendants keep unknown Git recovery inspect-only until their owned process group exits",async()=>{
  const f=await fixture("group-live");try{await git(f.cwd,"branch","feature");const read=await f.host.create(f.cwd,"sigma-demo/offline",crypto.randomUUID(),"read");const wrapper=await gitWrapper("group-live-wrapper",`const r=spawnSync(native,args,{stdio:"inherit"});if(args.includes("switch"))spawn(process.execPath,["-e","setTimeout(()=>{},2500)"],{stdio:"ignore"}).unref();process.exit(r.status??1);`),path=process.env.PATH;process.env.PATH=`${wrapper}:${path}`;try{await assert.rejects(f.host.gitAction(read,"switch",{branch:"feature"},crypto.randomUUID()),/process group remains active/);}finally{process.env.PATH=path;}const view=(await f.host.gitRecovery(f.id))[0];assert.equal(view.canReconcile,false);await assert.rejects(f.host.reconcileGit(f.id,view.id,{acknowledge:true,digest:view.digest}),/process group is live/);await new Promise(r=>setTimeout(r,2800));const fresh=(await f.host.gitRecovery(f.id))[0];assert.equal(fresh.canReconcile,true);await f.host.reconcileGit(f.id,fresh.id,{acknowledge:true,digest:fresh.digest});}finally{await f.host.close();await f.storage.close();}
});

test("a hung owned Git process reaches its bounded timeout and Stop drains the unknown command",async()=>{
  const f=await fixture("timeout"),marker=join(root,"timeout-started");try{await git(f.cwd,"branch","feature");const read=await f.host.create(f.cwd,"sigma-demo/offline",crypto.randomUUID(),"read"),wrapper=await gitWrapper("timeout-wrapper",`if(args.includes("switch")){writeFileSync(${JSON.stringify(marker)},"started");setTimeout(()=>{},60000);}else{const r=spawnSync(native,args,{stdio:"inherit"});process.exit(r.status??1);}`),path=process.env.PATH;process.env.PATH=`${wrapper}:${path}`;const started=Date.now();try{const action=f.host.gitAction(read,"switch",{branch:"feature"},crypto.randomUUID());const failed=assert.rejects(action,/failed or timed out/);for(let i=0;i<300;i++){if((await import("node:fs")).existsSync(marker))break;await new Promise(r=>setTimeout(r,20));}assert.equal((await import("node:fs")).existsSync(marker),true);let stopped=false;const stop=f.host.abort(read).then(()=>stopped=true);await new Promise(r=>setTimeout(r,50));assert.equal(stopped,false);await Promise.all([failed,stop]);assert.ok(Date.now()-started<19000);}finally{process.env.PATH=path;}const view=(await f.host.gitRecovery(f.id))[0];assert.equal(view.canReconcile,true);await f.host.reconcileGit(f.id,view.id,{acknowledge:true,digest:view.digest});}finally{await f.host.close();await f.storage.close();}
});

test("an idle session's own pending approval prevents API HEAD moves",async()=>{
  const f=await fixture("self-pending");try{await git(f.cwd,"branch","feature");const reader=(f.host as any).active.get(f.id).session.getToolDefinition("read");const reading:Promise<unknown>=reader.execute("pending-read",{path:"safe.txt"});const rejected=assert.rejects(reading);const approval=await pending(f.host,f.id);try{await assert.rejects(f.host.gitAction(f.id,"switch",{branch:"feature"},crypto.randomUUID()),/waiting for an approval/);assert.equal(await git(f.cwd,"branch","--show-current"),"main");}finally{await f.host.decide(f.id,approval.id,false);await rejected;}}finally{await f.host.close();await f.storage.close();}
});
