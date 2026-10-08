import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProjectTaskView, SessionView } from "../../packages/contracts/index.js";

const root=resolve(import.meta.dirname,"../..");
const fixture=join(root,".scratch",`multi-repo-api-${Date.now()}-${process.pid}`);
const dataDir=join(fixture,"data");
const model="sigma-demo/offline";

function git(cwd:string,...args:string[]){
  return execFileSync("git",["-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false",...args],{cwd,encoding:"utf8",env:{PATH:process.env.PATH,HOME:fixture,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_AUTHOR_NAME:"Fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"Fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid",LC_ALL:"C"}}).trim();
}
async function repo(name:string){
  const path=join(fixture,name);await mkdir(path);git(path,"init","-b","main");
  await writeFile(join(path,"README.md"),`${name} base\n`);
  await writeFile(join(path,"probe.test.mjs"),'import test from "node:test";\ntest("fixture",()=>{});\n');
  git(path,"add","README.md","probe.test.mjs");git(path,"commit","-m","base");
  return path;
}
async function freePort(){
  const server=createServer();await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
  const port=(server.address() as {port:number}).port;await new Promise<void>(done=>server.close(()=>done()));return port;
}
async function waitFor(check:()=>Promise<boolean>,ms=15000){
  const until=Date.now()+ms;while(Date.now()<until){if(await check())return;await new Promise(done=>setTimeout(done,50));}
  throw new Error("Timed out waiting for the multi-repository task");
}
async function launch(port:number){
  const child=spawn(process.execPath,["--import","tsx","apps/server/main.ts"],{cwd:root,env:{PATH:process.env.PATH,HOME:fixture,SIGMA_APPROVAL_MODE:"ask",PI_OFFLINE:"1",PI_CODING_AGENT_DIR:join(fixture,"agent"),SIGMA_DEMO:"1",SIGMA_PORT:String(port),SIGMA_DATA_DIR:dataDir},stdio:["ignore","pipe","pipe"]});
  let output="";for(const stream of [child.stdout,child.stderr])stream?.on("data",chunk=>{output=(output+String(chunk)).slice(-1000);});
  try{await waitFor(async()=>{if(child.exitCode!==null||child.signalCode!==null)throw new Error(`Server exited: ${output}`);try{return (await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(2000)})).ok;}catch{return false;}},120000);return child;}
  catch(error){child.kill("SIGKILL");throw error;}
}
async function stop(child:ChildProcess){
  if(child.exitCode!==null||child.signalCode!==null)return;
  await new Promise<void>((done,reject)=>{
    const timeout=setTimeout(()=>reject(new Error("Fixture server did not stop")),5000);
    child.once("exit",()=>{clearTimeout(timeout);done();});child.kill("SIGTERM");
  });
}

test("one project task dispatches directly to two repositories, supports worktrees and survives restart without replay",async()=>{
  await mkdir(fixture,{recursive:true});git(fixture,"init","--bare","-q");
  const first=await repo("first"),second=await repo("second");
  const sources=[first,second],heads=sources.map(path=>git(path,"rev-parse","HEAD"));
  const port=await freePort(),origin=`http://127.0.0.1:${port}`,base=`${origin}/api`;
  let child=await launch(port);
  async function client(){
    const boot=await fetch(`${base}/bootstrap`,{method:"POST",headers:{Origin:origin}});
    assert.equal(boot.status,200);const cookie=boot.headers.get("set-cookie")!.split(";")[0];
    return async(path:string,method="GET",body?:unknown,id?:string)=>{
      const response=await fetch(`${base}${path}`,{method,headers:{Origin:origin,Cookie:cookie,...(body===undefined?{}:{"Content-Type":"application/json"}),...(id?{"X-Command-Id":id}:{})},body:body===undefined?undefined:JSON.stringify(body)});
      return {status:response.status,data:await response.json() as any};
    };
  }
  try{
    let request=await client();const projectId=randomUUID(),taskId=randomUUID();
    assert.equal((await request(`/projects/${projectId}`,"PUT",{name:"Two repositories",folders:sources})).status,200);
    assert.equal((await request("/project-tasks","POST",{projectId,model},taskId)).status,200);
    const task=(await request(`/project-tasks/${taskId}`)).data as ProjectTaskView;
    assert.equal(task.status,"running");assert.equal(task.coordinatorId===task.repositories[0].sessionId,false);
    assert.deepEqual(task.repositories.map(item=>[item.sourceCwd,item.baseCommit]),sources.map((path,index)=>[path,heads[index]]));
    assert.equal(new Set(task.repositories.map(item=>item.id)).size,2);
    assert.equal((await request("/project-tasks","POST",{projectId,model,workspaceMode:"worktree"},taskId)).status,400,"A task ID cannot switch workspace mode");
    const members=await Promise.all(task.repositories.map(item=>request(`/sessions/${item.sessionId}`)));
    assert.ok(members.every(item=>item.status===200));
    for(const [index,item] of members.entries()){
      const view=item.data as SessionView,repo=task.repositories[index];
      assert.equal(view.policy?.task?.id,taskId);assert.equal(view.policy.task.repositoryId,repo.id);
      assert.equal(view.policy.workspace?.sourceCwd,repo.sourceCwd);assert.equal(view.policy.workspace.baseCommit,repo.baseCommit);
      assert.equal(view.cwd,repo.sourceCwd);assert.equal(view.policy.workspace.kind,"direct");
    }
    const worktreeTaskId=randomUUID();
    assert.equal((await request("/project-tasks","POST",{projectId,model,workspaceMode:"worktree"},worktreeTaskId)).status,200);
    const worktreeTask=(await request(`/project-tasks/${worktreeTaskId}`)).data as ProjectTaskView;
    for(const repo of worktreeTask.repositories){
      const view=(await request(`/sessions/${repo.sessionId}`)).data as SessionView;
      assert.notEqual(view.cwd,repo.sourceCwd);assert.equal(view.policy?.workspace?.kind,"worktree");
      assert.ok(git(repo.sourceCwd,"worktree","list","--porcelain").includes(`worktree ${view.cwd}\n`));
    }
    const copies=(await readdir(join(dataDir,"workspaces"))).sort();
    assert.deepEqual(copies,worktreeTask.repositories.map(item=>item.sessionId).sort());
    assert.equal((await request(`/sessions/${task.coordinatorId}/prompt`,"POST",{text:`repo2:${task.repositories[0].id}|${task.repositories[1].id}`},randomUUID())).status,200);
    await waitFor(async()=>{
      const views=await Promise.all(task.repositories.map(item=>request(`/sessions/${item.sessionId}`)));
      return views.every(item=>item.data.status==="settled"&&item.data.messages.some((message:{role:string;text:string})=>message.role==="assistant"&&message.text==="Demo response: hello"));
    });
    await waitFor(async()=>(await request(`/sessions/${task.coordinatorId}`)).data.status==="settled");
    const graphPath=`/sessions/${task.coordinatorId}/graph`;
    const dispatchGraph=(await request(graphPath)).data;
    assert.deepEqual(new Set(dispatchGraph.nodes.map((node:any)=>node.id)),new Set([task.coordinatorId,...task.repositories.map(repo=>repo.sessionId)]));
    assert.ok(dispatchGraph.events.filter((event:any)=>event.payload.kind==="creation").every((event:any)=>event.payload.actor==="user"&&event.payload.cause==="multi_repo_setup"));
    assert.equal(dispatchGraph.events.some((event:any)=>event.payload.kind==="result"&&event.payload.outcome==="received"),false,"Repository dispatch status is not result receipt");
    assert.equal((await request(`${graphPath}/nodes/${worktreeTask.repositories[0].sessionId}/history`)).status,404,"Same-project other task member is isolated");
    const statusId=randomUUID();await request(`/sessions/${task.coordinatorId}/prompt`,"POST",{text:`repo-status:${task.repositories[0].id}`},statusId);
    await waitFor(async()=>(await request(`/sessions/${task.coordinatorId}`)).data.status==="settled");
    const receiptGraph=(await request(graphPath)).data;
    const receipt=receiptGraph.events.find((event:any)=>event.payload.kind==="result"&&event.payload.cause==="repo_status"&&event.payload.outcome==="received");
    assert.equal(receipt?.payload.source,task.repositories[0].sessionId);assert.equal(receipt?.payload.target,task.coordinatorId);assert.ok(receipt?.payload.receiptEntryId);
    const messageCounts=await Promise.all(task.repositories.map(async item=>(await request(`/sessions/${item.sessionId}`)).data.messages.length));
    assert.equal((await request(`/sessions/${task.coordinatorId}/prompt`,"POST",{text:`repo:${randomUUID()}`},randomUUID())).status,200);
    await waitFor(async()=>(await request(`/sessions/${task.coordinatorId}`)).data.status==="settled");
    assert.equal((await request(`/sessions/${task.coordinatorId}`)).data.messages.at(-1).text,"Demo: a tool was denied or failed.");
    assert.deepEqual(await Promise.all(task.repositories.map(async item=>(await request(`/sessions/${item.sessionId}`)).data.messages.length)),messageCounts,"Foreign repository ID must not dispatch");
    const firstMember=task.repositories[0].sessionId;
    await request(`/sessions/${firstMember}/prompt`,"POST",{text:"delegate:delegate:nested repository result"},randomUUID());
    await waitFor(async()=>(await request(`/sessions/${firstMember}`)).data.status==="settled");
    const nested=(await request(`/sessions/${firstMember}`)).data as SessionView;
    const nestedChild=nested.agents.find(agent=>agent.parentId===firstMember)!,nestedGrand=nested.agents.find(agent=>agent.parentId===nestedChild.id)!;
    assert.equal(nested.agents.length,3);
    for(const agent of [nestedChild,nestedGrand])assert.deepEqual((await request(`/sessions/${firstMember}/agents/${agent.id}`)).data.policy.task,{id:taskId,repositoryId:task.repositories[0].id});
    const nestedGraph=(await request(graphPath)).data;
    for(const agent of [nestedChild,nestedGrand]){assert.equal(nestedGraph.nodes.find((node:any)=>node.id===agent.id)?.repositoryId,task.repositories[0].id);assert.equal((await request(`${graphPath}/nodes/${agent.id}/history`)).data.id,agent.id);}
    assert.equal((await request(`/sessions/${task.coordinatorId}/agents/${nestedGrand.id}`)).status,404,"Task graph membership does not grant coordinator root child controls");
    assert.equal((await request(`/sessions/${task.repositories[1].sessionId}/agents/${nestedGrand.id}/prompt`,"POST",{text:"foreign sibling"},randomUUID())).status,409);
    const followId=randomUUID(),followPath=`/sessions/${firstMember}/agents/${nestedGrand.id}/prompt`;
    assert.equal((await request(followPath,"POST",{text:"hello nested again"},followId)).status,200);
    await waitFor(async()=>(await request(`/sessions/${firstMember}/agents/${nestedGrand.id}`)).data.status==="settled");
    assert.equal((await request(followPath,"POST",{text:"hello nested again"},followId)).data.status,"completed","Nested follow-up does not replay");
    await request(followPath,"POST",{text:"read:README.md"},randomUUID());
    await waitFor(async()=>(await request(`/sessions/${firstMember}`)).data.approvals.some((approval:any)=>approval.status==="pending"));
    const settledApproval=(await request(`/sessions/${firstMember}`)).data.approvals.find((approval:any)=>approval.status==="pending");
    assert.equal((await request(`/sessions/${firstMember}`)).data.status,"settled");
    assert.equal((await request(`/sessions/${firstMember}/abort`,"POST",{})).status,200,"HTTP root Stop works when only a descendant is running");
    assert.equal((await request(`/sessions/${firstMember}/agents/${nestedGrand.id}`)).data.status,"interrupted");
    assert.equal((await request(`/sessions/${firstMember}/approvals/${settledApproval.id}`,"POST",{allow:true})).status,409);
    const helloCount=async()=>(await request(`/sessions/${firstMember}`)).data.messages.filter((message:{role:string;text:string})=>message.role==="user"&&message.text==="hello").length;
    const beforeDuplicate=await helloCount();
    assert.equal((await request(`/sessions/${task.coordinatorId}/prompt`,"POST",{text:`repo2:${task.repositories[0].id}|${task.repositories[0].id}`},randomUUID())).status,200);
    await waitFor(async()=>(await request(`/sessions/${task.coordinatorId}`)).data.status==="settled"&&(await request(`/sessions/${firstMember}`)).data.status==="settled");
    assert.equal(await helloCount(),beforeDuplicate+1,"Two tool calls for one repository admit only one new turn");
    assert.equal((await request(`/projects/${projectId}`,"PUT",{name:"Edited project",folders:[first]})).status,200);
    assert.deepEqual((await request("/project-tasks","POST",{projectId,model},taskId)).data,{id:taskId,status:"running"},"Retry must use the immutable task snapshot");
    assert.deepEqual((await request(`/project-tasks/${taskId}`)).data,task);
    const sessionIds=(await request("/sessions")).data.sessions.map((item:{id:string})=>item.id).sort();
    for(const [index,path] of sources.entries()){
      assert.equal(git(path,"rev-parse","HEAD"),heads[index]);assert.equal(git(path,"status","--porcelain"),"");
      assert.equal(await readFile(join(path,"README.md"),"utf8"),`${index===0?"first":"second"} base\n`);
    }
    await request(`/sessions/${task.coordinatorId}/prompt`,"POST",{text:`repo-status:${task.repositories[0].id}`},randomUUID());
    await waitFor(async()=>(await request(`/sessions/${task.coordinatorId}`)).data.status==="settled");
    const previousReceipt=(await request(graphPath)).data.events.filter((event:any)=>event.payload.cause==="repo_status"&&event.payload.outcome==="received").at(-1).payload;
    assert.ok(previousReceipt.sourceRun?.runId);assert.ok(previousReceipt.sourceEntryId);
    assert.equal((await request(`/sessions/${firstMember}/prompt`,"POST",{text:`slow ${"task ".repeat(80)}`},randomUUID())).status,200);
    await waitFor(async()=>(await request(`/sessions/${firstMember}`)).data.status==="running");
    await request(`/sessions/${task.coordinatorId}/prompt`,"POST",{text:`repo-status:${task.repositories[0].id}`},randomUUID());
    await waitFor(async()=>(await request(`/sessions/${task.coordinatorId}`)).data.status==="settled");
    const runningGraph=(await request(graphPath)).data;
    const oldResult=runningGraph.events.filter((event:any)=>event.payload.cause==="repo_status"&&event.payload.outcome==="received").at(-1).payload;
    assert.equal(oldResult.sourceRun.runId,previousReceipt.sourceRun.runId,"An old returned message keeps its producing run while a new run is active");
    assert.equal(oldResult.sourceEntryId,previousReceipt.sourceEntryId);
    assert.notEqual(oldResult.sourceRun.runId,runningGraph.nodes.find((node:any)=>node.id===firstMember).metadata.runId);
    await request(`/sessions/${firstMember}/agents/${nestedChild.id}/prompt`,"POST",{text:"delegate:read:README.md"},randomUUID());
    await waitFor(async()=>(await request(`/sessions/${firstMember}`)).data.approvals.some((approval:any)=>approval.status==="pending"));
    const taskApproval=(await request(`/sessions/${firstMember}`)).data.approvals.find((approval:any)=>approval.status==="pending");
    assert.equal((await request(`/sessions/${task.coordinatorId}/abort`,"POST",{})).status,200);
    await waitFor(async()=>(await request(`/sessions/${firstMember}`)).data.status==="interrupted");
    assert.equal((await request(`/sessions/${firstMember}`)).data.agents.find((agent:any)=>agent.id===taskApproval.agentId).status,"interrupted");
    assert.equal((await request(`/sessions/${firstMember}/approvals/${taskApproval.id}`,"POST",{allow:true})).status,409);
    await stop(child);
    const db=new DatabaseSync(join(dataDir,"state.sqlite"));
    try{
      db.prepare("UPDATE project_tasks SET status=?,data=? WHERE id=?").run("unknown",JSON.stringify({...task,status:"unknown"}),taskId);
      const member=db.prepare("SELECT policy FROM sessions WHERE id=?").get(worktreeTask.repositories[0].sessionId) as {policy:string};
      const policy=JSON.parse(member.policy);policy.task.repositoryId=task.repositories[0].id;
      db.prepare("UPDATE sessions SET policy=? WHERE id=?").run(JSON.stringify(policy),worktreeTask.repositories[0].sessionId);
    }finally{db.close();}
    child=await launch(port);request=await client();
    const restored=(await request(`/project-tasks/${taskId}`)).data as ProjectTaskView;
    assert.equal((await request(`/sessions/${worktreeTask.coordinatorId}/graph`)).status,404,"Tampered repository membership fails closed");
    assert.equal((await request(graphPath)).status,200);
    assert.equal(restored.status,"unknown");assert.deepEqual({...restored,status:"running"},task);
    assert.deepEqual((await readdir(join(dataDir,"workspaces"))).sort(),copies);
    assert.deepEqual((await request("/sessions")).data.sessions.map((item:{id:string})=>item.id).sort(),sessionIds);
    for(const repo of task.repositories){
      const view=(await request(`/sessions/${repo.sessionId}`)).data as SessionView;
      assert.equal(view.policy?.task?.repositoryId,repo.id);assert.equal(view.cwd,repo.sourceCwd);
    }
    assert.equal((await request(`/sessions/${task.coordinatorId}`)).status,200);
    const blockedPrompt=await request(`/sessions/${task.repositories[1].sessionId}/prompt`,"POST",{text:"must not run"},randomUUID());
    assert.equal(blockedPrompt.status,409);assert.match(blockedPrompt.data.error,/unresolved/i);
    const blockedCheck=await request(`/sessions/${task.repositories[1].sessionId}/checks`,"POST",{testPath:"probe.test.mjs",inputPaths:["README.md"]},randomUUID());
    assert.equal(blockedCheck.status,409);assert.match(blockedCheck.data.error,/unresolved/i);
    const blockedApply=await request(`/sessions/${task.repositories[1].sessionId}/source-applies`,"POST",{},randomUUID());
    assert.equal(blockedApply.status,409);assert.match(blockedApply.data.error,/unresolved/i);
    assert.deepEqual((await request("/project-tasks","POST",{projectId,model},taskId)).data,{id:taskId,status:"unknown"});
    assert.deepEqual((await request("/sessions")).data.sessions.map((item:{id:string})=>item.id).sort(),sessionIds,"Unknown retry must not create sessions");
    assert.deepEqual((await readdir(join(dataDir,"workspaces"))).sort(),copies,"Restart retry must not create worktrees again");
    const beforeContinueMessages=(await request(`/sessions/${task.coordinatorId}`)).data.messages.length;
    assert.equal((await request(`/project-tasks/${taskId}/continue`,"POST",{observedRevisions:(await request("/workspace-recovery")).data.items.filter((item:any)=>item.id===taskId).map((item:any)=>item.observedRevision)})).status,200,"Explicit continuation may restore exact saved IDs after ownership inspection");
    assert.equal((await request(`/project-tasks/${taskId}`)).data.status,"running");
    assert.equal((await request(`/sessions/${task.coordinatorId}`)).data.messages.length,beforeContinueMessages,"Continuation never replays the original coordinator prompt");
    assert.deepEqual((await request("/sessions")).data.sessions.map((item:{id:string})=>item.id).sort(),sessionIds,"Continuation reuses every existing session ID");
    assert.deepEqual((await readdir(join(dataDir,"workspaces"))).sort(),copies,"Continuation does not create or remove Git worktrees");
  }finally{await stop(child);}
});
