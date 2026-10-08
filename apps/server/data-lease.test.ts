import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, openSync, closeSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root=resolve(import.meta.dirname,"../..");
const scratch=join(root,".scratch");
const pause=()=>new Promise(resolve=>setTimeout(resolve,30));
async function waitFor(check:()=>boolean|Promise<boolean>,label:string){
  const deadline=Date.now()+30_000;
  while(Date.now()<deadline){if(await check())return;await pause();}
  throw new Error(`Timed out: ${label}`);
}
async function freePort(){const server=createServer();await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const port=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
function launch(data:string,port:number,preload?:string,extra:Record<string,string>={},fd?:number){
  const child=spawn(process.execPath,["--import","tsx",...(preload?["--import",preload]:[]),"apps/server/main.ts"],{
    cwd:root,env:{...environment(data,port),...extra},stdio:["pipe","pipe","pipe",...(fd===undefined?[]:[fd])],
  });
  return observe(child);
}
function environment(data:string,port:number){return {PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,HOME:join(data,"home"),PI_CODING_AGENT_DIR:join(data,"sdk"),SIGMA_APPROVAL_MODE:"ask",PI_OFFLINE:"1",SIGMA_DEMO:"1",SIGMA_DATA_DIR:data,SIGMA_PORT:String(port),SIGMA_PARENT_WATCH:"1"};}
function observe(child:ChildProcess){
  const observed={child,ready:false,output:""};
  for(const stream of [child.stdout,child.stderr])stream?.on("data",bytes=>{observed.output=(observed.output+String(bytes)).slice(-4000);observed.ready||=observed.output.includes("Sigma API listening on");});
  return observed;
}
type Launch=ReturnType<typeof observe>;
const exited=(run:Launch)=>run.child.exitCode!==null||run.child.signalCode!==null;
async function ready(run:Launch){await waitFor(()=>{assert.equal(exited(run),false,run.output);return run.ready;},"server readiness");}
async function stop(run:Launch,signal?:NodeJS.Signals){if(exited(run))return;if(signal)run.child.kill(signal);else run.child.stdin!.end();await waitFor(()=>exited(run),"owned process exit");}
async function rejected(run:Launch){
  try{await waitFor(()=>run.ready||exited(run),"contender rejection");assert.equal(run.ready,false,"Second owner must fail before readiness");assert.notEqual(run.child.exitCode,0);assert.match(run.output,/DATA_DIR.*already owned/);}
  finally{await stop(run);}
}
async function client(port:number){
  const origin=`http://127.0.0.1:${port}`;
  const boot=await fetch(`${origin}/api/bootstrap`,{method:"POST",headers:{origin}});assert.equal(boot.status,200);
  const cookie=boot.headers.get("set-cookie")!.split(";")[0];
  return async(path:string,method="GET",body?:unknown,id?:string)=>{
    const response=await fetch(`${origin}/api${path}`,{method,headers:{origin,cookie,...(body?{"content-type":"application/json"}:{}),...(id?{"x-command-id":id}:{})},body:body?JSON.stringify(body):undefined});
    assert.equal(response.status,200,`${method} ${path}`);return response.json() as Promise<any>;
  };
}
function state(data:string,session:string,command:string){
  const db=new DatabaseSync(join(data,"state.sqlite"),{readOnly:true});
  try{return {session:db.prepare("SELECT status FROM sessions WHERE id=?").get(session),approvals:db.prepare("SELECT id,status FROM approvals WHERE session_id=? ORDER BY id").all(session),command:db.prepare("SELECT status FROM commands WHERE id=?").get(command),events:db.prepare("SELECT COUNT(*) AS count FROM events WHERE session_id=?").get(session)};}
  finally{db.close();}
}
function git(data:string,...args:string[]){
  const result=spawnSync("git",["-c","core.hooksPath=/dev/null",...args],{cwd:data,env:{PATH:process.env.PATH,HOME:data,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_AUTHOR_NAME:"Fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"Fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid"},encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);return result.stdout.trim();
}
async function gitFixture(data:string){
  await writeFile(join(data,".gitignore"),"*\n!.gitignore\n");git(data,"init","-b","with-lock");git(data,"add",".gitignore");git(data,"commit","-m","synthetic fixture baseline");
}

test("DATA_DIR contenders cannot recover a live session; crash admits one owner without replay",async()=>{
  await mkdir(scratch,{recursive:true});const data=await mkdtemp(join(scratch,"data-owner-")),port=await freePort();
  const file=join(data,"workspace","view.txt");await mkdir(join(data,"workspace"));await writeFile(file,"harmless fixture");
  let owner=launch(data,port);
  try{
    await ready(owner);const req=await client(port),session=crypto.randomUUID(),command=crypto.randomUUID();
    await req("/sessions","POST",{cwd:join(data,"workspace"),model:"sigma-demo/offline"},session);
    await req(`/sessions/${session}/prompt`,"POST",{text:"read:view.txt"},command);
    await waitFor(async()=>{const snapshot=await req(`/sessions/${session}`);return snapshot.approvals.some((approval:any)=>approval.status==="pending");},"actual pending approval");
    const before=state(data,session,command);assert.equal(before.session!.status,"running");assert.equal(before.command!.status,"dispatched");assert.equal(before.approvals[0].status,"pending");
    const alias=join(data,"alias");await symlink(data,alias,"dir");
    for(const [directory,contenderPort] of [[data,port],[data,await freePort()],[alias,await freePort()]] as const){
      const contender=launch(directory,contenderPort);
      try{
        await waitFor(()=>contender.ready||exited(contender),"second launch outcome");
        assert.deepEqual(state(data,session,command),before,"A second launch must not run recovery against the live owner");
        await rejected(contender);
      }finally{await stop(contender);}
    }
    await stop(owner,"SIGKILL");
    const replacements=[launch(data,port),launch(data,await freePort())];
    try{
      await waitFor(()=>replacements.every(run=>run.ready||exited(run)),"simultaneous crash replacements");
      assert.equal(replacements.filter(run=>run.ready).length,1,"Only one replacement may recover after crash");
      owner=replacements.find(run=>run.ready)!;await rejected(replacements.find(run=>!run.ready)!);
    }catch(error){for(const run of replacements)await stop(run);throw error;}
    const recovered=state(data,session,command);assert.equal(recovered.session!.status,"interrupted");assert.equal(recovered.approvals[0].status,"expired");assert.equal(recovered.command!.status,"unknown");
    const actualPort=Number(owner.output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)![1]);
    const after=await client(actualPort),snapshot=await after(`/sessions/${session}`);assert.equal(snapshot.approvals.some((approval:any)=>approval.status==="pending"),false);
    const db=new DatabaseSync(join(data,"state.sqlite"),{readOnly:true});const historyPath=db.prepare("SELECT file FROM sessions WHERE id=?").get(session)!.file as string;db.close();
    const historyBefore=await readFile(historyPath,"utf8");
    const duplicate=await after(`/sessions/${session}/prompt`,"POST",{text:"read:view.txt"},command);assert.equal(duplicate.accepted,false);assert.equal(duplicate.status,"unknown");
    assert.equal(await readFile(historyPath,"utf8"),historyBefore,"Unknown commands must not replay Pi history or tools");
    await rejected(launch(data,await freePort()));
  }finally{await stop(owner);}
});

async function holdClose(data:string,outsideChild=false){
  const preload=join(data,"hold-close.mjs"),entered=join(data,"closing"),release=join(data,"release");
  await writeFile(preload,`import {existsSync,writeFileSync} from 'node:fs';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
const create=ModelRuntime.create;
ModelRuntime.create=async function(...args){
 const runtime=await create.apply(this,args);
 runtime.registerNativeProvider({id:'sigma-data-lease-fixture',name:'Synthetic lease finalizer',getModels:()=>[],
  auth:{oauth:{name:'Synthetic sign-in',login:async interaction=>{
   try{await interaction.prompt({type:'text',message:'Synthetic finalizer waiting for cancellation'});return {type:'oauth',access:'synthetic',refresh:'synthetic',expires:Date.now()+3600000};}
   finally{writeFileSync(${JSON.stringify(entered)},'finalizing');while(!existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,20));}
  },refresh:async value=>value,toAuth:async()=>({apiKey:'synthetic'})}},
  stream:()=>{throw new Error('No model calls');},streamSimple:()=>{throw new Error('No model calls');}});
 ${outsideChild?`const {spawn}=await import('node:child_process');const child=spawn('/bin/sleep',['120'],{stdio:'ignore'});child.unref();writeFileSync(${JSON.stringify(join(data,"outside-child"))},String(child.pid));`:""}
 return runtime;
};\n`);
  return {preload,entered,release};
}
async function admitFinalizer(port:number){
  const req=await client(port),id=crypto.randomUUID(),path="/providers/sigma-data-lease-fixture/login";
  await req(path,"POST",{},id);
  await waitFor(async()=>(await req(`${path}/${id}`)).operation.prompt?.type==="text","actual SDK sign-in admission");
}

test("shutdown retains the DATA_DIR lease until a held Pi finalizer and Storage finish",async()=>{
  await mkdir(scratch,{recursive:true});const data=await mkdtemp(join(scratch,"data-drain-")),port=await freePort(),gate=await holdClose(data);
  const owner=launch(data,port,gate.preload);
  try{
    await ready(owner);await admitFinalizer(port);owner.child.stdin!.end();await waitFor(()=>existsSync(gate.entered),"admitted SDK shutdown finalizer");
    await rejected(launch(data,await freePort()));assert.equal(exited(owner),false,"Lease stays held beyond listener shutdown");
    await writeFile(gate.release,"finish");await waitFor(()=>exited(owner),"drain completion");assert.equal(owner.child.exitCode,0,owner.output);
    const replacement=launch(data,port);try{await ready(replacement);}finally{await stop(replacement);}
  }finally{await writeFile(gate.release,"finish");await stop(owner);}
});

test("inherited lease cannot bypass identity or locking; bind failure releases the separate DATA_DIR",async()=>{
  await mkdir(scratch,{recursive:true});const data=await mkdtemp(join(scratch,"data-inherited-"));
  for(const supplied of ["invalid","0","987654"]){
    const run=launch(data,await freePort(),undefined,{SIGMA_DATA_LOCK_FD:supplied});
    try{await waitFor(()=>exited(run),"invalid inherited lease rejection");assert.notEqual(run.child.exitCode,0);assert.equal(existsSync(join(data,"state.sqlite")),false,"Invalid handoff never opens Storage");}
    finally{await stop(run);}
  }
  await writeFile(join(data,"sigma.lock"),"");
  const wrong=openSync(join(data,"wrong.lock"),"a+",0o600);
  try{
    const run=launch(data,await freePort(),undefined,{SIGMA_DATA_LOCK_FD:"3"},wrong);
    try{await waitFor(()=>exited(run),"mismatched inherited inode rejection");assert.match(run.output,/lease identity/);assert.equal(existsSync(join(data,"state.sqlite")),false);}
    finally{await stop(run);}
  }finally{closeSync(wrong);}
  // Supplying an independently opened correct inode must acquire a lock,
  // rather than trusting the env var as evidence of native ownership.
  const owner=launch(data,await freePort());await ready(owner);
  const fresh=openSync(join(data,"sigma.lock"),"r+");
  try{await rejected(launch(data,await freePort(),undefined,{SIGMA_DATA_LOCK_FD:"3"},fresh));}
  finally{closeSync(fresh);await stop(owner);}
  const other=await mkdtemp(join(scratch,"data-bind-failure-")),occupied=createServer();
  await new Promise<void>(resolve=>occupied.listen(0,"127.0.0.1",resolve));const port=(occupied.address() as {port:number}).port;
  try{
    const failed=launch(other,port);try{await waitFor(()=>exited(failed),"occupied port startup failure");assert.match(failed.output,/could not start/);assert.notEqual(failed.child.exitCode,0);}finally{await stop(failed);}
    const next=launch(other,await freePort());try{await ready(next);}finally{await stop(next);}
    assert.equal(occupied.listening,true,"Unrelated occupied listener stays alive");
  }finally{await new Promise<void>(resolve=>occupied.close(()=>resolve()));}
});

test("native inherited lease excludes source owners and survives parent SIGKILL through Node drain",async()=>{
  await mkdir(scratch,{recursive:true});const data=await mkdtemp(join(scratch,"data-native-")),executable=join(data,"native-owner");
  const compiled=spawnSync("rustc",["--edition=2021","--crate-name","sigma_lease_fixture",join(root,"apps/desktop/src-tauri/src/data-lease.fixture.rs"),"-o",executable],{encoding:"utf8"});assert.equal(compiled.status,0,compiled.stderr);
  const native=(port:number,preload?:string)=>observe(spawn(executable,[data,root,process.execPath,String(port),...(preload?[preload]:[])],{cwd:root,env:environment(data,port),stdio:["pipe","pipe","pipe"]}));
  let owner=launch(data,await freePort());
  try{await ready(owner);await rejected(native(await freePort()));}finally{await stop(owner);}
  const port=await freePort(),gate=await holdClose(data,true);owner=native(port,gate.preload);
  let nodePid:number|undefined,outsidePid:number|undefined;
  try{
    await ready(owner);nodePid=Number(owner.output.match(/native-child:(\d+)/)![1]);
    outsidePid=Number(await readFile(join(data,"outside-child"),"utf8"));
    await admitFinalizer(port);
    await rejected(launch(data,await freePort()));await rejected(native(await freePort()));
    await stop(owner,"SIGKILL");await waitFor(()=>existsSync(gate.entered),"Node drain after native SIGKILL");
    await rejected(launch(data,await freePort()));await rejected(native(await freePort()));
    await writeFile(gate.release,"finish");
    const canLock=()=>{const probe=spawnSync(executable,[data],{encoding:"utf8"});return probe.status===0;};
    await waitFor(canLock,"last inherited descriptor released after drain");
    process.kill(outsidePid,0); // A live unrelated subprocess must not retain our lease.
    const replacement=launch(data,port);try{await ready(replacement);}finally{await stop(replacement);}
  }finally{
    await writeFile(gate.release,"finish");await stop(owner);
    if(nodePid)await waitFor(()=>{try{process.kill(nodePid!,0);return false;}catch{return true;}},"native orphan Node exit");
    if(outsidePid){try{process.kill(outsidePid,"SIGKILL");}catch{}}
  }
});

test("workspace tools cannot replace the DATA_DIR lock inode",async()=>{
  await mkdir(scratch,{recursive:true});const data=await mkdtemp(join(scratch,"data-tool-")),port=await freePort(),owner=launch(data,port);
  try{
    await ready(owner);await gitFixture(data);const req=await client(port),id=crypto.randomUUID();
    await req("/sessions","POST",{cwd:data,model:"sigma-demo/offline",mode:"code",workspaceMode:"direct"},id);
    const before=statSync(join(data,"sigma.lock")).ino;
    await req(`/sessions/${id}/prompt`,"POST",{text:'write:{"path":"sigma.lock","content":"replacement"}'},crypto.randomUUID());
    await waitFor(async()=>{const view=await req(`/sessions/${id}`);return view.status!=="running"&&view.messages.some((message:any)=>message.role==="assistant");},"guarded lock-file tool result");
    const view=await req(`/sessions/${id}`);assert.equal(view.approvals.length,0,"Lease inode is rejected before Allow can be offered");
    assert.equal(statSync(join(data,"sigma.lock")).ino,before);assert.equal(await readFile(join(data,"sigma.lock"),"utf8"),"");
    await rejected(launch(data,await freePort()));
  }finally{await stop(owner);}
});

test("Git checkout may remove sigma.lock without splitting the DATA_DIR owner",async()=>{
  await mkdir(scratch,{recursive:true});const data=await mkdtemp(join(scratch,"data-git-lock-")),port=await freePort();
  await gitFixture(data);await writeFile(join(data,"sigma.lock"),"");git(data,"add","-f","sigma.lock");git(data,"commit","-m","synthetic tracked lock");
  git(data,"checkout","-b","without-lock");git(data,"rm","sigma.lock");git(data,"commit","-m","synthetic lock removal");git(data,"checkout","with-lock");
  await mkdir(join(data,"workspace"));await writeFile(join(data,"workspace","view.txt"),"harmless fixture");
  const owner=launch(data,port);
  try{
    await ready(owner);const req=await client(port),gitSession=crypto.randomUUID(),session=crypto.randomUUID(),command=crypto.randomUUID();
    await req("/sessions","POST",{cwd:data,model:"sigma-demo/offline"},gitSession);
    await req("/sessions","POST",{cwd:join(data,"workspace"),model:"sigma-demo/offline"},session);
    await req(`/sessions/${session}/prompt`,"POST",{text:"read:view.txt"},command);
    await waitFor(()=>state(data,session,command).approvals.some(approval=>approval.status==="pending"),"live owner before API switch");
    const before=state(data,session,command);
    await req(`/sessions/${gitSession}/git/switch`,"POST",{branch:"without-lock"},crypto.randomUUID());assert.equal(existsSync(join(data,"sigma.lock")),false,"Actual Git API removed the old locked pathname");
    await rejected(launch(data,await freePort()));assert.deepEqual(state(data,session,command),before,"Directory inode lease prevents live recovery after lock file removal");
  }finally{await stop(owner);}
});
