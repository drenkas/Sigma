import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Storage } from "./storage.js";
import { PiHost } from "./pi-host.js";
import { Verification } from "./verification.js";
import { SourceApply } from "./source-apply.js";
import { WorkerMerge } from "./worker-merge.js";
import { NESTED_WORKER_PROFILE, REVIEW_PROFILE, type WorkspaceRecoveryItem, type ProjectTaskView } from "../../packages/contracts/index.js";

const root=resolve(import.meta.dirname,"../.."),fixture=join(root,".scratch/workspace-recovery",`${Date.now()}-${process.pid}`);
process.env.PI_OFFLINE="1";process.env.SIGMA_DEMO="1";process.env.PI_CODING_AGENT_DIR=join(fixture,"agent");
const git=(cwd:string,...args:string[])=>execFileSync("git",["-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false",...args],{cwd,encoding:"utf8",env:{PATH:process.env.PATH,HOME:fixture,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_AUTHOR_NAME:"Fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"Fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid"}}).trim();
async function source(name:string){const cwd=join(fixture,name);await mkdir(cwd,{recursive:true});git(cwd,"init","-b","main");await writeFile(join(cwd,"calc.ts"),"export const value = 1;\n");await writeFile(join(cwd,"probe.test.mjs"),"import assert from 'node:assert/strict'; assert.equal(1,1);\n");git(cwd,"add",".");git(cwd,"commit","-m","Fixture");return cwd;}
async function waitFor(check:()=>Promise<boolean>,ms=8000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,10));}throw new Error("Fixture boundary timed out");}
async function reopen(data:string){const storage=new Storage(join(data,"state.sqlite")),host=new PiHost(storage,data,async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);});await host.init();return {storage,host,close:async()=>{await host.close();await storage.close();}};}
async function crash(kind:"session"|"task"|"nested"|"review",sources:string[]){
  const id=randomUUID(),data=join(fixture,`${kind}-${id}`);await mkdir(data,{recursive:true});
  const code=`
    import {Storage} from ${JSON.stringify(join(root,"apps/server/storage.ts"))};
    import {PiHost} from ${JSON.stringify(join(root,"apps/server/pi-host.ts"))};
    import {snapshotProjectTask} from ${JSON.stringify(join(root,"apps/server/project-task.ts"))};
    const data=${JSON.stringify(data)},sources=${JSON.stringify(sources)},id=${JSON.stringify(id)},kind=${JSON.stringify(kind)};
    const storage=new Storage(data+'/state.sqlite'),host=new PiHost(storage,data,async(sid,type,payload,durable)=>{if(durable)await storage.event(sid,type,payload);});await host.init();
    const call=storage.call.bind(storage);storage.call=async(op,args={})=>{
      if(op==='addSession'&&(kind==='session'||kind==='task'||args.parentId)){
        process.stdout.write(JSON.stringify({data,id,sessionId:args.id,rootId:args.parentId??args.id,cwd:args.cwd})+'\\n');
        await new Promise(()=>{});
      }return call(op,args);
    };
    if(kind==='session')await host.create(sources[0],'sigma-demo/offline',id,'code',{workspaceMode:'worktree'});
    if(kind==='task'){
      let task=await snapshotProjectTask({id:crypto.randomUUID(),name:'Fixture task',folders:sources},'sigma-demo/offline',id,'fixture','worktree');task.roleCatalog=await host.roles();task=await host.prepareProjectTask(task);await storage.call('addProjectTask',task);
      for(const repo of task.repositories)await host.create(repo.sourceCwd,task.model,repo.sessionId,'parallel',{baseCommit:repo.baseCommit,workspaceMode:'worktree',task:{id:task.id,repositoryId:repo.id}});
      await host.createCoordinator(task);
    }
    if(kind==='nested'){await host.create(sources[0],'sigma-demo/offline',id,'parallel',{workspaceMode:'worktree'});await host.prompt(id,'delegate2:small worker result');}
    if(kind==='review'){await host.create(sources[0],'sigma-demo/offline',id,'code',{workspaceMode:'worktree'});await host.startReviewer(id,crypto.randomUUID(),sources[0],'hello',new AbortController().signal);}
  `;
  const script=join(data,"crash-child.mjs");await writeFile(script,code);
  const child=spawn(process.execPath,["--import","tsx",script],{cwd:root,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,HOME:fixture,SIGMA_APPROVAL_MODE:"ask",PI_OFFLINE:"1",SIGMA_DEMO:"1",PI_CODING_AGENT_DIR:join(data,"agent")},stdio:["ignore","pipe","pipe"]});
  let output="",errors="";child.stdout.on("data",chunk=>output+=chunk);child.stderr.on("data",chunk=>errors+=chunk);
  try{await waitFor(async()=>{if(child.exitCode!==null)throw new Error(`Crash child exited before allocation: ${errors}`);return output.includes("\n");},90000);const info=JSON.parse(output.trim());const exited=new Promise(resolve=>child.once("exit",(_code,signal)=>resolve(signal)));child.kill("SIGKILL");assert.equal(await exited,"SIGKILL");await writeFile(join(data,"fixture.json"),JSON.stringify({...info,kind,sources,environment:{SIGMA_APPROVAL_MODE:"ask",PI_OFFLINE:"1",SIGMA_DEMO:"1",PI_CODING_AGENT_DIR:join(data,"agent")}},null,2));return info as {id:string;sessionId:string;rootId:string;data:string;cwd:string};}
  finally{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");}
}
const itemFor=async(host:PiHost,id:string)=>(await host.workspaceRecovery()).find(item=>item.setup?.sessionId===id)!;

