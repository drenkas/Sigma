import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const scratch=resolve(import.meta.dirname,"../../.scratch",`provider-auth-${Date.now()}-${process.pid}`);
// Set isolation BEFORE SDK import: no ambient credentials, commands or network.
for(const key of Object.keys(process.env))if(!["PATH","TMPDIR","SystemRoot"].includes(key))delete process.env[key];
process.env.HOME=scratch;process.env.PI_OFFLINE="1";process.env.PI_CODING_AGENT_DIR=join(scratch,"agent");
const {ModelRuntime}=await import("@earendil-works/pi-coding-agent");
const {ProviderAuth}=await import("./provider-auth.js");
const {registerAuthFixture}=await import("./provider-auth.fixture.js");
const pause=()=>new Promise(resolve=>setTimeout(resolve,15));
async function waitFor(check:()=>boolean){const end=Date.now()+8000;while(Date.now()<end){if(check())return;await pause();}throw new Error("Synthetic sign-in state timed out");}
async function fixture(name:string,overlay=false){
  const dir=join(scratch,name);await mkdir(dir,{recursive:true});
  const modelsPath=overlay?join(dir,"models.json"):null;
  if(modelsPath)await writeFile(modelsPath,JSON.stringify({providers:{"sigma-auth-fixture":{name:"Synthetic account with model configuration",baseUrl:"https://example.invalid/synthetic-models"}}}));
  const runtime=await ModelRuntime.create({authPath:join(dir,"auth.json"),modelsPath,allowModelNetwork:false});
  const controls=registerAuthFixture(runtime);await runtime.refresh({allowNetwork:false});
  return {runtime,auth:new ProviderAuth(runtime),controls,provider:"sigma-auth-fixture"};
}

test("SDK discovery, one-use manual/callback/device prompts, duplicate admission and safe errors",async()=>{
  const {runtime,auth,controls,provider}=await fixture("interaction");
  async function begin(mode:string){const id=crypto.randomUUID();auth.start(provider,id);await waitFor(()=>!!auth.operation(provider,id).prompt);const prompt=auth.operation(provider,id).prompt!;auth.answer(provider,id,prompt.id,mode);return id;}
  try{
    assert.equal((await runtime.getAvailable(provider)).length,0);
    const discovered=(await auth.list()).find(item=>item.id===provider)!;assert.equal(discovered.oauth,true);assert.equal(discovered.configured,false);
    const id=crypto.randomUUID();auth.start(provider,id);auth.start(provider,id);
    await waitFor(()=>!!auth.operation(provider,id).prompt);assert.equal(controls.logins,1,"Same command observation never replays SDK login");
    assert.throws(()=>auth.start(provider,crypto.randomUUID()));assert.throws(()=>auth.start("openai-codex",id));
    assert.throws(()=>auth.refresh(provider));
    let prompt=auth.operation(provider,id).prompt!;assert.throws(()=>auth.answer(provider,id,prompt.id,"not-an-option"));assert.throws(()=>auth.answer(provider,id,crypto.randomUUID(),"manual"));
    auth.answer(provider,id,prompt.id,"manual");assert.throws(()=>auth.answer(provider,id,prompt.id,"manual"));
    await waitFor(()=>auth.operation(provider,id).prompt?.type==="manual_code");prompt=auth.operation(provider,id).prompt!;
    assert.equal(auth.operation(provider,id).authUrl,"https://example.invalid/synthetic-sign-in");assert.equal(auth.operation(provider,id).deviceExpiresAt,undefined,"No invented URL/token expiry");
    auth.answer(provider,id,prompt.id,"synthetic-answer-only");await waitFor(()=>auth.operation(provider,id).state==="succeeded");
    assert.equal(auth.operation(provider,id).credentialStored,true);assert.equal((await auth.list()).find(item=>item.id===provider)!.credentialType,"oauth");
    assert.equal(auth.operation(provider,id).authUrl,undefined);assert.throws(()=>auth.answer(provider,id,prompt.id,"synthetic-answer-only"));
    auth.start(provider,id);assert.equal(controls.logins,1);
    const callbackId=await begin("callback");await waitFor(()=>auth.operation(provider,callbackId).prompt?.type==="manual_code");const stale=auth.operation(provider,callbackId).prompt!.id;controls.callback();
    await waitFor(()=>auth.operation(provider,callbackId).state==="succeeded");assert.equal(auth.operation(provider,callbackId).prompt,undefined);assert.throws(()=>auth.answer(provider,callbackId,stale,"late-answer"));assert.throws(()=>auth.start(provider,id),"Older operations cannot replay after replacement");
    const deviceId=await begin("device");await waitFor(()=>!!auth.operation(provider,deviceId).deviceCode);
    const device=auth.operation(provider,deviceId);assert.ok(device.deviceExpiresAt!>Date.now()+890000&&device.deviceExpiresAt!<=Date.now()+900000);
    auth.answer(provider,deviceId,device.prompt!.id,"confirmed");await waitFor(()=>auth.operation(provider,deviceId).state==="succeeded");
    const cancelled=await begin("device");await waitFor(()=>!!auth.operation(provider,cancelled).deviceCode);
    await auth.cancel(provider,cancelled);assert.equal(auth.operation(provider,cancelled).state,"cancelled");assert.equal(auth.operation(provider,cancelled).credentialStored,true,"Cancel preserves a previous saved credential");assert.equal(auth.operation(provider,cancelled).deviceCode,undefined);
    const failureId=await begin("error");await waitFor(()=>auth.operation(provider,failureId).state==="failed");
    const unsafeId=await begin("unsafe");await waitFor(()=>auth.operation(provider,unsafeId).state==="cancelled");assert.equal(auth.operation(provider,unsafeId).authUrl,undefined);
    const json=JSON.stringify(await auth.list());for(const secret of ["synthetic-access-only","synthetic-refresh-only","synthetic-answer-only"])assert.equal(json.includes(secret),false,"Interaction views never expose credentials, answers or raw provider errors");
    assert.throws(()=>auth.operation(provider,failureId));
  }finally{await auth.close();}
});

