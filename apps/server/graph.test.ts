import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Storage } from "./storage.js";
import { PiHost } from "./pi-host.js";
import type { GraphFact, GraphSnapshot } from "../../packages/contracts/index.js";
const root=resolve(import.meta.dirname,"../.."),scratch=join(process.env.SIGMA_TEST_DIR||join(root,".scratch"),`graph-${Date.now()}-${process.pid}`);

test("graph cursor pages preserve scope, legacy gaps, and an explicit bounded history",async()=>{
  await mkdir(scratch,{recursive:true});const storage=new Storage(join(scratch,"cursor.sqlite"));
  const sid=randomUUID(),foreign=randomUUID();
  try{
    for(const id of [sid,foreign])await storage.call("addSession",{id,cwd:scratch,file:join(scratch,id),model:"legacy/model"});
    let snapshot=await storage.call<GraphSnapshot>("graphSnapshot",{scopeId:sid});
    assert.equal(snapshot.nodes[0].creationAvailable,false);assert.equal(snapshot.nodes[0].metadata.reasoningAvailability,"unavailable");
    await assert.rejects(storage.call("graphMember",{scopeId:sid,nodeId:foreign}),/outside/);
    const expected:number[]=[];
    for(let index=0;index<2101;index++){
      const event=await storage.event(sid,"graph_run",{runId:String(index),model:"provider/model",reasoning:"high",reasoningAvailability:"available",title:null});expected.push(event.seq);
      if(index%100===0)await storage.event(foreign,"graph_run",{runId:"foreign"});
    }
    snapshot=await storage.call<GraphSnapshot>("graphSnapshot",{scopeId:sid});
    assert.equal(snapshot.truncated,true);assert.equal(snapshot.totalEvents,2101);assert.equal(snapshot.events.length,2000);
    assert.deepEqual(snapshot.events.map(event=>event.seq),expected.slice(-2000));
    let after=0;const delivered:number[]=[];
    while(true){const page=await storage.call<GraphSnapshot>("graphSnapshot",{scopeId:sid,after});delivered.push(...page.events.map(event=>event.seq));assert.ok(page.events.length<=500);after=page.cursor;if(!page.hasMore)break;}
    assert.deepEqual(delivered,expected,"Interleaved foreign events neither create a gap nor enter this scope");
    assert.equal(new Set(delivered).size,2101);
    assert.equal((await storage.call<GraphSnapshot>("graphSnapshot",{scopeId:sid,after})).events.length,0);
    await assert.rejects(storage.call("graphSnapshot",{scopeId:sid,after:after+1}),/cursor/);
  }finally{await storage.close();}
});

