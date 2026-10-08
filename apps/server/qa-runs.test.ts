import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import test from "node:test";
import type { QaActionView, QaArtifactView, QaRunView, QaView } from "../../packages/contracts/index.js";
import { chromiumPath, pngInfo } from "./qa-browser.js";
import { Qa, type QaHost } from "./qa-runs.js";
import { Storage } from "./storage.js";

const root=resolve(import.meta.dirname,"../..");
const scratch=join(process.env.SIGMA_TEST_DIR||join(root,".scratch"),`qa-runs-${Date.now()}-${process.pid}`);
const chromium=chromiumPath();
const skip=process.platform!=="darwin"?"QA browser is macOS-only (sandbox-exec)":!existsSync("/usr/bin/sandbox-exec")?"/usr/bin/sandbox-exec is missing":!existsSync(chromium)?`Chromium not found at ${chromium}; set SIGMA_QA_CHROMIUM to a Chrome for Testing binary`:false;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function waitFor<T>(read:()=>Promise<T|false>|T|false,ms=15000):Promise<T>{const end=Date.now()+ms;while(Date.now()<end){const value=await read();if(value)return value;await sleep(40);}throw new Error("Timed out waiting for QA state");}
const INDEX=`<!doctype html><meta charset=utf-8><title>Fixture</title><body style="margin:0"><h1 id=t>Hello QA</h1><button id=go onclick="document.getElementById('out').textContent='clicked'">Go</button><input id=name><div id=out>idle</div><a href="/second.html">second</a>`;
function site(name:string,index=INDEX){
  const dir=join(scratch,name);mkdirSync(join(dir,"site"),{recursive:true});mkdirSync(join(dir,"data"),{recursive:true});
  writeFileSync(join(dir,"site/index.html"),index);
  writeFileSync(join(dir,"site/second.html"),"<!doctype html><title>Second</title><p id=p>second page</p>");
  writeFileSync(join(dir,"site/busy.html"),"<!doctype html><button id=b onclick=\"const t=Date.now();while(Date.now()-t<60000);\">Busy</button>");
  writeFileSync(join(dir,"site/.env"),"SECRET=do-not-serve");
  return {dir,site:join(dir,"site"),data:join(dir,"data")};
}
function stubHost(state:{cwd:string;revision:string}):QaHost{
  return {verifiedCode:async()=>({}),assertDirectReady:async()=>{},snapshot:async()=>({status:"idle"}),
    changes:async()=>({cwd:state.cwd,sourceCwd:state.cwd,baseCommit:"",files:[],diff:"",omitted:0,revision:state.revision}),
    withPromptAdmission:(_id,action)=>action({check:()=>{}})};
}
const members=(marker:string)=>spawnSync("/bin/ps",["-axo","pid=,command="],{encoding:"utf8"}).stdout.split("\n").filter(line=>line.includes(marker));
async function service(name:string,revision="rev-1"){
  const fx=site(name),state={cwd:fx.site,revision};
  const storage=new Storage(join(fx.data,"state.sqlite")),events:Array<{type:string;payload:any}>=[];
  const qa=new Qa(storage,stubHost(state),fx.data,async(_id,type,payload)=>{events.push({type,payload});});
  await storage.call("addSession",{id:"s1",cwd:fx.site,file:"",model:"m",managerId:"s1",creation:{source:"user",actor:"user",cause:"test",commandId:"c"}});
  return {...fx,state,storage,qa,events,close:async()=>{await qa.close();await storage.close();}};
}
const allow=async()=>true;
const actions=(f:{storage:Storage},runId:string)=>f.storage.call<QaActionView[]>("qaActions",{runId});

