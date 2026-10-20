import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Storage } from "./storage.js";
import { PiHost, cachedVisibleMessages, trimWorkSteps, visibleMessages } from "./pi-host.js";
import { registerDemoProvider } from "./demo-provider.js";
import { chromiumPath } from "./qa-browser.js";
import { syntheticChromeBinary } from "./chrome-test-fixture.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const root=resolve(import.meta.dirname,"../..");
const testRoot=join(process.env.SIGMA_TEST_DIR||join(root,".scratch"),`checks-${Date.now()}-${process.pid}`);
process.env.PI_OFFLINE="1";
process.env.PI_CODING_AGENT_DIR=join(testRoot,"agent");
async function freePort():Promise<number>{const s=createServer();await new Promise<void>(r=>s.listen(0,"127.0.0.1",r));const port=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return port;}
async function waitFor(check:()=>Promise<boolean>,ms=6000){const until=Date.now()+ms;while(Date.now()<until){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw new Error("Timed out waiting for state");}
async function launch(port:number,dataDir:string,preload?:string,browser=chromiumPath()):Promise<ChildProcess>{
  const started=Date.now();let startup="";
  const child=spawn(process.execPath,["--import","tsx",...(preload?["--import",preload]:[]),"apps/server/main.ts"],{cwd:root,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,HOME:testRoot,SIGMA_APPROVAL_MODE:"ask",PI_OFFLINE:"1",PI_CODING_AGENT_DIR:join(testRoot,"agent"),SIGMA_DEMO:"1",SIGMA_PORT:String(port),SIGMA_DATA_DIR:dataDir,SIGMA_QA_CHROMIUM:browser},stdio:["ignore","pipe","pipe"]});
  for(const stream of [child.stdout,child.stderr])stream?.on("data",chunk=>{startup=(startup+String(chunk)).slice(-1000);});
  try{
    await waitFor(async()=>{
      if(child.exitCode!==null||child.signalCode!==null)throw new Error(`Fixture server exited: ${child.exitCode??child.signalCode}`);
      try{return (await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(2000)})).ok;}catch{return false;}
    },120000);
    return child;
  }catch(error){
    try{await stop(child);}catch{
      if(child.exitCode===null&&child.signalCode===null){
        const exited=new Promise<void>(resolve=>child.once("exit",()=>resolve()));child.kill("SIGKILL");
        await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,3000))]);
      }
    }
    throw new Error(`Fixture server on port ${port} was not ready after ${Date.now()-started} ms: ${error instanceof Error?error.message:String(error)}; startup: ${startup.trim()||"no output"}`);
  }
}
async function stop(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;child.kill("SIGTERM");await Promise.race([new Promise<void>(r=>child.once("exit",()=>r())),new Promise((_,reject)=>setTimeout(()=>reject(new Error("Service did not stop with active SSE")),5000))]);}
async function crash(child:ChildProcess){child.kill("SIGKILL");await new Promise<void>(r=>child.once("exit",()=>r()));}

test("Pi bash cannot bootstrap the Sigma control plane while project loopback networking stays available",async()=>{
  const port=await freePort(),origin=`http://127.0.0.1:${port}`,base=`${origin}/api`,dataDir=join(testRoot,"shell-control-plane",crypto.randomUUID());
  await mkdir(dataDir,{recursive:true});let received:Record<string,unknown>|undefined,child:ChildProcess|undefined;
  const project=createHttpServer((request,response)=>{
    if(request.method==="GET"&&request.url==="/health"){response.writeHead(200);response.end("ok");return;}
    if(request.method==="POST"&&request.url==="/report"){
      const chunks:Buffer[]=[];request.on("data",chunk=>chunks.push(Buffer.from(chunk)));request.on("end",()=>{try{received=JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string,unknown>;}catch{}response.writeHead(204);response.end();});return;
    }
    response.writeHead(404);response.end();
  });
  await new Promise<void>((resolve,reject)=>{project.once("error",reject);project.listen(0,"127.0.0.1",resolve);});
  const projectPort=(project.address() as {port:number}).port;
  const closeProject=()=>project.listening?new Promise<void>(resolve=>project.close(()=>resolve())):Promise.resolve();
  try{
    child=await launch(port,dataDir);
    const bootstrap=await fetch(`${base}/bootstrap`,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:"{}"});
    assert.equal(bootstrap.status,200,"A supervised UI request can still reach the actual API outside the agent shell");
    const cookie=bootstrap.headers.get("set-cookie")!.split(";")[0];
    const api=async(path:string,method="GET",body?:unknown,id?:string)=>{
      const response=await fetch(`${base}${path}`,{method,headers:{Origin:origin,Cookie:cookie,...(body===undefined?{}:{"Content-Type":"application/json"}),...(id?{"X-Command-Id":id}:{})},body:body===undefined?undefined:JSON.stringify(body)});
      return {status:response.status,data:await response.json() as any};
    };
    const created=await api("/sessions","POST",{cwd:root,model:"sigma-demo/offline",mode:"code"},crypto.randomUUID());
    assert.equal(created.status,200);
    const actualId=created.data.id as string;
    assert.equal((await api(`/sessions/${actualId}/browser-use`)).status,200,"The normal authenticated API remains available outside the shell");

    const config={apiPort:port,projectPort,apiOrigin:origin,sessionId:actualId};
    const script=`const http=require("node:http"),c=${JSON.stringify(config)};const request=(hostname,port,path,method="GET",headers={},body)=>new Promise(resolve=>{const req=http.request({hostname,port,path,method,headers},res=>{const cookie=res.headers["set-cookie"]?.[0]?.split(";")[0]||null;res.resume();res.once("end",()=>resolve({status:res.statusCode??null,error:null,cookie}))});req.setTimeout(3000,()=>req.destroy(Object.assign(new Error("timeout"),{code:"ETIMEDOUT"})));req.once("error",error=>resolve({status:null,error:error.code||"unknown",cookie:null}));req.end(body)});(async()=>{const host="127.0.0.1:"+c.apiPort,origin="http://"+host,boot=await request("127.0.0.1",c.apiPort,"/api/bootstrap","POST",{Host:host,Origin:origin,"Content-Type":"application/json"},"{}");let inventoryStatus=null,selectStatus=null;if(boot.status===200&&boot.cookie){const headers={Host:host,Origin:origin,Cookie:boot.cookie};inventoryStatus=(await request("127.0.0.1",c.apiPort,"/api/sessions/"+c.sessionId+"/browser-use","GET",headers)).status;selectStatus=(await request("127.0.0.1",c.apiPort,"/api/sessions/"+c.sessionId+"/browser-use/select","POST",{...headers,"Content-Type":"application/json"},JSON.stringify({targetId:"forged-target"}))).status}const project=await request("127.0.0.1",c.projectPort,"/health");const report={bootstrapStatus:boot.status,bootstrapError:boot.error,inventoryStatus,selectStatus,projectStatus:project.status};await request("127.0.0.1",c.projectPort,"/report","POST",{"Content-Type":"application/json"},JSON.stringify(report))})().catch(()=>{process.exitCode=2})`;
    const quote=(value:string)=>`'${value.replace(/'/g,"'\\''")}'`,command=`node -e ${quote(script)}`;
    const actualPromptId=crypto.randomUUID(),submitted=await api(`/sessions/${actualId}/prompt`,"POST",{text:`bash:${JSON.stringify({command,timeoutSeconds:20})}`},actualPromptId);
    assert.equal(submitted.status,200);
    let approval:any;
    await waitFor(async()=>{approval=(await api(`/sessions/${actualId}`)).data.approvals.find((item:any)=>item.tool==="bash"&&item.status==="pending");return !!approval;},30000);
    assert.equal((await api(`/sessions/${actualId}/approvals/${approval.id}`,"POST",{allow:true})).status,200,"The actual Pi bash tool is explicitly approved before it runs");
    await waitFor(async()=>!!received,30000);
    assert.deepEqual(received,{bootstrapStatus:null,bootstrapError:"EPERM",inventoryStatus:null,selectStatus:null,projectStatus:200},"The sandbox denies the connection before HTTP auth/status handling, and leaves an unrelated local project service reachable");
    await waitFor(async()=>(await api(`/sessions/${actualId}`)).data.status==="settled",30000);
  }finally{
    if(child)await stop(child).catch(()=>{});
    await closeProject();
  }
});

