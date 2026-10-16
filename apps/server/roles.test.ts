import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, type AssistantMessage } from "@earendil-works/pi-ai";
import { Storage } from "./storage.js";
import { PiHost } from "./pi-host.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { applyProjectAgents, normalizeProjectAgents, normalizeRoles, projectAgentsInput, resolveRole, roleInput } from "./roles.js";
import { snapshotProjectTask } from "./project-task.js";

const scratch=resolve(import.meta.dirname,"../../.scratch",`roles-${Date.now()}-${process.pid}`);
process.env.PI_OFFLINE="1";process.env.PI_CODING_AGENT_DIR=join(scratch,"agent");
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
async function waitFor(check:()=>Promise<boolean>){const until=Date.now()+8000;while(Date.now()<until){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw new Error("Role run did not settle");}

test("group and role models reach Pi, nested runs keep the root snapshot, and restart restores it",async()=>{
  await mkdir(scratch,{recursive:true});let storage=new Storage(join(scratch,"state.sqlite"));
  const observed:Array<{model:string;instructions:string;reasoning:unknown}>=[];
  function register(host:PiHost){
    const runtime=(host as unknown as {runtime:ModelRuntime}).runtime;
    runtime.registerProvider("role-fixture",{api:"role-fixture",apiKey:"local-fixture",baseUrl:"http://127.0.0.1/unused",models:["root","child","override"].map(id=>({id,name:id,reasoning:true,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:16384,maxTokens:1024})),streamSimple:(model,context,options)=>{
      observed.push({model:model.id,instructions:getCurrentSystemPrompt(context.messages)??"",reasoning:options?.reasoning});
      const stream=createAssistantMessageEventStream(),output:AssistantMessage={role:"assistant",content:[],api:model.api,provider:model.provider,model:model.id,usage,stopReason:"pending",timestamp:Date.now()};
      const last=context.messages.at(-1),raw=last?.role==="user"?(typeof last.content==="string"?last.content:last.content.filter(p=>p.type==="text").map(p=>p.text).join("")):"";
      const text=raw.match(/^Role: \w+\. Task: ([\s\S]*)\nReturn a concise result and state what you verified\.$/)?.[1]??raw;
      stream.push({type:"start",partial:output});
      if(last?.role==="user"&&(text==="delegate worker"||text==="delegate researcher"||text==="delegate nested"||text==="delegate planner")){
        const call={type:"toolCall" as const,id:crypto.randomUUID(),name:"delegate",arguments:{role:text==="delegate researcher"?"researcher":text==="delegate planner"?"planner":"worker",task:text==="delegate nested"?"delegate researcher":"Return a result"}};
        output.content.push(call);stream.push({type:"toolcall_start",contentIndex:0,partial:output});stream.push({type:"toolcall_end",contentIndex:0,toolCall:call,partial:output});output.stopReason="toolUse";stream.push({type:"done",reason:"toolUse",message:output});
      }else{output.content.push({type:"text",text:"verified fixture response"});stream.push({type:"text_start",contentIndex:0,partial:output});stream.push({type:"text_delta",contentIndex:0,delta:"verified fixture response",partial:output});stream.push({type:"text_end",contentIndex:0,content:"verified fixture response",partial:output});output.stopReason="stop";stream.push({type:"done",reason:"stop",message:output});}
      stream.end();return stream;
    }});
  }
  const make=async()=>{const host=new PiHost(storage,scratch,async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);});await host.init();register(host);return host;};
  let host=await make();
  try{
    const catalog=await host.roles();assert.deepEqual(catalog.roles.map(r=>r.role),["planner","researcher","worker","reviewer","qa"]);
    const set=(role:string,model:string)=>{catalog.roles.find(r=>r.role===role)!.model=model;};
    set("planner","role-fixture/override");set("researcher","role-fixture/override");set("worker","role-fixture/child");set("reviewer","role-fixture/override");
    catalog.roles.find(r=>r.role==="worker")!.reasoning="high";catalog.roles.find(r=>r.role==="researcher")!.reasoning="medium";catalog.roles.find(r=>r.role==="planner")!.model=null;catalog.roles.find(r=>r.role==="planner")!.reasoning="xhigh";
    await assert.rejects(host.saveRoles({...catalog,roles:catalog.roles.map(r=>r.role==="reviewer"?{...r,reasoning:"xhigh"}:r)}),/Reasoning level is unavailable/,"An explicit model must support the saved level");
    const saved=await host.saveRoles(catalog),id=await host.create(scratch,"role-fixture/root");
    const initial=await host.snapshot(id);assert.equal(initial.model,"role-fixture/root","The chat model is the orchestrator");assert.equal(initial.policy!.requested.model,"role-fixture/root");
    const changed=structuredClone(saved);changed.roles.find(r=>r.role==="worker")!.model="role-fixture/override";await host.saveRoles(changed);
    await host.prompt(id,"delegate worker");await waitFor(async()=>(await host.snapshot(id)).status==="settled");
    const worker=(await host.snapshot(id)).agents.find(a=>a.role==="worker")!;assert.equal(worker.model,"role-fixture/child","A session keeps the roles snapshot it was created with");
    assert.ok(observed.some(call=>call.model==="root"&&call.instructions.includes("You are the orchestrator")),"The root session gets the orchestrator section");assert.ok(observed.filter(call=>call.model==="child").every(call=>!call.instructions.includes("You are the orchestrator")),"Children do not");
    const workerView=await host.childSnapshot(id,worker.id);assert.equal(workerView.policy!.role!.catalog.revision,saved.revision);assert.equal(workerView.policy!.role!.requestedReasoning,"high");
    assert.ok(observed.some(call=>call.model==="child"&&call.reasoning==="high"),"Actual Pi provider sees the mapped model and reasoning");
    await host.prompt(id,"delegate nested");await waitFor(async()=>(await host.snapshot(id)).status==="settled");
    const nested=(await host.snapshot(id)).agents.find(a=>a.role==="researcher")!;assert.notEqual(nested.parentId,id);assert.equal(nested.model,"role-fixture/override");
    await host.prompt(id,"delegate planner");await waitFor(async()=>(await host.snapshot(id)).status==="settled");
    const planner=(await host.snapshot(id)).agents.find(a=>a.role==="planner")!;assert.equal(planner.model,"role-fixture/root","Same as chat model");assert.equal((await host.childSnapshot(id,planner.id)).policy!.role!.requestedReasoning,null,"A saved level the chat model lacks falls back to the model default instead of failing");
    const plannerView=await host.childSnapshot(id,planner.id);assert.ok(!(plannerView.policy!.effective.profile.tools as readonly string[]).includes("write")&&!plannerView.policy!.workspace,"Planner is read-only like researcher, never a writer");
    await host.close();await storage.close();storage=new Storage(join(scratch,"state.sqlite"));host=await make();
    assert.equal((await host.roles()).revision,saved.revision+1);assert.equal((await host.snapshot(id)).policy!.role!.catalog.revision,saved.revision);
    await host.prompt(id,"delegate worker");await waitFor(async()=>(await host.snapshot(id)).status==="settled");
    assert.equal((await host.snapshot(id)).agents.filter(a=>a.role==="worker").at(-1)!.model,"role-fixture/child");
    const fresh=await host.create(scratch,"role-fixture/root");await host.prompt(fresh,"delegate worker");await waitFor(async()=>(await host.snapshot(fresh)).status==="settled");assert.equal((await host.snapshot(fresh)).agents.find(a=>a.role==="worker")!.model,"role-fixture/override");
    // A pre-0.4.0 catalog (groups, reasoning, instructions, a root override) still resolves: group model is the fallback, root ignores the catalog.
    const legacy={revision:3,groups:[{id:"g",name:"G",model:"role-fixture/override",reasoning:"high",instructions:"x"}],roles:[{role:"root",groupId:"g",model:"role-fixture/override",reasoning:"high",instructions:"x"},{role:"worker",groupId:"g",model:"role-fixture/child",reasoning:null,instructions:""},{role:"researcher",groupId:"g",model:null,reasoning:null,instructions:""}]} as any;
    assert.deepEqual(normalizeRoles(legacy),{revision:3,roles:[{role:"planner",model:null,reasoning:null},{role:"researcher",model:"role-fixture/override",reasoning:"high"},{role:"worker",model:"role-fixture/child",reasoning:"high"},{role:"reviewer",model:null,reasoning:null},{role:"qa",model:null,reasoning:null}]});
    assert.equal(resolveRole(legacy,"worker","chat/m").model,"role-fixture/child");assert.equal(resolveRole(legacy,"planner","chat/m").model,"chat/m");assert.equal(resolveRole(legacy,"researcher","chat/m").role.requestedReasoning,"high");assert.equal(resolveRole(legacy,"root","chat/m").role.requestedReasoning,null);
    assert.equal(resolveRole(legacy,"root","chat/m").model,"chat/m","Root ignores the catalog");assert.equal(resolveRole(legacy,"coordinator","chat/m").model,"chat/m");assert.equal(resolveRole(saved,"root","chat/m").model,"chat/m");
    assert.throws(()=>roleInput({revision:0,roles:[{role:"root",model:null,reasoning:null},...saved.roles.slice(1)]}),/known role/);assert.throws(()=>roleInput({...saved,roles:saved.roles.map((r,i)=>i?r:{...r,model:"bad model"})}));assert.throws(()=>roleInput({...saved,roles:saved.roles.slice(1)}));assert.throws(()=>roleInput({...saved,roles:[saved.roles[0],...saved.roles.slice(0,4)]}));
    // A catalog stored in the old shape is read through the normalizer, keeping its revision for the conflict check.
    await storage.call("saveRoles",{catalog:{revision:saved.revision+1,groups:[],roles:[]}});
    assert.equal((await host.roles()).revision,saved.revision+2);
    const folders=[join(scratch,"repo-a"),join(scratch,"repo-b")];
    for(const folder of folders){await mkdir(folder);const git=(...args:string[])=>execFileSync("git",["-C",folder,"-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false",...args],{env:{...process.env,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_AUTHOR_NAME:"Fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"Fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid"}});git("init","-q","-b","main");git("commit","--allow-empty","-qm","fixture");}
    let task=await snapshotProjectTask({id:crypto.randomUUID(),name:"Role dispatch fixture",folders},"role-fixture/child",crypto.randomUUID(),"fixture","direct");task.roleCatalog=saved;
    task=await host.prepareProjectTask(task);
    await storage.call("addProjectTask",{...task});
    for(const repo of task.repositories)await host.create(repo.sourceCwd,task.model,repo.sessionId,"parallel",{baseCommit:repo.baseCommit,workspaceMode:"direct",task:{id:task.id,repositoryId:repo.id},roleCatalog:task.roleCatalog});
    await host.createCoordinator(task);await storage.call("projectTaskStatus",{id:task.id,status:"running"});
    await host.prompt(task.coordinatorId,"Return coordinator result");await waitFor(async()=>(await host.snapshot(task.coordinatorId)).status==="settled");
    assert.equal((await host.snapshot(task.coordinatorId)).model,"role-fixture/child","Coordinator uses the chat model, never a catalog override");
    const repository=task.repositories[0];await host.prompt(repository.sessionId,"delegate worker");await waitFor(async()=>(await host.snapshot(repository.sessionId)).status==="settled");assert.equal((await host.snapshot(repository.sessionId)).agents.find(a=>a.role==="worker")!.model,"role-fixture/child","Task members share the task's admitted catalog, not the newly edited defaults");
    const reviewerId=crypto.randomUUID(),review=await host.startReviewer(repository.sessionId,reviewerId,folders[0],"Return reviewer result",new AbortController().signal);await review.done;
    assert.equal((await storage.call<{model:string}>("session",{id:reviewerId})).model,"role-fixture/override");assert.ok(observed.some(call=>call.model==="override"),"Revision review uses the mapped reviewer model in an actual Pi call");
    const chosen=await host.create(scratch,"role-fixture/root",undefined,"read",{reasoning:"high"});
    assert.equal((await host.snapshot(chosen)).policy!.role!.requestedReasoning,"high","An explicit session level overrides the role default");
    await host.prompt(chosen,"Return result");await waitFor(async()=>(await host.snapshot(chosen)).status==="settled");assert.ok(observed.some(call=>call.model==="root"&&call.reasoning==="high"),"The chosen level reaches the actual Pi call");
    await assert.rejects(host.create(scratch,"role-fixture/root",undefined,"read",{reasoning:"xhigh"}),/Reasoning level is unavailable/,"No silent clamp for a level the model does not accept");
    const levelTask=await host.prepareProjectTask({...await snapshotProjectTask({id:crypto.randomUUID(),name:"Reasoning fixture",folders},"role-fixture/child",crypto.randomUUID(),"fixture","direct"),roleCatalog:saved,reasoning:"medium"});
    assert.ok(levelTask.repositories.every(repo=>repo.setup!.role!.requestedReasoning==="medium")&&levelTask.coordinatorSetup!.role!.requestedReasoning==="medium","A task level is frozen into every repository and the coordinator");
    await assert.rejects(host.prepareProjectTask({...levelTask,reasoning:"max",repositories:levelTask.repositories.map(({setup,...repo})=>repo)}),/Reasoning level is unavailable/);
  }finally{await host.close();await storage.close();}
});

test("shutdown drains held creation and restored-session loading before storage can close",async()=>{
  process.env.SIGMA_DEMO="1";
  for(const boundary of ["create","restore","completion"] as const){
    const data=join(scratch,`shutdown-${boundary}`);await mkdir(data,{recursive:true});const storage=new Storage(join(data,"state.sqlite"));
    const make=async()=>{const host=new PiHost(storage,data,async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);});await host.init();return host;};
    let host=await make(),id:string=crypto.randomUUID();
    if(boundary!=="create"){id=await host.create(data,"sigma-demo/offline");if(boundary==="restore"){await host.close();host=await make();}}
    const original=storage.call.bind(storage);let release=()=>{},entered=()=>{};
    const gate=new Promise<void>(resolve=>{release=resolve;}),held=new Promise<void>(resolve=>{entered=resolve;});
    const commandId=crypto.randomUUID();if(boundary==="completion")await storage.call("command",{id:commandId,sessionId:id,kind:"prompt",requestHash:"fixture"});
    storage.call=async(op,args={})=>{if(boundary==="completion"?op==="commandStatus"&&args.status==="completed":op===(boundary==="create"?"roles":"delegationContext")){entered();await gate;}return original(op,args);};
    const admission=(boundary==="create"?host.create(data,"sigma-demo/offline",id):boundary==="restore"?host.snapshot(id):host.prompt(id,"hello",undefined,commandId)).then(()=>"opened",error=>String(error));
    let closing:Promise<void>|undefined;
    try{
      await held;closing=host.close();
      const state=await Promise.race([closing.then(()=>"closed"),new Promise<string>(resolve=>setTimeout(()=>resolve("pending"),100))]);
      assert.equal(state,"pending","Shutdown cannot return while an SDK/session admission is still held");
      release();if(boundary==="completion")assert.equal(await admission,"opened");else assert.match(await admission,/stopped|shutting down/i);await closing;
      assert.equal((await host.list()).some(row=>row.id===id),boundary!=="create","No new session was registered after shutdown began");
      if(boundary==="completion")assert.equal((await original<{status:string}>("command",{id:commandId,sessionId:id,kind:"prompt",requestHash:"fixture"})).status,"completed","Prompt completion is persisted before close returns");
    }finally{release();await admission;await closing;await host.close();await storage.close();}
  }
});

test("project agent overrides replace only the fields they set and fall back when the layers disagree on reasoning",()=>{
  const global=normalizeRoles({revision:3,roles:[{role:"planner",model:"a/deep",reasoning:"max"},{role:"worker",model:"a/fast",reasoning:"low"},{role:"qa",model:null,reasoning:"high"}]});
  const levels=(model:string)=>({"a/deep":["low","medium","high","max"],"a/fast":["low"],"b/tiny":["off"]} as Record<string,string[]>)[model];
  assert.deepEqual(applyProjectAgents(global,[],levels),global,"No overrides keeps the global catalog");
  const merged=applyProjectAgents(global,[{role:"planner",reasoning:"medium"},{role:"worker",model:"a/deep"},{role:"qa",model:"b/tiny"},{role:"reviewer",model:null,reasoning:null}],levels);
  assert.equal(merged.revision,3);
  assert.deepEqual(merged.roles.find(r=>r.role==="planner"),{role:"planner",model:"a/deep",reasoning:"medium"},"Reasoning only keeps the global model");
  assert.deepEqual(merged.roles.find(r=>r.role==="worker"),{role:"worker",model:"a/deep",reasoning:"low"},"A supported global level stays with the project model");
  assert.deepEqual(merged.roles.find(r=>r.role==="qa"),{role:"qa",model:"b/tiny",reasoning:null},"A global level the project model lacks falls back to the model default");
  assert.deepEqual(merged.roles.find(r=>r.role==="reviewer"),{role:"reviewer",model:null,reasoning:null});
  assert.deepEqual(merged.roles.find(r=>r.role==="researcher"),global.roles.find(r=>r.role==="researcher"));
  assert.deepEqual(projectAgentsInput([{role:"worker"},{role:"qa",model:null}]),[{role:"qa",model:null}],"Rows that change nothing are dropped");
  for(const bad of [null,{},[{role:"root"}],[{role:"qa",model:"x"}],[{role:"qa",reasoning:"huge"}],[{role:"qa"},{role:"qa"}],[{role:"qa",groupId:"g"}]])assert.throws(()=>projectAgentsInput(bad),`${JSON.stringify(bad)} is rejected`);
  assert.deepEqual(normalizeProjectAgents([{role:"qa",model:"bad"},{role:"worker",reasoning:"low"},{role:"worker",reasoning:"high"},"junk"]),[{role:"worker",reasoning:"low"}],"Stored junk is ignored on read");
});
