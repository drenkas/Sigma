import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { Storage } from "./storage.js";
import { PiHost } from "./pi-host.js";
import type { GraphSnapshot, GraphFact } from "../../packages/contracts/index.js";

const root=resolve(import.meta.dirname,"../.."),scratch=join(root,".scratch/nested-delegation-2026-10-02",`tests-${Date.now()}-${process.pid}`);
process.env.PI_OFFLINE="1";process.env.SIGMA_DEMO="1";process.env.PI_CODING_AGENT_DIR=join(scratch,"agent");
async function waitFor(check:()=>Promise<boolean>,ms=8000){const until=Date.now()+ms;while(Date.now()<until){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw new Error("Timed out waiting for state");}
async function fixture(name:string){const data=join(scratch,name);await mkdir(data,{recursive:true});const storage=new Storage(join(data,"state.sqlite"));const host=new PiHost(storage,data,async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);});await host.init();return {data,storage,host,close:async()=>{await host.close();await storage.close();}};}
async function entries(storage:Storage,id:string){const row=await storage.call<{file:string}>("session",{id});return (await readFile(row.file,"utf8")).trim().split("\n").map(line=>JSON.parse(line));}
const toolErrors=async(storage:Storage,id:string)=>(await entries(storage,id)).filter(entry=>entry.message?.role==="toolResult"&&entry.message.isError).map(entry=>entry.message.content.map((part:any)=>part.text??"").join(" ")).join(" ");

test("nested Pi delegation persists immediate caller receipts and recursive inventory",async()=>{
  const f=await fixture("chain");
  try{
    const id=await f.host.create(f.data,"sigma-demo/offline");
    await f.host.prompt(id,"delegate:delegate:small result");
    await waitFor(async()=>(await f.host.snapshot(id)).status==="settled");
    const view=await f.host.snapshot(id);
    assert.equal(view.agents.length,3,"Root, child and grandchild are actual Pi sessions");
    const child=view.agents.find(agent=>agent.parentId===id)!,grandchild=view.agents.find(agent=>agent.parentId===child.id)!;
    const graph=await f.storage.call<GraphSnapshot>("graphSnapshot",{scopeId:id});
    assert.deepEqual(new Set(graph.nodes.map(node=>node.id)),new Set([id,child.id,grandchild.id]));
    for(const [caller,callee] of [[id,child.id],[child.id,grandchild.id]]){
      const receipt=graph.events.filter(event=>event.type==="graph_fact").map(event=>event.payload as GraphFact).find(fact=>fact.kind==="result"&&fact.target===caller&&fact.source===callee&&fact.outcome==="received")!;
      assert.ok(receipt?.receiptEntryId&&receipt.sourceEntryId&&receipt.run?.runId&&receipt.sourceRun?.runId,"Receipt cites persisted Pi entries and both actual runs");
      const row=await f.storage.call<{file:string}>("session",{id:caller});
      const entries=(await readFile(row.file,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
      const entry=entries.find(entry=>entry.id===receipt.receiptEntryId);
      assert.equal(entry.message.role,"toolResult");assert.equal(entry.message.toolName,"delegate");assert.equal(entry.message.toolCallId,receipt.toolCallId);
    }
  }finally{await f.close();}
});

test("restored version 1 and null policies retain restrictive nested tool rights",async()=>{
  const f=await fixture("legacy"),ids:string[]=[],policies:any[]=[];
  for(let index=0;index<3;index++){const id=await f.host.create(f.data,"sigma-demo/offline");ids.push(id);await f.host.prompt(id,"hello");await waitFor(async()=>(await f.host.snapshot(id)).status==="settled");policies.push((await f.host.snapshot(id)).policy);}
  await f.close();
  const db=new DatabaseSync(join(f.data,"state.sqlite"));
  policies[0].version=1;policies[0].effective.profile.maxDepth=1;
  policies[1]=null;policies[2].version=1;policies[2].effective.profile.maxDepth=0;policies[2].effective.profile.rootTotalChildren=0;
  for(let index=0;index<3;index++)db.prepare("UPDATE sessions SET policy=? WHERE id=?").run(JSON.stringify(policies[index]),ids[index]);db.close();
  const storage=new Storage(join(f.data,"state.sqlite")),host=new PiHost(storage,f.data,async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);});await host.init();
  try{for(let index=0;index<3;index++){await host.prompt(ids[index],"delegate:delegate:legacy");await waitFor(async()=>(await host.snapshot(ids[index])).status==="settled");const view=await host.snapshot(ids[index]);assert.deepEqual(view.policy,policies[index]);assert.equal(view.agents.length,index===2?1:2);if(index<2)assert.match(await toolErrors(storage,view.agents[1].id),/not found|disabled/i);}}
  finally{await host.close();await storage.close();}
});