test("real worktree allocation survives SIGKILL before registration; inspection and continuation reuse IDs without prompt replay",async()=>{
  const src=await source("single-source"),info=await crash("session",[src]),f=await reopen(info.data);
  try{
    const before=git(src,"worktree","list","--porcelain"),index=await readFile(join(src,".git/index")),base=await readFile(join(info.cwd,"calc.ts"));
    const item=await itemFor(f.host,info.sessionId);assert.equal(item.canContinue,true);assert.equal(item.setup?.phase,"allocated");assert.equal(item.registered,false);assert.equal(item.worktreeRegistered,true);assert.equal(await f.storage.call("session",{id:info.sessionId}),undefined);
    assert.equal(git(src,"worktree","list","--porcelain"),before);assert.deepEqual(await readFile(join(src,".git/index")),index);
    const setup=item.setup!,wrong={...setup,commonIno:setup.commonIno!+1};await f.storage.call("commandSetupUpdate",{id:item.id,from:setup,to:wrong});await assert.rejects(f.host.continueWorkspaceSetup(item.id,item.observedRevision),/identity|observation/);await f.storage.call("commandSetupUpdate",{id:item.id,from:wrong,to:setup});
    await writeFile(join(info.cwd,"calc.ts"),"external change\n");assert.equal((await itemFor(f.host,info.sessionId)).canContinue,false);await assert.rejects(f.host.continueWorkspaceSetup(item.id,item.observedRevision),/base tree|observation/);await writeFile(join(info.cwd,"calc.ts"),base);
    const fresh=await itemFor(f.host,info.sessionId),outcomes=await Promise.allSettled([f.host.continueWorkspaceSetup(fresh.id,fresh.observedRevision),f.host.continueWorkspaceSetup(fresh.id,fresh.observedRevision)]);assert.equal(outcomes.filter(value=>value.status==="fulfilled").length,1,"CAS admits only one explicit continuation");
    const row=await f.storage.call<any>("session",{id:info.sessionId});assert.equal(row.managerId,info.sessionId);assert.equal(row.cwd,info.cwd);assert.deepEqual((await f.host.snapshot(info.sessionId)).messages,[]);assert.equal(git(src,"worktree","list","--porcelain"),before);assert.deepEqual(await readFile(join(src,".git/index")),index);assert.deepEqual(await readFile(join(info.cwd,"calc.ts")),base);
    assert.equal((await f.host.workspaceRecovery()).some(item=>item.setup?.sessionId===info.sessionId||item.id===`workspace:${info.sessionId}`),false,"Registered workspaces are not orphan inventory");
    await f.storage.call("commandStatus",{id:info.id,status:"unknown"});
    const db=new DatabaseSync(join(info.data,"state.sqlite")),original=await f.storage.call<any>("session",{id:info.sessionId});
    for(const mutation of [{model:"sigma-demo/wrong"},{policy:JSON.stringify({...original.policy,effective:{...original.policy.effective,profile:REVIEW_PROFILE}})}]){
      for(const [field,value] of Object.entries(mutation))db.prepare(`UPDATE sessions SET ${field}=? WHERE id=?`).run(value,info.sessionId);
      const mismatch=await itemFor(f.host,info.sessionId);assert.equal(mismatch.canContinue,false);await assert.rejects(f.host.continueWorkspaceSetup(mismatch.id,mismatch.observedRevision),/exact saved setup/);
      db.prepare("UPDATE sessions SET model=?,policy=? WHERE id=?").run(original.model,JSON.stringify(original.policy),info.sessionId);
    }
    db.close();await f.storage.call("commandStatus",{id:info.id,status:"completed"});
    await f.host.archiveOwner(info.sessionId,true);assert.ok((await f.host.snapshot(info.sessionId)).archivedAt);await assert.rejects(f.host.prompt(info.sessionId,"must not run"),/Archived/);await f.host.archiveOwner(info.sessionId,false);assert.equal((await f.host.snapshot(info.sessionId)).archivedAt,null);assert.equal(git(src,"worktree","list","--porcelain"),before);assert.deepEqual(await readFile(join(src,".git/index")),index);
  }finally{await f.close();}
});

