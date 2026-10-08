import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { Storage } from "./storage.js";
import { PiHost } from "./pi-host.js";
import { WorkerMerge } from "./worker-merge.js";

const root=resolve(import.meta.dirname,"../.."),scratch=join(root,".scratch/worker-placement",`tests-${Date.now()}-${process.pid}`);
process.env.PI_OFFLINE="1";process.env.SIGMA_DEMO="1";process.env.PI_CODING_AGENT_DIR=join(scratch,"agent");
async function waitFor(check:()=>Promise<boolean>,ms=15000){const until=Date.now()+ms;while(Date.now()<until){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw new Error("Timed out waiting for state");}
async function fixture(name:string,mode:"full"|"ask"){
  const data=join(scratch,name),source=join(data,"source");await mkdir(source,{recursive:true});
  const git=(...args:string[])=>execFileSync("git",["-C",source,"-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false",...args],{env:{...process.env,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_AUTHOR_NAME:"Fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"Fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid"}});
  git("init","-q","-b","main");await writeFile(join(source,"seed.txt"),"base\n");await writeFile(join(source,"shared.txt"),"base\n");git("add","--",".");git("commit","-qm","fixture");
  const storage=new Storage(join(data,"state.sqlite"));
  const host=new PiHost(storage,data,async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);});await host.init();await host.setApprovalMode(mode);
  const merge=new WorkerMerge(storage,host,data,async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);});host.setAutoMerger((rootId,workerId)=>merge.auto(rootId,workerId));
  return {data,source,storage,host,merge,close:async()=>{await merge.close();await host.close();await storage.close();}};
}
type F=Awaited<ReturnType<typeof fixture>>;
async function entries(f:F,id:string){const row=await f.storage.call<{file:string}>("session",{id});return (await readFile(row.file,"utf8")).trim().split("\n").map(line=>JSON.parse(line));}
async function delegateResults(f:F,id:string){return (await entries(f,id)).filter(entry=>entry.message?.role==="toolResult"&&entry.message.toolName==="delegate").map(entry=>entry.message.content.map((part:any)=>part.text??"").join(" ") as string);}
/** Runs a root prompt to completion, approving every pending request (Ask mode) as the user would. */
async function run(f:F,id:string,prompt:string,approve=false){
  await f.host.prompt(id,prompt);
  await waitFor(async()=>{
    const view=await f.host.snapshot(id);
    if(approve)for(const approval of view.approvals.filter(item=>item.status==="pending"))await f.host.decide(id,approval.id,true).catch(()=>{});
    return view.status==="settled";
  });
  return f.host.snapshot(id);
}
const exists=(path:string)=>readFile(path,"utf8").then(()=>true,()=>false);
const writes=(...files:Array<[string,string]>)=>`delegate2:${files.map(([path,content])=>`write:${JSON.stringify({path,content})}`).join("|")}`;

test("a lone worker edits the root working copy in place: no worktree, no merge",async()=>{
  const f=await fixture("lone","full");
  try{
    const id=await f.host.create(f.source,"sigma-demo/offline",crypto.randomUUID(),"parallel");
    const view=await run(f,id,writes(["lone.txt","in place\n"]));
    const worker=view.agents.find(agent=>agent.parentId===id)!;
    assert.equal(worker.role,"worker");assert.equal(worker.cwd,view.cwd);
    assert.equal(await readFile(join(f.source,"lone.txt"),"utf8"),"in place\n");
    const policy=(await f.host.snapshot(worker.id)).policy!;assert.equal(policy.workspace?.kind,"direct");assert.equal(policy.effective.cwd,view.cwd);
    assert.equal(await exists(join(f.data,"workspaces")),false,"no worktree is created for a lone worker");
    assert.deepEqual(await f.storage.call("workerMerges",{rootId:id}),[]);
    const [result]=await delegateResults(f,id);assert.match(result,/applied in the working copy/);
  }finally{await f.close();}
});

test("a second concurrent worker gets a worktree and is merged automatically under Full access",async()=>{
  const f=await fixture("parallel-full","full");
  try{
    const id=await f.host.create(f.source,"sigma-demo/offline",crypto.randomUUID(),"parallel");
    const view=await run(f,id,writes(["a.txt","A\n"],["b.txt","B\n"]));
    const workers=view.agents.filter(agent=>agent.parentId===id);assert.equal(workers.length,2);
    assert.equal(workers.filter(worker=>worker.cwd===view.cwd).length,1,"exactly one worker edits in place");
    const isolated=workers.find(worker=>worker.cwd!==view.cwd)!;assert.ok((await readdir(join(f.data,"workspaces"))).includes(isolated.id));
    assert.equal(await readFile(join(f.source,"a.txt"),"utf8"),"A\n");assert.equal(await readFile(join(f.source,"b.txt"),"utf8"),"B\n");
    const merges=await f.storage.call<any[]>("workerMerges",{rootId:id});assert.equal(merges.length,1);
    assert.equal(merges[0].status,"applied");assert.equal(merges[0].workerId,isolated.id);assert.equal(merges[0].auto,true);
    const results=await delegateResults(f,id);assert.equal(results.length,2);
    assert.ok(results.some(text=>/merged into the working copy automatically/.test(text)));assert.ok(results.some(text=>/applied in the working copy/.test(text)));
    assert.ok(!results.some(text=>/not integrated/.test(text)));
  }finally{await f.close();}
});