test("nested delegation has no agent-count limit but still enforces depth",async()=>{
  const f=await fixture("limits");
  try{
    const id=await f.host.create(f.data,"sigma-demo/offline");
    await f.host.prompt(id,"delegate:delegate:seed");await waitFor(async()=>(await f.host.snapshot(id)).status==="settled");
    await f.host.prompt(id,"delegate:third");await waitFor(async()=>(await f.host.snapshot(id)).status==="settled");
    await f.host.prompt(id,"delegate2: fourth A | fourth B");await waitFor(async()=>(await f.host.snapshot(id)).status==="settled");
    assert.equal((await f.host.snapshot(id)).agents.length,6,"Both children of the last prompt are admitted");
    await f.host.prompt(id,"delegate:overflow");await waitFor(async()=>(await f.host.snapshot(id)).status==="settled");assert.equal((await f.host.snapshot(id)).agents.length,7,"More than four children can be delegated from one root");
    const blocker=await f.host.create(f.data,"sigma-demo/offline");await writeFile(join(f.data,"safe.txt"),"safe\n");
    await f.host.prompt(blocker,"delegate:read:safe.txt");await waitFor(async()=>(await f.host.snapshot(blocker)).approvals.some(approval=>approval.status==="pending"));
    const chain=await f.host.create(f.data,"sigma-demo/offline");await f.host.prompt(chain,"delegate:delegate:service overflow");await waitFor(async()=>(await f.host.snapshot(chain)).status==="settled");
    const view=await f.host.snapshot(chain);assert.equal(view.agents.length,3,"A pending approval elsewhere does not block new children");assert.doesNotMatch(await toolErrors(f.storage,view.agents[1].id),/limit reached/);
    await f.host.abort(blocker);
    const depth=await f.host.create(f.data,"sigma-demo/offline");await f.host.prompt(depth,"delegate:delegate:delegate:too deep");await waitFor(async()=>(await f.host.snapshot(depth)).status==="settled");
    const deep=await f.host.snapshot(depth);assert.equal(deep.agents.length,3);assert.match(await toolErrors(f.storage,deep.agents[2].id),/not found|disabled/i);
  }finally{await f.close();}
});