test("run creation freezes the revision and an immutable manifest; sensitive files are not served",{skip,timeout:90_000},async()=>{
  const f=await service("create");
  try{
    await assert.rejects(f.qa.create("s1",crypto.randomUUID(),"missing.html"),/unavailable|Input file/);
    await assert.rejects(f.qa.create("s1",crypto.randomUUID(),"../x.html"),/relative/);
    await assert.rejects(f.qa.create("s1",crypto.randomUUID(),"notes.txt"),/relative/);
    const id=crypto.randomUUID(),run=await f.qa.create("s1",id,"index.html");
    assert.equal(run.status,"running");assert.equal(run.revision,"rev-1");assert.equal(run.isolation,"outer");
    assert.match(run.chromiumSha256,/^[0-9a-f]{64}$/);assert.equal(run.chromiumSha256,createHash("sha256").update(readFileSync(chromium)).digest("hex"));
    assert.deepEqual(run.manifest.map(file=>file.path),["busy.html","index.html","second.html"],".env is not copied");
    assert.equal((await f.qa.create("s1",id,"index.html")).id,id,"same command ID is idempotent");
    await assert.rejects(f.qa.create("s1",id,"second.html"),/conflict/);
    await assert.rejects(f.qa.create("s1",crypto.randomUUID(),"index.html"),/current QA run/);
    // The workspace moves on; the frozen preview does not.
    writeFileSync(join(f.site,"index.html"),INDEX.replace("Hello QA","Changed after approval"));f.state.revision="rev-2";
    await f.qa.act("s1","a",  "navigate",{path:"/index.html"},allow);
    assert.equal(JSON.parse(await f.qa.act("s1","a","assert",{kind:"text",expected:"Hello QA"},allow)).outcome,"pass");
    assert.equal(JSON.parse(await f.qa.act("s1","a","assert",{kind:"text",expected:"Changed after approval"},allow)).outcome,"fail");
    await assert.rejects(f.qa.act("s1","a","navigate",{path:"/.env"},allow),/manifest/);
    await assert.rejects(f.qa.act("s1","a","navigate",{path:"http://example.com/"},allow),/path/);
    const view=await f.qa.list("s1");
    assert.equal(view.runs[0].current,false,"revision moved on, so the run is no longer current");assert.equal(view.runs[0].revision,"rev-1");
    await f.qa.cancel("s1",id);
    assert.equal((await f.storage.call<QaRunView>("qaRun",{id})).status,"cancelled");
    assert.deepEqual(members(f.data),[],"no browser processes remain");
  }finally{await f.close();}
});

test("workspace changing during the copy fails the run before any browser starts",{skip,timeout:60_000},async()=>{
  const f=await service("racing"),host=stubHost(f.state);let calls=0;
  const racing:QaHost={...host,changes:async id=>{const value=await host.changes(id);return {...value,revision:++calls>1?"rev-moved":"rev-1"};}};
  const qa=new Qa(f.storage,racing,f.data,async()=>{});
  try{
    await assert.rejects(qa.create("s1",crypto.randomUUID(),"index.html"),/changed while creating/);
    assert.deepEqual(members(f.data),[]);
  }finally{await qa.close();await f.close();}
});