test("with Ask mode the parallel worker's changes stay in its worktree for a manual merge",async()=>{
  const f=await fixture("parallel-ask","ask");
  try{
    const id=await f.host.create(f.source,"sigma-demo/offline",crypto.randomUUID(),"parallel");
    const view=await run(f,id,writes(["a.txt","A\n"],["b.txt","B\n"]),true);
    const workers=view.agents.filter(agent=>agent.parentId===id);assert.equal(workers.length,2);
    const isolated=workers.find(worker=>worker.cwd!==view.cwd)!,inPlace=workers.find(worker=>worker.cwd===view.cwd)!;
    assert.ok(isolated&&inPlace);
    const [inPlaceFile,isolatedFile]=(await readFile(join(f.source,"a.txt"),"utf8").then(()=>true,()=>false))?["a.txt","b.txt"]:["b.txt","a.txt"];
    assert.equal(await exists(join(f.source,inPlaceFile)),true);assert.equal(await exists(join(f.source,isolatedFile)),false,"the isolated worker's file is not in the working copy");
    assert.equal(await exists(join(isolated.cwd,isolatedFile)),true);
    assert.deepEqual(await f.storage.call("workerMerges",{rootId:id}),[]);
    const results=await delegateResults(f,id);assert.ok(results.some(text=>/pending merge in Changes/.test(text)));
    // The user can still merge it manually afterwards.
    const preview=await f.merge.prepare(id,isolated.id,crypto.randomUUID());assert.equal(preview.status,"pending");
    assert.equal((await f.merge.decide(id,preview.id,true)).status,"applied");assert.equal(await exists(join(f.source,isolatedFile)),true);
  }finally{await f.close();}
});

test("a conflicting automatic merge is left for the user with a clear note",async()=>{
  const f=await fixture("parallel-conflict","full");
  try{
    const id=await f.host.create(f.source,"sigma-demo/offline",crypto.randomUUID(),"parallel");
    const view=await run(f,id,writes(["shared.txt","one\n"],["shared.txt","two\n"]));
    const workers=view.agents.filter(agent=>agent.parentId===id);assert.equal(workers.length,2);
    const isolated=workers.find(worker=>worker.cwd!==view.cwd)!;
    const inPlaceText=await readFile(join(f.source,"shared.txt"),"utf8");assert.match(inPlaceText,/^(one|two)\n$/,"the root copy keeps the in-place worker's content untouched");
    const merges=await f.storage.call<any[]>("workerMerges",{rootId:id});assert.equal(merges.length,1);assert.equal(merges[0].status,"conflict");assert.equal(merges[0].auto,true);
    assert.match(await readFile(join(isolated.cwd,"shared.txt"),"utf8"),/^(one|two)\n$/);assert.notEqual(await readFile(join(isolated.cwd,"shared.txt"),"utf8"),inPlaceText);
    const results=await delegateResults(f,id);
    assert.ok(results.some(text=>/changes not integrated: merge conflict in shared\.txt; the user must merge them from Changes/.test(text)));
  }finally{await f.close();}
});

test("in a worktree root, 'in place' is the root's own worktree and the source stays untouched",async()=>{
  const f=await fixture("worktree-root","full");
  try{
    const id=await f.host.create(f.source,"sigma-demo/offline",crypto.randomUUID(),"parallel",{workspaceMode:"worktree"});
    const lone=await run(f,id,writes(["lone.txt","x\n"]));
    const worker=lone.agents.find(agent=>agent.parentId===id)!;
    assert.notEqual(lone.cwd,f.source);assert.equal(worker.cwd,lone.cwd);assert.equal(await readFile(join(lone.cwd,"lone.txt"),"utf8"),"x\n");assert.equal(await exists(join(f.source,"lone.txt")),false);
    assert.deepEqual(await f.storage.call("workerMerges",{rootId:id}),[]);
    await f.storage.call("status",{id,status:"idle"});
    const both=await run(f,id,writes(["a.txt","A\n"],["b.txt","B\n"]));
    assert.equal(await readFile(join(both.cwd,"a.txt"),"utf8"),"A\n");assert.equal(await readFile(join(both.cwd,"b.txt"),"utf8"),"B\n");assert.equal(await exists(join(f.source,"a.txt")),false);
    assert.equal((await f.storage.call<any[]>("workerMerges",{rootId:id})).filter(row=>row.status==="applied"&&row.auto).length,1);
  }finally{await f.close();}
});