test("authenticated Pi SDK session, approval, idempotency and restart",async()=>{
  const port=await freePort(),origin=`http://127.0.0.1:${port}`,base=`${origin}/api`,dataDir=join(testRoot,"integration");
  await mkdir(dataDir,{recursive:true});let child=await launch(port,dataDir);
  async function client(){
    const boot=await fetch(`${base}/bootstrap`,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:"{}"});assert.equal(boot.status,200);
    const cookie=boot.headers.get("set-cookie")!.split(";")[0];
    return async(path:string,method="GET",body?:unknown,id?:string)=>{
      const res=await fetch(`${base}${path}`,{method,headers:{Origin:origin,Cookie:cookie,...(body===undefined?{}:{"Content-Type":"application/json"}),...(id?{"X-Command-Id":id}:{})},body:body===undefined?undefined:JSON.stringify(body)});
      return {status:res.status,data:await res.json()};
    };
  }
  try{
    assert.equal((await fetch(`${base}/sessions`,{headers:{Origin:origin}})).status,401);
    assert.equal((await fetch(`${base}/bootstrap`,{method:"POST",headers:{Origin:"http://evil.example"}})).status,403);
    let req=await client();
    for(const path of ["/v2/providers","/providers","/providers/openai-codex/login/00000000-0000-4000-8000-000000000000"]){
      assert.equal((await fetch(`${base}${path}`)).status,401,"Provider interaction requires the current bootstrap cookie");
      assert.equal((await fetch(`${base}${path}`,{headers:{Origin:"http://evil.example"}})).status,403,"Provider metadata and sign-in URLs reject another origin");
    }
    for(const path of ["/v2/providers/sigma-claude-cli/connect","/v2/providers/sigma-claude-cli/disconnect","/v2/providers/sigma-claude-cli/cancel","/v2/providers/sigma-claude-cli/refresh","/providers/openai-codex/login","/providers/openai-codex/refresh",...['answer','cancel','open'].map(action=>`/providers/openai-codex/login/00000000-0000-4000-8000-000000000000/${action}`)]){
      assert.equal((await fetch(`${base}${path}`,{method:"POST",headers:{Origin:origin}})).status,401,"Unauthenticated callers cannot change provider authentication or open a browser");
      assert.equal((await fetch(`${base}${path}`,{method:"POST",headers:{Origin:"http://evil.example"}})).status,403,"Other origins cannot change authentication or open a browser");
    }
    const native=await req("/v2/providers");assert.equal(native.status,200);assert.ok(native.data.providers.every((provider:any)=>provider.owner==="native_cli"&&provider.state==="blocked"));assert.equal((await req("/v2/providers/sigma-claude-cli/connect","POST",{})).data.providers[0].state,"blocked");
    const providers=await req("/providers");assert.equal(providers.status,200);assert.ok(providers.data.providers.some((provider:any)=>provider.id==="openai-codex"&&provider.oauth),"SDK OAuth discovery is independent of authenticated model availability");
    assert.equal((await req("/providers/openai-codex/login","POST",{})).status,400,"Missing command IDs cannot start a login");
    assert.equal((await req("/providers/not-a-provider/login","POST",{},crypto.randomUUID())).status,409);
    assert.equal((await req("/providers/openai-codex/login/00000000-0000-4000-8000-000000000000/open","POST",{url:"https://example.invalid"})).status,409,"Caller URLs cannot open a browser outside a current SDK sign-in operation");
    assert.equal((await fetch(`${base}/roles`)).status,401);
    assert.equal((await fetch(`${base}/roles`,{method:"PUT",headers:{Origin:"http://evil.example","Content-Type":"application/json"},body:"{}"})).status,403);
    const originalRoles=(await req("/roles")).data.catalog;
    assert.equal((await req("/roles","PUT",{...originalRoles,roles:[]})).status,400);
    const badModel=structuredClone(originalRoles);badModel.roles[0].model="missing/model";
    assert.equal((await req("/roles","PUT",badModel)).status,400);
    const badKey=structuredClone(originalRoles);badKey.roles[0].model="no-slash";
    assert.equal((await req("/roles","PUT",badKey)).status,400,"Model keys must be provider/id");
    const badReasoning=structuredClone(originalRoles);badReasoning.roles[0].model="sigma-demo/offline";badReasoning.roles[0].reasoning="high";
    assert.equal((await req("/roles","PUT",badReasoning)).status,400,"No silent reasoning clamp");
    const unknownRole=structuredClone(originalRoles);unknownRole.roles[0].role="root";
    assert.equal((await req("/roles","PUT",unknownRole)).status,400,"Root is not configurable");
    assert.equal((await req("/roles","PUT",{revision:0,groups:[],roles:originalRoles.roles})).status,400,"The old groups shape is not accepted");
    assert.equal((await req("/sessions","POST",{cwd:root,model:"sigma-demo/offline",reasoning:"high"},crypto.randomUUID())).status,400,"A model without reasoning rejects an explicit level");
    assert.equal((await req("/sessions","POST",{cwd:root,model:"sigma-demo/offline",reasoning:"turbo"},crypto.randomUUID())).status,400,"Unknown reasoning levels are rejected");
    assert.equal((await req("/project-tasks","POST",{projectId:crypto.randomUUID(),model:"sigma-demo/offline",reasoning:"turbo"},crypto.randomUUID())).status,400,"Project tasks reject unknown reasoning levels");
    const savedRoles=await req("/roles","PUT",originalRoles);assert.equal(savedRoles.status,200);assert.equal(savedRoles.data.catalog.revision,1);
    assert.equal((await req("/roles","PUT",originalRoles)).status,409,"Stale tabs cannot overwrite saved settings");
    assert.deepEqual((await req("/roles")).data.catalog,savedRoles.data.catalog);
    assert.equal((await fetch(`${base}/projects`)).status,401);
    assert.equal((await fetch(`${base}/folders/choose`,{method:"POST",headers:{Origin:origin}})).status,401,"Unauthenticated callers cannot open native dialogs");
    assert.equal((await fetch(`${base}/folders/choose`,{method:"POST",headers:{Origin:"http://evil.example"}})).status,403,"Other origins cannot open native dialogs");
    const projectId=crypto.randomUUID(),projectFolders=[join(dataDir,"frontend"),join(dataDir,"backend")];
    for(const folder of projectFolders)await mkdir(folder);
    assert.equal((await req(`/projects/${projectId}`,"PUT",{name:"Bad",folders:["relative"]})).status,400);
    assert.equal((await req(`/projects/${projectId}`,"PUT",{name:" ",folders:projectFolders})).status,400);
    assert.equal((await req(`/projects/${projectId}`,"PUT",{name:"Bad",folders:[join(dataDir,"missing")]})).status,400);
    assert.equal((await req(`/projects/${projectId}`,"PUT",{name:"Bad",folders:Array(21).fill(dataDir)})).status,400);
    assert.equal((await req(`/projects/${projectId}`,"PUT",null)).status,400);
    const project={id:projectId,name:"Custom project",folders:projectFolders};
    assert.deepEqual((await req(`/projects/${projectId}`,"PUT",{name:" Custom project ",folders:[...projectFolders,`${projectFolders[0]}/.`]})).data.project,{...project,archivedAt:null,agents:[]});
    assert.equal((await req(`/projects/${projectId}`,"PUT",project)).status,200,"Repeated save replaces the same project, without duplicates");
    assert.deepEqual((await req("/projects")).data.projects,[{...project,archivedAt:null,agents:[]}]);
    const gitSnapshot=await req(`/projects/${projectId}/status`);
    assert.equal(gitSnapshot.status,200);assert.deepEqual(gitSnapshot.data.folders.map((f:any)=>f.path),projectFolders);
    assert.equal((await req(`/projects/${crypto.randomUUID()}/status`)).status,404);
    for(const agents of [{},[{role:"root",model:null}],[{role:"worker",model:"missing/model"}],[{role:"worker",model:"no-slash"}],[{role:"worker",reasoning:"huge"}],[{role:"worker",model:null},{role:"worker",reasoning:null}],[{role:"worker",extra:1}]])
      assert.equal((await req(`/projects/${projectId}`,"PUT",{...project,agents})).status,400,`Invalid project agents are rejected: ${JSON.stringify(agents)}`);
    const agents=[{role:"worker",model:"sigma-demo/offline"},{role:"qa",reasoning:null}];
    assert.deepEqual((await req(`/projects/${projectId}`,"PUT",{...project,agents})).data.project.agents,agents);
    assert.deepEqual((await req(`/projects/${projectId}`,"PUT",project)).data.project.agents,agents,"A save without agents keeps the project's agent settings");
    assert.equal((await req("/sessions","POST",{cwd:root,model:"sigma-demo/offline",projectId},crypto.randomUUID())).status,400,"A project chat must use one of the project's folders");
    assert.equal((await req("/sessions","POST",{scratch:true,model:"sigma-demo/offline",projectId},crypto.randomUUID())).status,400);
    const projectChat=await req("/sessions","POST",{cwd:projectFolders[0],model:"sigma-demo/offline",projectId},crypto.randomUUID());assert.equal(projectChat.status,200);
    const projectCatalog=(await req(`/sessions/${projectChat.data.id}`)).data.policy.role.catalog;
    assert.equal(projectCatalog.roles.find((item:any)=>item.role==="worker").model,"sigma-demo/offline","A chat in the project snapshots the project's agent model");
    assert.equal(projectCatalog.roles.find((item:any)=>item.role==="planner").model,null,"Roles the project leaves alone follow the global Agents settings");
    const looseChat=await req("/sessions","POST",{cwd:projectFolders[0],model:"sigma-demo/offline"},crypto.randomUUID());
    assert.equal((await req(`/sessions/${looseChat.data.id}`)).data.policy.role.catalog.roles.find((item:any)=>item.role==="worker").model,null,"Chats outside a project keep the global settings");
    for(const id of [projectChat.data.id,looseChat.data.id])assert.equal((await req(`/sessions/${id}/archive`,"POST",{archived:true})).status,200);
    assert.deepEqual((await req(`/projects/${projectId}`,"PUT",{...project,agents:[]})).data.project.agents,[]);
    const createId=crypto.randomUUID(),model="sigma-demo/offline";
    const created=await req("/sessions","POST",{cwd:root,model},createId);assert.equal(created.status,200);const sid=created.data.id;
    assert.equal((await req("/sessions","POST",{cwd:root,model},createId)).data.id,sid);
    assert.equal((await req("/sessions","POST",{cwd:root,model,mode:"unsafe"},crypto.randomUUID())).status,400);
    assert.equal((await req("/sessions","POST",{cwd:root,model,mode:"code"},createId)).status,400,"Changing mode cannot reuse a creation ID");
    assert.equal((await req(`/sessions/${sid}/changes`)).status,409);
    assert.equal((await fetch(`${base}/v2/access`)).status,401);
    assert.equal((await req("/v2/access")).data.mode,"ask","Suite default is ask via SIGMA_APPROVAL_MODE");
    for(const bad of [{},{mode:"yes"},{mode:"full",extra:1},[],"full",null])assert.equal((await req("/v2/access","POST",bad)).status,400);
    assert.equal((await req("/v2/access","POST",{mode:"full"})).data.mode,"full");assert.equal((await req("/v2/access")).data.mode,"full");
    assert.equal((await req("/v2/access","POST",{mode:"ask"})).data.mode,"ask");
    const graphPath=`/sessions/${sid}/graph`;
    assert.equal((await fetch(`${base}${graphPath}`)).status,401);
    assert.equal((await fetch(`${base}${graphPath}/events`,{headers:{Origin:"http://evil.example"}})).status,403);
    const lone=(await req(graphPath)).data;assert.deepEqual(lone.nodes.map((node:any)=>node.id),[sid]);
    assert.equal(lone.nodes[0].metadata.reasoningAvailability,"unavailable","No historical run is invented on creation");
    assert.equal(lone.events[0].payload.actor,"user");assert.equal(lone.events[0].payload.cause,"user_create");
    assert.equal((await fetch(`${base}/sessions/${sid}/changes`)).status,401);
    const commandId=crypto.randomUUID();assert.equal((await req(`/sessions/${sid}/prompt`,"POST",{text:"hello"},commandId)).data.accepted,true);
    assert.equal((await req(`/sessions/${sid}/prompt`,"POST",{text:"hello"},commandId)).data.accepted,false);
    assert.equal((await req(`/sessions/${sid}/prompt`,"POST",{text:"different"},commandId)).status,409);
    assert.ok(["dispatched","completed"].includes((await req(`/sessions/${sid}/prompt`,"POST",{text:"hello"},commandId)).data.status));
    await waitFor(async()=>(await req(`/sessions/${sid}`)).data.messages.length===2);
    await waitFor(async()=>(await req(`/sessions/${sid}/prompt`,"POST",{text:"hello"},commandId)).data.status==="completed");
    const readId=crypto.randomUUID();await req(`/sessions/${sid}/prompt`,"POST",{text:"read:package.json"},readId);
    await waitFor(async()=>(await req(`/sessions/${sid}`)).data.approvals.some((a:any)=>a.status==="pending"));
    const pending=(await req(`/sessions/${sid}`)).data.approvals.find((a:any)=>a.status==="pending");
    assert.equal(pending.preview,"read package.json");
    assert.equal((await req(`/sessions/${sid}/approvals/${pending.id}`,"POST",{allow:true})).status,200);
    await waitFor(async()=>(await req(`/sessions/${sid}`)).data.messages.some((m:any)=>m.text==="Demo: the read tool completed."));
    {const turn=(await req(`/sessions/${sid}`)).data.messages.find((m:any)=>m.role==="user"&&m.text==="read:package.json");
    assert.ok(turn?.work,"tool-using turn exposes its working stages");assert.ok(turn.work.startedAt<=turn.work.endedAt);
    assert.ok(turn.work.steps.some((st:any)=>st.kind==="tool"&&st.tool==="read"&&st.detail==="package.json"&&st.status==="done"));}
    const delegationId=crypto.randomUUID();await req(`/sessions/${sid}/prompt`,"POST",{text:"delegate2: inspect A | inspect B"},delegationId);
    await waitFor(async()=>{const s=(await req(`/sessions/${sid}`)).data;return s.status==="settled"&&s.agents.length===3&&s.agents.every((a:any)=>a.status==="settled");});
    const beforeRestart=(await req(`/sessions/${sid}`)).data;
    {const earlier=beforeRestart.messages.find((m:any)=>m.role==="user"&&m.text==="read:package.json"),latest=[...beforeRestart.messages].reverse().find((m:any)=>m.role==="user");
    assert.deepEqual(earlier.work.steps,[],"Earlier turns leave their steps out of the chat snapshot");assert.ok(earlier.work.stepCount>0);assert.ok(latest.work.steps.length>0&&latest.work.stepCount===undefined,"The latest turn keeps its steps");
    const steps=(await req(`/sessions/${sid}/messages/${earlier.id}/work`)).data.steps;assert.equal(steps.length,earlier.work.stepCount);
    assert.ok(steps.some((st:any)=>st.kind==="tool"&&st.tool==="read"&&st.detail==="package.json"&&st.status==="done"),"Steps of an earlier turn load on demand");
    assert.equal((await req(`/sessions/${sid}/messages/no-such-message/work`)).status,404);}
    const delegatedGraph=(await req(graphPath)).data;
    assert.equal(delegatedGraph.nodes.length,3);assert.equal(new Set(delegatedGraph.nodes.map((node:any)=>node.id)).size,3);
    const receipts=delegatedGraph.events.filter((event:any)=>event.payload.kind==="result"&&event.payload.outcome==="received");
    assert.equal(receipts.length,2,"Only two persisted delegate tool results prove root receipt");
    assert.ok(receipts.every((event:any)=>event.payload.target===sid&&event.payload.receiptEntryId&&event.payload.sourceRun.runId&&event.payload.run.runId));
    assert.ok(delegatedGraph.nodes.every((node:any)=>node.metadata.model==="sigma-demo/offline"&&node.metadata.reasoningAvailability==="unsupported"));
    assert.equal((await req(`${graphPath}/events?after=${delegatedGraph.cursor}`)).data.events.length,0);
    assert.equal((await req(`${graphPath}/events?after=${delegatedGraph.cursor+1}`)).status,400);
    assert.equal((await req(`${graphPath}/events?after=-1`)).status,400);
    assert.deepEqual(beforeRestart.agents.map((a:any)=>a.role),["root","worker","worker"]);
    const childHistories=await Promise.all(beforeRestart.agents.filter((a:any)=>a.role==="worker").map(async(a:any)=>(await req(`/sessions/${sid}/agents/${a.id}`)).data));
    for(const text of ["inspect A","inspect B"])assert.ok(childHistories.some(child=>child.messages.some((m:any)=>m.role==="assistant"&&m.text.includes(text))),"Each child result is available from its own Pi history");
    const firstChild=childHistories.find(child=>child.messages.some((m:any)=>m.role==="assistant"&&m.text.includes("inspect A"))),messageChild=firstChild.id,childPath=`/sessions/${sid}/agents/${messageChild}`;
    assert.ok(beforeRestart.agents.some((a:any)=>a.id===messageChild));
    assert.equal((await fetch(`${base}${childPath}`)).status,401);
    assert.equal((await fetch(`${base}${childPath}/prompt`,{method:"POST",headers:{Origin:"http://evil.example","Content-Type":"application/json"},body:JSON.stringify({text:"spoof"})})).status,403);
    assert.equal((await req(`/sessions/${crypto.randomUUID()}/agents/${messageChild}`)).status,404);
    assert.equal((await req(`/sessions/${sid}/agents/${sid}`)).status,404);
    const resumeId=crypto.randomUUID();
    assert.equal((await req(`${childPath}/prompt`,"POST",{text:"slow resumed"},resumeId)).data.status,"dispatched");
    await waitFor(async()=>(await req(`/sessions/${sid}`)).data.agents.find((a:any)=>a.id===messageChild).status==="running");
    const steerId=crypto.randomUUID(),followId=crypto.randomUUID();
    assert.equal((await req(`${childPath}/prompt`,"POST",{text:"redirect",behavior:"steer"},steerId)).data.status,"queued");
    assert.equal((await req(`${childPath}/prompt`,"POST",{text:"follow-up",behavior:"followUp"},followId)).data.status,"queued");
    assert.equal((await req(`${childPath}/prompt`,"POST",{text:"redirect",behavior:"steer"},steerId)).data.status,"queued","Duplicate command does not queue twice");
    assert.equal((await req(`${childPath}/prompt`,"POST",{text:"different",behavior:"steer"},steerId)).status,409);
    assert.equal((await req(`/sessions/${crypto.randomUUID()}/agents/${messageChild}/prompt`,"POST",{text:"foreign"},crypto.randomUUID())).status,409);
    assert.equal((await req(`/sessions/${sid}/agents/${sid}/prompt`,"POST",{text:"root spoof"},crypto.randomUUID())).status,409);
    await waitFor(async()=>(await req(`/sessions/${sid}`)).data.agents.find((a:any)=>a.id===messageChild).status==="settled",12000);
    const continued=(await req(childPath)).data.messages;
    assert.ok(continued.some((m:any)=>m.role==="user"&&m.text==="redirect"));
    assert.ok(continued.some((m:any)=>m.role==="user"&&m.text==="follow-up"));
    assert.ok(continued.some((m:any)=>m.role==="assistant"&&m.text.includes("follow-up")));
    const graphAfterMessages=(await req(graphPath)).data;
    assert.equal(graphAfterMessages.nodes.length,3,"Follow-ups do not duplicate nodes");
    for(const [command,kind] of [[steerId,"steer"],[followId,"followUp"]]){
      const fact=graphAfterMessages.events.find((event:any)=>event.payload.commandId===command&&event.payload.outcome==="received");
      assert.equal(fact?.payload.kind,kind);assert.equal(fact?.payload.actor,"user");assert.equal(fact?.payload.target,messageChild);
    }
    const graphIncrement=(await req(`${graphPath}/events?after=${delegatedGraph.cursor}`)).data;
    assert.deepEqual(graphIncrement.events.map((event:any)=>event.seq),graphAfterMessages.events.filter((event:any)=>event.seq>delegatedGraph.cursor).map((event:any)=>event.seq),"Snapshot and catch-up have neither gaps nor duplicate events");
    const stopResumeId=crypto.randomUUID(),siblingId=beforeRestart.agents.find((a:any)=>a.role==="worker"&&a.id!==messageChild)!.id,siblingPath=`/sessions/${sid}/agents/${siblingId}`;
    assert.notEqual(siblingId,messageChild,"Targeted Stop requires two distinct child identities");
    assert.equal((await req(`${childPath}/prompt`,"POST",{text:`slow ${"stop me ".repeat(20)}`},stopResumeId)).data.status,"dispatched");
    assert.equal((await req(`${siblingPath}/prompt`,"POST",{text:`slow ${"sibling ".repeat(20)}`},crypto.randomUUID())).data.status,"dispatched");
    await waitFor(async()=>(await req(`/sessions/${sid}`)).data.agents.filter((a:any)=>a.parentId&&a.status==="running").length===2);
    await req(`/sessions/${sid}/prompt`,"POST",{text:"delegate:service cap on resumed children"},crypto.randomUUID());
    await waitFor(async()=>(await req(`/sessions/${sid}`)).data.status==="settled");
    assert.equal((await req(`/sessions/${sid}`)).data.agents.length,4,"A third child is admitted while two resumed child turns run");
    assert.equal((await req(`${childPath}/abort`,"POST",{},crypto.randomUUID())).data.status,"completed");
    assert.equal((await req(`/sessions/${sid}`)).data.agents.find((a:any)=>a.id===messageChild).status,"interrupted");
    assert.equal((await req(`/sessions/${sid}`)).data.agents.find((a:any)=>a.id===siblingId).status,"running","Sibling keeps running after targeted Stop");
    await waitFor(async()=>(await req(`/sessions/${sid}`)).data.agents.find((a:any)=>a.id===siblingId).status==="settled",12000);
    assert.equal((await req(`${childPath}/prompt`,"POST",{text:`slow ${"stop me ".repeat(20)}`},stopResumeId)).data.status,"unknown","Stopped child command is not replayed");
    assert.ok((await req(childPath)).data.recoveryInputs.some((input:any)=>input.id===stopResumeId));
    assert.equal((await req(`${childPath}/prompt`,"POST",{text:"revive"},crypto.randomUUID())).status,409);
    const messages=(await req(`/sessions/${sid}`)).data.messages;assert.equal(messages.length,8);
    assert.ok(Number.isSafeInteger(beforeRestart.cursor)&&beforeRestart.cursor>0);
    const stream=await fetch(`${base}/sessions/${sid}/events?after=${beforeRestart.cursor-1}`,{headers:{Origin:origin,Cookie:(await fetch(`${base}/bootstrap`,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:"{}"})).headers.get("set-cookie")!.split(";")[0]}});
    assert.equal(stream.status,200);
    const reader=stream.body!.getReader();
    const firstEvent=JSON.parse(new TextDecoder().decode((await reader.read()).value!).replace(/^data: /,"").split("\n\n")[0]);
    assert.equal(firstEvent.seq,beforeRestart.cursor);
    await stop(child);await reader.cancel();
    child=await launch(port,dataDir);req=await client();
    assert.deepEqual((await req("/projects")).data.projects,[{...project,archivedAt:null,agents:[]}],"Project membership survives a real service restart");
    assert.deepEqual((await req(`/projects/${projectId}`,"PUT",{name:"Renamed",folders:[projectFolders[1]]})).data.project,{id:projectId,name:"Renamed",folders:[projectFolders[1]],archivedAt:null,agents:[]});
    const restoredPair=await Promise.all([req(`/sessions/${sid}`),req(`/sessions/${sid}`)]);
    assert.equal(restoredPair[0].status,200);assert.equal(restoredPair[1].status,200);
    const restored=restoredPair[0].data;
    const restoredGraph=(await req(graphPath)).data;
    assert.equal(restoredGraph.nodes.length,4);
    assert.deepEqual(restoredGraph.events.filter((event:any)=>event.payload.kind==="result"&&event.payload.outcome==="received").slice(0,receipts.length),receipts,"Receipt facts retain actual run metadata over restart");
    const foreign=crypto.randomUUID();await req("/sessions","POST",{cwd:root,model},foreign);
    assert.equal((await req(`${graphPath}/nodes/${foreign}/history`)).status,404,"Same-folder root is outside this graph");
    assert.equal((await req(`/sessions/${foreign}/graph/nodes/${messageChild}/history`)).status,404);
    assert.equal((await req(`${graphPath}/nodes/${messageChild}/history`)).data.id,messageChild);
    assert.equal((await req(`/sessions/${messageChild}/graph`)).status,404,"Child cannot redefine root scope");
    assert.deepEqual(restored.messages,messages);assert.equal(restored.approvals.find((a:any)=>a.id===pending.id).status,"approved");
    const retry=await req(`/sessions/${sid}/prompt`,"POST",{text:"hello"},commandId);assert.equal(retry.data.status,"completed");
    assert.equal((await req(`/sessions/${sid}`)).data.messages.length,8);
    await req(`/sessions/${sid}/prompt`,"POST",{text:"delegate:race child"},crypto.randomUUID());
    await waitFor(async()=>{const row=(await req(`/sessions/${sid}`)).data;return row.status==="settled"&&row.agents.length===5&&row.agents[4].status==="settled";});
    const raceChild=(await req(`/sessions/${sid}`)).data.agents[4].id,racePath=`/sessions/${sid}/agents/${raceChild}`,raceText=`slow ${"one owner ".repeat(20)}`,raceTextB=`slow ${"other owner ".repeat(20)}`;
    const raceA=crypto.randomUUID(),raceB=crypto.randomUUID();
    const attempts=await Promise.all([req(`${racePath}/prompt`,"POST",{text:raceText},raceA),req(`${racePath}/prompt`,"POST",{text:raceTextB},raceB)]);
    assert.deepEqual(attempts.map(x=>x.status).sort(),[200,409],"Only one settled-child turn is admitted");
    const loserId=attempts[0].status===409?raceA:raceB,loserText=attempts[0].status===409?raceText:raceTextB;
    assert.equal((await req(`${racePath}/prompt`,"POST",{text:loserText},loserId)).data.status,"rejected","Rejected admission does not remain accepted");
    await waitFor(async()=>(await req(`/sessions/${sid}`)).data.agents.find((a:any)=>a.id===raceChild).status==="running");
    assert.equal((await req(`${racePath}/abort`,"POST",{},crypto.randomUUID())).data.status,"completed");
    assert.equal((await req(`/sessions/${sid}`)).data.agents.find((a:any)=>a.id===raceChild).status,"interrupted","Targeted Stop still owns the concurrent admission winner");
    const winnerId=attempts[0].status===200?raceA:raceB,winnerText=attempts[0].status===200?raceText:raceTextB;
    assert.equal((await req(`${racePath}/prompt`,"POST",{text:winnerText},winnerId)).data.status,"unknown","Stopped winner is not replayed");
    const cancelId=crypto.randomUUID();await req("/sessions","POST",{cwd:root,model},cancelId);
    await req(`/sessions/${cancelId}/prompt`,"POST",{text:"delegate2: slow A | slow B"},crypto.randomUUID());
    await waitFor(async()=>{const s=(await req(`/sessions/${cancelId}`)).data;return s.agents.length===3&&s.agents.some((a:any)=>a.parentId&&a.status==="running");});
    await req(`/sessions/${cancelId}/abort`,"POST",{});
    await waitFor(async()=>{const s=(await req(`/sessions/${cancelId}`)).data;return s.status==="interrupted"&&s.agents.every((a:any)=>a.status==="interrupted");});
    const failureId=crypto.randomUUID();await req("/sessions","POST",{cwd:root,model},failureId);
    await req(`/sessions/${failureId}/prompt`,"POST",{text:"fail-provider"},crypto.randomUUID());
    await waitFor(async()=>(await req(`/sessions/${failureId}`)).data.status==="error");
    assert.equal((await req(`/sessions/${failureId}`)).data.messages.some((m:any)=>m.text.includes("Demo response")),false);
    const childFailureId=crypto.randomUUID();await req("/sessions","POST",{cwd:root,model},childFailureId);
    await req(`/sessions/${childFailureId}/prompt`,"POST",{text:"delegate:fail-provider"},crypto.randomUUID());
    await waitFor(async()=>{const s=(await req(`/sessions/${childFailureId}`)).data;return s.agents.length===2&&s.agents[1].status==="error"&&s.status==="settled";});
    assert.match((await req(`/sessions/${childFailureId}`)).data.messages.at(-1).text,/denied or failed/);
    assert.deepEqual((await req(`/sessions/${childFailureId}`)).data.recoveryActions,[],"Observed child failure is terminal, not an uncertain spawn");
    const targetedId=crypto.randomUUID();await req("/sessions","POST",{cwd:`${root}/.`,model},targetedId);
    const policy=(await req(`/sessions/${targetedId}`)).data.policy;
    const {role,setup,...basePolicy}=policy;assert.equal(setup.sessionId,targetedId);assert.equal(setup.managerId,targetedId);assert.equal(setup.policyVersion,basePolicy.version);assert.deepEqual(setup.requested,basePolicy.requested);assert.deepEqual(setup.profile,basePolicy.effective.profile);assert.equal(role.type,"root");assert.equal(role.catalog.revision,1);
    assert.deepEqual(basePolicy,{version:2,requested:{cwd:`${root}/.`,model,mode:"read"},effective:{cwd:root,model,profile:{execution:"host",tools:["read","ls"],approval:"per-call",rootTotalChildren:4,maxDepth:2,childTimeoutMs:1_800_000}}});
    await req(`/sessions/${targetedId}/prompt`,"POST",{text:"delegate2: read:package.json | read:README.md"},crypto.randomUUID());
    await waitFor(async()=>(await req(`/sessions/${targetedId}`)).data.approvals.filter((a:any)=>a.status==="pending").length===2);
    const overlapping=(await req(`/sessions/${targetedId}`)).data;
    assert.equal(overlapping.agents.filter((a:any)=>a.parentId&&a.status==="running").length,2,"Both children actually overlap");
    const [approvalA,approvalB]=overlapping.approvals,stopId=crypto.randomUUID();
    const stopPath=`/sessions/${targetedId}/agents/${approvalA.agentId}/abort`;
    const {role:childRole,setup:childSetup,...childPolicy}=(await req(`/sessions/${approvalA.agentId}`)).data.policy;
    assert.equal(childSetup.sessionId,approvalA.agentId);assert.equal(childSetup.managerId,approvalA.agentId);assert.equal(childSetup.parentId,targetedId);assert.equal(childSetup.rootId,targetedId);assert.deepEqual(childSetup.profile,childPolicy.effective.profile);
    assert.deepEqual(childPolicy,basePolicy,"Child inherits the root permissions");
    assert.equal(childRole.type,"worker");assert.deepEqual(childRole.catalog,role.catalog,"Child keeps the root's role snapshot");
    assert.equal((await req(`/sessions/${approvalA.agentId}/prompt`,"POST",{text:"bypass delegation limits"},crypto.randomUUID())).status,409);
    assert.equal((await req(stopPath,"POST",{})).status,400);
    assert.equal((await req(`/sessions/${sid}/agents/${approvalA.agentId}/abort`,"POST",{},crypto.randomUUID())).status,404);
    assert.equal((await req(`/sessions/${targetedId}/agents/${targetedId}/abort`,"POST",{},crypto.randomUUID())).status,404);
    assert.equal((await req(`/sessions/${approvalA.agentId}/agents/${approvalB.agentId}/abort`,"POST",{},crypto.randomUUID())).status,404);
    const cappedId=crypto.randomUUID();await req("/sessions","POST",{cwd:root,model},cappedId);
    await req(`/sessions/${cappedId}/prompt`,"POST",{text:"delegate:service cap"},crypto.randomUUID());
    await waitFor(async()=>(await req(`/sessions/${cappedId}`)).data.status==="settled");
    assert.equal((await req(`/sessions/${cappedId}`)).data.agents.length,2,"No service-wide concurrency limit: other roots do not block a new child");
    assert.equal((await req(`/sessions/${targetedId}`)).data.approvals.filter((a:any)=>a.status==="pending").length,2);
    assert.equal((await req(stopPath,"POST",{},stopId)).status,200,"Stop one child while its approval is pending");
    const afterStop=(await req(`/sessions/${targetedId}`)).data;
    assert.equal(afterStop.status,"running");
    assert.equal(afterStop.agents.find((a:any)=>a.id===approvalA.agentId).status,"interrupted");
    assert.equal(afterStop.agents.find((a:any)=>a.id===approvalB.agentId).status,"running");
    assert.equal(afterStop.approvals.find((a:any)=>a.id===approvalA.id).status,"denied");
    assert.equal(afterStop.approvals.find((a:any)=>a.id===approvalB.id).status,"pending");
    assert.equal((await req(`/sessions/${targetedId}/approvals/${approvalA.id}`,"POST",{allow:true})).status,409,"Late Allow cannot revive a cancelled child");
    assert.equal((await req(stopPath,"POST",{},stopId)).data.status,"completed");
    assert.equal((await req(`/sessions/${targetedId}/agents/${approvalB.agentId}/abort`,"POST",{},stopId)).status,409,"A command ID cannot be retargeted");
    await req(`/sessions/${targetedId}/approvals/${approvalB.id}`,"POST",{allow:true});
    await waitFor(async()=>{const s=(await req(`/sessions/${targetedId}`)).data;return s.status==="settled"&&s.agents.find((a:any)=>a.id===approvalB.agentId).status==="settled";});
    assert.equal((await req(`/sessions/${targetedId}/agents/${approvalB.agentId}/abort`,"POST",{},crypto.randomUUID())).data.status,"completed");
    assert.equal((await req(`/sessions/${targetedId}`)).data.agents.find((a:any)=>a.id===approvalB.agentId).status,"settled","Late Stop preserves the completed result");
    await req(`/sessions/${cappedId}/prompt`,"POST",{text:"delegate:service released child"},crypto.randomUUID());
    await waitFor(async()=>(await req(`/sessions/${cappedId}`)).data.status==="settled");
    assert.equal((await req(`/sessions/${cappedId}`)).data.agents.length,3,"A further child can start; legacy nesting is covered separately");
    await req(`/sessions/${targetedId}/prompt`,"POST",{text:"delegate2: slow C | slow D"},crypto.randomUUID());
    await waitFor(async()=>(await req(`/sessions/${targetedId}`)).data.agents.filter((a:any)=>a.parentId&&a.status==="running").length===2);
    const runningPair=(await req(`/sessions/${targetedId}`)).data.agents.filter((a:any)=>a.parentId&&a.status==="running");
    await req(`/sessions/${targetedId}/agents/${runningPair[0].id}/abort`,"POST",{},crypto.randomUUID());
    assert.equal((await req(`/sessions/${targetedId}`)).data.agents.find((a:any)=>a.id===runningPair[1].id).status,"running");
    await req(`/sessions/${targetedId}/abort`,"POST",{});
    const rootStopped=(await req(`/sessions/${targetedId}`)).data;
    assert.equal(rootStopped.status,"interrupted");
    assert.ok(rootStopped.agents.filter((a:any)=>runningPair.some((p:any)=>p.id===a.id)).every((a:any)=>a.status==="interrupted"));
    assert.equal(rootStopped.agents.find((a:any)=>a.id===approvalB.agentId).status,"settled","Root Stop preserves earlier child results");
    await req(`/sessions/${targetedId}/prompt`,"POST",{text:"delegate:root lifetime cap"},crypto.randomUUID());
    await waitFor(async()=>(await req(`/sessions/${targetedId}`)).data.status==="settled");
    assert.equal((await req(`/sessions/${targetedId}`)).data.agents.length,6,"No per-root child limit: every delegation is admitted");
    const targetBeforeCrash=(await req(`/sessions/${targetedId}`)).data;
    assert.deepEqual(targetBeforeCrash.policy,policy);
    const pendingId=crypto.randomUUID(),pendingPromptId=crypto.randomUUID();await req("/sessions","POST",{cwd:root,model},pendingId);
    await req(`/sessions/${pendingId}/prompt`,"POST",{text:"read:package.json"},pendingPromptId);
    await waitFor(async()=>(await req(`/sessions/${pendingId}`)).data.approvals.some((a:any)=>a.status==="pending"));
    const queueA=crypto.randomUUID(),queueB=crypto.randomUUID();
    assert.equal((await req(`/sessions/${pendingId}/prompt`,"POST",{text:"queue A",behavior:"followUp"},queueA)).data.status,"queued");
    assert.equal((await req(`/sessions/${pendingId}/prompt`,"POST",{text:"queue B",behavior:"followUp"},queueB)).data.status,"queued");
    const delegatedCrashId=crypto.randomUUID(),delegatedPromptId=crypto.randomUUID();
    await req("/sessions","POST",{cwd:root,model},delegatedCrashId);
    await req(`/sessions/${delegatedCrashId}/prompt`,"POST",{text:"delegate:read:README.md"},delegatedPromptId);
    await waitFor(async()=>(await req(`/sessions/${delegatedCrashId}`)).data.approvals.some((a:any)=>a.status==="pending"));
    const delegatedChild=(await req(`/sessions/${delegatedCrashId}`)).data.agents[1].id;
    const codeSource=join(dataDir,"code-source");await mkdir(codeSource);
    const fixtureGit=(args:string[])=>execFileSync("git",["-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false",...args],{cwd:codeSource,env:{...process.env,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_AUTHOR_NAME:"Fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"Fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid"}});
    fixtureGit(["init","-b","main"]);await writeFile(join(codeSource,"seed.txt"),"fixture\n");fixtureGit(["add","seed.txt"]);fixtureGit(["commit","-m","Fixture"]);
    const codeCrashId=crypto.randomUUID(),codePromptId=crypto.randomUUID(),writePrompt='write:{"path":"target.txt","content":"after crash\\n"}';
    assert.equal((await req("/sessions","POST",{cwd:codeSource,model,mode:"code"},codeCrashId)).status,200);
    await req(`/sessions/${codeCrashId}/prompt`,"POST",{text:writePrompt},codePromptId);
    await waitFor(async()=>(await req(`/sessions/${codeCrashId}`)).data.approvals.some((a:any)=>a.status==="pending"));
    const live=await fetch(`${base}/sessions/${pendingId}/events`,{headers:{Origin:origin,Cookie:(await fetch(`${base}/bootstrap`,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:"{}"})).headers.get("set-cookie")!.split(";")[0]}});
    assert.equal(live.status,200);
    await crash(child);await live.body?.cancel().catch(()=>{});
    child=await launch(port,dataDir);req=await client();
    const restoredTarget=(await req(`/sessions/${targetedId}`)).data;
    assert.deepEqual(restoredTarget.policy,policy);
    assert.deepEqual(restoredTarget.agents,targetBeforeCrash.agents);
    assert.equal(restoredTarget.agents.length,6);
    assert.equal((await req(stopPath,"POST",{},stopId)).data.status,"completed","Completed child stop is not replayed after restart");
    const recovered=(await req(`/sessions/${pendingId}`)).data;
    const recoveredDelegation=(await req(`/sessions/${delegatedCrashId}`)).data;
    assert.equal(recoveredDelegation.agents.length,2);
    const crashedGraph=(await req(`/sessions/${delegatedCrashId}/graph`)).data;
    assert.ok(crashedGraph.events.some((event:any)=>event.payload.kind==="delegation"&&event.payload.outcome==="unknown"));
    assert.equal(crashedGraph.events.some((event:any)=>event.payload.kind==="result"&&event.payload.outcome==="received"),false,"Interrupted child and completed admission do not imply receipt");
    assert.equal(recoveredDelegation.agents[1].status,"interrupted");
    assert.equal(recoveredDelegation.approvals[0].status,"expired");
    assert.deepEqual(recoveredDelegation.recoveryActions.map((action:any)=>[action.kind,action.status,action.agentId,action.text]),[["delegate","unknown",delegatedChild,"read:README.md"]]);
    assert.equal((await req(`/sessions/${delegatedCrashId}/prompt`,"POST",{text:"delegate:read:README.md"},delegatedPromptId)).data.status,"unknown");
    assert.equal((await req(`/sessions/${delegatedCrashId}`)).data.agents.length,2,"Uncertain child command is not dispatched twice");
    const recoveredWrite=(await req(`/sessions/${codeCrashId}`)).data;
    // The approval was still pending at the crash, so no write had started.
    assert.deepEqual(recoveredWrite.recoveryActions,[]);
    assert.equal(recoveredWrite.approvals[0].status,"expired");
    assert.equal((await req(`/sessions/${codeCrashId}/prompt`,"POST",{text:writePrompt},codePromptId)).data.status,"unknown");
    assert.equal((await req(`/sessions/${codeCrashId}`)).data.approvals.length,1,"The expired write does not request approval again");
    assert.equal(recovered.approvals.some((a:any)=>a.status==="pending"),false);
    assert.equal(recovered.approvals[0].status,"expired");
    assert.equal((await req(`/sessions/${pendingId}/prompt`,"POST",{text:"read:package.json"},pendingPromptId)).data.status,"unknown");
    assert.deepEqual(recovered.recoveryInputs.filter((input:any)=>[queueA,queueB].includes(input.id)).map((input:any)=>[input.id,input.text,input.status]),[[queueB,"queue B","unknown"],[queueA,"queue A","unknown"]]);
    assert.equal((await req(`/sessions/${pendingId}/prompt`,"POST",{text:"queue A",behavior:"followUp"},queueA)).data.status,"unknown");
    assert.equal((await req(`/sessions/${pendingId}/prompt`,"POST",{text:"queue B",behavior:"followUp"},queueB)).data.status,"unknown");
    const replacementId=crypto.randomUUID();
    assert.equal((await req(`/sessions/${pendingId}/prompt`,"POST",{text:"queue A"},replacementId)).status,200);
    await waitFor(async()=>(await req(`/sessions/${pendingId}`)).data.messages.some((message:any)=>message.role==="user"&&message.text==="queue A"));
    assert.ok((await req(`/sessions/${pendingId}`)).data.recoveryInputs.some((input:any)=>input.id===queueA),"A newer identical message does not resolve the crashed command");
    await stop(child);
    const recoveredStorage=new Storage(join(dataDir,"state.sqlite")),recoveredHost=new PiHost(recoveredStorage,dataDir,async()=>{});
    try{
      await recoveredHost.init();registerDemoProvider((recoveredHost as unknown as {runtime:ModelRuntime}).runtime);
      await recoveredHost.snapshot(codeCrashId);
      const tool=(recoveredHost as any).active.get(codeCrashId).session.getToolDefinition("write");
      const priorWrite=await recoveredStorage.call<{commandId:string;commandStatus:string}>("writeApproval",{id:recoveredWrite.approvals[0].id});
      assert.equal(priorWrite.commandStatus,"rejected");
      const toolCallId=priorWrite.commandId.slice(`pi-tool:${codeCrashId}:`.length);
      await assert.rejects(tool.execute(toolCallId,{path:"target.txt",content:"after crash\n"}),/Previous write tool call is rejected/);
      assert.equal((await recoveredHost.snapshot(codeCrashId)).approvals.length,1,"The same Pi tool call cannot ask for another write approval after restart");
    }finally{await recoveredHost.close();await recoveredStorage.close();}
  }finally{if(child.exitCode===null&&child.signalCode===null)await stop(child);}
});