test("addressed subtree Stop isolates siblings and settled or idle root Stop cancels descendant follow-ups",async()=>{
  const f=await fixture("stop");
  try{
    await writeFile(join(f.data,"safe.txt"),"safe\n");const id=await f.host.create(f.data,"sigma-demo/offline");
    await f.host.prompt(id,"delegate:delegate:seed");await waitFor(async()=>(await f.host.snapshot(id)).status==="settled");
    let view=await f.host.snapshot(id);const child=view.agents.find(agent=>agent.parentId===id)!,grandchild=view.agents.find(agent=>agent.parentId===child.id)!;
    await f.host.prompt(id,"delegate:sibling");await waitFor(async()=>(await f.host.snapshot(id)).status==="settled");
    const sibling=(await f.host.snapshot(id)).agents.find(agent=>agent.parentId===id&&agent.id!==child.id)!;
    await f.host.prompt(grandchild.id,"read:safe.txt",undefined,undefined,id);
    await f.host.prompt(sibling.id,"read:safe.txt",undefined,undefined,id);
    await waitFor(async()=>(await f.host.snapshot(id)).approvals.filter(approval=>approval.status==="pending").length===2);
    view=await f.host.snapshot(id);const pending=view.approvals.find(approval=>approval.agentId===grandchild.id&&approval.status==="pending")!;
    await f.host.abortChild(id,child.id);view=await f.host.snapshot(id);
    assert.equal(view.status,"settled");assert.equal(view.agents.find(agent=>agent.id===child.id)!.status,"settled","Earlier parent result remains terminal");assert.equal(view.agents.find(agent=>agent.id===grandchild.id)!.status,"interrupted");assert.equal(view.agents.find(agent=>agent.id===sibling.id)!.status,"running");
    assert.equal(view.approvals.find(approval=>approval.id===pending.id)!.status,"denied");await assert.rejects(f.host.decide(id,pending.id,true),/no longer pending/);
    await f.host.abort(id);view=await f.host.snapshot(id);assert.equal(view.status,"settled");assert.equal(view.agents.find(agent=>agent.id===sibling.id)!.status,"interrupted");assert.equal(view.approvals.some(approval=>approval.status==="pending"),false);
    // The other earlier settled child can resume independently while root is idle.
    await f.storage.call("status",{id,status:"idle"});
    await f.host.prompt(child.id,"read:safe.txt",undefined,undefined,id);await waitFor(async()=>(await f.host.snapshot(id)).approvals.some(approval=>approval.status==="pending"));
    await f.host.abort(id);assert.equal((await f.storage.call<any>("session",{id})).status,"idle");assert.equal((await f.host.snapshot(id)).agents.find(agent=>agent.id===child.id)!.status,"interrupted");
    const foreign=await f.host.create(f.data,"sigma-demo/offline");await assert.rejects(f.host.childSnapshot(foreign,grandchild.id),/belong/);await assert.rejects(f.host.childSnapshot(child.id,grandchild.id),/belong/);await assert.rejects(f.host.abortChild(foreign,grandchild.id),/belong/);
  }finally{await f.close();}
});