test("navigate, click and type need per-action approval; Deny sends nothing; stale or missing observations are refused",{skip,timeout:120_000},async()=>{
  const f=await service("actions");
  try{
    const run=await f.qa.create("s1",crypto.randomUUID(),"index.html");
    const previews:string[]=[];
    const deny=async(preview:string)=>{previews.push(preview);return false;};
    await assert.rejects(f.qa.act("s1","a","navigate",{path:"/index.html"},deny),/denied/);
    assert.match(previews[0],new RegExp(`qa_navigate /index.html · run ${run.id.slice(0,8)} · revision rev-1 · manifest ${run.manifestHash.slice(0,12)}`));
    assert.equal(JSON.parse(await f.qa.act("s1","a","assert",{kind:"selector",expected:"#go"},allow)).outcome,"fail","Denied navigation never reached the page");
    await f.qa.act("s1","a","navigate",{path:"/index.html"},allow);
    // No observation yet: refused without asking for approval.
    let asked=0;const counting=async()=>{asked++;return true;};
    await assert.rejects(f.qa.act("s1","a","click",{selector:"#go",observationId:"made-up"},counting),/stale/);
    assert.equal(asked,0);
    const first=JSON.parse(await f.qa.act("s1","a","screenshot",{},allow));
    // Navigation invalidates the first observation.
    await f.qa.act("s1","a","navigate",{path:"/second.html"},allow);
    await assert.rejects(f.qa.act("s1","a","click",{selector:"#go",observationId:first.observationId},counting),/stale/);
    assert.equal(asked,0);
    await f.qa.act("s1","a","navigate",{path:"/index.html"},allow);
    const second=JSON.parse(await f.qa.act("s1","a","screenshot",{},allow));
    assert.ok(second.elements.some((element:any)=>element.selector==="#go"));
    // Denying a click after a fresh observation leaves the page untouched and the observation usable.
    await assert.rejects(f.qa.act("s1","a","click",{selector:"#go",observationId:second.observationId},deny),/denied/);
    assert.equal(JSON.parse(await f.qa.act("s1","a","assert",{kind:"text",expected:"idle"},allow)).outcome,"pass");
    await f.qa.act("s1","a","click",{selector:"#go",observationId:second.observationId},counting);
    assert.equal(asked,1);
    assert.equal(JSON.parse(await f.qa.act("s1","a","assert",{kind:"text",expected:"clicked"},allow)).outcome,"pass");
    // The click invalidated the observation again: typing with it is refused.
    await assert.rejects(f.qa.act("s1","a","type",{selector:"#name",text:"x",observationId:second.observationId},counting),/stale/);
    const third=JSON.parse(await f.qa.act("s1","a","screenshot",{},allow));
    await f.qa.act("s1","a","type",{selector:"#name",text:"typed value",observationId:third.observationId},counting);
    assert.equal(JSON.parse(await f.qa.act("s1","a","assert",{kind:"selector",expected:"#name"},allow)).outcome,"pass");
    const rows=await actions(f,run.id);
    const statuses=rows.map(row=>`${row.kind}:${row.status}`);
    assert.deepEqual(statuses,["navigate:denied","assert:done","navigate:done","click:refused","screenshot:done","navigate:done","click:refused","navigate:done","screenshot:done","click:denied","assert:done","click:done","assert:done","type:refused","screenshot:done","type:done","assert:done"]);
    assert.ok(rows.every(row=>row.revision==="rev-1"&&row.manifestHash===run.manifestHash&&/^[0-9a-f]{64}$/.test(row.actionHash)));
    assert.equal(rows.find(row=>row.kind==="type"&&row.status==="done")!.text,"typed value");
    assert.ok(f.events.some(event=>event.type==="qa_changed"));
  }finally{await f.close();}
});

test("screenshot artifacts: PNG metadata, content-addressed file, never inline bytes",{skip,timeout:90_000},async()=>{
  const f=await service("shots");
  try{
    const run=await f.qa.create("s1",crypto.randomUUID(),"index.html");
    await f.qa.act("s1","a","navigate",{path:"/index.html"},allow);
    const text=await f.qa.act("s1","a","screenshot",{},allow),result=JSON.parse(text);
    assert.ok(text.length<20_000&&!text.includes("iVBOR"),"tool result carries metadata, not image bytes");
    const [artifact]=(await f.qa.list("s1")).artifacts.filter(item=>item.id===result.artifactId);
    assert.equal(artifact.mime,"image/png");assert.deepEqual({width:artifact.width,height:artifact.height},{width:1024,height:768});assert.deepEqual(artifact.viewport,{width:1024,height:768});
    assert.equal(artifact.revision,"rev-1");assert.equal(artifact.manifestHash,run.manifestHash);assert.equal(artifact.observationId,result.observationId);assert.equal(artifact.runId,run.id);
    const file=join(f.data,"qa",run.id,"artifacts",`${artifact.sha256}.png`),bytes=readFileSync(file);
    assert.equal(bytes.length,artifact.bytes);assert.equal(createHash("sha256").update(bytes).digest("hex"),artifact.sha256);assert.deepEqual(pngInfo(bytes),{width:1024,height:768});
    const served=await f.qa.artifact("s1",artifact.id);assert.equal(served.mime,"image/png");assert.ok(served.bytes.equals(bytes));
    await assert.rejects(f.qa.artifact("other-session",artifact.id),/unavailable/);
    writeFileSync(file,Buffer.concat([bytes,Buffer.from("x")]));
    await assert.rejects(f.qa.artifact("s1",artifact.id),/changed on disk/);
  }finally{await f.close();}
});

