import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Storage } from "./storage.js";
import { PiHost } from "./pi-host.js";

const root=resolve(import.meta.dirname,"../..");
const testRoot=join(process.env.SIGMA_TEST_DIR||join(root,".scratch"),`access-${Date.now()}-${process.pid}`);
process.env.PI_OFFLINE="1";process.env.SIGMA_DEMO="1";process.env.PI_CODING_AGENT_DIR=join(testRoot,"agent");
async function open(name:string,env?:string){
  const data=join(testRoot,name);await mkdir(data,{recursive:true});const saved=process.env.SIGMA_APPROVAL_MODE;
  if(env===undefined)delete process.env.SIGMA_APPROVAL_MODE;else process.env.SIGMA_APPROVAL_MODE=env;
  const storage=new Storage(join(data,"state.sqlite")),host=new PiHost(storage,data,async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);});
  try{await host.init();}finally{if(saved===undefined)delete process.env.SIGMA_APPROVAL_MODE;else process.env.SIGMA_APPROVAL_MODE=saved;}
  const sid=await host.create(root,"sigma-demo/offline"),row=(host as any).active.get(sid).row;
  return {data,storage,host,sid,row,ask:(preview:string)=>(host as any).requestApproval(row,"read",preview) as Promise<string|null>,close:async()=>{await host.close();await storage.close();}};
}
const status=async(f:Awaited<ReturnType<typeof open>>,id:string)=>(await f.host.snapshot(f.sid)).approvals.find(a=>a.id===id)?.status;

test("default access is full and approvals are recorded as approved without decide",async()=>{
  const f=await open("default");
  try{
    assert.equal(f.host.approvalMode,"full");
    const id=await f.ask("read a.txt");assert.ok(id);assert.equal(await status(f,id!),"approved");
  }finally{await f.close();}
});

test("ask mode keeps approvals pending until decide, and switching to full releases them",async()=>{
  const f=await open("ask","ask");
  try{
    assert.equal(f.host.approvalMode,"ask");
    const first=f.ask("read one"),second=f.ask("read two");
    const ids=async()=>(await f.host.snapshot(f.sid)).approvals.filter(a=>a.status==="pending");
    for(let i=0;i<100&&(await ids()).length<2;i++)await new Promise(r=>setTimeout(r,50));
    const pending=await ids();assert.equal(pending.length,2);
    const waiting=async()=>(await f.host.list() as any[]).find(r=>r.id===f.sid)?.waiting;assert.equal(await waiting(),true);
    await f.host.decide(f.sid,pending.find(a=>a.preview==="read one")!.id,true);assert.ok(await first);
    await f.host.setApprovalMode("full");
    const id=await second;assert.ok(id);assert.equal(await status(f,id!),"approved");
    assert.equal((await ids()).length,0);assert.equal(await waiting(),undefined);
  }finally{await f.close();}
});

test("access mode persists privately and survives reload",async()=>{
  const f=await open("persist");
  try{
    await f.host.setApprovalMode("ask");
    const file=join(f.data,"agent-access.json");assert.deepEqual(JSON.parse(await readFile(file,"utf8")),{mode:"ask"});assert.equal((await stat(file)).mode&0o777,0o600);
  }finally{await f.close();}
  const again=await open("persist");
  try{assert.equal(again.host.approvalMode,"ask");await again.host.setApprovalMode("full");}finally{await again.close();}
  const third=await open("persist","ask");
  try{assert.equal(third.host.approvalMode,"full","Saved choice wins over the env default");}finally{await third.close();}
  await writeFile(join(testRoot,"persist","agent-access.json"),"{bad");
  const broken=await open("persist");try{assert.equal(broken.host.approvalMode,"full");}finally{await broken.close();}
});
