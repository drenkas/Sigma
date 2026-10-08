import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Storage } from "./storage.js";
import { PiHost } from "./pi-host.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CLIPROXY_PROVIDER_ID } from "./cliproxy-provider.js";

const root=resolve(import.meta.dirname,"../..");
process.env.PI_OFFLINE="0";delete process.env.SIGMA_DEMO;delete process.env.PI_ORCH_DEMO;
delete process.env.OPENAI_CUSTOM_HEADERS;delete process.env.OPENAI_LOG;
const secretKey="test-only-local-gateway-key-do-not-use";
async function waitFor(check:()=>Promise<boolean>,ms=8_000){const until=Date.now()+ms;while(Date.now()<until){if(await check())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error("Timed out waiting for local proxy fixture state");}
function sendSse(reply:ServerResponse,body:unknown){reply.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache",connection:"keep-alive"});reply.write(`data: ${JSON.stringify(body)}\n\n`);reply.write(`data: ${JSON.stringify({id:"fixture",object:"chat.completion.chunk",created:1,model:"fixture-model",choices:[{index:0,delta:{},finish_reason:"stop"}]})}\n\n`);reply.write("data: [DONE]\n\n");reply.end();}
function requestBody(req:IncomingMessage){return new Promise<any>((resolve,reject)=>{let body="";req.setEncoding("utf8");req.on("data",chunk=>body+=chunk);req.on("end",()=>{try{resolve(JSON.parse(body));}catch(error){reject(error);}});req.on("error",reject);});}

test("local CLIProxyAPI stays app-owned through catalog, Pi tools, private paths, and aborts",async()=>{
  const scratch=join(root,".scratch");await mkdir(scratch,{recursive:true});const base=await mkdtemp(join(scratch,"cliproxy-owner-"));
  const data=join(base,".data"),privateDir=join(data,"cliproxyapi"),workspace=base,agent=join(base,"agent"),secret=join(privateDir,"connection.json"),alias=join(workspace,"proxy-secrets");
  await mkdir(privateDir,{recursive:true,mode:0o700});await mkdir(workspace,{recursive:true});await mkdir(agent,{recursive:true,mode:0o700});
  await writeFile(join(workspace,"note.txt"),"pi-owned fixture content\n");
  await writeFile(secret,JSON.stringify({baseUrl:"PLACEHOLDER",apiKey:secretKey}),{mode:0o600});await chmod(privateDir,0o700);await chmod(secret,0o600);
  await symlink(privateDir,alias);
  const requests:Array<{authorization:string|undefined;body:any}> =[],toolResults:string[]=[],proposals:string[]=[],closed= {value:false};let releaseWait:(()=>void)|undefined;
  const server=createServer(async(req,reply)=>{
    if(req.url==="/v1/models"){requests.push({authorization:req.headers.authorization,body:null});reply.writeHead(200,{"content-type":"application/json"});reply.end(JSON.stringify({data:[{id:"fixture-model",object:"model",owned_by:"antigravity"}]}));return;}
    if(req.url!=="/v1/chat/completions"){reply.writeHead(404);reply.end();return;}
    const body=await requestBody(req);requests.push({authorization:req.headers.authorization,body});
    const messages=Array.isArray(body.messages)?body.messages:[];
    const toolMessage=messages.filter((message:any)=>message.role==="tool").at(-1);if(toolMessage)toolResults.push(JSON.stringify(toolMessage));
    const prompt=JSON.stringify(messages.filter((message:any)=>message.role==="user").at(-1)?.content??"");
    const latestUser=messages.reduce((found:number,message:any,index:number)=>message.role==="user"?index:found,-1);
    const latestTool=messages.slice(latestUser+1).filter((message:any)=>message.role==="tool").at(-1);if(latestTool)toolResults.push(JSON.stringify(latestTool));
    if(prompt.includes("hold-open")){
      reply.on("close",()=>{closed.value=true;});await new Promise<void>(resolve=>{releaseWait=resolve;reply.on("close",()=>resolve());});return;
    }
    if(prompt.includes("provider-error")){reply.writeHead(401,{"content-type":"application/json"});reply.end(JSON.stringify({error:{message:`rejected ${secretKey}`}}));return;}
    if(messages.slice(latestUser+1).some((message:any)=>message.role==="tool")){
      sendSse(reply,{id:"fixture",object:"chat.completion.chunk",created:1,model:"fixture-model",choices:[{index:0,delta:{content:"Fixture completed."},finish_reason:null}]});return;
    }
    const target=prompt.includes("symlink-secret")?"proxy-secrets/connection.json":prompt.includes("direct-secret")?".data/cliproxyapi/connection.json":"note.txt";
    proposals.push(target);
    const call={id:"call_fixture",type:"function",function:{name:"read",arguments:JSON.stringify({path:target})}};
    reply.writeHead(200,{"content-type":"text/event-stream",connection:"keep-alive"});
    reply.write(`data: ${JSON.stringify({id:"fixture",object:"chat.completion.chunk",created:1,model:"fixture-model",choices:[{index:0,delta:{tool_calls:[{index:0,...call}]},finish_reason:null}]})}\n\n`);
    reply.write(`data: ${JSON.stringify({id:"fixture",object:"chat.completion.chunk",created:1,model:"fixture-model",choices:[{index:0,delta:{},finish_reason:"tool_calls"}]})}\n\n`);
    reply.write("data: [DONE]\n\n");reply.end();
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const port=(server.address() as {port:number}).port;
  await writeFile(secret,JSON.stringify({baseUrl:`http://127.0.0.1:${port}/v1`,apiKey:secretKey}),{mode:0o600});await chmod(secret,0o600);
  const oldHome=process.env.HOME,oldAgent=process.env.PI_CODING_AGENT_DIR;process.env.HOME=base;process.env.PI_CODING_AGENT_DIR=agent;
  const storage=new Storage(join(data,"state.sqlite")),host=new PiHost(storage,data,async()=>{});
  try{
    await host.init();assert.equal((await host.models()).some(model=>model.provider===CLIPROXY_PROVIDER_ID),false,"provider is not network-probed or advertised before explicit connect");
    const connected=await host.cliproxyProviders.connect();assert.equal(connected.connected,true);assert.equal(connected.modelCount,1);
    const discovered=await host.models();assert.equal(discovered.filter(model=>model.provider===CLIPROXY_PROVIDER_ID).length,1,JSON.stringify({view:host.cliproxyProviders.view(),registered:!!(host as any).runtime.getRegisteredNativeProvider(CLIPROXY_PROVIDER_ID),composed:!!(host as any).runtime.getProvider(CLIPROXY_PROVIDER_ID),models:(host as any).runtime.getModels(CLIPROXY_PROVIDER_ID).length,errorIncludesProvider:(host as any).runtime.getError()?.includes(CLIPROXY_PROVIDER_ID)}));
    assert.ok(requests.every(request=>request.authorization===`Bearer ${secretKey}`),"catalog and chat requests use only the app-owned key");

    const runtime=(host as unknown as {runtime:ModelRuntime}).runtime;
    await runtime.setRuntimeApiKey(CLIPROXY_PROVIDER_ID,"unrelated-pi-credential");
    assert.equal((await host.models()).some(model=>model.provider===CLIPROXY_PROVIDER_ID),false,"a Pi-stored/runtime credential cannot shadow the app-owned connection");
    const chatCount=requests.filter(request=>request.body).length;
    await runtime.removeRuntimeApiKey(CLIPROXY_PROVIDER_ID);assert.equal((await host.models()).some(model=>model.provider===CLIPROXY_PROVIDER_ID),true);
    assert.equal(requests.filter(request=>request.body).length,chatCount,"credential rejection happens before model dispatch");
    const authRows=await host.providerAuth.list();assert.equal(authRows.some(provider=>provider.id===CLIPROXY_PROVIDER_ID),false,"local connection is not duplicated as a Pi credential/login card");

    const id=await host.create(workspace,`${CLIPROXY_PROVIDER_ID}/fixture-model`);
    await host.prompt(id,"read note.txt");
    await waitFor(async()=>((await host.snapshot(id)).approvals.some(approval=>approval.status==="pending")));
    let snapshot=await host.snapshot(id),approval=snapshot.approvals.find(item=>item.status==="pending")!;
    assert.equal(approval.preview,"read note.txt");await host.decide(id,approval.id,true);
    await waitFor(async()=>{const current=await host.snapshot(id);return current.status==="settled"&&current.messages.some(message=>message.text.includes("Fixture completed."));});
    snapshot=await host.snapshot(id);assert.ok(snapshot.messages.some(message=>message.text.includes("Fixture completed.")));
    assert.ok(toolResults.some(result=>result.includes("call_fixture")&&result.includes("pi-owned fixture content")),JSON.stringify({toolResultCount:toolResults.length,hasCorrelation:toolResults.some(result=>result.includes("call_fixture"))}));

    const denyId=await host.create(workspace,`${CLIPROXY_PROVIDER_ID}/fixture-model`);await host.prompt(denyId,"read note.txt");
    await waitFor(async()=>((await host.snapshot(denyId)).approvals.some(item=>item.status==="pending")));
    const denied=(await host.snapshot(denyId)).approvals.find(item=>item.status==="pending")!;await host.decide(denyId,denied.id,false);
    await waitFor(async()=>{const state=await host.snapshot(denyId);return state.status==="settled"&&state.approvals.some(item=>item.id===denied.id&&item.status==="denied");});
    assert.equal(toolResults.slice(-1)[0]?.includes("pi-owned fixture content"),false,"Deny returns through Pi without executing the read");

    for(const prompt of ["direct-secret", "symlink-secret"]){
      const beforeState=await host.snapshot(id),before=beforeState.approvals.length;await host.prompt(id,prompt);
      try{await waitFor(async()=>{const state=await host.snapshot(id);return state.status==="settled"&&state.messages.length>beforeState.messages.length;});}catch{const state=await host.snapshot(id);throw new Error(JSON.stringify({status:state.status,messageCount:state.messages.length,approvalCount:state.approvals.length,newApproval:state.approvals.length>before,proxyRequests:proposals.length}));}
      const after=await host.snapshot(id);assert.equal(after.approvals.length,before,`${prompt} is stopped before approval and file bytes are exposed`);
      assert.equal(after.messages.some(message=>message.text.includes(secretKey)),false);
      assert.ok(proposals.includes(prompt==="direct-secret"?".data/cliproxyapi/connection.json":"proxy-secrets/connection.json"),"fixture actually proposed the protected path");
    }

    const model=runtime.getModel(CLIPROXY_PROVIDER_ID,"fixture-model")!;
    const error=await runtime.completeSimple(model,{messages:[{role:"user",content:"provider-error",timestamp:Date.now()}]});
    assert.equal(error.stopReason,"error");assert.equal(error.errorMessage,"Local proxy request failed.");assert.equal(JSON.stringify(error).includes(secretKey),false,"gateway response bodies never enter Pi errors");

    assert.deepEqual((await host.models()).find(entry=>entry.provider===CLIPROXY_PROVIDER_ID)!.reasoningLevels,["off","low","medium","high"]);
    const sent=requests.length;await runtime.completeSimple(model,{messages:[{role:"user",content:"read note.txt",timestamp:Date.now()}]},{reasoning:"medium"});
    assert.equal(requests[sent]?.body?.reasoning_effort,"medium","a chosen level reaches the proxy as reasoning_effort");
    const sentOff=requests.length;await runtime.completeSimple(model,{messages:[{role:"user",content:"read note.txt",timestamp:Date.now()}]});
    assert.equal("reasoning_effort" in requests[sentOff]!.body,false,"no chosen level sends no reasoning_effort");
    const beforeHold=requests.filter(request=>request.body).length,holdId=await host.create(workspace,`${CLIPROXY_PROVIDER_ID}/fixture-model`);await host.prompt(holdId,"hold-open");
    await waitFor(async()=>requests.filter(request=>request.body).length>beforeHold);
    await host.abort(holdId);await waitFor(async()=>closed.value);assert.equal(closed.value,true,"Pi Stop aborts the owned local HTTP stream");
    releaseWait?.();
  }finally{
    releaseWait?.();await host.close();await storage.close();await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;
    if(oldAgent===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=oldAgent;
  }
});

test("a disconnected provider adopts a re-pointed connection file, while a connected one still blocks tampering",async()=>{
  const scratch=join(root,".scratch");await mkdir(scratch,{recursive:true});const base=await mkdtemp(join(scratch,"cliproxy-repoint-"));
  const data=join(base,".data"),privateDir=join(data,"cliproxyapi"),agent=join(base,"agent"),file=join(privateDir,"connection.json");
  await mkdir(privateDir,{recursive:true,mode:0o700});await mkdir(agent,{recursive:true,mode:0o700});await chmod(privateDir,0o700);
  const make=()=>createServer((req,reply)=>{if(req.url==="/v1/models"&&req.headers.authorization===`Bearer ${secretKey}`){reply.writeHead(200,{"content-type":"application/json"});reply.end(JSON.stringify({data:[{id:"fixture-model",object:"model",owned_by:"antigravity"}]}));}else{reply.writeHead(404);reply.end();}});
  const first=make(),second=make();
  for(const server of [first,second])await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const url=(server:ReturnType<typeof make>)=>`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
  const write=async(server:ReturnType<typeof make>)=>{await writeFile(file,JSON.stringify({baseUrl:url(server),apiKey:secretKey}),{mode:0o600});await chmod(file,0o600);};
  await write(first);
  const oldHome=process.env.HOME,oldAgent=process.env.PI_CODING_AGENT_DIR;process.env.HOME=base;process.env.PI_CODING_AGENT_DIR=agent;
  const storage=new Storage(join(data,"state.sqlite")),host=new PiHost(storage,data,async()=>{});
  try{
    await host.init();
    await write(second);
    const view=await host.cliproxyProviders.connect();assert.equal(view.connected,true,"re-pointed connection is adopted while disconnected");
    assert.equal(host.cliproxyProviders.isConnected(),true);
    await write(first);
    assert.equal(host.cliproxyProviders.isConnected(),false,"tampering while connected is still blocked");
  }finally{
    await host.close();await storage.close();for(const server of [first,second])await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;
    if(oldAgent===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=oldAgent;
  }
});