test("cancellation after SDK credential publication drains the write and reconciles saved metadata",async()=>{
  let stored:import("@earendil-works/pi-ai").Credential|undefined,release!:()=>void,published=false;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const runtime=await ModelRuntime.create({modelsPath:null,allowModelNetwork:false,credentials:{
    read:async id=>id==="sigma-auth-fixture"?stored:undefined,
    list:async()=>stored?[{providerId:"sigma-auth-fixture",type:stored.type}]:[],
    modify:async(_id,fn)=>{stored=await fn(stored);published=true;await held;return stored;},
    delete:async()=>{stored=undefined;},
  }});
  const controls=registerAuthFixture(runtime);await runtime.refresh({allowNetwork:false});const auth=new ProviderAuth(runtime),provider="sigma-auth-fixture",id=crypto.randomUUID();
  try{
    const preSaveId=crypto.randomUUID();auth.start(provider,preSaveId);await waitFor(()=>!!auth.operation(provider,preSaveId).prompt);auth.answer(provider,preSaveId,auth.operation(provider,preSaveId).prompt!.id,"device");
    await waitFor(()=>!!auth.operation(provider,preSaveId).deviceCode);await auth.cancel(provider,preSaveId);assert.equal(auth.operation(provider,preSaveId).state,"cancelled");assert.equal(published,false,"Interaction cancellation before credential return never starts publication");assert.equal((await runtime.listCredentials()).length,0);
    auth.start(provider,id);await waitFor(()=>!!auth.operation(provider,id).prompt);auth.answer(provider,id,auth.operation(provider,id).prompt!.id,"manual");
    await waitFor(()=>auth.operation(provider,id).prompt?.type==="manual_code");auth.answer(provider,id,auth.operation(provider,id).prompt!.id,"synthetic-code");await waitFor(()=>published);
    let cancelled=false;const cancel=auth.cancel(provider,id).then(()=>{cancelled=true;});await pause();assert.equal(cancelled,false,"Cancel waits an SDK credential write that already started");
    release();await cancel;const view=auth.operation(provider,id);assert.equal(view.state,"succeeded","An already-started credential save completes synchronization before cancel returns");assert.equal(view.credentialStored,true);assert.equal(view.message,undefined,"Completed synchronization clears the transient finishing disclosure");assert.equal(controls.logins,2);
    assert.equal((await auth.list()).find(item=>item.id===provider)!.credentialType,"oauth");assert.equal(JSON.stringify(view).includes("synthetic-access-only"),false);
  }finally{release();await auth.close();}
});

