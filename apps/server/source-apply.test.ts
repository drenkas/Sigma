import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { PiHost } from "./pi-host.js";
import { SourceApply } from "./source-apply.js";
import { Storage } from "./storage.js";
import { Verification } from "./verification.js";

const root=resolve(import.meta.dirname,"../..");
const scratch=join(process.env.SIGMA_TEST_DIR||join(root,".scratch"),`source-apply-${Date.now()}-${process.pid}`);
process.env.PI_OFFLINE="1";process.env.SIGMA_DEMO="1";process.env.PI_CODING_AGENT_DIR=join(scratch,"agent");
const digest=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
const git=(cwd:string,...args:string[])=>execFileSync("git",["-C",cwd,"-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false",...args],{env:{...process.env,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_AUTHOR_NAME:"Fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"Fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid"}}).toString().trim();
async function waitFor<T>(read:()=>Promise<T|false>,ms=120000){const end=Date.now()+ms;while(Date.now()<end){const value=await read();if(value)return value;await new Promise(r=>setTimeout(r,35));}throw new Error("Timed out waiting for fixture outcome");}

test("source Apply keeps unrelated source/index data and rejects stale or dirty targets",async()=>{
  const source=join(scratch,"source"),data=join(scratch,"data");await mkdir(source,{recursive:true});await mkdir(data);
  git(source,"init","-q","-b","main");
  await writeFile(join(source,"sum.mjs"),"export const sum=(a,b)=>a-b;\n");
  await writeFile(join(source,"sum.test.mjs"),"import {test} from 'node:test'; import assert from 'node:assert/strict'; import {sum} from './sum.mjs'; test('sum',()=>assert.equal(sum(2,3),5));\n");
  await writeFile(join(source,"note.txt"),"before\n");await writeFile(join(source,"staged.txt"),"base\n");await writeFile(join(source,"dirty.txt"),"base\n");
  git(source,"add","--",".");git(source,"commit","-qm","base");
  await writeFile(join(source,"staged.txt"),"staged change\n");git(source,"add","--","staged.txt");
  await writeFile(join(source,"dirty.txt"),"unstaged change\n");await writeFile(join(source,"untracked.txt"),"untracked\n");
  const storage=new Storage(join(data,"state.sqlite"));let host:PiHost;
  const send=async(id:string,type:string,payload:unknown,durable?:boolean)=>{if(durable)await storage.event(id,type,payload);};
  host=new PiHost(storage,data,send);await host.init();
  const verification=new Verification(storage,host,data,send),apply=new SourceApply(storage,host,verification,data,send);
  try{
    const sid=await host.create(source,"sigma-demo/offline",crypto.randomUUID(),"code",{workspaceMode:"worktree"});
    const change=async(prompt:string)=>{
      await host.prompt(sid,prompt);
      const approval=await waitFor(async()=>{const row=await host.snapshot(sid);return row.approvals.find(a=>a.status==="pending"&&a.change)||false;});
      await host.decide(sid,approval.id,true);
      await waitFor(async()=>{const row=await host.snapshot(sid);return row.status==="settled"&&row.approvals.find(a=>a.id===approval.id)?.outcome==="applied";});
    };
    await change('edit:{"path":"sum.mjs","edits":[{"oldText":"a-b","newText":"a+b"}]}');
    await change('write:{"path":"note.txt","content":"after\\n"}');
    await change('write:{"path":"added.txt","content":"new file\\n"}');
    const check=await verification.prepare(sid,crypto.randomUUID(),"sum.test.mjs",["sum.mjs"]);
    await verification.decide(sid,check.id,true);
    await waitFor(async()=>{const row=(await verification.evidence(sid)).checks.find(c=>c.id===check.id);return row?.status==="passed"?row:false;});
    const reviewer=await verification.review(sid,check.id);
    await waitFor(async()=>{const row=(await verification.evidence(sid)).reviews.find(r=>r.id===reviewer.id);return row?.status==="completed"?row:false;});

    const denied=await apply.prepare(sid,crypto.randomUUID());assert.equal(denied.files.length,3);await apply.decide(sid,denied.id,false);
    assert.match(await readFile(join(source,"sum.mjs"),"utf8"),/a-b/);
    const branch=await apply.prepare(sid,crypto.randomUUID());git(source,"branch","same-oid");git(source,"switch","-q","same-oid");
    await assert.rejects(apply.decide(sid,branch.id,true),/branch or HEAD changed/);
    git(source,"switch","-q","main");
    const late=await apply.prepare(sid,crypto.randomUUID());await writeFile(join(source,"sum.mjs"),"external edit\n");
    await assert.rejects(apply.decide(sid,late.id,true),/dirty or staged|changed/);
    await writeFile(join(source,"sum.mjs"),"export const sum=(a,b)=>a-b;\n");
    const mid=await apply.prepare(sid,crypto.randomUUID()),originalSnapshot=host.snapshot.bind(host);
    let switched=false;
    host.snapshot=async (...args)=>{
      const state=await storage.call<{files:{status:string}[]}|undefined>("sourceApply",{id:mid.id});
      if(!switched&&state?.files.some(file=>file.status==="applying")){
        switched=true;git(source,"switch","-q","same-oid");
      }
      return originalSnapshot(...args);
    };
    try{
      await apply.decide(sid,mid.id,true);
      const conflict=await waitFor(async()=>{const row=(await apply.evidence(sid)).find(x=>x.id===mid.id);return row&&!["pending","approved","running"].includes(row.status)?row:false;});
      assert.equal(switched,true);assert.equal(conflict.status,"conflict",conflict.error);
      assert.match(await readFile(join(source,"sum.mjs"),"utf8"),/a-b/);
    }finally{host.snapshot=originalSnapshot;git(source,"switch","-q","main");}
    git(source,"update-index","--assume-unchanged","sum.mjs");await writeFile(join(source,"sum.mjs"),"hidden edit\n");
    assert.equal(git(source,"status","--porcelain","--","sum.mjs"),"");
    await assert.rejects(apply.prepare(sid,crypto.randomUUID()),/content changed/);
    await writeFile(join(source,"sum.mjs"),"export const sum=(a,b)=>a-b;\n");git(source,"update-index","--no-assume-unchanged","sum.mjs");

    const closingApply=new SourceApply(storage,host,verification,data,send),heldApproval=await closingApply.prepare(sid,crypto.randomUUID());
    let releaseApproval!:()=>void,enteredApproval!:()=>void;const approvalGate=new Promise<void>(r=>releaseApproval=r),approvalEntered=new Promise<void>(r=>enteredApproval=r);
    const originalCall=storage.call.bind(storage);let holdApproval=true;
    storage.call=((op:string,args:Record<string,unknown>={})=>op==="sourceApplyTransition"&&args.from==="pending"&&args.to==="approved"&&holdApproval
      ?(holdApproval=false,enteredApproval(),approvalGate.then(()=>originalCall(op,args)))
      :originalCall(op,args)) as typeof storage.call;
    try{
      const allowing=closingApply.decide(sid,heldApproval.id,true);await approvalEntered;
      const closing=closingApply.close();await new Promise<void>(resolve=>setImmediate(resolve));
      assert.match(await readFile(join(source,"sum.mjs"),"utf8"),/a-b/);
      releaseApproval();await Promise.all([closing,assert.rejects(allowing,/shutting down/)]);
      assert.equal((await storage.call<{status:string}>("sourceApply",{id:heldApproval.id})).status,"cancelled");
      assert.match(await readFile(join(source,"sum.mjs"),"utf8"),/a-b/);
    }finally{releaseApproval();storage.call=originalCall;await closingApply.close();}

    let failApprovalEvent=false;
    const notifyingApply=new SourceApply(storage,host,verification,data,async(id,type,payload,durable)=>{
      if(failApprovalEvent&&type==="source_apply_changed"&&(payload as {status?:string}).status==="approved")throw new Error("event journal unavailable");
      if(durable)await storage.event(id,type,payload);
    });
    const notificationFailure=await notifyingApply.prepare(sid,crypto.randomUUID());failApprovalEvent=true;
    await assert.rejects(notifyingApply.decide(sid,notificationFailure.id,true),/event journal unavailable/);
    await notifyingApply.close();assert.equal((await storage.call<{status:string}>("sourceApply",{id:notificationFailure.id})).status,"cancelled");
    assert.match(await readFile(join(source,"sum.mjs"),"utf8"),/a-b/);

    const clean=await apply.prepare(sid,crypto.randomUUID());
    const unrelated={index:digest(await readFile(join(source,".git/index"))),staged:digest(await readFile(join(source,"staged.txt"))),dirty:digest(await readFile(join(source,"dirty.txt"))),untracked:digest(await readFile(join(source,"untracked.txt")))};
    const priorUmask=process.umask(0o077);
    try{await apply.decide(sid,clean.id,true);await waitFor(async()=>{const row=(await apply.evidence(sid)).find(x=>x.id===clean.id);return row?.status==="applied"?row:false;});}
    finally{process.umask(priorUmask);}
    assert.match(await readFile(join(source,"sum.mjs"),"utf8"),/a\+b/);
    assert.equal(await readFile(join(source,"note.txt"),"utf8"),"after\n");
    assert.equal(await readFile(join(source,"added.txt"),"utf8"),"new file\n");
    assert.equal((await stat(join(source,"sum.mjs"))).mode&0o777,0o644);
    assert.equal((await stat(join(source,"note.txt"))).mode&0o777,0o644);
    assert.equal((await stat(join(source,"added.txt"))).mode&0o777,0o644);
    assert.deepEqual({index:digest(await readFile(join(source,".git/index"))),staged:digest(await readFile(join(source,"staged.txt"))),dirty:digest(await readFile(join(source,"dirty.txt"))),untracked:digest(await readFile(join(source,"untracked.txt")))},unrelated);
    assert.equal((await apply.evidence(sid)).find(x=>x.id===clean.id)?.files.every(f=>f.status==="applied"),true);
  }finally{await apply.close();await verification.close();await host.close();await storage.close();}
});

test("Source Apply stops between files and recovers an uncertain intent without replay",async()=>{
  const source=join(scratch,"partial-source"),data=join(scratch,"partial-data");await mkdir(source,{recursive:true});await mkdir(data);
  git(source,"init","-q","-b","main");
  await writeFile(join(source,"a.mjs"),"export const a=1;\n");await writeFile(join(source,"b.mjs"),"export const b=1;\n");
  await writeFile(join(source,"sum.test.mjs"),"import {test} from 'node:test'; import assert from 'node:assert/strict'; import {a} from './a.mjs'; import {b} from './b.mjs'; test('sum',()=>assert.equal(a+b,4));\n");
  git(source,"add","--",".");git(source,"commit","-qm","base");
  const storage=new Storage(join(data,"state.sqlite"));let apply:SourceApply,stopId="";
  const send=async(id:string,type:string,payload:unknown,durable?:boolean)=>{
    if(durable)await storage.event(id,type,payload);
    const change=payload as {id?:string;path?:string};
    if(type==="source_apply_changed"&&change.id===stopId&&change.path==="a.mjs"){
      void apply.abort(id,stopId).catch(()=>{});
      await waitFor(async()=>Boolean((apply as unknown as {active:Map<string,{cancelled:boolean}>}).active.get(stopId)?.cancelled));
    }
  };
  const host=new PiHost(storage,data,send);await host.init();
  const verification=new Verification(storage,host,data,send);apply=new SourceApply(storage,host,verification,data,send);
  try{
    const sid=await host.create(source,"sigma-demo/offline",crypto.randomUUID(),"code",{workspaceMode:"worktree"});
    for(const path of ["a.mjs","b.mjs"]){
      await host.prompt(sid,`edit:{"path":"${path}","edits":[{"oldText":"=1","newText":"=2"}]}`);
      const approval=await waitFor(async()=>{const row=await host.snapshot(sid);return row.approvals.find(a=>a.status==="pending"&&a.change?.path===path)||false;});
      await host.decide(sid,approval.id,true);
      await waitFor(async()=>{const row=await host.snapshot(sid);return row.approvals.find(a=>a.id===approval.id)?.outcome==="applied"?true:false;});
    }
    const check=await verification.prepare(sid,crypto.randomUUID(),"sum.test.mjs",["a.mjs","b.mjs"]);await verification.decide(sid,check.id,true);
    await waitFor(async()=>{const row=(await verification.evidence(sid)).checks.find(x=>x.id===check.id);return row?.status==="passed"?row:false;});
    const review=await verification.review(sid,check.id);
    await waitFor(async()=>{const row=(await verification.evidence(sid)).reviews.find(x=>x.id===review.id);return row?.status==="completed"?row:false;});
    const proposed=await apply.prepare(sid,crypto.randomUUID());stopId=proposed.id;await apply.decide(sid,proposed.id,true);
    const partial=await waitFor(async()=>{const row=(await apply.evidence(sid)).find(x=>x.id===proposed.id);return row?.status==="partial"?row:false;});
    assert.equal(partial.files[0].status,"applied");
    assert.notEqual(partial.files[1].status,"applied");
    assert.equal(await readFile(join(source,"a.mjs"),"utf8"),"export const a=2;\n");
    assert.equal(await readFile(join(source,"b.mjs"),"utf8"),"export const b=1;\n");
    const recoveryPath=join(data,"recovery.sqlite"),crash=new Storage(recoveryPath);
    const uncertain={...partial,id:crypto.randomUUID(),sourceCwd:join(data,"unrelated-fixture"),status:"running",files:partial.files.map(file=>file.path==="b.mjs"?{...file,status:"applying"}:file)};
    const owner=await storage.call<any>("session",{id:sid});await crash.call("addSession",owner);
    await crash.call("addSourceApply",uncertain);await crash.close();
    const resumed=new Storage(recoveryPath);
    try{
      const recovered=await resumed.call<{status:string;files:{status:string}[]}>("sourceApply",{id:uncertain.id});
      assert.equal(recovered.status,"unknown");assert.deepEqual(recovered.files.map(file=>file.status),["applied","unknown"]);
      assert.equal(await readFile(join(source,"b.mjs"),"utf8"),"export const b=1;\n");
    }finally{await resumed.close();}
  }finally{await apply.close();await verification.close();await host.close();await storage.close();}
});

test("Source Apply close drains the published final file until its durable receipt settles",async()=>{
  const dir=join(scratch,"publish-receipt-drain"),source=join(dir,"source"),worktree=join(dir,"worktree"),data=join(dir,"data"),sessionId=crypto.randomUUID();
  await mkdir(source,{recursive:true});await mkdir(data);git(source,"init","-q","-b","main");await writeFile(join(source,"last.mjs"),"export const last=1;\n");git(source,"add","--","last.mjs");git(source,"commit","-qm","base");
  const head=git(source,"rev-parse","HEAD");git(source,"worktree","add","--detach",worktree,head);await writeFile(join(worktree,"last.mjs"),"export const last=2;\n");
  const storage=new Storage(join(data,"state.sqlite")),host=Object.assign(new PiHost(storage,data,async()=>{}),{repositoryCode:async()=>({id:sessionId,status:"settled",policy:{workspace:{kind:"worktree",sourceCwd:source,baseCommit:head}}}),changes:async()=>({cwd:worktree,sourceCwd:source,baseCommit:head,revision:"receipt-revision",diff:"fixture",files:["last.mjs"],omitted:false}),snapshot:async()=>({cwd:worktree,status:"settled"})});
  const verification={evidence:async()=>({revision:"receipt-revision",checks:[{id:"check",current:true,status:"passed"}],reviews:[{id:"review",checkId:"check",current:true,status:"completed"}]})} as unknown as Verification;
  const send=async(id:string,type:string,payload:unknown,durable?:boolean)=>{if(durable)await storage.event(id,type,payload);},apply=new SourceApply(storage,host,verification,data,send);
  let release!:()=>void,published!:()=>void;const receiptHeld=new Promise<void>(resolve=>release=resolve),atPublish=new Promise<void>(resolve=>published=resolve);
  const internals=storage as unknown as {call:(op:string,args?:any)=>Promise<any>},original=storage.call.bind(storage);
  internals.call=async(op,args={})=>{if(op==="sourceApplyFile"&&args.from==="applying"&&args.to==="applied"&&args.path==="last.mjs"){published();await receiptHeld;}return original(op,args);};
  const applyId=crypto.randomUUID();
  try{
    await storage.call("addSession",{id:sessionId,cwd:worktree,file:join(data,"fixture-history"),model:"sigma-demo/offline"});
    await apply.prepare(sessionId,applyId);await apply.decide(sessionId,applyId,true);await atPublish;
    assert.equal(await readFile(join(source,"last.mjs"),"utf8"),"export const last=2;\n","filesystem publication precedes the held receipt");
    let closeSettled=false;const closing=apply.close().finally(()=>{closeSettled=true;});
    await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(closeSettled,false,"close drains the in-flight post-publish receipt");
    const held=await original<any>("sourceApply",{id:applyId});assert.equal(held.status,"running");assert.equal(held.files[0].status,"applying");
    release();await closing;
    const settled=await original<any>("sourceApply",{id:applyId});assert.equal(settled.status,"applied");assert.equal(settled.files[0].status,"applied");
    assert.ok((await original<any[]>("events",{sessionId})).some(event=>event.type==="source_apply_changed"&&event.payload.status==="applied"));
  }finally{release();await apply.close();await storage.close();}
});

test("Source Apply crash after publication reconciles exact fresh observations and continues without replay",async()=>{
  const dir=join(scratch,"publish-crash"),source=join(dir,"source"),worktree=join(dir,"worktree"),data=join(dir,"data"),marker=join(dir,"published");
  await mkdir(source,{recursive:true});await mkdir(data);git(source,"init","-q","-b","main");
  await writeFile(join(source,"a.mjs"),"export const a=1;\n",{mode:0o755});await writeFile(join(source,"b.mjs"),"export const b=1;\n");
  await writeFile(join(source,"staged.txt"),"base\n");await writeFile(join(source,"dirty.txt"),"base\n");
  git(source,"add","--",".");git(source,"commit","-qm","base");
  await writeFile(join(source,"staged.txt"),"staged\n");git(source,"add","--","staged.txt");await writeFile(join(source,"dirty.txt"),"dirty\n");await writeFile(join(source,"untracked.txt"),"untracked\n");
  const head=git(source,"rev-parse","HEAD");git(source,"worktree","add","--detach",worktree,head);
  await writeFile(join(worktree,"a.mjs"),"export const a=2;\n",{mode:0o755});await writeFile(join(worktree,"b.mjs"),"export const b=2;\n");await writeFile(join(worktree,"added.mjs"),"export const added=3;\n");
  const root=resolve(import.meta.dirname,"../.."),fixture=join(dir,"publish-crash.mjs");
  await writeFile(fixture,`import {pathToFileURL} from 'node:url';import {join} from 'node:path';
const root=process.env.SIGMA_ROOT;const {Storage}=await import(pathToFileURL(join(root,'apps/server/storage.ts')).href);const {SourceApply}=await import(pathToFileURL(join(root,'apps/server/source-apply.ts')).href);const {PiHost}=await import(pathToFileURL(join(root,'apps/server/pi-host.ts')).href);
const source=process.env.SIGMA_SOURCE,worktree=process.env.SIGMA_WORKTREE,data=process.env.SIGMA_DATA,marker=process.env.SIGMA_MARKER,head=process.env.SIGMA_HEAD,sessionId=process.env.SIGMA_SESSION;
const storage=new Storage(join(data,'state.sqlite')),baseCommit=head,files=['a.mjs','b.mjs','added.mjs'];const host=Object.assign(new PiHost(storage,data,async()=>{}),{repositoryCode:async()=>({id:sessionId,status:'settled',policy:{workspace:{kind:'worktree',sourceCwd:source,baseCommit}}}),changes:async()=>({cwd:worktree,sourceCwd:source,baseCommit,revision:'fixture-revision',diff:'fixture diff',files,omitted:false}),snapshot:async()=>({cwd:worktree,status:'settled'})});await storage.call('addSession',{id:sessionId,cwd:worktree,file:join(data,'fixture-history'),model:'sigma-demo/offline'});const verification={evidence:async()=>({revision:'fixture-revision',checks:[{id:'check',current:true,status:'passed'}],reviews:[{id:'review',checkId:'check',current:true,status:'completed'}]})};const send=async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);};const apply=new SourceApply(storage,host,verification,data,send);const call=storage.call.bind(storage);storage.call=async(op,args={})=>{if(op==='sourceApplyFile'&&args.from==='applying'&&args.to==='applied'&&args.path==='a.mjs'){await (await import('node:fs/promises')).writeFile(marker,'published');await new Promise(()=>{});}return call(op,args);};await apply.prepare(sessionId,process.env.SIGMA_APPLY);await apply.decide(sessionId,process.env.SIGMA_APPLY,true);setInterval(()=>{},1000);
`);
  const beforeIndex=await readFile(join(source,".git/index")),beforeIndexEntries=git(source,"ls-files","--stage"),baseAoid=git(source,"rev-parse","HEAD:a.mjs"),beforeStaged=await readFile(join(source,"staged.txt")),beforeDirty=await readFile(join(source,"dirty.txt")),beforeUntracked=await readFile(join(source,"untracked.txt"));
  const applyId=crypto.randomUUID(),sessionId=crypto.randomUUID(),child=spawn(process.execPath,["--import","tsx",fixture],{cwd:root,env:{PATH:process.env.PATH,HOME:dir,TMPDIR:dir,SIGMA_ROOT:root,SIGMA_SOURCE:source,SIGMA_WORKTREE:worktree,SIGMA_DATA:data,SIGMA_MARKER:marker,SIGMA_HEAD:head,SIGMA_SESSION:sessionId,SIGMA_APPLY:applyId},stdio:["ignore","ignore","pipe"]});
  let stderr="";child.stderr?.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-2000);});
  try{
    await waitFor(async()=>{if(child.exitCode!==null||child.signalCode!==null)throw new Error(`Crash fixture exited early: ${stderr}`);try{return await readFile(marker,"utf8")==="published";}catch{return false;}});
    child.kill("SIGKILL");await new Promise<void>(resolve=>child.once("exit",()=>resolve()));
    assert.equal(await readFile(join(source,"a.mjs"),"utf8"),"export const a=2;\n","publication reached disk before the durable file receipt");
    assert.equal(await readFile(join(source,"b.mjs"),"utf8"),"export const b=1;\n");
    const visibleFiles=["a.mjs","b.mjs","added.mjs"],storage=new Storage(join(data,"state.sqlite")),host=Object.assign(new PiHost(storage,data,async()=>{}),{repositoryCode:async()=>({id:sessionId,status:'settled',policy:{workspace:{kind:'worktree',sourceCwd:source,baseCommit:head}}}),changes:async()=>({cwd:worktree,sourceCwd:source,baseCommit:head,revision:'fixture-revision',diff:'fixture diff',files:visibleFiles,omitted:false}),snapshot:async()=>({cwd:worktree,status:'settled'})});
    const verification={evidence:async()=>({revision:'fixture-revision',checks:[{id:'check',current:true,status:'passed'}],reviews:[{id:'review',checkId:'check',current:true,status:'completed'}]})} as unknown as Verification,send=async(id:string,type:string,payload:unknown,durable?:boolean)=>{if(durable)await storage.event(id,type,payload);},apply=new SourceApply(storage,host,verification,data,send);
    try{
      const uncertain=(await storage.call<any>("sourceApply",{id:applyId}));assert.equal(uncertain.status,"unknown");assert.equal(uncertain.files[0].status,"unknown");
      const observed=(await apply.evidence(sessionId)).find(row=>row.id===applyId)!;assert.equal(observed.files[0].observation,"after");assert.equal(observed.files[1].observation,"before");assert.equal(observed.files[2].observation,"before");assert.equal(observed.files[2].observedMode,null);
      const ack={acknowledge:true as const,sourceCwd:source,files:observed.files.map(({path,observedHash,observedMode,observation})=>({path,observedHash:observedHash!,observedMode:observedMode??null,observation:observation!}))};
      const rejected=async(value:any)=>{const prior=await storage.call<any>("sourceApply",{id:applyId});await assert.rejects(apply.reconcile(sessionId,applyId,value));assert.deepEqual(await storage.call<any>("sourceApply",{id:applyId}),prior,"rejected acknowledgement does not mutate recovery state");};
      await rejected({...ack,sourceCwd:worktree});await rejected({...ack,files:ack.files.slice(1)});await rejected({...ack,files:[...ack.files,ack.files[0]]});await rejected({...ack,files:ack.files.map((file,index)=>index?file:{...file,path:"wrong.mjs"})});await rejected({...ack,files:ack.files.map((file,index)=>index?file:{...file,observedHash:"stale"})});await rejected({...ack,files:ack.files.map((file,index)=>index?file:{...file,observedMode:0o600})});
      const prior=await storage.call<any>("sourceApply",{id:applyId});await assert.rejects(apply.reconcile(crypto.randomUUID(),applyId,ack));assert.deepEqual(await storage.call<any>("sourceApply",{id:applyId}),prior);
      assert.deepEqual(await readFile(join(source,".git/index")),beforeIndex);assert.equal(await readFile(join(source,"a.mjs"),"utf8"),"export const a=2;\n");assert.equal(await readFile(join(source,"b.mjs"),"utf8"),"export const b=1;\n");
      const clone=join(dir,"replacement"),original=join(dir,"original");git(source,"clone",source,clone);await writeFile(join(clone,"a.mjs"),"export const a=2;\n",{mode:0o755});
      await rename(source,original);await rename(clone,source);await assert.rejects(apply.reconcile(sessionId,applyId,ack),/Git identity/);await rename(source,clone);await rename(original,source);await rm(clone,{recursive:true,force:true});
      const reconciled=await apply.reconcile(sessionId,applyId,ack);assert.equal(reconciled.status,"reconciled");assert.equal(reconciled.current,true,"a missing new file remains a fresh before observation");
      git(source,"update-index","--cacheinfo",`100644,${baseAoid},a.mjs`);const modeOnlyIndex=await readFile(join(source,".git/index"));
      await assert.rejects(apply.prepare(sessionId,crypto.randomUUID()),/Source index changed/);
      assert.deepEqual(await readFile(join(source,".git/index")),modeOnlyIndex,"mode-only staged changes are preserved on rejection");
      git(source,"update-index","--cacheinfo",`100755,${baseAoid},a.mjs`);assert.equal(git(source,"ls-files","--stage"),beforeIndexEntries);const restoredIndex=await readFile(join(source,".git/index"));
      const continuation=await apply.prepare(sessionId,crypto.randomUUID());assert.deepEqual(continuation.files.map(file=>file.status),["applied","waiting","waiting"]);await apply.decide(sessionId,continuation.id,true);
      await waitFor(async()=>{const row=(await apply.evidence(sessionId)).find(item=>item.id===continuation.id);return row?.status==="applied"?row:false;});
      assert.equal(await readFile(join(source,"a.mjs"),"utf8"),"export const a=2;\n");assert.equal((await stat(join(source,"a.mjs"))).mode&0o777,0o755);
      assert.equal(await readFile(join(source,"b.mjs"),"utf8"),"export const b=2;\n");assert.equal(await readFile(join(source,"added.mjs"),"utf8"),"export const added=3;\n");
      assert.deepEqual(await readFile(join(source,".git/index")),restoredIndex,"Apply preserves index bytes after the deliberate mode-only fixture mutation is restored");assert.equal(git(source,"ls-files","--stage"),beforeIndexEntries);assert.deepEqual(await readFile(join(source,"staged.txt")),beforeStaged);assert.deepEqual(await readFile(join(source,"dirty.txt")),beforeDirty);assert.deepEqual(await readFile(join(source,"untracked.txt")),beforeUntracked);
      visibleFiles.splice(0,visibleFiles.length,"a.mjs");const sourceAfter=await readFile(join(source,"a.mjs")),indexAfter=await readFile(join(source,".git/index"));
      await assert.rejects(apply.prepare(sessionId,crypto.randomUUID()),/dirty or staged/,"an old acknowledgement for a is stale when any other observed path changed");
      assert.deepEqual(await readFile(join(source,"a.mjs")),sourceAfter);assert.deepEqual(await readFile(join(source,".git/index")),indexAfter);
      assert.equal((await apply.evidence(sessionId)).find(row=>row.id===applyId)?.current,false,"later source changes stale the stored crash observations");
    }finally{await apply.close();await storage.close();}
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill("SIGKILL");await new Promise<void>(resolve=>child.once("exit",()=>resolve()));}}
});