test("cancel during an action leaves it unknown, blocks the run, never replays and leaves no browser",{skip,timeout:120_000},async()=>{
  const f=await service("unknown");
  try{
    const run=await f.qa.create("s1",crypto.randomUUID(),"index.html");
    await f.qa.act("s1","a","navigate",{path:"/busy.html"},allow);
    const shot=JSON.parse(await f.qa.act("s1","a","screenshot",{},allow));
    const click=f.qa.act("s1","a","click",{selector:"#b",observationId:shot.observationId},allow);const settled=click.catch(error=>error as Error);
    await waitFor(async()=>(await actions(f,run.id)).find(row=>row.kind==="click"&&row.status==="dispatched"));
    await f.qa.cancel("s1",run.id);
    assert.match((await settled as Error).message,/unknown|exited/i);
    const rows=await actions(f,run.id);assert.equal(rows.find(row=>row.kind==="click")!.status,"unknown");
    assert.equal((await f.storage.call<QaRunView>("qaRun",{id:run.id})).status==="cancelled"||(await f.storage.call<QaRunView>("qaRun",{id:run.id})).status==="unknown",true);
    await assert.rejects(f.qa.act("s1","a","screenshot",{},allow),/No approved running QA run/);
    assert.equal((await actions(f,run.id)).filter(row=>row.kind==="click").length,1,"no replay");
    assert.deepEqual(members(f.data),[]);
  }finally{await f.close();}
});

test("SIGKILL of the server mid-action: restart shows the action unknown, the run blocked, and no Chromium remains",{skip,timeout:120_000},async()=>{
  const f=await service("sigkill");await f.storage.close();
  const child=spawn(process.execPath,["--import","tsx",join(import.meta.dirname,"qa-crash.fixture.ts"),f.data,f.site],{cwd:root,stdio:["ignore","pipe","inherit"]});
  try{
    const runId=await new Promise<string>((resolve,reject)=>{let out="";const timer=setTimeout(()=>reject(new Error("fixture did not become ready")),60_000);
      child.stdout.on("data",chunk=>{out+=chunk;const match=/READY (\S+)/.exec(out);if(match){clearTimeout(timer);resolve(match[1]);}});child.on("exit",()=>reject(new Error("fixture exited early")));});
    const db=new DatabaseSync(join(f.data,"state.sqlite"),{readOnly:true});
    await waitFor(()=>db.prepare("SELECT 1 FROM qa_actions WHERE status='dispatched'").get());db.close();
    assert.ok(members(f.data).length>0,"browser is running before the kill");
    child.kill("SIGKILL");
    await waitFor(()=>members(f.data).length===0,6000);
    const storage=new Storage(join(f.data,"state.sqlite"));
    try{
      const run=await storage.call<QaRunView>("qaRun",{id:runId});assert.equal(run.status,"unknown");assert.match(run.error??"",/new run/);
      const rows=await storage.call<QaActionView[]>("qaActions",{runId});
      assert.deepEqual(rows.map(row=>`${row.kind}:${row.status}`),["navigate:done","screenshot:done","click:unknown"]);assert.match(rows[2].detail,/never replayed/);
      const qa=new Qa(storage,stubHost({cwd:f.site,revision:"rev-1"}),f.data,async()=>{});
      await assert.rejects(qa.act("session-1","a","screenshot",{},allow),/No approved running QA run/);
      assert.equal((await storage.call<QaActionView[]>("qaActions",{runId})).length,3,"restart does not replay or add actions");
      await qa.close();
    }finally{await storage.close();}
  }finally{try{child.kill("SIGKILL");}catch{}}
});

test("shutdown drain closes the browser group before returning and rejects new runs",{skip,timeout:90_000},async()=>{
  const f=await service("drain");
  try{
    const run=await f.qa.create("s1",crypto.randomUUID(),"index.html");
    assert.ok(members(f.data).length>0);
    f.qa.beginClose();
    await f.qa.close();
    assert.deepEqual(members(f.data),[],"group is empty once close() resolves");
    assert.equal((await f.storage.call<QaRunView>("qaRun",{id:run.id})).status,"cancelled");
    await assert.rejects(f.qa.create("s1",crypto.randomUUID(),"index.html"),/shutting down/);
    await assert.rejects(f.qa.act("s1","a","screenshot",{},allow),/shutting down|No approved/);
  }finally{await f.close();}
});