test("saved SDK credentials remain sync-pending, while shutdown waits actual canceled provider finalizers",async()=>{
  const {auth,controls,provider}=await fixture("lifecycle");
  async function mode(value:string){const id=crypto.randomUUID();auth.start(provider,id);await waitFor(()=>!!auth.operation(provider,id).prompt);auth.answer(provider,id,auth.operation(provider,id).prompt!.id,value);return id;}
  try{
    controls.syncFailure=true;const id=await mode("manual");await waitFor(()=>auth.operation(provider,id).prompt?.type==="manual_code");auth.answer(provider,id,auth.operation(provider,id).prompt!.id,"fixture-code");
    await waitFor(()=>auth.operation(provider,id).state==="sync_pending");assert.equal(auth.operation(provider,id).credentialStored,true);assert.equal((await auth.list()).find(item=>item.id===provider)!.credentialType,"oauth");
    const count=controls.logins;await assert.rejects(auth.refresh(provider));assert.equal(controls.logins,count,"A failed synchronization never starts another login");
    assert.equal(JSON.stringify(auth.operation(provider,id)).includes("synthetic-refresh-only"),false);
    controls.syncFailure=false;await auth.refresh(provider);assert.equal(auth.operation(provider,id).state,"succeeded");
    const held=await mode("hold");await waitFor(()=>auth.operation(provider,held).prompt?.type==="secret");
    let closed=false;const closing=auth.close().then(()=>{closed=true;});await pause();await pause();assert.equal(closed,false,"SDK abort-return is not the actual provider finalizer drain");assert.equal(auth.operation(provider,held).state,"cancelling");assert.throws(()=>auth.start(provider,crypto.randomUUID()));
    controls.release();await closing;assert.equal(auth.operation(provider,held).state,"cancelled");assert.equal(controls.finalized,2);assert.equal(auth.operation(provider,held).prompt,undefined);
  }finally{controls.release();await auth.close();}
});


test("provider refresh refuses replacement and shutdown drains its actual SDK finalizer",async()=>{
  const {runtime,auth,provider}=await fixture("refresh-drain");
  const adapter=runtime.getRegisteredNativeProvider(provider)!;
  const refresh=adapter.refreshModels!;let release!:()=>void,started=false,closed=false;
  const held=new Promise<void>(resolve=>{release=resolve;});
  adapter.refreshModels=async context=>{started=true;await held;return refresh.call(adapter,context);};
  let work:Promise<unknown>|undefined,closing:Promise<void>|undefined;
  try{
    work=auth.refresh(provider);await waitFor(()=>started);
    assert.throws(()=>auth.refresh(provider),"A concurrent refresh cannot supersede the admitted provider finalizer");
    assert.throws(()=>auth.start(provider,crypto.randomUUID()),"Login remains fenced by model synchronization");
    closing=auth.close().then(()=>{closed=true;});await pause();await pause();assert.equal(closed,false,"Shutdown waits the actual refresh finalizer");
    release();await work;await closing;
  }finally{release();await work?.catch(()=>{});await closing;adapter.refreshModels=refresh;await auth.close();}
});

test("post-save cancellation drains the SDK model refresh finalizer before settling",async()=>{
  const {runtime,auth,controls,provider}=await fixture("saved-refresh-drain",true);
  const adapter=runtime.getRegisteredNativeProvider(provider)!;
  assert.notEqual(runtime.getProvider(provider),adapter,"The actual SDK model configuration composes a different provider for post-save refresh");
  const refresh=adapter.refreshModels!;let release!:()=>void,started=false,cancelled=false,closed=false;
  const held=new Promise<void>(resolve=>{release=resolve;});
  adapter.refreshModels=async context=>{started=true;await held;return refresh.call(adapter,context);};
  let cancelling:Promise<unknown>|undefined,closing:Promise<void>|undefined;
  const id=crypto.randomUUID();
  try{
    auth.start(provider,id);await waitFor(()=>!!auth.operation(provider,id).prompt);auth.answer(provider,id,auth.operation(provider,id).prompt!.id,"manual");
    await waitFor(()=>auth.operation(provider,id).prompt?.type==="manual_code");auth.answer(provider,id,auth.operation(provider,id).prompt!.id,"synthetic-code");await waitFor(()=>started&&auth.operation(provider,id).state==="finishing");
    const finishing=auth.operation(provider,id);
    cancelling=auth.cancel(provider,id).then(()=>{cancelled=true;});closing=auth.close().then(()=>{closed=true;});await pause();await pause();
    assert.equal(cancelled,false,"Cancel cannot finish while the SDK post-save refresh finalizer is held");assert.equal(closed,false,"Shutdown shares the admitted post-save finalizer drain");
    assert.equal(finishing.state,"finishing");assert.equal(finishing.authUrl,undefined);assert.equal(finishing.prompt,undefined);
    release();await cancelling;await closing;const view=auth.operation(provider,id);assert.equal(view.credentialStored,true);assert.equal(view.state,"succeeded","Cancellation does not invent a pending synchronization after the SDK completes it");assert.equal(controls.logins,1);
  }finally{release();await cancelling;await closing;adapter.refreshModels=refresh;await auth.close();}
});