test("Source Apply no longer requires a passed check or review and reports the unverified revision",async()=>{
  const dir=join(scratch,"unverified"),source=join(dir,"source"),worktree=join(dir,"worktree"),data=join(dir,"data"),sessionId=crypto.randomUUID();
  await mkdir(source,{recursive:true});await mkdir(data);git(source,"init","-q","-b","main");await writeFile(join(source,"u.mjs"),"export const u=1;\n");git(source,"add","--","u.mjs");git(source,"commit","-qm","base");
  const head=git(source,"rev-parse","HEAD");git(source,"worktree","add","--detach",worktree,head);await writeFile(join(worktree,"u.mjs"),"export const u=2;\n");
  const storage=new Storage(join(data,"state.sqlite")),host=Object.assign(new PiHost(storage,data,async()=>{}),{repositoryCode:async()=>({id:sessionId,status:"settled",policy:{workspace:{kind:"worktree",sourceCwd:source,baseCommit:head}}}),changes:async()=>({cwd:worktree,sourceCwd:source,baseCommit:head,revision:"r1",diff:"fixture",files:["u.mjs"],omitted:false}),snapshot:async()=>({cwd:worktree,status:"settled"})});
  let proof:any={revision:"r1",checks:[],reviews:[]};
  const verification={evidence:async()=>proof} as unknown as Verification,send=async(id:string,type:string,payload:unknown,durable?:boolean)=>{if(durable)await storage.event(id,type,payload);},apply=new SourceApply(storage,host,verification,data,send);
  try{
    await storage.call("addSession",{id:sessionId,cwd:worktree,file:join(data,"fixture-history"),model:"sigma-demo/offline"});
    const view=await apply.prepare(sessionId,crypto.randomUUID());assert.deepEqual(view.verified,{check:false,review:false});
    proof={revision:"r1",checks:[{id:"c",current:true,status:"passed"}],reviews:[]};
    assert.deepEqual((await apply.evidence(sessionId))[0].verified,{check:true,review:false});
    await apply.decide(sessionId,view.id,true);await waitFor(async()=>await readFile(join(source,"u.mjs"),"utf8")==="export const u=2;\n");await waitFor(async()=>(await storage.call<any>("sourceApply",{id:view.id})).status==="applied");
    proof={revision:"stale",checks:[],reviews:[]};await assert.rejects(apply.prepare(sessionId,crypto.randomUUID()),/unavailable/,"Stale evidence is still refused");
  }finally{await apply.close();await host.close();await storage.close();}
});