test("explicit browser mode commands launch internal Chrome once, persist receipts, and switch back",{skip:existsSync(chromiumPath())?false:`Chrome for Testing is unavailable (${chromiumPath()})`,timeout:90_000},async()=>{
  const port=await freePort(),origin=`http://127.0.0.1:${port}`,dataDir=join(testRoot,"browser-mode-command");await mkdir(dataDir,{recursive:true});
  let child=await launch(port,dataDir,undefined,syntheticChromeBinary(join(dataDir,"launcher"),chromiumPath()));
  try{
    const boot=await fetch(`${origin}/api/bootstrap`,{method:"POST",headers:{Origin:origin}}),cookie=boot.headers.get("set-cookie")!.split(";")[0];
    const req=async(path:string,method="GET",body?:unknown,id?:string)=>{
      const response=await fetch(`${origin}/api${path}`,{method,headers:{Origin:origin,Cookie:cookie,...(body===undefined?{}:{"Content-Type":"application/json"}),...(id?{"X-Command-Id":id}:{})},body:body===undefined?undefined:JSON.stringify(body)});
      return {status:response.status,data:await response.json() as any};
    };
    const created=await req("/sessions","POST",{cwd:root,model:"sigma-demo/offline"},crypto.randomUUID());assert.equal(created.status,200);const sessionId=created.data.id;
    const internalId=crypto.randomUUID(),first=await req(`/sessions/${sessionId}/prompt`,"POST",{text:"/browser internal"},internalId);
    assert.equal(first.status,200);assert.deepEqual([first.data.accepted,first.data.status,first.data.mode],[true,"completed","internal"]);
    assert.match(first.data.receipt,/own empty profile/);
    const ownerDir=join(dataDir,"browser-use","internal",sessionId),runs=await import("node:fs/promises").then(fs=>fs.readdir(ownerDir));assert.equal(runs.length,1);
    const profile=join(ownerDir,runs[0],"profile");assert.ok(!existsSync(join(profile,"DevToolsActivePort")),"internal mode is controlled through its private pipe, not a loopback CDP endpoint");
    const duplicate=await req(`/sessions/${sessionId}/prompt`,"POST",{text:"/browser internal"},internalId);
    assert.deepEqual([duplicate.data.accepted,duplicate.data.status,duplicate.data.mode],[false,"completed","internal"]);
    assert.equal((await import("node:fs/promises").then(fs=>fs.readdir(ownerDir))).length,1,"repeating the same command ID does not launch another browser");
    const active=await req(`/sessions/${sessionId}/browser-use`);assert.equal(active.data.mode,"internal");assert.equal(active.data.status,"selected");assert.equal(active.data.selected?.origin,"about:blank");
    const chrome=await req(`/sessions/${sessionId}/prompt`,"POST",{text:"/browser chrome"},crypto.randomUUID());assert.deepEqual([chrome.status,chrome.data.status,chrome.data.mode],[200,"completed","chrome"]);
    const disconnected=await req(`/sessions/${sessionId}/browser-use`);assert.deepEqual([disconnected.data.status,disconnected.data.mode],["disconnected","chrome"]);
    assert.ok(disconnected.data.modeCommands.some((item:any)=>item.id===internalId&&item.mode==="internal"&&item.status==="completed"));
    assert.ok(existsSync(profile),"switching modes retains the owned profile for the user's review");
  }finally{await stop(child);}
});

