import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Diagnostics, failureReason } from "./diagnostics.js";
import { PiHost } from "./pi-host.js";
import { Storage } from "./storage.js";
import { AGENT_TIMEOUT_MS, READ_ONLY_PROFILE, NESTED_WORKER_PROFILE, REVIEW_PROFILE } from "../../packages/contracts/index.js";
import { DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, protectedRoots } from "./shell-tool.js";

const base=await mkdtemp(join(tmpdir(),"sigma-diagnostics-"));
process.env.HOME=base;process.env.PI_OFFLINE="1";process.env.SIGMA_DEMO="1";process.env.PI_CODING_AGENT_DIR=join(base,"agent");
test.after(()=>rm(base,{recursive:true,force:true}));
const pathOf=(dir:string)=>join(dir,"logs/runtime.jsonl");
const records=async(dir:string)=>(await readFile(pathOf(dir),"utf8")).trim().split("\n").map(line=>JSON.parse(line));
async function scratch(){return mkdtemp(join(base,"case-"));}
async function waitFor(check:()=>Promise<boolean>,ms=8000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error("Fixture did not settle");}
async function fixture(directory?:string){
  const dir=directory??await scratch();
  const storage=new Storage(join(dir,"state.sqlite"));
  const host=new PiHost(storage,dir,async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);});
  await host.init();return {dir,host,storage,close:async()=>{try{await host.close();}finally{await storage.close();}}};
}

test("structured diagnostics allowlist excludes arbitrary exception/request content and restores private modes",async()=>{
  const dir=await scratch(),log=new Diagnostics(dir),id=randomUUID();
  log.write("provider_error",{sessionId:id,role:"planner",reason:failureReason(new Error("401 secret-key prompt-content")),...{message:"secret-key",stack:"prompt-content",url:"https://user:password@host",model:"secret-key"}} as any);
  await chmod(join(dir,"logs"),0o755);await chmod(pathOf(dir),0o644);
  log.write("agent_stop",{sessionId:"not-an-id-secret",reason:"timeout",timeoutMs:AGENT_TIMEOUT_MS});
  const text=await readFile(pathOf(dir),"utf8"),rows=await records(dir);
  assert.doesNotMatch(text,/secret-key|prompt-content|password|not-an-id|https/);
  assert.equal(rows[0].sessionId,id);assert.equal(rows[0].reason,"authentication");assert.equal(rows[1].sessionId,undefined);
  assert.equal((await stat(pathOf(dir))).mode&0o777,0o600);assert.equal((await stat(join(dir,"logs"))).mode&0o777,0o700);
  for(const [input,expected] of [["Child time limit reached","timeout"],["Claude CLI sent nothing for 30 minutes","idle_timeout"],["Child provider failed","provider_error"],["native_protocol","native_protocol"],["credits required","rate_limit"],["ECONNRESET","transport"],["arbitrary secret","internal_error"]])assert.equal(failureReason(input),expected);
});

test("diagnostics rotates two bounded backups and refuses symlinks and hardlinks without changing their targets",async()=>{
  const dir=await scratch(),log=new Diagnostics(dir,512);
  for(let i=0;i<50;i++)log.write("provider_error",{sessionId:randomUUID(),reason:"transport"});
  assert.deepEqual((await readdir(join(dir,"logs"))).sort(),["runtime.jsonl","runtime.jsonl.1","runtime.jsonl.2"]);
  for(const name of await readdir(join(dir,"logs"))){const file=join(dir,"logs",name);assert.ok((await stat(file)).size<=512);assert.equal((await stat(file)).mode&0o777,0o600);for(const line of (await readFile(file,"utf8")).trim().split("\n"))JSON.parse(line);}
  const target=join(dir,"outside");await writeFile(target,"untouched",{mode:0o644});
  for(const kind of ["file-link","hardlink","directory-link","backup-link"]){
    const unsafe=await scratch();await mkdir(join(unsafe,"logs"));
    if(kind==="directory-link"){await rm(join(unsafe,"logs"),{recursive:true});await symlink(dir,join(unsafe,"logs"));}
    else if(kind==="hardlink")await link(target,pathOf(unsafe));
    else await symlink(target,pathOf(unsafe)+(kind==="backup-link"?".1":""));
    assert.doesNotThrow(()=>new Diagnostics(unsafe).write("service_start"));
    assert.equal(await readFile(target,"utf8"),"untouched");assert.equal((await stat(target)).mode&0o777,0o644);
  }
  const missing=join(dir,"missing/parent");assert.doesNotThrow(()=>new Diagnostics(missing).write("service_error"));
});