test("partial task preflights every frozen source, then allocates only reserved members and coordinator",async()=>{
  const sources=[await source("task-source-one"),await source("task-source-two")],info=await crash("task",sources),f=await reopen(info.data);
  try{
    const task=await f.storage.call<ProjectTaskView>("projectTask",{id:info.id});assert.equal(task.status,"unknown");assert.equal(task.repositories[0].setup?.phase,"allocated");assert.equal(task.repositories[1].setup?.phase,"reserved");assert.equal(task.coordinatorSetup?.phase,"reserved");assert.ok((await f.host.workspaceRecovery()).filter(item=>item.id===info.id).every(item=>item.canContinue),"Allocated first member and exact absent reserved members are explicitly eligible in inventory");
    const before=sources.map(src=>git(src,"worktree","list","--porcelain")),observations=async()=>(await f.host.workspaceRecovery()).filter(item=>item.id===info.id).map(item=>item.observedRevision!);
    await writeFile(join(sources[1],"calc.ts"),"user changed second source\n");git(sources[1],"add","calc.ts");git(sources[1],"commit","-m","Drift fixture");await assert.rejects(f.host.continueProjectTask(info.id,await observations()),/HEAD changed/);assert.deepEqual(sources.map(src=>git(src,"worktree","list","--porcelain")),before.map((value,index)=>index===1?git(sources[1],"worktree","list","--porcelain"):value));assert.equal((await f.host.list()).length,0,"No first member is registered before all sources pass preflight");
    // Explicit fixture construction restores the frozen commit, never production recovery.
    git(sources[1],"checkout","--detach",task.repositories[1].baseCommit);
    await f.host.continueProjectTask(info.id,await observations());
    const current=await f.storage.call<ProjectTaskView>("projectTask",{id:info.id});assert.equal(current.status,"running");
    for(const id of [task.coordinatorId,...task.repositories.map(repo=>repo.sessionId)]){const row=await f.storage.call<any>("session",{id});assert.equal(row.managerId,id);assert.deepEqual((await f.host.snapshot(id)).messages,[]);}
    assert.equal(git(sources[0],"worktree","list","--porcelain"),before[0]);assert.equal(git(sources[1],"worktree","list","--porcelain").match(/^worktree /gm)?.length,2);
    const memberships=sources.map(src=>git(src,"worktree","list","--porcelain"));await f.host.archiveOwner(task.id,true,true);await assert.rejects(f.host.prompt(task.repositories[0].sessionId,"blocked"),/Archived/);await f.host.archiveOwner(task.id,false,true);assert.deepEqual(sources.map(src=>git(src,"worktree","list","--porcelain")),memberships);
  }finally{await f.close();}
});

