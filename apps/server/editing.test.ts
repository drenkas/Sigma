import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile, symlink, link, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PiHost } from "./pi-host.js";
import { mutationTools } from "./editing.js";
import { SourceApply } from "./source-apply.js";
import { Storage } from "./storage.js";
import { Verification } from "./verification.js";
import type { ApprovalView } from "../../packages/contracts/index.js";

const exec=promisify(execFile),fixture=resolve(import.meta.dirname,`../../.scratch/code-check-${Date.now()}-${process.pid}`);
process.env.PI_OFFLINE="1";process.env.SIGMA_DEMO="1";process.env.PI_CODING_AGENT_DIR=join(fixture,"agent");
// Git writes only construct and validate disposable fixtures, never user repositories.
async function git(cwd:string,...args:string[]){return (await exec("git",["-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false",...args],{cwd,env:{PATH:process.env.PATH,HOME:fixture,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_AUTHOR_NAME:"Fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"Fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid"}})).stdout;}
async function waitFor<T>(check:()=>Promise<T|undefined>):Promise<T>{const end=Date.now()+6000;while(Date.now()<end){const result=await check();if(result!==undefined)return result;await new Promise(r=>setTimeout(r,20));}throw new Error("Timed out");}

test("Pi code sessions approve the actual diff, preserve source, reject unsafe/stale writes and recover without replay",async()=>{
  const source=join(fixture,"source"),data=join(fixture,"data");await mkdir(source,{recursive:true});await mkdir(data);
  await git(source,"init","-b","main");await writeFile(join(source,"calc.ts"),"export const answer = 41;\n");await writeFile(join(source,".gitignore"),"ignored/\n");
  await git(source,"add",".");await git(source,"commit","-m","Fixture");
  await writeFile(join(source,"calc.ts"),"user's uncommitted work\n");await writeFile(join(source,"untracked.txt"),"user notes\n");const index=await readFile(join(source,".git/index"));
  let storage=new Storage(join(data,"state.sqlite"));let host=new PiHost(storage,data,async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);});
  await host.init();const sid=await host.create(source,"sigma-demo/offline",crypto.randomUUID(),"code",{workspaceMode:"worktree"}),initial=await host.snapshot(sid),cwd=initial.cwd;
  const pending=()=>waitFor(async()=> (await host.snapshot(sid)).approvals.find(a=>a.status==="pending"));
  const settled=()=>waitFor(async()=> (await host.snapshot(sid)).status==="settled"?true:undefined);
  const prompt=(tool:string,args:unknown)=>host.prompt(sid,`${tool}:${JSON.stringify(args)}`);
  const decide=async(approval:ApprovalView,allow:boolean)=>{await host.decide(sid,approval.id,allow);await settled();return (await host.snapshot(sid)).approvals.find(a=>a.id===approval.id)!;};
  try{
    assert.equal(initial.policy?.workspace?.sourceCwd,source);assert.equal(initial.policy?.effective.profile.maxDepth,0);
    assert.equal(await readFile(join(cwd,"calc.ts"),"utf8"),"export const answer = 41;\n");await assert.rejects(stat(join(cwd,"untracked.txt")));
    assert.equal((await host.list() as any[]).find(s=>s.id===sid).sourceCwd,source);
    await prompt("edit",{path:"calc.ts",edits:[{oldText:"41",newText:"42"}]});let approval=await pending();
    assert.match(approval.change!.diff,/-export const answer = 41;\n\+export const answer = 42;/);assert.notEqual(approval.change!.beforeHash,approval.change!.afterHash);
    assert.match(await readFile(join(cwd,"calc.ts"),"utf8"),/41/);assert.equal((await decide(approval,true)).outcome,"applied");assert.match(await readFile(join(cwd,"calc.ts"),"utf8"),/42/);
    const writeTool=(host as any).active.get(sid).session.getToolDefinition("write"),toolCallId=crypto.randomUUID(),toolArgs={path:"repeat.txt",content:"written once\n"};
    const directWrite=writeTool.execute(toolCallId,toolArgs);
    approval=await pending();await host.decide(sid,approval.id,true);await directWrite;
    const approvalCount=(await host.snapshot(sid)).approvals.length;
    const repeated=writeTool.execute(toolCallId,toolArgs).then(()=>"executed",(error:unknown)=>String(error));
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal((await host.snapshot(sid)).approvals.length,approvalCount,"The same Pi write call cannot request a second approval");
    assert.match(await repeated,/Previous write tool call is completed/);
    assert.equal(await readFile(join(cwd,"repeat.txt"),"utf8"),"written once\n");
    await prompt("write",{path:"new/note.txt",content:"not allowed\n"});approval=await pending();await assert.rejects(stat(join(cwd,"new")));await decide(approval,false);await assert.rejects(stat(join(cwd,"new")));
    await prompt("write",{path:"calc.ts",content:"overwrite\n"});approval=await pending();await writeFile(join(cwd,"calc.ts"),"external change\n");assert.equal((await decide(approval,true)).outcome,"failed");assert.equal(await readFile(join(cwd,"calc.ts"),"utf8"),"external change\n");
    await prompt("write",{path:"new/has space.txt",content:"approved new file\n"});approval=await pending();assert.equal((await decide(approval,true)).outcome,"applied");
    await prompt("write",{path:"ignored/empty.txt",content:""});approval=await pending();assert.equal((await decide(approval,true)).outcome,"applied");
    const odd='quote"-slash\\-$&-é.txt';await prompt("write",{path:odd,content:"odd path\n"});approval=await pending();await decide(approval,true);
    const changes=await host.changes(sid);assert.equal(changes.omitted,0);assert.deepEqual([...changes.files].sort(),["calc.ts","ignored/empty.txt","new/has space.txt",odd,"repeat.txt"].sort());
    const patchFile=join(fixture,"result.patch");await writeFile(patchFile,changes.diff);
    const baseline=join(fixture,"baseline");await git(fixture,"clone","--local","--no-hardlinks",source,baseline);await git(baseline,"apply","--check",patchFile);await git(baseline,"apply",patchFile);
    assert.equal(await readFile(join(baseline,"new/has space.txt"),"utf8"),"approved new file\n");assert.equal((await stat(join(baseline,"ignored/empty.txt"))).size,0);assert.equal(await readFile(join(baseline,odd),"utf8"),"odd path\n");
    await git(cwd,"config","core.filemode","false");await chmod(join(cwd,".gitignore"),0o755);
    const modeOnly=await host.changes(sid);assert.equal(modeOnly.omitted,1,"Mode-only changes need an exportable patch or must block export");assert.ok(!modeOnly.files.includes(".gitignore"));
    // A path swapped to a symlink after the preview must fail as well as paths blocked at entry.
    await prompt("write",{path:"escape/new.txt",content:"escape\n"});approval=await pending();await symlink(source,join(cwd,"escape"));assert.equal((await decide(approval,true)).outcome,"failed");await assert.rejects(stat(join(source,"new.txt")));
    await link(join(source,"untracked.txt"),join(cwd,"hardlink.txt"));
    const count=(await host.snapshot(sid)).approvals.length;
    for(const path of ["../outside.txt",".git/config",".env.local","escape/untracked.txt","hardlink.txt"]){await prompt("write",{path,content:"forbidden"});await settled();}
    assert.equal((await host.snapshot(sid)).approvals.length,count,"Unsafe paths do not even offer approval");
    await host.prompt(sid,"delegate:forbidden");await settled();assert.equal((await host.snapshot(sid)).agents.length,1);
    await prompt("write",{path:"stopped.txt",content:"no\n"});approval=await pending();await host.abort(sid);await assert.rejects(host.decide(sid,approval.id,true),/no longer pending/);await assert.rejects(stat(join(cwd,"stopped.txt")));
    const readonly=await host.create(source,"sigma-demo/offline");await host.prompt(readonly,'write:{"path":"calc.ts","content":"bypass"}');await waitFor(async()=>(await host.snapshot(readonly)).status==="settled"?true:undefined);assert.equal((await host.snapshot(readonly)).approvals.length,0);
    await prompt("write",{path:"after-restart.txt",content:"never replay\n"});const unfinished=await pending();
    // Storage crash fixture: durable intent exists but no final filesystem receipt.
    const crashId=crypto.randomUUID(),temporary=".pi-edit-crash-fixture";
    await storage.call("approval",{id:crashId,sessionId:sid,agentId:sid,tool:"write",preview:"write crash.txt",change:{path:"crash.txt",diff:"proposed change",beforeHash:"missing",afterHash:"fixture"}});
    await storage.call("approvalStatus",{id:crashId,status:"approved"});await storage.call("writeOutcome",{id:crashId,outcome:"applying"});await writeFile(join(cwd,temporary),"unfinished atomic write\n");
    await host.close();await storage.close();storage=new Storage(join(data,"state.sqlite"));host=new PiHost(storage,data,async()=>{});await host.init();
    const restored=await host.snapshot(sid);assert.equal(restored.approvals.find(a=>a.id===crashId)?.outcome,"unknown");const recoveredChanges=await host.changes(sid);assert.ok(recoveredChanges.omitted>0);assert.ok(!recoveredChanges.diff.includes(temporary));await assert.rejects(stat(join(cwd,"crash.txt")));assert.equal(restored.approvals.find(a=>a.id===unfinished.id)?.status,"expired");assert.ok(restored.approvals.some(a=>a.outcome==="applied"&&a.change?.path==="calc.ts"));await assert.rejects(stat(join(cwd,"after-restart.txt")));
    assert.equal(await readFile(join(source,"calc.ts"),"utf8"),"user's uncommitted work\n");assert.equal(await readFile(join(source,"untracked.txt"),"utf8"),"user notes\n");assert.deepEqual(await readFile(join(source,".git/index")),index);
  }finally{await host.close();await storage.close();}
});

test("direct Code approvals preserve unrelated Git state and stop at HEAD drift or an uncertain write",async()=>{
  const source=join(fixture,"direct-source"),data=join(fixture,"direct-data");await mkdir(source,{recursive:true});await mkdir(data);
  await git(source,"init","-b","main");
  for(const [path,content] of [["calc.ts","export const answer = 41;\n"],["staged.txt","base\n"],["dirty.txt","base\n"],[".gitignore","node_modules/\nignored/\n"]])await writeFile(join(source,path),content);
  await git(source,"add",".");await git(source,"commit","-m","Fixture");
  await writeFile(join(source,"staged.txt"),"staged\n");await git(source,"add","staged.txt");
  await writeFile(join(source,"dirty.txt"),"dirty\n");await writeFile(join(source,"untracked.txt"),"untracked\n");
  await mkdir(join(source,"node_modules"));await Promise.all(Array.from({length:205},(_,i)=>writeFile(join(source,"node_modules",`${i}.txt`),"ignored\n")));
  const index=await readFile(join(source,".git/index"));
  const storage=new Storage(join(data,"state.sqlite")),host=new PiHost(storage,data,async()=>{});await host.init();
  const verification=new Verification(storage,host,data,async()=>{}),apply=new SourceApply(storage,host,verification,data,async()=>{});
  try{
    const sid=await host.create(source,"sigma-demo/offline",crypto.randomUUID(),"code");
    assert.equal((await host.snapshot(sid)).cwd,source);
    await host.prompt(sid,'edit:{"path":"calc.ts","edits":[{"oldText":"41","newText":"42"}]}');
    const approval=await waitFor(async()=> (await host.snapshot(sid)).approvals.find(a=>a.status==="pending"&&a.change?.path==="calc.ts"));
    assert.equal(await readFile(join(source,"calc.ts"),"utf8"),"export const answer = 41;\n");
    await host.decide(sid,approval.id,true);
    await waitFor(async()=> (await host.snapshot(sid)).approvals.find(a=>a.id===approval.id)?.outcome==="applied"?true:undefined);
    assert.equal(await readFile(join(source,"calc.ts"),"utf8"),"export const answer = 42;\n");
    assert.deepEqual(await readFile(join(source,".git/index")),index);
    assert.equal(await readFile(join(source,"staged.txt"),"utf8"),"staged\n");
    assert.equal(await readFile(join(source,"dirty.txt"),"utf8"),"dirty\n");
    assert.equal(await readFile(join(source,"untracked.txt"),"utf8"),"untracked\n");
    assert.ok((await host.changes(sid)).files.includes("calc.ts"),"Ignored dependencies cannot hide a tracked edit");
    await assert.rejects(apply.prepare(sid,crypto.randomUUID()),/direct|source apply/i);
    await waitFor(async()=>(await host.snapshot(sid)).status==="settled"?true:undefined);
    const beforeIgnored=(await host.snapshot(sid)).approvals.length;
    await host.prompt(sid,'write:{"path":"ignored/agent.txt","content":"must not disappear from diff"}');
    await waitFor(async()=>{const row=await host.snapshot(sid);return row.status==="settled"||row.approvals.length>beforeIgnored?true:undefined;});
    assert.equal((await host.snapshot(sid)).approvals.length,beforeIgnored,"Ignored writes must be rejected before approval in direct mode");
    await assert.rejects(stat(join(source,"ignored","agent.txt")));
    await git(source,"commit","-m","Changed HEAD","--","calc.ts");
    const approvalCount=(await host.snapshot(sid)).approvals.length;
    await host.prompt(sid,'write:{"path":"after-head.txt","content":"blocked\\n"}');
    await waitFor(async()=>(await host.snapshot(sid)).status==="settled"?true:undefined);
    assert.equal((await host.snapshot(sid)).approvals.length,approvalCount);
    await assert.rejects(stat(join(source,"after-head.txt")));
    const second=await host.create(source,"sigma-demo/offline",crypto.randomUUID(),"code");
    const uncertain=crypto.randomUUID();
    await storage.call("approval",{id:uncertain,sessionId:sid,agentId:sid,tool:"write",preview:"write uncertain.txt",change:{path:"uncertain.txt",diff:"proposed change",beforeHash:"missing",afterHash:"fixture"}});
    await storage.call("approvalStatus",{id:uncertain,status:"approved"});await storage.call("writeOutcome",{id:uncertain,outcome:"unknown"});
    await host.prompt(second,'write:{"path":"after-uncertain.txt","content":"blocked\\n"}');
    await waitFor(async()=>(await host.snapshot(second)).status==="settled"?true:undefined);
    assert.equal((await host.snapshot(second)).approvals.length,0,"An unresolved direct write blocks another session in the same folder");
    await assert.rejects(stat(join(source,"after-uncertain.txt")));
  }finally{await apply.close();await verification.close();await host.close();await storage.close();}
});

test("edit and write run sequentially so parallel calls in one turn never see each other's applying approval",async()=>{
  const source=join(fixture,"seq-source"),data=join(fixture,"seq-data");await mkdir(source,{recursive:true});await mkdir(data);
  await git(source,"init","-b","main");await writeFile(join(source,"a.txt"),"a\n");await git(source,"add",".");await git(source,"commit","-m","Fixture");
  const storage=new Storage(join(data,"state.sqlite")),host=new PiHost(storage,data,async()=>{});await host.init();
  try{
    const sid=await host.create(source,"sigma-demo/offline",crypto.randomUUID(),"code"),session=(host as any).active.get(sid).session;
    const direct=mutationTools(source,async()=>null,async()=>{},()=>false);
    assert.deepEqual(direct.map(tool=>[tool.name,tool.executionMode]),[["edit","sequential"],["write","sequential"]]);
    for(const name of ["edit","write"]){
      assert.equal(session.getToolDefinition(name).executionMode,"sequential",`${name} definition keeps its execution mode through Pi registration`);
      assert.equal(session.agent.state.tools.find((tool:any)=>tool.name===name).executionMode,"sequential",`${name} agent tool makes the whole batch sequential`);
    }
  }finally{await host.close();await storage.close();}
});