// ---- Through the real server: demo provider, qa-role child sessions, approvals, HTTP routes ----
async function freePort(){const server=createServer();await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const port=(server.address() as {port:number}).port;await new Promise<void>(r=>server.close(()=>r()));return port;}
async function launch(port:number,dataDir:string):Promise<ChildProcess>{
  const child=spawn(process.execPath,["--import","tsx","apps/server/main.ts"],{cwd:root,env:{PATH:process.env.PATH,HOME:scratch,SIGMA_APPROVAL_MODE:"ask",PI_OFFLINE:"1",PI_CODING_AGENT_DIR:join(scratch,"agent"),SIGMA_DEMO:"1",SIGMA_QA_CHROMIUM:chromium,SIGMA_PORT:String(port),SIGMA_DATA_DIR:dataDir},stdio:["ignore","pipe","pipe"]});
  child.stdout?.resume();child.stderr?.resume();
  await waitFor(async()=>{if(child.exitCode!==null)throw new Error("server exited");try{return (await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(2000)})).ok;}catch{return false;}},120_000);
  return child;
}
async function client(origin:string){
  const boot=await fetch(`${origin}/api/bootstrap`,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:"{}"});
  const cookie=boot.headers.get("set-cookie")!.split(";")[0];
  return {cookie,req:async(path:string,method="GET",body?:unknown,id?:string)=>{const response=await fetch(`${origin}/api${path}`,{method,headers:{Origin:origin,Cookie:cookie,...(body===undefined?{}:{"Content-Type":"application/json"}),...(id?{"X-Command-Id":id}:{})},body:body===undefined?undefined:JSON.stringify(body)});const text=await response.text();let data:any=text;try{data=JSON.parse(text);}catch{}return {status:response.status,data};}};
}

