import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, realpath } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Storage } from "./storage.js";
import { PiHost, openPiHistory, readPiHistory } from "./pi-host.js";

const root=resolve(import.meta.dirname,"../.."),scratch=join(process.env.SIGMA_TEST_DIR||join(root,".scratch"),`unload-${Date.now()}-${process.pid}`);
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const assistant=(text:string):AssistantMessage=>({role:"assistant",content:[{type:"text",text}],api:"fixture",provider:"fixture",model:"m",usage,stopReason:"stop",timestamp:Date.now()});

test("a history built from entries readPiHistory parsed behaves exactly like SessionManager.open and keeps persisting",async()=>{
  await mkdir(scratch,{recursive:true});const cwd=await realpath(scratch),dir=join(cwd,"sessions-fixture");await mkdir(dir,{recursive:true});
  const id="11111111-2222-4333-8444-555555555555",seed=SessionManager.create(cwd,dir,{id});
  seed.appendMessage({role:"user",content:"first",timestamp:Date.now()});seed.appendMessage(assistant("reply one"));seed.appendThinkingLevelChange("high");seed.appendMessage({role:"user",content:"second",timestamp:Date.now()});seed.appendMessage(assistant("reply two"));
  const file=seed.getSessionFile()!,found=readPiHistory(file,dir,id,cwd),mine=openPiHistory(found.path,dir,cwd,found.entries),sdk=SessionManager.open(file,dir,cwd);
  assert.equal(found.entries.length,6);assert.equal(mine.getSessionId(),sdk.getSessionId());assert.deepEqual(mine.getEntries(),sdk.getEntries());assert.equal(mine.getSessionFile(),sdk.getSessionFile());assert.equal(mine.getCwd(),sdk.getCwd());
  assert.deepEqual(mine.getHeader(),sdk.getHeader());assert.equal(mine.getLeafId(),sdk.getLeafId());assert.deepEqual(mine.buildSessionContext().messages,sdk.buildSessionContext().messages);
  const added=mine.appendMessage({role:"user",content:"third",timestamp:Date.now()}),lines=readFileSync(file,"utf8").trimEnd().split("\n");
  assert.equal(lines.length,7,"The new entry is appended to the same file, not rewritten");assert.equal(JSON.parse(lines.at(-1)!).id,added);assert.equal(readPiHistory(file,dir,id,cwd).entries.length,7);
});

test("idle sessions beyond the cap are unloaded; viewed, running, recent and unsaved ones stay; an unloaded chat reopens with the same messages",async()=>{
  const data=join(scratch,"host");await mkdir(data,{recursive:true});
  Object.assign(process.env,{SIGMA_APPROVAL_MODE:"ask",PI_OFFLINE:"1",SIGMA_DEMO:"1",PI_CODING_AGENT_DIR:join(data,"agent")});
  const storage=new Storage(join(data,"state.sqlite")),host=new PiHost(storage,data,async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);});
  await host.init();host.maxLoaded=2;host.idleMs=0;
  const settled=async(id:string)=>{const until=Date.now()+8000;while(Date.now()<until){if((await host.state(id)).status==="settled")return;await new Promise(r=>setTimeout(r,20));}throw new Error("Timed out");};
  try{
    const ids:string[]=[],before=new Map<string,unknown>();
    for(let index=0;index<4;index++){const id=await host.create(data,"sigma-demo/offline");await host.prompt(id,`hello ${index}`);await settled(id);ids.push(id);}
    for(const id of ids)before.set(id,(await host.snapshot(id)).messages);
    const [viewed,second,third,fourth]=ids;host.setViewerCheck(id=>id===viewed);
    const running=await host.create(data,"sigma-demo/offline");await host.prompt(running,`slow ${"keep me ".repeat(20)}`);assert.equal((await host.state(running)).status,"running");
    host.idleMs=60_000;host.trimLoaded();assert.equal(host.loadedCount(),5,"Sessions used within the idle window are not unloaded");
    host.idleMs=0;host.trimLoaded();
    assert.equal(host.loadedCount(),2);assert.deepEqual(ids.map(id=>host.isLoaded(id)),[true,false,false,false]);assert.equal(host.isLoaded(running),true);
    for(const id of [second,third,fourth])assert.deepEqual((await host.snapshot(id)).messages,before.get(id),"An unloaded chat reopens from disk with the same messages");
    await settled(running);assert.ok((await host.snapshot(running)).messages.some(message=>message.role==="assistant"&&message.text.startsWith("Demo response: slow")));
    // A session whose history was never saved lives in memory only (Pi writes the file with the first reply) and is not unloaded.
    const fresh=await host.create(data,"sigma-demo/offline");host.maxLoaded=1;host.trimLoaded();
    assert.equal(host.isLoaded(fresh),true);assert.equal(host.isLoaded(viewed),true);assert.equal(host.isLoaded(running),false,"An idle session that finished is unloaded once nothing holds it");
    assert.deepEqual((await host.snapshot(viewed)).messages,before.get(viewed));
  }finally{await host.close();await storage.close();}
});