test("model availability HTTP boundaries suppress actual SDK provider errors",async()=>{
  const dataDir=join(testRoot,"model-errors"),preload=join(dataDir,"provider-preload.mjs"),privateMarker=crypto.randomUUID();await mkdir(dataDir,{recursive:true});
  await writeFile(preload,`import { isMainThread } from 'node:worker_threads';
if(isMainThread){
const { PiHost }=await import(${JSON.stringify(new URL("./pi-host.ts",import.meta.url).href)});
const original=PiHost.prototype.init;
PiHost.prototype.init=async function(){await original.call(this);this.runtime.registerNativeProvider({id:'metadata-error-fixture',name:'Metadata error fixture',auth:{apiKey:{name:'Synthetic private error',check:async()=>{throw new Error(${JSON.stringify(privateMarker)});},resolve:async()=>undefined}},getModels:()=>[],stream:()=>{throw new Error('No model calls');},streamSimple:()=>{throw new Error('No model calls');}});await this.runtime.refresh({allowNetwork:false});};
}\n`);
  const port=await freePort(),origin=`http://127.0.0.1:${port}`,child=await launch(port,dataDir,preload);
  try{
    const bootstrap=await fetch(`${origin}/api/bootstrap`,{method:"POST",headers:{Origin:origin}}),cookie=bootstrap.headers.get("set-cookie")!.split(";")[0];
    const request=async(path:string,method="GET",body?:unknown)=>fetch(`${origin}/api${path}`,{method,headers:{Origin:origin,Cookie:cookie,...(body===undefined?{}:{"Content-Type":"application/json","X-Command-Id":crypto.randomUUID()})},body:body===undefined?undefined:JSON.stringify(body)});
    const catalog=(await (await request("/roles")).json() as any).catalog;catalog.roles[0].model="sigma-demo/offline";
    for(const [path,method,status,input] of [["/models","GET",503,undefined],["/models/refresh","POST",409,undefined],["/roles","PUT",400,catalog],["/sessions","POST",400,{cwd:root,model:"sigma-demo/offline"}]] as const){
      const response=await request(path,method,input);assert.equal(response.status,status);const body=await response.text();
      assert.equal(body.includes(privateMarker),false,`${method} ${path} must suppress unrelated SDK availability errors`);
      assert.ok(JSON.parse(body).error.startsWith("Model availability could not refresh"));
    }
    const list=await request("/providers");assert.equal(list.status,200);assert.equal((await list.text()).includes(privateMarker),false,"Metadata enumeration remains safe despite a failed availability check");
  }finally{await stop(child);}
});