test("lone nested workers edit the root working copy in place with per-action approvals; reviewers are not capped",async()=>{
  const f=await fixture("writers"),source=join(f.data,"source");await mkdir(source);
  const git=(...args:string[])=>execFileSync("git",["-C",source,"-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false",...args],{env:{...process.env,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_AUTHOR_NAME:"Fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"Fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid"}});
  git("init","-q","-b","main");await writeFile(join(source,"seed.txt"),"base\n");git("add","seed.txt");git("commit","-qm","fixture");await writeFile(join(source,"seed.txt"),"staged\n");git("add","seed.txt");await writeFile(join(source,"seed.txt"),"dirty\n");await writeFile(join(source,"notes.txt"),"untracked\n");const index=await readFile(join(source,".git/index"));
  try{
    const id=await f.host.create(source,"sigma-demo/offline",crypto.randomUUID(),"parallel");
    await f.host.prompt(id,'delegate2:delegate2:write:{"path":"target.txt","content":"isolated\\n"}');
    await waitFor(async()=>(await f.host.snapshot(id)).approvals.some(approval=>approval.status==="pending"));
    let view=await f.host.snapshot(id);const child=view.agents.find(agent=>agent.parentId===id)!,grandchild=view.agents.find(agent=>agent.parentId===child.id)!;
    assert.equal(child.role,"worker");assert.equal(grandchild.role,"worker");assert.equal(new Set([view.cwd,child.cwd,grandchild.cwd]).size,1,"a lone worker chain edits the root's own working copy");assert.equal(child.cwd,source);
        const denied=view.approvals.find(approval=>approval.status==="pending")!;assert.equal(denied.agentId,grandchild.id);await f.host.decide(id,denied.id,false);await waitFor(async()=>(await f.host.snapshot(id)).status==="settled");
    await assert.rejects(readFile(join(grandchild.cwd,"target.txt")));
    await f.host.prompt(grandchild.id,'write:{"path":"target.txt","content":"approved\\n"}',undefined,undefined,id);await waitFor(async()=>(await f.host.snapshot(id)).approvals.some(approval=>approval.status==="pending"));
    const approved=(await f.host.snapshot(id)).approvals.find(approval=>approval.status==="pending")!;assert.equal(approved.agentId,grandchild.id);await f.host.decide(id,approved.id,true);await waitFor(async()=>(await f.host.snapshot(id)).agents.find(agent=>agent.id===grandchild.id)!.status==="settled");
    assert.equal(await readFile(join(grandchild.cwd,"target.txt"),"utf8"),"approved\n");assert.equal(await readFile(join(source,"target.txt"),"utf8"),"approved\n");assert.equal(await readFile(join(source,"seed.txt"),"utf8"),"dirty\n");assert.equal(await readFile(join(source,"notes.txt"),"utf8"),"untracked\n");assert.deepEqual(await readFile(join(source,".git/index")),index);
    await f.host.prompt(child.id,'delegate:write:{"path":"reader-escape.txt","content":"bad"}',undefined,undefined,id);await waitFor(async()=>(await f.host.snapshot(id)).agents.find(agent=>agent.id===child.id)!.status==="settled");
    view=await f.host.snapshot(id);const reader=view.agents.find(agent=>agent.parentId===child.id&&agent.id!==grandchild.id)!;assert.equal(reader.role,"researcher");assert.equal((await f.host.snapshot(reader.id)).policy?.workspace,undefined);assert.match(await toolErrors(f.storage,reader.id),/not found|disabled/i);await assert.rejects(readFile(join(child.cwd,"reader-escape.txt")));
    const reviewId=crypto.randomUUID(),review=await f.host.startReviewer(id,reviewId,f.data,"delegate:must remain read only",new AbortController().signal);assert.match(await review.done,/denied or failed/);assert.equal((await f.host.snapshot(id)).agents.length,5);
    const extra=await f.host.startReviewer(id,crypto.randomUUID(),f.data,"second review",new AbortController().signal);await extra.done;
    const policy=(await f.host.snapshot(reviewId)).policy!;assert.equal(policy.effective.profile.maxDepth,0);assert.deepEqual(policy.effective.profile.tools,["read","ls"]);
    // Hold a real Allow after its durable decision, when it is no longer in Pending.
    const call=f.storage.call.bind(f.storage);let release!:()=>void,approvedReady!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{approvedReady=resolve;});
    (f.storage as any).call=async(op:string,args:any={})=>{const result=await call(op,args);if(op==="approvalStatus"&&args.status==="approved"){approvedReady();await gate;}return result;};
    await f.host.prompt(grandchild.id,'write:{"path":"stopped.txt","content":"must not write"}',undefined,undefined,id);await waitFor(async()=>(await f.host.snapshot(id)).approvals.some(approval=>approval.status==="pending"));
    const late=(await f.host.snapshot(id)).approvals.find(approval=>approval.status==="pending")!,allow=f.host.decide(id,late.id,true);await ready;
    const releaseFence=f.host.stopFence(id),stopped=f.host.abort(id);await waitFor(async()=>(await f.host.snapshot(id)).agents.find(agent=>agent.id===grandchild.id)!.status==="interrupted");release();await Promise.all([allow,stopped]);releaseFence();
    await assert.rejects(readFile(join(grandchild.cwd,"stopped.txt")));assert.deepEqual(await readFile(join(source,".git/index")),index);
  }finally{await f.close();}
});

test("Stop fences nested admission before session or workspace allocation",async()=>{
  const f=await fixture("admission-stop"),call=f.storage.call.bind(f.storage);let release!:()=>void,admitted!:(id:string)=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<string>(resolve=>{admitted=resolve;});const id=await f.host.create(f.data,"sigma-demo/offline");
  (f.storage as any).call=async(op:string,args:any={})=>{const result=await call(op,args);if(op==="reserveChild"&&args.parentId!==id){admitted(args.agentId);await gate;}return result;};
  try{await f.host.prompt(id,"delegate:delegate:read:never.txt");const grandchild=await ready,stopped=f.host.abort(id);await waitFor(async()=>(await f.storage.call<any>("session",{id})).status==="interrupted");release();await stopped;assert.equal(await f.storage.call("session",{id:grandchild}),undefined);assert.equal((await f.host.snapshot(id)).agents.length,2);assert.equal((await f.host.snapshot(id)).approvals.length,0);}
  finally{release();await f.close();}
});

test("real nested admission, approval and recipient-receipt crashes keep identities and never replay",async()=>{
  for(const site of ["admission","approval","receipt"]){
    const data=join(scratch,`crash-${site}`);await mkdir(data,{recursive:true});await writeFile(join(data,"safe.txt"),"safe\n");const id=crypto.randomUUID(),dbPath=join(data,"state.sqlite");
    const script=`import { Storage } from ${JSON.stringify(join(root,"apps/server/storage.ts"))};import { PiHost } from ${JSON.stringify(join(root,"apps/server/pi-host.ts"))};
      const storage=new Storage(${JSON.stringify(dbPath)}),site=${JSON.stringify(site)},rootId=${JSON.stringify(id)};
      const call=storage.call.bind(storage);storage.call=async(op,args={})=>{const result=await call(op,args);if(site==='admission'&&op==='reserveChild'&&args.parentId!==rootId)process.kill(process.pid,'SIGKILL');return result;};
      const host=new PiHost(storage,${JSON.stringify(data)},async(sessionId,type,payload,durable)=>{if(durable)await storage.event(sessionId,type,payload);if(site==='approval'&&type==='approval')process.kill(process.pid,'SIGKILL');if(site==='receipt'&&type==='graph_fact'&&payload.kind==='result'&&payload.target!==rootId&&payload.outcome==='unknown')process.kill(process.pid,'SIGKILL');});await host.init();await host.create(${JSON.stringify(data)},'sigma-demo/offline',rootId);await host.prompt(rootId,site==='receipt'?'delegate:delegate:small result':'delegate:delegate:read:safe.txt');`;
    const scriptPath=join(data,"crash.mjs");await writeFile(scriptPath,script);
    const child=spawn(process.execPath,["--import","tsx",scriptPath],{cwd:root,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,HOME:data,SIGMA_APPROVAL_MODE:"ask",PI_OFFLINE:"1",SIGMA_DEMO:"1",PI_CODING_AGENT_DIR:join(data,"agent")},stdio:["ignore","ignore","pipe"]});let diagnostic="";child.stderr.on("data",part=>{diagnostic=(diagnostic+part).slice(-1000);});const ended=new Promise<string|null>(resolve=>child.once("exit",(_code,signal)=>resolve(signal)));const timer=setTimeout(()=>child.kill("SIGTERM"),20000);try{assert.equal(await ended,"SIGKILL",diagnostic);}finally{clearTimeout(timer);}
    const storage=new Storage(dbPath),host=new PiHost(storage,data,async(sessionId,type,payload,durable)=>{if(durable)await storage.event(sessionId,type,payload);});await host.init();
    try{
      const view=await host.snapshot(id),parent=view.agents.find(agent=>agent.parentId===id)!;assert.equal(view.agents.length,site==="admission"?2:3);assert.equal(view.policy?.version,2);
      const actions=await storage.call<any[]>("recoveryActions",{sessionId:parent.id});const commands=new DatabaseSync(dbPath,{readOnly:true});const command=commands.prepare("SELECT id,agent_id AS agentId,reserved,status FROM commands WHERE session_id=? AND kind='delegate'").get(parent.id) as any;commands.close();
      assert.equal(command.reserved,1);assert.equal(command.status,site==="receipt"?"completed":"unknown");if(site!=="receipt")assert.equal(actions[0].agentId,command.agentId);
      const graph=await storage.call<GraphSnapshot>("graphSnapshot",{scopeId:id});const facts=graph.events.filter(event=>event.type==="graph_fact").map(event=>event.payload as GraphFact);assert.equal(facts.some(fact=>fact.kind==="result"&&fact.source===command.agentId&&fact.outcome==="received"),false);
      if(site==="approval"){assert.equal(view.approvals[0].agentId,command.agentId);assert.equal(view.approvals[0].status,"expired");await assert.rejects(host.decide(id,view.approvals[0].id,true),/no longer pending/);}
      await host.snapshot(parent.id);const native=(host as any).active.get(parent.id).session,tool=native.getToolDefinition("delegate"),toolCallId=command.id.slice(`pi-tool:${parent.id}:`.length);await assert.rejects(tool.execute(toolCallId,{role:"researcher",task:site==="receipt"?"small result":"read:safe.txt"}),/Previous delegate tool call/);
      assert.deepEqual((await host.snapshot(id)).agents.map(agent=>agent.id),view.agents.map(agent=>agent.id));assert.deepEqual((await storage.call<GraphSnapshot>("graphSnapshot",{scopeId:id})).events,graph.events);
      // Two more lifetime units fit, regardless of whether the uncertain grandchild row exists.
      await host.prompt(id,"delegate2:remaining A | remaining B");await waitFor(async()=>(await host.snapshot(id)).status==="settled");const count=(await host.snapshot(id)).agents.length;
      await host.prompt(id,"delegate:must reject");await waitFor(async()=>(await host.snapshot(id)).status==="settled");assert.equal((await host.snapshot(id)).agents.length,count+1,"Delegation is not capped");
    }finally{await host.close();await storage.close();}
  }
});


test("HTTP Stop cancels prompt admission held before host dispatch and waits without blocking fresh commands",async()=>{
  const data=join(scratch,"prompt-stop");await mkdir(data,{recursive:true});await writeFile(join(data,"safe.txt"),"safe\n");
  const socket=createServer();await new Promise<void>(done=>socket.listen(0,"127.0.0.1",done));const port=(socket.address() as {port:number}).port;await new Promise<void>(done=>socket.close(()=>done()));
  const origin=`http://127.0.0.1:${port}`,script=join(data,"server.mjs");
  await writeFile(script,`
    import {Storage} from ${JSON.stringify(join(root,"apps/server/storage.ts"))};
    let hold,release;const call=Storage.prototype.call;
    process.on('message',message=>{if(message==='release'){release?.();hold=undefined;}else{hold={...message};process.send('armed');}});
    Storage.prototype.call=async function(op,args={}){const result=await call.call(this,op,args);if(hold&&!hold.used&&op===hold.op&&(op==='descendantMember'?args.agentId===hold.id:op==='command'?args.sessionId===hold.id&&(hold.kind==='create'?args.kind==='create':args.inputText==='read:safe.txt'):args.sessionId===hold.id&&args.type==='graph_fact'&&args.payload?.cause==='user_child_message')){if(hold.skip){hold.skip--;return result;}hold.used=true;process.send('held');await new Promise(done=>{release=done;});}return result;};
    await import(${JSON.stringify(join(root,"apps/server/main.ts"))});`);
  const server=spawn(process.execPath,["--import","tsx",script],{cwd:root,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,HOME:data,SIGMA_APPROVAL_MODE:"ask",PI_OFFLINE:"1",PI_CODING_AGENT_DIR:join(data,"agent"),SIGMA_DEMO:"1",SIGMA_PORT:String(port),SIGMA_DATA_DIR:join(data,"state")},stdio:["ignore","pipe","pipe","ipc"]});
  const messages:string[]=[];server.on("message",message=>messages.push(String(message)));let output="";for(const stream of [server.stdout,server.stderr])stream?.on("data",chunk=>{output=(output+String(chunk)).slice(-1000);});
  try{
    await waitFor(async()=>{if(server.exitCode!==null||server.signalCode!==null)throw new Error(`Fixture exited: ${output}`);try{return (await fetch(origin,{signal:AbortSignal.timeout(1000)})).ok;}catch{return false;}},120000);
    const boot=await fetch(`${origin}/api/bootstrap`,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:"{}"}),cookie=boot.headers.get("set-cookie")!.split(";")[0];
    const req=async(path:string,method="GET",body?:unknown,commandId=crypto.randomUUID())=>{const response=await fetch(`${origin}/api${path}`,{method,headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json","X-Command-Id":commandId},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
    const source=join(data,"create-source");await mkdir(source);await writeFile(join(source,"tracked.txt"),"baseline\n");
    for(const args of [["init"],["add","tracked.txt"],["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","fixture"]])execFileSync("git",args,{cwd:source,stdio:"ignore"});
    const createId=crypto.randomUUID(),before=execFileSync("git",["worktree","list","--porcelain"],{cwd:source,encoding:"utf8"});
    server.send({op:"command",kind:"create",id:createId});await waitFor(async()=>messages.includes("armed"));messages.length=0;
    const creating=req("/sessions","POST",{cwd:source,model:"sigma-demo/offline",mode:"code",workspaceMode:"worktree"},createId);await waitFor(async()=>messages.includes("held"));messages.length=0;
    const stopping=req(`/sessions/${createId}/abort`,"POST",{});let stopReturned=false;void stopping.then(()=>{stopReturned=true;},()=>{});await new Promise(done=>setTimeout(done,100));const stoppedBeforeRelease=stopReturned;
    server.send("release");const [createResult,stopResult]=await Promise.all([creating,stopping]);
    assert.equal(stopResult.status,200,"Stop owns a create admission before its session row exists");assert.equal(stoppedBeforeRelease,false,"Stop drains the held create command and durable finalizer");assert.equal(createResult.status,400);assert.equal(createResult.data.status,"rejected");
    assert.equal((await req(`/sessions/${createId}`)).status,404);assert.equal(execFileSync("git",["worktree","list","--porcelain"],{cwd:source,encoding:"utf8"}),before,"Cancelled HTTP create cannot allocate a late worktree");
    assert.equal((await req("/sessions","POST",{cwd:source,model:"sigma-demo/offline",mode:"code",workspaceMode:"worktree"},createId)).data.status,"rejected","Create finalization is durable without replay");
    const rootId=(await req("/sessions","POST",{cwd:data,model:"sigma-demo/offline"})).data.id;
    await req(`/sessions/${rootId}/prompt`,"POST",{text:"delegate:delegate:seed"});await waitFor(async()=>(await req(`/sessions/${rootId}`)).data.status==="settled");
    await req(`/sessions/${rootId}/prompt`,"POST",{text:"delegate:sibling"});await waitFor(async()=>(await req(`/sessions/${rootId}`)).data.status==="settled");
    const view=(await req(`/sessions/${rootId}`)).data,child=view.agents.find((a:any)=>a.parentId===rootId),grandchild=view.agents.find((a:any)=>a.parentId===child.id),sibling=view.agents.find((a:any)=>a.parentId===rootId&&a.id!==child.id);
    for(const stage of [{op:"descendantMember",skip:0,scope:rootId},{op:"descendantMember",skip:1,scope:child.id},{op:"event",skip:0,scope:rootId},{op:"command",skip:0,scope:rootId}]){
      const target=stage.op==="command"?rootId:grandchild.id;
      server.send({...stage,id:target});await waitFor(async()=>messages.includes("armed"));messages.length=0;
      const prompted=req(stage.op==="command"?`/sessions/${rootId}/prompt`:`/sessions/${rootId}/agents/${target}/prompt`,"POST",{text:"read:safe.txt"});await waitFor(async()=>messages.includes("held"));messages.length=0;
      const stopped=req(stage.scope===rootId?`/sessions/${rootId}/abort`:`/sessions/${rootId}/agents/${stage.scope}/abort`,"POST",{});
      // A held transport keeps admission in flight beyond the old transient Stop fence.
      let returned=false;void stopped.then(()=>{returned=true;},()=>{});await new Promise(done=>setTimeout(done,100));const returnedBeforeRelease=returned;
      server.send("release");const [promptResult,stopResult]=await Promise.all([prompted,stopped]);
      assert.equal(promptResult.status,409,`${stage.op}/${stage.skip}: a pre-Stop prompt must not dispatch after the fence is released`);assert.equal(stopResult.status,200);assert.equal(returnedBeforeRelease,false,"Stop waits for the cancelled admission to unwind");
      const after=(await req(`/sessions/${rootId}`)).data;assert.equal(after.approvals.some((a:any)=>a.status==="pending"),false);assert.equal(after.agents.find((a:any)=>a.id===sibling.id).status,"settled");assert.equal(after.agents.find((a:any)=>a.id===child.id).status,"settled");
      const freshTarget=stage.op==="event"?sibling.id:target;
      const fresh=await req(freshTarget===rootId?`/sessions/${rootId}/prompt`:`/sessions/${rootId}/agents/${freshTarget}/prompt`,"POST",{text:"fresh explicit command"});assert.equal(fresh.status,200);await waitFor(async()=>{const current=(await req(`/sessions/${rootId}`)).data;return (freshTarget===rootId?current:current.agents.find((a:any)=>a.id===freshTarget)).status==="settled";});
    }
  }finally{
    if(server.connected)server.send("release");if(server.exitCode===null&&server.signalCode===null){const exited=new Promise<void>(done=>server.once("exit",()=>done()));server.kill("SIGTERM");await Promise.race([exited,new Promise(done=>setTimeout(done,5000))]);if(server.exitCode===null&&server.signalCode===null){server.kill("SIGKILL");await exited;}}
  }
});