test("QA tools through the server: gate, approvals, stale refusal, artifact route; no tools without an approved run; Stop closes the browser",{skip,timeout:300_000},async()=>{
  const source=join(scratch,"e2e-source"),dataDir=join(scratch,"e2e-data");mkdirSync(source,{recursive:true});mkdirSync(dataDir,{recursive:true});
  writeFileSync(join(source,"index.html"),INDEX);
  execFileSync("git",["init","-q",source]);execFileSync("git",["-C",source,"add","--","."]);execFileSync("git",["-C",source,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","baseline"]);
  const port=await freePort(),origin=`http://127.0.0.1:${port}`,server=await launch(port,dataDir);
  try{
    const api=await client(origin),req=api.req;
    const mk=async()=>{const created=await req("/sessions","POST",{cwd:source,model:"sigma-demo/offline",mode:"parallel",workspaceMode:"worktree"},crypto.randomUUID());assert.equal(created.status,200);return created.data.id as string;};
    const settle=(sid:string)=>waitFor(async()=>{const view=(await req(`/sessions/${sid}`)).data;return view.status==="settled"&&!view.approvals.some((x:any)=>x.status==="pending")?view:false;},60_000);
    const say=async(sid:string,text:string)=>{assert.equal((await req(`/sessions/${sid}/prompt`,"POST",{text},crypto.randomUUID())).status,200);};
    const decide=async(sid:string,allow:boolean)=>{
      const approval=await waitFor(async()=>((await req(`/sessions/${sid}`)).data.approvals.find((x:any)=>x.status==="pending"&&x.tool==="qa_action"))||false,20_000).catch(async error=>{const data=(await req(`/sessions/${sid}`)).data;throw new Error(`${error.message}: ${JSON.stringify({status:data.status,approvals:data.approvals,agents:data.agents,messages:data.messages.slice(-3)})}`);});
      assert.equal((await req(`/sessions/${sid}/approvals/${approval.id}`,"POST",{allow})).status,200);return approval;
    };
    const qaView=async(sid:string)=>(await req(`/sessions/${sid}/qa`)).data as QaView;
    const sid=await mk(),other=await mk();
    // 1. No run yet: a qa child gets no QA tools; the root session never has them.
    await say(other,'delegate-qa:qa_screenshot:{}');await settle(other);
    await say(sid,'qa_navigate:{"path":"/index.html"}');await settle(sid);
    assert.deepEqual((await qaView(other)).actions,[],"a qa child without an approved run never reached the QA service");
    assert.deepEqual((await qaView(sid)).actions,[],"a root session never reaches the QA service");
    const errors=(sessionId:string)=>readdirSync(join(dataDir,"sessions")).filter(name=>name.includes(sessionId)).flatMap(name=>readFileSync(join(dataDir,"sessions",name),"utf8").trim().split("\n").map(line=>JSON.parse(line))).filter(entry=>entry.message?.role==="toolResult"&&entry.message.isError).map(entry=>`${entry.message.toolName}: ${entry.message.content.map((part:any)=>part.text??"").join(" ")}`);
    assert.ok(errors(sid).some(line=>/^qa_navigate: .*not found/.test(line)),`root: ${errors(sid)}`);
    // 2. The user's POST is the approval of the run.
    assert.equal((await req(`/sessions/${sid}/qa/runs`,"POST",{entry:"index.html"})).status,400);
    assert.equal((await req(`/sessions/${sid}/qa/runs`,"POST",{entry:"nope.html"},crypto.randomUUID())).status,409);
    const changes=(await req(`/sessions/${sid}/changes`)).data,runId=crypto.randomUUID();
    const started=await req(`/sessions/${sid}/qa/runs`,"POST",{entry:"index.html"},runId);assert.equal(started.status,200,JSON.stringify(started.data));
    const run=started.data as QaRunView;assert.equal(run.status,"running");assert.equal(run.revision,changes.revision);assert.equal(run.current,true);
    // Children are capped at 4 per root: Deny, approved navigate, stale click, screenshot.
    await say(sid,'delegate-qa:qa_navigate:{"path":"/index.html"}');await decide(sid,false);await settle(sid);
    await say(sid,'delegate-qa:qa_navigate:{"path":"/index.html"}');const navigation=await decide(sid,true);await settle(sid);
    assert.match(navigation.preview,new RegExp(`qa_navigate /index.html · run ${runId.slice(0,8)} · revision ${changes.revision.slice(0,12)} · manifest ${run.manifestHash.slice(0,12)}`));
    await say(sid,'delegate-qa:qa_click:{"selector":"#go","observationId":"not-an-observation"}');await settle(sid);
    await say(sid,'delegate-qa:qa_screenshot:{}');await settle(sid);
    const view=await qaView(sid),kinds=view.actions.filter(a=>a.runId===runId).map(a=>`${a.kind}:${a.status}`);
    assert.deepEqual(kinds,["navigate:denied","navigate:done","click:refused","screenshot:done"]);
    assert.ok(view.actions.every(a=>a.revision===changes.revision&&a.agentId!==sid));
    // 3. Artifact route.
    const [artifact]=view.artifacts as QaArtifactView[];assert.ok(artifact);
    const image=await fetch(`${origin}/api/sessions/${sid}/qa/artifacts/${artifact.id}`,{headers:{Origin:origin,Cookie:api.cookie}});
    assert.equal(image.status,200);assert.equal(image.headers.get("content-type"),"image/png");assert.equal(image.headers.get("x-content-type-options"),"nosniff");
    const bytes=Buffer.from(await image.arrayBuffer());assert.equal(createHash("sha256").update(bytes).digest("hex"),artifact.sha256);assert.deepEqual(pngInfo(bytes),{width:artifact.width,height:artifact.height});
    assert.equal((await fetch(`${origin}/api/sessions/${sid}/qa/artifacts/${artifact.id}`)).status,401,"same auth as other routes");
    assert.equal((await fetch(`${origin}/api/sessions/${crypto.randomUUID()}/qa/artifacts/${artifact.id}`,{headers:{Origin:origin,Cookie:api.cookie}})).status,404);
    assert.equal((await fetch(`${origin}/api/sessions/${sid}/qa/artifacts/not-a-uuid`,{headers:{Origin:origin,Cookie:api.cookie}})).status,400);
    // 4. Cancel closes the browser group.
    assert.ok(members(dataDir).length>0,"browser is running");
    assert.equal((await req(`/sessions/${sid}/qa/runs/${runId}/cancel`,"POST",{})).status,200);
    assert.deepEqual(members(dataDir),[]);
    assert.equal((await qaView(sid)).runs.find(item=>item.id===runId)!.status,"cancelled");
    assert.equal((await req(`/sessions/${sid}/qa/runs/${runId}/cancel`,"POST",{})).status,409);
    // 5. A second session whose run is active when the server is stopped.
    const second=await req(`/sessions/${other}/qa/runs`,"POST",{entry:"index.html"},crypto.randomUUID());assert.equal(second.status,200);
    assert.ok(members(dataDir).length>0);
    const exited=new Promise<void>(resolve=>server.once("exit",()=>resolve()));server.kill("SIGTERM");await exited;
    assert.deepEqual(members(dataDir),[],"graceful shutdown drained the browser group");
  }finally{try{server.kill("SIGKILL");}catch{}}
});