test("visible messages are rebuilt only when the history changes, and trimming keeps the latest turn's steps",()=>{
  const user={role:"user",content:"go",timestamp:1_000},call={role:"assistant",content:[{type:"toolCall",id:"c1",name:"read",arguments:{path:"a.txt"}}],timestamp:1_010},result={role:"toolResult",toolCallId:"c1",isError:false,content:[],timestamp:1_020};
  const entries:any[]=[{type:"message"},{type:"message"}],session:any={messages:[user,call],sessionManager:{fileEntries:entries,getEntries:()=>[]}};
  const first=cachedVisibleMessages(session,"/tmp");assert.equal(cachedVisibleMessages(session,"/tmp"),first,"Unchanged history reuses the built view");
  assert.equal((first[0].work!.steps[0] as any).status,"running");
  session.messages.push(result);entries.push({type:"message"});
  const second=cachedVisibleMessages(session,"/tmp");assert.notEqual(second,first);assert.equal((second[0].work!.steps[0] as any).status,"done","A new message rebuilds the view");
  session.messages=[...session.messages];assert.notEqual(cachedVisibleMessages(session,"/tmp"),second,"A replaced history array (compaction) rebuilds the view");
  const two=[{id:"0",role:"user",text:"a",work:{startedAt:1,endedAt:2,steps:[{kind:"note" as const,text:"x"}]}},{id:"1",role:"assistant",text:"b"},{id:"2",role:"user",text:"c",work:{startedAt:3,endedAt:4,steps:[{kind:"note" as const,text:"y"}]}}];
  const trimmed=trimWorkSteps(two);assert.deepEqual(trimmed[0].work,{startedAt:1,endedAt:2,steps:[],stepCount:1});assert.equal(trimmed[2],two[2]);assert.equal(two[0].work!.steps.length,1,"Trimming never changes the cached view");
});

