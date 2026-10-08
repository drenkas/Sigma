import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PiHost } from "./pi-host.js";
import { Storage } from "./storage.js";

const exec=promisify(execFile),fixture=resolve(import.meta.dirname,`../../.scratch/bash-check-${Date.now()}-${process.pid}`);
process.env.PI_OFFLINE="1";process.env.SIGMA_DEMO="1";process.env.PI_CODING_AGENT_DIR=join(fixture,"agent");
async function git(cwd:string,...args:string[]){return (await exec("git",["-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false",...args],{cwd,env:{PATH:process.env.PATH,HOME:fixture,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_AUTHOR_NAME:"Fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"Fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid"}})).stdout;}
async function waitFor<T>(check:()=>Promise<T|undefined>):Promise<T>{const end=Date.now()+15000;while(Date.now()<end){const result=await check();if(result!==undefined)return result;await new Promise(r=>setTimeout(r,20));}throw new Error("Timed out");}
async function open(name:string,mode:"full"|"ask"){
  const source=join(fixture,name,"source"),data=join(fixture,name,"data");await mkdir(source,{recursive:true});await mkdir(data,{recursive:true});
  await git(source,"init","-b","main");await writeFile(join(source,"a.txt"),"a\n");await git(source,"add",".");await git(source,"commit","-m","Fixture");
  const storage=new Storage(join(data,"state.sqlite")),host=new PiHost(storage,data,async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);});
  await host.init();await host.setApprovalMode(mode);
  const sid=await host.create(source,"sigma-demo/offline",crypto.randomUUID(),"code",{workspaceMode:"worktree"}),cwd=(await host.snapshot(sid)).cwd;
  const settled=()=>waitFor(async()=>(await host.snapshot(sid)).status==="settled"?true:undefined);
  const run=async(command:string,extra:object={})=>{await host.prompt(sid,`bash:${JSON.stringify({command,...extra})}`);};
  const approvals=async()=>(await host.snapshot(sid)).approvals.filter(a=>a.tool==="bash");
  return {source,data,storage,host,sid,cwd,settled,run,approvals,close:async()=>{await host.close();await storage.close();}};
}

test("Full access runs bash in the agent's folder without prompting, journals it and blocks Sigma's data folder",async()=>{
  const f=await open("full","full");
  try{
    assert.deepEqual(((await f.host.snapshot(f.sid)).policy!.effective.profile.tools),["read","ls","edit","write"],"Profiles are unchanged; bash is added per session role");
    assert.ok((f.host as any).active.get(f.sid).session.getToolDefinition("bash"),"bash is registered for a code session");
    await f.run(`echo made > made.txt && pwd > where.txt && cat ${JSON.stringify(join(f.data,"agent-access.json"))} > leaked.txt 2>/dev/null; echo done`);await f.settled();
    assert.equal(await readFile(join(f.cwd,"made.txt"),"utf8"),"made\n");assert.equal((await readFile(join(f.cwd,"where.txt"),"utf8")).trim(),await (await import("node:fs/promises")).realpath(f.cwd));
    assert.equal(await readFile(join(f.cwd,"leaked.txt"),"utf8"),"","Sigma's access file is unreadable from agent commands");
    await assert.rejects(stat(join(f.source,"made.txt")),"The source folder is untouched; the isolated workspace is used");
    const [approval]=await f.approvals();assert.equal(approval.status,"approved");assert.match(approval.preview,/^bash echo made/);
    await f.run("git status --short > gs.txt; git log --oneline | head -1 >> gs.txt; exit 3");await f.settled();
    const second=(await f.approvals()).find(a=>a.preview.includes("exit 3"));assert.equal(second?.status,"approved","A failing exit code is still an approved, completed call");
    assert.match(await readFile(join(f.cwd,"gs.txt"),"utf8"),/Fixture/,"git works in the isolated worktree under the sandbox");
  }finally{await f.close();}
});

test("Ask mode needs approval for bash; Deny never runs the command and Allow does",async()=>{
  const f=await open("ask","ask");
  try{
    await f.run("echo denied > denied.txt");
    const pending=await waitFor(async()=>(await f.approvals()).find(a=>a.status==="pending"));assert.equal(pending.preview,"bash echo denied > denied.txt");
    await assert.rejects(stat(join(f.cwd,"denied.txt")),"Nothing runs while waiting");
    await f.host.decide(f.sid,pending.id,false);await f.settled();
    await assert.rejects(stat(join(f.cwd,"denied.txt")),"Denied command did not run");
    assert.equal((await f.approvals()).find(a=>a.id===pending.id)?.status,"denied");
    await f.run("echo allowed > allowed.txt");
    const second=await waitFor(async()=>(await f.approvals()).find(a=>a.status==="pending"));
    await f.host.decide(f.sid,second.id,true);await f.settled();
    assert.equal(await readFile(join(f.cwd,"allowed.txt"),"utf8"),"allowed\n");
  }finally{await f.close();}
});

test("Stopping a run kills a running bash command",async()=>{
  const f=await open("stop","full");
  try{
    await f.run(`echo started > started.txt; sleep 20; echo late > late.txt`);
    await waitFor(async()=>{try{await stat(join(f.cwd,"started.txt"));return true;}catch{return undefined;}});
    await f.host.abort(f.sid);await new Promise(r=>setTimeout(r,2500));
    await assert.rejects(stat(join(f.cwd,"late.txt")));
  }finally{await f.close();}
});

test("Read-only sessions get no bash tool",async()=>{
  const f=await open("readonly","full");
  try{
    const readonly=await f.host.create(f.source,"sigma-demo/offline");
    assert.equal((f.host as any).active.get(readonly).session.getToolDefinition("bash"),undefined);
    await f.host.prompt(readonly,'bash:{"command":"echo no > blocked.txt"}');await waitFor(async()=>(await f.host.snapshot(readonly)).status==="settled"?true:undefined);
    assert.equal((await f.host.snapshot(readonly)).approvals.length,0);await assert.rejects(stat(join(f.source,"blocked.txt")));
  }finally{await f.close();}
});
