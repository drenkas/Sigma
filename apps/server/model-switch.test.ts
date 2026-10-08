import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { Storage } from "./storage.js";
import { PiHost } from "./pi-host.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const scratch=resolve(import.meta.dirname,"../../.scratch",`model-switch-${Date.now()}-${process.pid}`);
process.env.PI_OFFLINE="1";process.env.PI_CODING_AGENT_DIR=join(scratch,"agent");
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
async function waitFor(check:()=>Promise<boolean>){const until=Date.now()+8000;while(Date.now()<until){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw new Error("Run did not settle");}

test("switching the model and reasoning reaches the next Pi call, persists across restart and is guarded",async()=>{
  await mkdir(scratch,{recursive:true});let storage=new Storage(join(scratch,"state.sqlite"));
  const observed:Array<{model:string;reasoning:unknown}>=[];let gate:(()=>void)|undefined,hold:Promise<void>|undefined;
  function register(host:PiHost){
    const runtime=(host as unknown as {runtime:ModelRuntime}).runtime;
    runtime.registerProvider("switch-fixture",{api:"switch-fixture",apiKey:"local-fixture",baseUrl:"http://127.0.0.1/unused",models:[{id:"a",reasoning:true},{id:"b",reasoning:true},{id:"plain",reasoning:false}].map(({id,reasoning})=>({id,name:id,reasoning,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:8192,maxTokens:1024})),streamSimple:(model,context,options)=>{
      observed.push({model:model.id,reasoning:options?.reasoning});
      const stream=createAssistantMessageEventStream(),output:AssistantMessage={role:"assistant",content:[],api:model.api,provider:model.provider,model:model.id,usage,stopReason:"pending",timestamp:Date.now()};
      const last=context.messages.at(-1),text=last?.role==="user"?(typeof last.content==="string"?last.content:last.content.filter(p=>p.type==="text").map(p=>p.text).join("")):"";
      void (async()=>{
        stream.push({type:"start",partial:output});
        if(text==="hold")await hold;
        if(last?.role==="user"&&text==="delegate worker"){
          const call={type:"toolCall" as const,id:crypto.randomUUID(),name:"delegate",arguments:{role:"worker",task:"Return a result"}};
          output.content.push(call);stream.push({type:"toolcall_start",contentIndex:0,partial:output});stream.push({type:"toolcall_end",contentIndex:0,toolCall:call,partial:output});output.stopReason="toolUse";stream.push({type:"done",reason:"toolUse",message:output});
        }else{output.content.push({type:"text",text:"ok"});stream.push({type:"text_start",contentIndex:0,partial:output});stream.push({type:"text_delta",contentIndex:0,delta:"ok",partial:output});stream.push({type:"text_end",contentIndex:0,content:"ok",partial:output});output.stopReason="stop";stream.push({type:"done",reason:"stop",message:output});}
        stream.end();
      })();
      return stream;
    }});
  }
  const make=async()=>{const host=new PiHost(storage,scratch,async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);});await host.init();register(host);return host;};
  const swap=(host:PiHost,id:string,model:string,reasoning:string|null)=>host.withPromptAdmission(id,admission=>host.switchModel(id,model,reasoning as never,admission));
  const run=async(host:PiHost,id:string,text:string)=>{await host.prompt(id,text);await waitFor(async()=>(await host.snapshot(id)).status==="settled");};
  let host=await make();
  try{
    const id=await host.create(scratch,"switch-fixture/a",undefined,"read",{reasoning:"low"});
    await run(host,id,"first");assert.deepEqual(observed.at(-1),{model:"a",reasoning:"low"});
    assert.deepEqual(await swap(host,id,"switch-fixture/b","high"),{model:"switch-fixture/b",reasoning:"high"});
    const view=await host.snapshot(id);assert.equal(view.model,"switch-fixture/b");assert.equal(view.policy!.effective.model,"switch-fixture/b");assert.equal(view.policy!.requested.model,"switch-fixture/a","The original request stays recorded");assert.equal(view.policy!.role!.requestedReasoning,"high");
    await run(host,id,"second");assert.deepEqual(observed.at(-1),{model:"b",reasoning:"high"},"The next actual Pi call uses the new model and reasoning");
    assert.equal((await host.snapshot(id)).policy!.role!.requestedReasoning,"high");

    await assert.rejects(swap(host,id,"switch-fixture/plain","high"),/Reasoning level is unavailable/,"No silent clamp");
    await assert.rejects(swap(host,id,"switch-fixture/missing",null),/unavailable/);
    await assert.rejects(swap(host,id,"sigma-antigravity-unsupervised/agy",null),/Unsupervised Antigravity/,"Switching to unsupervised AGY is refused");
    assert.equal((await host.snapshot(id)).model,"switch-fixture/b","Rejected switches change nothing");
    assert.deepEqual(await swap(host,id,"switch-fixture/a",null),{model:"switch-fixture/a",reasoning:null},"No explicit level and no role default clears the override");
    assert.equal((await host.snapshot(id)).policy!.role!.requestedReasoning,null);
    const live=()=>(host as unknown as {active:Map<string,{session:{thinkingLevel:string;sessionManager:{getEntries():Array<{type:string;thinkingLevel?:string}>}}}>}).active.get(id)!.session;
    assert.equal(live().thinkingLevel,"medium","Default reasoning resets the live session from high to Pi's default");
    assert.equal(live().sessionManager.getEntries().filter(entry=>entry.type==="thinking_level_change").at(-1)?.thinkingLevel,"medium","The reset is journaled so a restart reopens on it");
    const changed=(await storage.call<any[]>("events",{sessionId:id})).filter(event=>event.type==="model_changed").at(-1);assert.equal(changed.payload.effective,"medium");
    await swap(host,id,"switch-fixture/b","medium");

    // Restart: the persisted model and reasoning are reopened without a fallback error.
    await host.close();await storage.close();storage=new Storage(join(scratch,"state.sqlite"));host=await make();
    assert.equal((await host.snapshot(id)).model,"switch-fixture/b");
    await run(host,id,"after restart");assert.deepEqual(observed.at(-1),{model:"b",reasoning:"medium"});
    const graph=await storage.call<any>("graphSnapshot",{scopeId:id});assert.equal(graph.nodes.find((node:any)=>node.id===id)?.metadata?.model,"switch-fixture/b","Run metadata reflects the new model");

    // A fresh parallel root registers the delegate tool.
    const repo=join(scratch,"repo");await mkdir(repo,{recursive:true});for(const args of [["init","-q","-b","main"],["-c","user.name=t","-c","user.email=t@t","commit","-q","--allow-empty","-m","base"]])execFileSync("git",args,{cwd:repo});
    for(const workspaceMode of ["direct","worktree"] as const){
      const parallel=await host.create(repo,"switch-fixture/a",undefined,"parallel",{workspaceMode});await run(host,parallel,"first");
      const tool=(host as unknown as {active:Map<string,{session:{getToolDefinition(name:string):unknown}}>}).active.get(parallel)?.session.getToolDefinition("delegate");assert.ok(tool,`parallel ${workspaceMode} roots can delegate`);
    }

    // A running session cannot switch.
    hold=new Promise<void>(resolve=>{gate=resolve;});
    await host.prompt(id,"hold");await waitFor(async()=>(await host.snapshot(id)).status==="running");
    await assert.rejects(swap(host,id,"switch-fixture/a",null),/busy|running/);
    gate!();await waitFor(async()=>(await host.snapshot(id)).status==="settled");

    // Child sessions cannot switch.
    await run(host,id,"delegate worker");
    const child=(await host.snapshot(id)).agents.find(agent=>agent.parentId);assert.ok(child);
    await assert.rejects(swap(host,child!.id,"switch-fixture/a",null),/main session only/);
  }finally{gate?.();await host.close().catch(()=>{});await storage.close().catch(()=>{});}
});