test("nested and reviewer crash setups preserve their exact role/profile and reject mismatched real history",async()=>{
  for(const kind of ["nested","review"] as const){
    const src=await source(`${kind}-source`),info=await crash(kind,[src]),f=await reopen(info.data);
    try{
      let item=await itemFor(f.host,info.sessionId);assert.equal(item.canContinue,true);assert.equal(item.setup?.rootId,info.id);assert.equal(item.setup?.agentRole,kind==="nested"?"worker":"reviewer");assert.deepEqual(item.setup?.profile,kind==="nested"?NESTED_WORKER_PROFILE:REVIEW_PROFILE);
      await f.host.prompt(info.id,"hello");await waitFor(async()=>(await f.host.snapshot(info.id)).status==="settled");const parent=await f.storage.call<any>("session",{id:info.id}),bad=join(info.data,"sessions",`wrong_${info.sessionId}.jsonl`);await writeFile(bad,await readFile(parent.file));item=await itemFor(f.host,info.sessionId);assert.equal(item.canContinue,false);await assert.rejects(f.host.continueWorkspaceSetup(item.id,item.observedRevision),/header differs/);await rename(bad,`${bad}.invalid-fixture`);
      item=await itemFor(f.host,info.sessionId);const membership=git(src,"worktree","list","--porcelain"),result=await f.host.continueWorkspaceSetup(item.id,item.observedRevision);assert.equal(result.rootId,info.id);assert.equal(result.id,info.sessionId);const child=await f.host.childSnapshot(info.id,info.sessionId);assert.deepEqual(child.policy?.effective.profile,kind==="nested"?NESTED_WORKER_PROFILE:REVIEW_PROFILE);assert.deepEqual(child.messages,[]);assert.equal((await f.storage.call<any>("commandSetupGet",{id:item.id})).status,"reconciled","Recovered setup is not an executed original delegate/review input");assert.equal(git(src,"worktree","list","--porcelain"),membership);
    }finally{await f.close();}
  }
});