test("fatal observer persists classification without swallowing the fatal exit or raw secrets",async()=>{
  const dir=await scratch();
  const child=spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",`import {Diagnostics,observeFatalErrors} from './apps/server/diagnostics.ts'; observeFatalErrors(new Diagnostics(${JSON.stringify(dir)})); throw new Error('401 sensitive-fatal-key');`],{cwd:process.cwd(),encoding:"utf8"});
  assert.notEqual(child.status,0);const text=await readFile(pathOf(dir),"utf8");assert.doesNotMatch(text,/sensitive-fatal-key/);assert.equal((await records(dir))[0].event,"process_fatal");
  const rejected=await scratch();
  const unhandled=spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",`import {Diagnostics,observeFatalErrors} from './apps/server/diagnostics.ts'; observeFatalErrors(new Diagnostics(${JSON.stringify(rejected)})); Promise.reject(new Error('sensitive-rejection-key'));`],{cwd:process.cwd(),encoding:"utf8"});
  assert.notEqual(unhandled.status,0);assert.equal((await records(rejected))[0].event,"process_fatal");assert.doesNotMatch(await readFile(pathOf(rejected),"utf8"),/sensitive-rejection-key/);
});

test("all execution defaults are 30 minutes; provider return-errors and failed delegation are logged",async()=>{
  assert.equal(AGENT_TIMEOUT_MS,1_800_000);
  for(const profile of [READ_ONLY_PROFILE,NESTED_WORKER_PROFILE,REVIEW_PROFILE])assert.equal(profile.childTimeoutMs,AGENT_TIMEOUT_MS);
  assert.equal(DEFAULT_TIMEOUT_SECONDS,1800);assert.equal(MAX_TIMEOUT_SECONDS,1800);
  const f=await fixture();
  try{
    const id=await f.host.create(f.dir,"sigma-demo/offline");await f.host.prompt(id,"delegate:fail-provider");
    await waitFor(async()=>(await f.host.snapshot(id)).status==="settled");
    const rows=await records(f.dir),provider=rows.find(row=>row.event==="provider_error"),delegation=rows.find(row=>row.event==="delegation_error");
    assert.ok(provider?.sessionId);assert.equal(provider.rootId,id);assert.equal(provider.role,"researcher");assert.equal(provider.reason,"provider_error");assert.equal(delegation.sessionId,provider.sessionId);assert.equal(delegation.reason,"provider_error");
    assert.ok(rows.find(row=>row.event==="agent_start"&&row.timeoutMs===AGENT_TIMEOUT_MS));
    assert.ok(protectedRoots(f.dir,join(base,"agent")).dirs.includes(join(f.dir,"logs")));
  }finally{await f.close();}
});