test("crash after completed delegation and before persisted recipient tool result leaves unknown receipt without replay",async()=>{
  const data=join(scratch,"receipt-crash");await mkdir(data,{recursive:true});const id=randomUUID();
  // The existing host transport boundary is the crash site; no product-only hook is added.
  const script=`import { Storage } from ${JSON.stringify(join(root,'apps/server/storage.ts'))}; import { PiHost } from ${JSON.stringify(join(root,'apps/server/pi-host.ts'))};
    const storage=new Storage(${JSON.stringify(join(data,"state.sqlite"))});
    const host=new PiHost(storage,${JSON.stringify(data)},async(sessionId,type,payload,durable)=>{
      if(durable)await storage.event(sessionId,type,payload);
      if(type==='graph_fact'&&payload.kind==='result'&&payload.outcome==='unknown')process.kill(process.pid,'SIGKILL');
    });await host.init();await host.create(${JSON.stringify(data)},'sigma-demo/offline',${JSON.stringify(id)});
    await host.prompt(${JSON.stringify(id)},'delegate:small independent result');`;
  const scriptPath=join(data,"crash.mjs");await writeFile(scriptPath,script);
  const child=spawn(process.execPath,["--import","tsx",scriptPath],{cwd:root,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,HOME:data,SIGMA_APPROVAL_MODE:"ask",PI_OFFLINE:"1",SIGMA_DEMO:"1",PI_CODING_AGENT_DIR:join(data,"agent")},stdio:["ignore","ignore","pipe"]});
  let diagnostic="";child.stderr.on("data",part=>{diagnostic=(diagnostic+part).slice(-1000);});
  const ended=new Promise<string|null>(resolve=>child.once("exit",(_code,signal)=>resolve(signal)));
  const timer=setTimeout(()=>child.kill("SIGKILL"),15000);
  try{assert.equal(await ended,"SIGKILL",diagnostic);}finally{clearTimeout(timer);}
  const storage=new Storage(join(data,"state.sqlite"));
  try{
    const snapshot=await storage.call<GraphSnapshot>("graphSnapshot",{scopeId:id});
    assert.equal(snapshot.nodes.length,2);
    const receipt=snapshot.events.filter(event=>event.type==="graph_fact"&&(event.payload as GraphFact).kind==="result");
    assert.equal(receipt.length,1);assert.equal((receipt[0].payload as GraphFact).outcome,"unknown");
    const dispatch=snapshot.events.filter(event=>event.type==="graph_fact"&&(event.payload as GraphFact).kind==="delegation").at(-1)!;
    assert.equal((dispatch.payload as GraphFact).outcome,"dispatched","Completed delegate command does not prove receipt");
    const record=await storage.call<{file:string}>("session",{id});
    const entries=(await readFile(record.file,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    assert.equal(entries.some(entry=>entry.message?.role==="toolResult"),false,"The recipient result was not persisted before the crash");
    assert.deepEqual((await storage.call<GraphSnapshot>("graphSnapshot",{scopeId:id})).events,snapshot.events,"Reading recovery does not replay delivery");
  }finally{await storage.close();}
});

test("first user turn is a prompt, later turns are follow-ups, and legacy facts stay follow-ups",async()=>{
  const data=join(scratch,"first-prompt");await mkdir(data,{recursive:true});
  Object.assign(process.env,{SIGMA_APPROVAL_MODE:"ask",PI_OFFLINE:"1",SIGMA_DEMO:"1",PI_CODING_AGENT_DIR:join(data,"agent")});
  const storage=new Storage(join(data,"state.sqlite")),host=new PiHost(storage,data,async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);});
  await host.init();
  const settled=async(id:string)=>{const until=Date.now()+8000;while(Date.now()<until){if((await host.snapshot(id)).status==="settled")return;await new Promise(r=>setTimeout(r,20));}throw new Error("Timed out");};
  const input=async(scope:string,command:string)=>(await storage.call<GraphSnapshot>("graphSnapshot",{scopeId:scope})).events.map(event=>event.payload as GraphFact).filter(fact=>fact.commandId===command).at(-1)!;
  try{
    const id=await host.create(data,"sigma-demo/offline"),first=randomUUID(),second=randomUUID();
    await host.prompt(id,"hello",undefined,first);await settled(id);
    await host.prompt(id,"again",undefined,second);await settled(id);
    assert.equal((await input(id,first)).kind,"prompt");assert.equal((await input(id,first)).cause,"user_prompt");
    assert.equal((await input(id,second)).kind,"followUp");
    // A delegated child already received its task via the delegation fact, so a later user message is a follow-up.
    const root=await host.create(data,"sigma-demo/offline");await host.prompt(root,"delegate:delegate:small result");await settled(root);
    const child=(await host.snapshot(root)).agents.find(agent=>agent.parentId===root)!,childCommand=randomUUID();
    const facts=((await storage.call<GraphSnapshot>("graphSnapshot",{scopeId:root})).events.map(event=>event.payload as GraphFact));
    assert.equal(facts.some(fact=>fact.kind==="delegation"&&fact.target===child.id),true);assert.equal(facts.some(fact=>fact.kind==="prompt"&&fact.target===child.id),false,"Delegation is not double counted as a prompt");
    await host.prompt(child.id,"more",undefined,childCommand,root);await settled(root);
    assert.equal((await input(root,childCommand)).kind,"followUp");assert.equal((await input(root,childCommand)).cause,"user_child_message");
    // Legacy journals recorded the initial prompt as followUp/user_prompt; they are not reclassified and still count as prior input.
    const legacy=await host.create(data,"sigma-demo/offline"),old={id:"input:legacy",kind:"followUp",source:"user",target:legacy,actor:"user",cause:"user_prompt",commandId:"legacy",outcome:"received",run:null};
    await storage.event(legacy,"graph_fact",old);const next=randomUUID();
    await host.prompt(legacy,"after legacy",undefined,next);await settled(legacy);
    const snapshot=await storage.call<GraphSnapshot>("graphSnapshot",{scopeId:legacy});
    assert.deepEqual(snapshot.events.map(event=>event.payload as GraphFact).find(fact=>fact.id==="input:legacy"),old);
    assert.equal((await input(legacy,next)).kind,"followUp");
    // A rejected first attempt does not consume "first".
    const retry=await host.create(data,"sigma-demo/offline");
    await storage.event(retry,"graph_fact",{...old,id:"input:rejected",target:retry,kind:"prompt",outcome:"unknown"});await storage.event(retry,"graph_fact",{...old,id:"input:rejected",target:retry,kind:"prompt",outcome:"rejected"});
    const again=randomUUID();await host.prompt(retry,"retry",undefined,again);await settled(retry);assert.equal((await input(retry,again)).kind,"prompt");
  }finally{await host.close();await storage.close();}
});