test("a stopped run reports the time up to when its last message was saved, not when it started streaming",()=>{
  const user={role:"user",content:"think hard",timestamp:1_000},stopped={role:"assistant",content:[{type:"thinking",thinking:"hmm"}],stopReason:"aborted",timestamp:1_050};
  const session={messages:[user,stopped],sessionManager:{getEntries:()=>[{type:"message",message:user,timestamp:new Date(1_000).toISOString()},{type:"message",message:stopped,timestamp:new Date(13_000).toISOString()}]}};
  const [owner]=visibleMessages(session as any,"/tmp");assert.equal(owner.work?.endedAt,13_000);assert.equal(owner.work!.endedAt-owner.work!.startedAt,12_000);
  assert.equal(visibleMessages({messages:[user,stopped]} as any,"/tmp")[0].work?.endedAt,1_050,"Without saved entries the message timestamp is the fallback");
});

test("prompt images are validated, need an image-capable model and are not stored in commands",async()=>{
  const dataDir=join(testRoot,"prompt-images"),preload=join(dataDir,"vision-preload.mjs");await mkdir(dataDir,{recursive:true});
  await writeFile(preload,`import { isMainThread } from 'node:worker_threads';
if(isMainThread){
const { PiHost }=await import(${JSON.stringify(new URL("./pi-host.ts",import.meta.url).href)});
const original=PiHost.prototype.init;
PiHost.prototype.init=async function(){await original.call(this);const runtime=this.runtime;runtime.registerProvider('sigma-vision',{api:'sigma-demo',baseUrl:'http://127.0.0.1/unused',apiKey:'local-demo',streamSimple:(_model,context,options)=>runtime.streamSimple(runtime.getModel('sigma-demo','offline'),context,options),models:[{id:'eyes',name:'Vision demonstration',reasoning:false,input:['text','image'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:16384,maxTokens:1024}]});await runtime.refresh({allowNetwork:false});};
}\n`);
  const port=await freePort(),origin=`http://127.0.0.1:${port}`,child=await launch(port,dataDir,preload);
  try{
    const bootstrap=await fetch(`${origin}/api/bootstrap`,{method:"POST",headers:{Origin:origin}}),cookie=bootstrap.headers.get("set-cookie")!.split(";")[0];
    const req=async(path:string,method="GET",body?:unknown,id?:string)=>{const res=await fetch(`${origin}/api${path}`,{method,headers:{Origin:origin,Cookie:cookie,...(body===undefined?{}:{"Content-Type":"application/json"}),...(id?{"X-Command-Id":id}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,data:await res.json() as any};};
    const models=(await req("/models")).data.models as any[];
    assert.equal(models.find(entry=>entry.provider==="sigma-demo")?.images,false);assert.equal(models.find(entry=>entry.provider==="sigma-vision")?.images,true);
    const textId=(await req("/sessions","POST",{cwd:root,model:"sigma-demo/offline"},crypto.randomUUID())).data.id,visionId=(await req("/sessions","POST",{cwd:root,model:"sigma-vision/eyes"},crypto.randomUUID())).data.id;
    const png={mimeType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="},send=(id:string,body:unknown,command=crypto.randomUUID())=>req(`/sessions/${id}/prompt`,"POST",body,command);
    for(const [images,why] of [[[{...png,mimeType:"image/svg+xml"}],"mime"],[Array(5).fill(png),"count"],[[{...png,data:"not base64!"}],"base64"],[[{...png,data:"A".repeat(7_200_000)}],"size"],[[{mimeType:"image/png"}],"data"],["png","shape"]] as const)assert.equal((await send(visionId,{text:"look",images})).status,400,`Rejects images: ${why}`);
    assert.equal((await send(visionId,{text:"",images:[]})).status,400,"Empty text still needs an image");
    const refused=await send(textId,{text:"look",images:[png]});assert.equal(refused.status,400);assert.match(refused.data.error,/cannot read images/,"A text-only model rejects images");
    const command=crypto.randomUUID(),accepted=await send(visionId,{text:"",images:[png]},command);assert.equal(accepted.status,200);assert.equal(accepted.data.accepted,true);
    await waitFor(async()=>(await req(`/sessions/${visionId}`)).data.messages.length===2);
    assert.equal((await req(`/sessions/${visionId}`)).data.messages[0].images,1,"History reports the image count without data");
    assert.equal((await send(visionId,{text:"",images:[png]},command)).data.accepted,false,"Same command and images replay");
    assert.equal((await send(visionId,{text:"",images:[{...png,data:Buffer.from("other").toString("base64")}]},command)).status,409,"Different images cannot reuse a command ID");
    assert.ok(!JSON.stringify(await req(`/sessions/${visionId}`)).includes(png.data),"Image data never reaches the client");
    const raw=(path:string,headers:Record<string,string>={Cookie:cookie})=>fetch(`${origin}/api${path}`,{headers:{Origin:origin,...headers}}),history=(await req(`/sessions/${visionId}`)).data.messages as Array<{id:string;role:string}>;
    const served=await raw(`/sessions/${visionId}/messages/${history[0].id}/images/0`);
    assert.equal(served.status,200);assert.equal(served.headers.get("content-type"),"image/png");assert.match(served.headers.get("cache-control")??"",/private/);assert.deepEqual(Buffer.from(await served.arrayBuffer()),Buffer.from(png.data,"base64"),"The stored image is served byte for byte");
    for(const path of [`/sessions/${visionId}/messages/${history[0].id}/images/1`,`/sessions/${visionId}/messages/${history[1].id}/images/0`,`/sessions/${visionId}/messages/abc/images/0`,`/sessions/${visionId}/messages/${history[0].id}/images/x`,`/sessions/${textId}/messages/0/images/0`,`/sessions/${crypto.randomUUID()}/messages/0/images/0`])assert.equal((await raw(path)).status,404,`No image at ${path}`);
    assert.equal((await raw(`/sessions/${visionId}/messages/${history[0].id}/images/0`,{})).status,401,"The image route needs the session cookie");
    const picker=await req(`/mentions?cwd=${encodeURIComponent(root)}&q=`),names=(picker.data.tools as Array<{name:string;description:string}>).map(tool=>tool.name);
    for(const name of ["read","ls","edit","write","bash","delegate","browser_screenshot"])assert.ok(names.includes(name),`The new-session @-picker offers ${name}`);
    assert.ok(!names.includes("git_commit")&&(picker.data.tools as Array<{description:string}>).every(tool=>tool.description),"Only tools a new session has, each described");
  }finally{await stop(child);}
});

test("direct uncertain write requires exact observed reconciliation before another session can edit",async()=>{
  const dir=join(testRoot,"direct-reconcile"),source=join(dir,"source"),dataDir=join(dir,"data");await mkdir(source,{recursive:true});await mkdir(dataDir);
  const git=(...args:string[])=>execFileSync("git",["-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false",...args],{cwd:source,env:{...process.env,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_AUTHOR_NAME:"Fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"Fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid"}});
  git("init","-b","main");const target=join(source,"target.txt"),before="before\n",after="after\n";await writeFile(target,before);git("add","target.txt");git("commit","-m","Fixture");
  const port=await freePort(),origin=`http://127.0.0.1:${port}`,child=await launch(port,dataDir);
  try{
    const boot=await fetch(`${origin}/api/bootstrap`,{method:"POST",headers:{Origin:origin}}),cookie=boot.headers.get("set-cookie")!.split(";")[0];
    const req=async(path:string,method="GET",body?:unknown,id?:string)=>{const response=await fetch(`${origin}/api${path}`,{method,headers:{Origin:origin,Cookie:cookie,...(body===undefined?{}:{"Content-Type":"application/json"}),...(id?{"X-Command-Id":id}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:response.headers.get("content-type")?.includes("json")?await response.json() as any:await response.text()};};
    const model="sigma-demo/offline",first=crypto.randomUUID(),second=crypto.randomUUID();
    assert.equal((await req("/sessions","POST",{cwd:source,model,mode:"code"},first)).status,200);
    assert.equal((await req("/sessions","POST",{cwd:source,model,mode:"code"},second)).status,200);
    const digest=(value:string)=>createHash("sha256").update(value).digest("hex"),approvalId=crypto.randomUUID(),commandId=`pi-tool:${first}:${crypto.randomUUID()}`;
    const storage=new Storage(join(dataDir,"state.sqlite"));
    try{
      await storage.call("command",{id:commandId,sessionId:first,kind:"write",requestHash:"fixture"});
      await storage.call("commandInput",{id:commandId,text:"target.txt"});
      await storage.call("commandTransition",{id:commandId,from:"accepted",to:"unknown"});
      await storage.call("approval",{id:approvalId,sessionId:first,agentId:first,tool:"write",preview:"write target.txt",commandId,change:{path:"target.txt",diff:"proposed change",beforeHash:digest(before),afterHash:digest(after),beforeMode:0o644,afterMode:0o644}});
      await storage.call("approvalStatus",{id:approvalId,status:"approved"});await storage.call("writeOutcome",{id:approvalId,outcome:"unknown"});
    }finally{await storage.close();}
    await writeFile(target,after);
    await req(`/sessions/${second}/prompt`,"POST",{text:'write:{"path":"blocked.txt","content":"blocked"}'},crypto.randomUUID());
    await waitFor(async()=>(await req(`/sessions/${second}`)).data.status==="settled");
    assert.equal((await req(`/sessions/${second}`)).data.approvals.length,0);
    const preview=await req(`/sessions/${first}/writes/${approvalId}/reconcile`);assert.equal(preview.status,200);assert.equal(typeof preview.data,"object","Expected a JSON reconciliation preview");
    assert.equal(preview.data.state,"after");assert.equal(preview.data.observedHash,digest(after));
    const observed={acknowledge:true,observedHash:preview.data.observedHash,observedMode:preview.data.observedMode,state:preview.data.state};
    assert.equal((await req(`/sessions/${first}/writes/${approvalId}/reconcile`,"POST",{...observed,observedHash:digest("stale")},crypto.randomUUID())).status,409);
    assert.equal((await req(`/sessions/${first}/writes/${approvalId}/reconcile`,"POST",observed,crypto.randomUUID())).status,200);
    const reconciled=(await req(`/sessions/${first}`)).data;
    assert.equal(reconciled.approvals.find((approval:any)=>approval.id===approvalId)?.outcome,"reconciled");
    assert.equal(reconciled.recoveryActions.some((action:any)=>action.id===commandId),false);
    assert.equal(await readFile(target,"utf8"),after,"Reconciliation must not replay the write");
    assert.equal((await stat(target)).mode&0o777,preview.data.observedMode);
    await req(`/sessions/${second}/prompt`,"POST",{text:'write:{"path":"allowed.txt","content":"allowed"}'},crypto.randomUUID());
    await waitFor(async()=>(await req(`/sessions/${second}`)).data.approvals.some((approval:any)=>approval.status==="pending"));
    const pending=(await req(`/sessions/${second}`)).data.approvals.find((approval:any)=>approval.status==="pending");
    assert.equal((await req(`/sessions/${second}/approvals/${pending.id}`,"POST",{allow:true})).status,200);
    await waitFor(async()=>(await req(`/sessions/${second}`)).data.approvals.some((approval:any)=>approval.id===pending.id&&approval.outcome==="applied"));
    assert.equal(await readFile(join(source,"allowed.txt"),"utf8"),"allowed");assert.equal(await readFile(target,"utf8"),after);
  }finally{await stop(child);}
});

test("local instances on different ports keep independent browser cookies",async()=>{
  const portA=await freePort(),portB=await freePort();
  let a:ChildProcess|undefined,b:ChildProcess|undefined;
  try{
    a=await launch(portA,join(testRoot,"cookie-a"));b=await launch(portB,join(testRoot,"cookie-b"));
    const cookies=new Map<string,string>();
    for(const port of [portA,portB]){
      const origin=`http://127.0.0.1:${port}`;
      const boot=await fetch(`${origin}/api/bootstrap`,{method:"POST",headers:{Origin:origin}});
      const cookie=boot.headers.get("set-cookie")!.split(";")[0],at=cookie.indexOf("=");
      cookies.set(cookie.slice(0,at),cookie.slice(at+1));
    }
    // Browsers share cookies across ports on the same host.
    const Cookie=[...cookies].map(([name,value])=>`${name}=${value}`).join("; ");
    for(const port of [portA,portB])assert.equal((await fetch(`http://127.0.0.1:${port}/api/projects`,{headers:{Cookie}})).status,200);
  }finally{if(a)await stop(a);if(b)await stop(b);}
});

test("Pi SDK preflight rejection remains retryable",async()=>{
  const dir=join(testRoot,"preflight");await mkdir(dir,{recursive:true});
  const storage=new Storage(join(dir,"state.sqlite"));const host=new PiHost(storage,dir,async()=>{});
  try{
    await host.init();const runtime=(host as unknown as {runtime:ModelRuntime}).runtime;registerDemoProvider(runtime);
    const sid=await host.create(root,"sigma-demo/offline");
    runtime.unregisterProvider("sigma-demo");await runtime.refresh();
    const commandId=crypto.randomUUID(),text="must stay in composer";
    await storage.call("command",{id:commandId,sessionId:sid,kind:"prompt",requestHash:"same request"});
    await assert.rejects(host.prompt(sid,text,undefined,commandId),/api key|Authentication|auth/i);
    assert.equal((await storage.call<{status:string}>("command",{id:commandId,sessionId:sid,kind:"prompt",requestHash:"same request"})).status,"rejected");
    assert.equal((await host.snapshot(sid)).messages.length,0);
  }finally{await host.close();await storage.close();}
});

test("old approval schema migrates without swapping preview and status",async()=>{
  const dir=join(testRoot,"migration");await mkdir(dir,{recursive:true});const file=join(dir,"state.sqlite");
  const old=new DatabaseSync(file);old.exec("CREATE TABLE approvals(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,agent_id TEXT NOT NULL,tool TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL); CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT NOT NULL,file TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,parent_id TEXT,role TEXT NOT NULL DEFAULT 'root'); INSERT INTO sessions VALUES('legacy','/fixture','/fixture/session','sigma-demo/offline','settled',1,NULL,'root'); INSERT INTO sessions VALUES('unfinished-child','/fixture','/fixture/child','sigma-demo/offline','idle',1,'legacy','worker')");old.close();
  const storage=new Storage(file);
  try{await storage.call("approval",{id:"approval-1",sessionId:"legacy",agentId:"unfinished-child",tool:"read",preview:"read README.md"});
    assert.deepEqual((await storage.call<any[]>("approvals",{sessionId:"legacy"})).map(a=>[a.preview,a.status]),[["read README.md","pending"]]);
    await storage.call("approvalStatus",{id:"approval-1",status:"denied"});
    assert.equal((await storage.call<any[]>("approvals",{sessionId:"legacy"}))[0].status,"denied");
    assert.equal((await storage.call<any>("session",{id:"legacy"})).policy,null,"Migration must not invent a historical policy");
    assert.equal((await storage.call<any>("session",{id:"unfinished-child"})).status,"interrupted","A crash during child creation must not leave an apparently startable child");
  }finally{await storage.close();}
});

test("child cancellation while creation is published cannot start the child",async()=>{
  const dir=join(testRoot,"creation-stop");await mkdir(dir,{recursive:true});
  const storage=new Storage(join(dir,"state.sqlite"));
  let release!:()=>void,published!:(id:string)=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),created=new Promise<string>(resolve=>{published=resolve;});
  const host=new PiHost(storage,dir,async(id,type,payload,durable)=>{
    if(durable)await storage.event(id,type,payload);
    if(type==="agent_created"){published((payload as {id:string}).id);await gate;}
  });
  try{
    await host.init();registerDemoProvider((host as unknown as {runtime:ModelRuntime}).runtime);
    const sid=await host.create(root,"sigma-demo/offline");
    await host.prompt(sid,"delegate:read:package.json");
    const childId=await created;
    const stopped=host.abortChild(sid,childId);
    await waitFor(async()=>(await storage.call<any>("session",{id:childId})).status==="interrupted");
    release();await stopped;
    await waitFor(async()=>(await host.snapshot(sid)).status==="settled");
    const child=await host.snapshot(childId);
    assert.equal(child.status,"interrupted");assert.deepEqual(child.messages,[]);
    assert.equal((await host.snapshot(sid)).approvals.length,0,"Cancelled before open: no tool execution or approval appears later");
    await host.abort(sid);
    assert.equal((await host.snapshot(sid)).agents.find(a=>a.id===childId)!.status,"interrupted");
  }finally{release();await host.close();await storage.close();}
});

test("parent pipe EOF drains the service and releases its loopback port",async()=>{
  const port=await freePort(),dataDir=join(testRoot,"parent-watch");await mkdir(dataDir,{recursive:true});
  const child=spawn(process.execPath,["--import","tsx","apps/server/main.ts"],{cwd:root,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,HOME:testRoot,SIGMA_APPROVAL_MODE:"ask",PI_OFFLINE:"1",PI_CODING_AGENT_DIR:join(dataDir,"agent"),SIGMA_DEMO:"1",SIGMA_PORT:String(port),SIGMA_DATA_DIR:dataDir,SIGMA_PARENT_WATCH:"1"},stdio:["pipe","pipe","pipe"]});
  let output="";for(const stream of [child.stdout,child.stderr])stream?.on("data",chunk=>{output=(output+String(chunk)).slice(-1000);});
  try{
    const origin=`http://127.0.0.1:${port}`;
    let html="";
    await waitFor(async()=>{if(child.exitCode!==null||child.signalCode!==null)throw new Error(`Service exited before readiness: ${output}`);try{const response=await fetch(origin,{signal:AbortSignal.timeout(1000)});if(!response.ok)return false;html=await response.text();return true;}catch{return false;}});
    assert.match(html,/<script[^>]+src="([^"]+\.js)"/);
    const asset=html.match(/<script[^>]+src="([^"]+\.js)"/)![1];
    const assetResponse=await fetch(new URL(asset,origin));
    assert.equal(assetResponse.status,200);
    assert.match(assetResponse.headers.get("content-type")||"",/javascript/);
    assert.match(await assetResponse.text(),/createElement|document/);
    const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once("exit",(code,signal)=>resolve({code,signal})));
    child.stdin!.end();
    let timer:ReturnType<typeof setTimeout>|undefined;
    let outcome:{code:number|null;signal:NodeJS.Signals|null};
    try{outcome=await Promise.race([exited,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Service did not exit after parent pipe EOF")),5000);})]);}
    finally{if(timer)clearTimeout(timer);}
    assert.deepEqual(outcome,{code:0,signal:null},output);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(500)}));
  }finally{if(child.exitCode===null&&child.signalCode===null)await stop(child);}
});

test("parent pipe EOF during Pi startup exits before binding a service port",async()=>{
  const port=await freePort(),dataDir=join(testRoot,"parent-watch-startup");await mkdir(dataDir,{recursive:true});
  const preload=join(root,"apps/server/parent-watch-hang-preload.mjs");
  const child=spawn(process.execPath,["--import","tsx","--import",preload,"apps/server/main.ts"],{cwd:root,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,HOME:testRoot,PI_CODING_AGENT_DIR:join(dataDir,"agent"),SIGMA_PORT:String(port),SIGMA_DATA_DIR:dataDir,SIGMA_PARENT_WATCH:"1"},stdio:["pipe","pipe","pipe"]});
  let output="";for(const stream of [child.stdout,child.stderr])stream?.on("data",chunk=>{output=(output+String(chunk)).slice(-1000);});
  try{
    await waitFor(async()=>existsSync(join(dataDir,"agent")));
    const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once("exit",(code,signal)=>resolve({code,signal})));
    child.stdin!.end();
    let timer:ReturnType<typeof setTimeout>|undefined;
    let outcome:{code:number|null;signal:NodeJS.Signals|null};
    try{outcome=await Promise.race([exited,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Service remained alive after parent pipe EOF during startup")),3000);})]);}
    finally{if(timer)clearTimeout(timer);}
    assert.deepEqual(outcome,{code:1,signal:null},output);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(500)}));
  }finally{if(child.exitCode===null&&child.signalCode===null)await stop(child);}
});

test("PiHost close drains every active finalizer when one rejects",async()=>{
  const data=join(testRoot,"host-close-finalizers");await mkdir(data,{recursive:true});
  const storage=new Storage(join(data,"state.sqlite")),host=new PiHost(storage,data,async()=>{});
  let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);let settled=false,disposed=0;
  const internals=host as unknown as {active:Map<string,{session:{abort:()=>Promise<void>;dispose:()=>void};row:{status:string};unsubscribe:()=>void}>};
  internals.active.set("reject",{session:{abort:async()=>{throw new Error("runner finalizer failed");},dispose:()=>{disposed++;}},row:{status:"idle"},unsubscribe:()=>{}});
  internals.active.set("held",{session:{abort:async()=>{await held;},dispose:()=>{disposed++;}},row:{status:"idle"},unsubscribe:()=>{}});
  const closing=host.close().finally(()=>{settled=true;});
  try{
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(settled,false,"a rejected runner cannot skip draining its sibling");
    release();await assert.rejects(closing,AggregateError);
    assert.equal(disposed,2,"both sessions are disposed after their abort finalizers settle");
  }finally{release();try{await closing;}catch{}await storage.close();}
});

test("PiHost close drains an approval finalizer already removed from pending",async()=>{
  const data=join(testRoot,"approval-finalizer-drain");await mkdir(data,{recursive:true});
  const storage=new Storage(join(data,"state.sqlite")),host=new PiHost(storage,data,async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);});
  let release!:()=>void;const ready=new Promise<void>(resolve=>release=resolve);let settled=false,approved:boolean|undefined;
  const id=crypto.randomUUID();await host.init();registerDemoProvider((host as unknown as {runtime:ModelRuntime}).runtime);const sessionId=await host.create(root,"sigma-demo/offline");
  await storage.call("approval",{id,sessionId,agentId:sessionId,tool:"read",preview:"read package.json"});
  const pending={sessionId,agentId:sessionId,ready,resolve:(value:boolean)=>{approved=value;},timer:setTimeout(()=>{},300_000)};
  const internals=host as unknown as {pending:Map<string,typeof pending>;finishApproval:(id:string,p:typeof pending,status:"approved"|"denied"|"expired")=>Promise<void>};
  internals.pending.set(id,pending);
  const finalizing=internals.finishApproval(id,pending,"expired");
  assert.equal(internals.pending.has(id),false,"approval is synchronously removed before durable completion");
  let closingSettled=false;const closing=host.close().finally(()=>{closingSettled=true;});
  try{
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(closingSettled,false,"shutdown includes a timer/decision finalizer no longer in pending");
    release();await Promise.all([finalizing,closing]);assert.equal(approved,false);
    assert.equal((await storage.call<any[]>("approvals",{sessionId})).find(row=>row.id===id)?.status,"expired");
    assert.ok((await storage.call<any[]>("events",{sessionId})).some(event=>event.type==="approval_decision"&&event.payload.id===id&&event.payload.status==="expired"));
  }finally{clearTimeout(pending.timer);release();try{await finalizing;}catch{}try{await closing;}catch{}await storage.close();}
});