test("root deadline stops its subtree and distinguishes timeout from user Stop and shutdown",async()=>{
  const f=await fixture();
  try{
    const id=await f.host.create(f.dir,"sigma-demo/offline");await f.host.prompt(id,"delegate:slow-child");
    await waitFor(async()=>[...(f.host as any).active.values()].some((live:any)=>live.row.parentId===id&&live.deadline));
    const root=(f.host as any).active.get(id);assert.equal(root.deadline._idleTimeout,AGENT_TIMEOUT_MS);
    root.deadline._onTimeout();
    await waitFor(async()=>{const view=await f.host.snapshot(id);return view.status==="interrupted"&&!view.agents.some(agent=>agent.status==="running");});
    await waitFor(async()=>(await records(f.dir)).some(row=>row.event==="delegation_error"&&row.parentId===id));
    let rows=await records(f.dir);assert.ok(rows.find(row=>row.event==="agent_timeout"&&row.sessionId===id&&row.reason==="timeout"));
    assert.ok(rows.find(row=>row.event==="agent_stop"&&row.parentId===id&&row.reason==="timeout"));
    assert.ok(rows.find(row=>row.event==="delegation_error"&&row.parentId===id&&row.reason==="timeout"),"Downstream cancellation keeps the original timeout cause");
    const stopped=await f.host.create(f.dir,"sigma-demo/offline");await f.host.prompt(stopped,"slow-user-stop");await f.host.abort(stopped);
    rows=await records(f.dir);assert.ok(rows.find(row=>row.event==="agent_stop"&&row.sessionId===stopped&&row.reason==="cancelled"));
    const shutdown=await f.host.create(f.dir,"sigma-demo/offline");await f.host.prompt(shutdown,"slow-shutdown");
    await f.host.close();rows=await records(f.dir);assert.ok(rows.find(row=>row.event==="agent_stop"&&row.sessionId===shutdown&&row.reason==="shutdown"));
  }finally{await f.close();}
});

test("background journal failures are recorded safely and still fail shutdown",async()=>{
  const f=await fixture();
  try{
    (f.host as any).track(Promise.reject(new Error("ECONNRESET secret-background-key")));
    await waitFor(async()=>{try{return (await records(f.dir)).some(row=>row.event==="background_error"&&row.reason==="transport");}catch{return false;}});
    assert.doesNotMatch(await readFile(pathOf(f.dir),"utf8"),/secret-background-key/);
    await assert.rejects(f.host.close(),/shutdown did not finish cleanly/);
  }finally{await f.storage.close();}
});

test("restored legacy policies keep provenance but use 30-minute delegation and resumed-child deadlines",async()=>{
  const first=await fixture(),id=await first.host.create(first.dir,"sigma-demo/offline");
  await first.host.prompt(id,"hello");await waitFor(async()=>(await first.host.snapshot(id)).status==="settled");
  const policy=structuredClone((await first.host.snapshot(id)).policy) as any;await first.close();
  policy.effective.profile.childTimeoutMs=1;
  if(policy.setup?.profile)policy.setup.profile.childTimeoutMs=1;
  const db=new DatabaseSync(join(first.dir,"state.sqlite"));db.prepare("UPDATE sessions SET policy=? WHERE id=?").run(JSON.stringify(policy),id);db.close();
  const f=await fixture(first.dir);
  try{
    await f.host.prompt(id,"delegate:slow-legacy");
    await waitFor(async()=>[...(f.host as any).active.values()].some((live:any)=>live.row.parentId===id&&live.deadline));
    const child=[...(f.host as any).active.values()].find((live:any)=>live.row.parentId===id) as any;
    assert.equal(child.deadline._idleTimeout,AGENT_TIMEOUT_MS);
    await new Promise(resolve=>setTimeout(resolve,30));assert.equal((await f.host.snapshot(id)).agents.find(agent=>agent.id===child.row.id)?.status,"running");
    await waitFor(async()=>(await f.host.snapshot(id)).status==="settled");
    assert.deepEqual((await f.host.snapshot(id)).policy,policy,"Runtime deadlines do not rewrite immutable saved setup/tool policies");
    await f.host.prompt(child.row.id,"slow-resumed",undefined,undefined,id);
    const live=(f.host as any).active.get(child.row.id);assert.equal(live.deadline._idleTimeout,AGENT_TIMEOUT_MS);
    live.deadline._onTimeout();await waitFor(async()=>(await f.host.snapshot(id)).agents.find(agent=>agent.id===child.row.id)?.status==="interrupted");
    assert.ok((await records(f.dir)).find(row=>row.event==="agent_timeout"&&row.sessionId===child.row.id));
  }finally{await f.close();}
});