test("held setup and dispatch admissions drain under Stop, and archive rejects every pre-insert owner window",async()=>{
  const src=await source("owner-source"),info=await crash("session",[src]),f=await reopen(info.data);
  try{
    const call=f.storage.call.bind(f.storage);let release=()=>{},entered=false;
    f.storage.call=async<T>(op:string,args:Record<string,unknown>={})=>{const result=await call<T>(op,args);if(op==="claimSetupContinuation"){entered=true;await new Promise<void>(r=>release=r);}return result;};
    const item=await itemFor(f.host,info.sessionId),continuation=f.host.continueWorkspaceSetup(item.id,item.observedRevision);const failed=assert.rejects(continuation,/stopped/);await waitFor(async()=>entered);let stopped=false;const stop=f.host.abort(info.sessionId).then(()=>stopped=true);await new Promise(r=>setTimeout(r,20));assert.equal(stopped,false);release();await Promise.all([stop,failed]);assert.equal(await call("session",{id:info.sessionId}),undefined);
    f.storage.call=call;const fresh=await itemFor(f.host,info.sessionId);await f.host.continueWorkspaceSetup(fresh.id,fresh.observedRevision);
    entered=false;f.storage.call=async<T>(op:string,args:Record<string,unknown>={})=>{const result=await call<T>(op,args);if(op==="markSessionDispatch"){entered=true;await new Promise<void>(r=>release=r);}return result;};
    const prompt=f.host.prompt(info.sessionId,"never dispatch"),promptFailed=assert.rejects(prompt,/stopped/);await waitFor(async()=>entered);stopped=false;const stopPrompt=f.host.abort(info.sessionId).then(()=>stopped=true);await new Promise(r=>setTimeout(r,20));assert.equal(stopped,false);release();await Promise.all([stopPrompt,promptFailed]);assert.deepEqual((await f.host.snapshot(info.sessionId)).messages,[]);assert.equal((await call<any>("session",{id:info.sessionId})).dispatchStarted,1);
    f.storage.call=call;
    // Each real owner begins admission before its session read, before any durable pending row exists.
    const verification=new Verification(f.storage,f.host,info.data,async()=>{}),apply=new SourceApply(f.storage,f.host,verification,info.data,async()=>{}),merge=new WorkerMerge(f.storage,f.host,info.data,async()=>{});
    const owners=[()=>verification.prepare(info.sessionId,randomUUID(),"probe.test.mjs",["calc.ts"]),()=>apply.prepare(info.sessionId,randomUUID()),()=>merge.prepare(info.sessionId,randomUUID(),randomUUID()),()=>f.host.gitAction(info.sessionId,"switch",{branch:"main"},randomUUID())];
    for(const owner of owners){
      entered=false;let once=true;f.storage.call=async<T>(op:string,args:Record<string,unknown>={})=>{const result=await call<T>(op,args);if(op==="session"&&once){once=false;entered=true;await new Promise<void>(r=>release=r);}return result;};
      const pending=owner().then(()=>{},()=>{});await waitFor(async()=>entered);await assert.rejects(f.host.archiveOwner(info.sessionId,true),/admitted/);release();await pending;f.storage.call=call;
      // Clear only test-created durable check intent through the public decision boundary.
      for(const check of await call<any[]>("checks",{sessionId:info.sessionId}))if(check.status==="pending")await verification.decide(info.sessionId,check.id,false);
    }
    // Stop during the insert await: no row existed when abortSession took its snapshot.
    entered=false;const lateId=randomUUID();f.storage.call=async<T>(op:string,args:Record<string,unknown>={})=>{if(op==="addCheck"){entered=true;await new Promise<void>(r=>release=r);}return call<T>(op,args);};
    const latePrepare=verification.prepare(info.sessionId,lateId,"probe.test.mjs",["calc.ts"]),lateFailed=assert.rejects(latePrepare,/stopped/);await waitFor(async()=>entered);await verification.abortSession(info.sessionId);stopped=false;const lateStop=f.host.abort(info.sessionId).then(()=>stopped=true);await new Promise(r=>setTimeout(r,20));assert.equal(stopped,false);release();await Promise.all([lateStop,lateFailed]);assert.equal((await call<any>("check",{id:lateId})).status,"cancelled","A row inserted after Stop is terminal and cannot be approved");
    // Stop after durable allocating but before worktree writes: the phase await must not allocate late.
    f.storage.call=call;const stoppedCreateId=randomUUID(),beforeAllocation=git(src,"worktree","list","--porcelain");entered=false;
    f.storage.call=async<T>(op:string,args:Record<string,unknown>={})=>{const result=await call<T>(op,args);if(op==="commandSetupPhase"&&args.id===stoppedCreateId&&args.to==="allocating"){entered=true;await new Promise<void>(r=>release=r);}return result;};
    const create=f.host.create(src,"sigma-demo/offline",stoppedCreateId,"code",{workspaceMode:"worktree"}),createFailed=assert.rejects(create,/stopped/);await waitFor(async()=>entered);stopped=false;const allocationStop=f.host.abort(stoppedCreateId).then(()=>stopped=true);await new Promise(r=>setTimeout(r,20));assert.equal(stopped,false);release();await Promise.all([allocationStop,createFailed]);assert.equal(git(src,"worktree","list","--porcelain"),beforeAllocation);assert.equal(await call("session",{id:stoppedCreateId}),undefined);
    f.storage.call=call;await verification.close();await apply.close();await merge.close();
  }finally{await f.close();}
});