test("shutdown rejects an SSE request whose session lookup finishes late",async()=>{
  const port=await freePort(),origin=`http://127.0.0.1:${port}`,data=join(testRoot,"late-sse-shutdown");await mkdir(data,{recursive:true});
  const gate=join(data,"hold"),entered=join(data,"entered"),release=join(data,"release"),preload=join(data,"hold-snapshot.mjs");
  await writeFile(preload,`import {existsSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
const {PiHost}=await import(pathToFileURL(join(process.env.SIGMA_ROOT,'apps/server/pi-host.ts')).href);
PiHost.prototype.state=async function(){if(existsSync(process.env.SIGMA_GATE)&&!existsSync(process.env.SIGMA_ENTERED)){writeFileSync(process.env.SIGMA_ENTERED,'held');while(!existsSync(process.env.SIGMA_RELEASE))await new Promise(resolve=>setTimeout(resolve,10));}return {};};
`);
  const child=spawn(process.execPath,["--import","tsx","--import",preload,"apps/server/main.ts"],{cwd:root,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,HOME:testRoot,SIGMA_APPROVAL_MODE:"ask",PI_OFFLINE:"1",PI_CODING_AGENT_DIR:join(data,"agent"),SIGMA_ROOT:root,SIGMA_DEMO:"1",SIGMA_PORT:String(port),SIGMA_DATA_DIR:data,SIGMA_GATE:gate,SIGMA_ENTERED:entered,SIGMA_RELEASE:release},stdio:["ignore","pipe","pipe"]});
  let output="";for(const stream of [child.stdout,child.stderr])stream?.on("data",chunk=>{output=(output+String(chunk)).slice(-2000);});
  try{
    await waitFor(async()=>{if(child.exitCode!==null||child.signalCode!==null)throw new Error(`Fixture exited: ${output}`);try{return (await fetch(origin,{signal:AbortSignal.timeout(1000)})).ok;}catch{return false;}},120000);
    const boot=await fetch(`${origin}/api/bootstrap`,{method:"POST",headers:{Origin:origin}}),cookie=boot.headers.get("set-cookie")!.split(";")[0],id=crypto.randomUUID();
    await writeFile(gate,"hold");const pending=fetch(`${origin}/api/sessions/${id}/events`,{headers:{Cookie:cookie,Connection:"close"},signal:AbortSignal.timeout(10000)});
    await waitFor(async()=>existsSync(entered));child.kill("SIGTERM");await new Promise(resolve=>setTimeout(resolve,100));await writeFile(release,"go");
    const response=await pending;assert.equal(response.status,503,"shutdown is rechecked after the held snapshot and before SSE registration");assert.equal(response.headers.get("content-type")?.includes("text/event-stream"),false);await response.text();
    const exited=await Promise.race([new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once("exit",(code,signal)=>resolve({code,signal}))),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error(`Service did not drain held snapshot: ${output}`)),5000))]);
    assert.deepEqual(exited,{code:0,signal:null},output);
  }finally{await writeFile(release,"go").catch(()=>{});if(child.exitCode===null&&child.signalCode===null)await stop(child);}
});
