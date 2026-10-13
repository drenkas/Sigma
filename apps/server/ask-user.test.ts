import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { askQuestion } from "./ask-user.js";

const root=resolve(import.meta.dirname,"../..");
const testRoot=join(process.env.SIGMA_TEST_DIR||join(root,".scratch"),`ask-user-${Date.now()}-${process.pid}`);
process.env.PI_OFFLINE="1";
process.env.PI_CODING_AGENT_DIR=join(testRoot,"agent");
const { PiHost, visibleMessages }=await import("./pi-host.js");
const { Storage }=await import("./storage.js");
const { registerDemoProvider }=await import("./demo-provider.js");

const ask={question:"Which size?",options:[{label:"Medium",description:"A worker, then a review"},{label:"Complex"}]};
const call=(id:string)=>({type:"toolCall",id,name:"ask_user",arguments:ask});

test("ask_user arguments become a trimmed question with labelled options",()=>{
  assert.deepEqual(askQuestion({question:"  Pick one  ",options:[{label:" A ",description:" first "},"B",{label:""},{description:"no label"}]}),{question:"Pick one",options:[{label:"A",description:"first"},{label:"B"}]});
  assert.equal(askQuestion({question:"",options:[{label:"A"}]}),undefined);
  assert.equal(askQuestion({question:"Q",options:[]}),undefined);
  assert.equal(askQuestion(null),undefined);
});

test("a delivered ask_user call is a reply carrying the question; a failed one is not",()=>{
  const user={role:"user",content:"Plan it",timestamp:1};
  const asked={role:"assistant",content:[{type:"text",text:"I need one detail."},call("c1")],timestamp:2};
  const result={role:"toolResult",toolCallId:"c1",isError:false,content:[],timestamp:3};
  const [,reply]=visibleMessages({messages:[user,asked,result]} as any,"/tmp");
  assert.equal(reply.role,"assistant");assert.equal(reply.interim,undefined);
  assert.equal(reply.text,"I need one detail.\n\nWhich size?");assert.deepEqual(reply.question,ask);
  const blocked={...result,isError:true};
  const [,note]=visibleMessages({messages:[user,asked,blocked]} as any,"/tmp");
  assert.equal(note.question,undefined);assert.equal(note.interim,true,"A blocked question leaves only the interim text");
  assert.equal(visibleMessages({messages:[user,{...asked,content:[call("c2")]}]} as any,"/tmp").length,1,"A call without a result yet shows nothing");
});

test("ask_user ends the root agent's turn and the answer arrives as the next user message",async()=>{
  const dir=join(testRoot,"host");await mkdir(dir,{recursive:true});
  const storage=new Storage(join(dir,"state.sqlite"));const host=new PiHost(storage,dir,async()=>{});
  try{
    await host.init();registerDemoProvider((host as unknown as {runtime:ModelRuntime}).runtime);
    const sid=await host.create(root,"sigma-demo/offline");
    const settled=async()=>{for(let i=0;i<200;i++){const view=await host.snapshot(sid);if(view.status!=="running")return view;await new Promise(r=>setTimeout(r,25));}throw new Error("Run did not settle");};
    await host.prompt(sid,`script:${JSON.stringify([{name:"ask_user",arguments:ask}])}`);
    let view=await settled();
    const last=view.messages.at(-1)!;
    assert.equal(last.role,"assistant");assert.deepEqual(last.question,ask);
    assert.ok(!view.messages.some(m=>m.text.startsWith("Demo QA script finished")),"The model gets no further turn after asking");
    const waiting=async()=>(await host.list() as any[]).find(row=>row.id===sid)?.waiting;
    assert.equal(await waiting(),true,"An open question marks the chat as waiting in the sidebar");
    host.maxLoaded=0;host.idleMs=0;host.trimLoaded();assert.equal(host.isLoaded(sid),false);
    assert.equal(await waiting(),true,"An unloaded chat with an open question still shows as waiting");
    host.maxLoaded=8;
    await host.prompt(sid,"Medium");
    view=await settled();
    assert.deepEqual(view.messages.filter(m=>m.role==="user").map(m=>m.text).at(-1),"Medium");
    assert.equal(view.messages.at(-1)!.question,undefined);
    assert.equal(await waiting(),undefined,"Answering clears the waiting state");
  }finally{await host.close();await storage.close();await rm(testRoot,{recursive:true,force:true});}
});
