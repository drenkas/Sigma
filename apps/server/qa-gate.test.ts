import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import test from "node:test";
import type { EvidenceView, QaActionView, QaGateView, QaView } from "../../packages/contracts/index.js";
import { chromiumPath } from "./qa-browser.js";
import { Qa, qaReviewTools, type QaHost } from "./qa-runs.js";
import { Storage } from "./storage.js";

const root=resolve(import.meta.dirname,"../..");
const scratch=join(process.env.SIGMA_TEST_DIR||join(root,".scratch"),`qa-gate-${Date.now()}-${process.pid}`);
const chromium=chromiumPath();
const skip=process.platform!=="darwin"?"QA browser is macOS-only (sandbox-exec)":!existsSync("/usr/bin/sandbox-exec")?"/usr/bin/sandbox-exec is missing":!existsSync(chromium)?`Chromium not found at ${chromium}; set SIGMA_QA_CHROMIUM to a Chrome for Testing binary`:false;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function waitFor<T>(read:()=>Promise<T|false>|T|false,ms=30000,what="QA state"):Promise<T>{const end=Date.now()+ms;while(Date.now()<end){const value=await read();if(value)return value;await sleep(50);}throw new Error(`Timed out waiting for ${what}`);}
const members=(marker:string)=>spawnSync("/bin/ps",["-axo","pid=,command="],{encoding:"utf8"}).stdout.split("\n").filter(line=>line.includes(marker));
const PNG=(()=>{const bytes=Buffer.alloc(64);Buffer.from("89504e470d0a1a0a0000000d49484452","hex").copy(bytes);bytes.writeUInt32BE(8,16);bytes.writeUInt32BE(6,20);bytes.write("fixture-png",33);return bytes;})();
const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");

// ---- Gate state machine over fabricated durable facts (no browser, no server) ----
async function rig(name:string,revision="rev-1"){
  const dir=join(scratch,name),data=join(dir,"data");mkdirSync(data,{recursive:true});
  const state={revision},storage=new Storage(join(data,"state.sqlite")),host:QaHost={verifiedCode:async()=>({}),assertDirectReady:async()=>{},snapshot:async()=>({status:"idle"}),changes:async()=>({cwd:dir,sourceCwd:dir,baseCommit:"",files:[],diff:"",omitted:0,revision:state.revision}),withPromptAdmission:(_id,action)=>action({check:()=>{}})};
  const qa=new Qa(storage,host,data,async()=>{});
  const session=async(id:string,parentId:string|null,role:string)=>{const file=join(dir,`${id}.jsonl`);writeFileSync(file,"");await storage.call("addSession",{id,cwd:dir,file,model:"m",managerId:id,parentId,role,childLimit:4,creation:{source:"user",actor:"user",cause:"test",commandId:id}});return file;};
  const rootFile=await session("s1",null,"root");await session("q1","s1","qa");await session("other",null,"root");
  let n=0;
  const run=async(id:string,revision:string,sessionId="s1")=>{await storage.call("addQaRun",{id,sessionId,requestHash:"x",revision,manifestHash:`m-${revision}`,manifest:[],entry:"index.html",origin:"http://127.0.0.1:1",viewport:{width:8,height:6},isolation:"outer",chromiumSha256:"0",status:"cancelled",createdAt:Date.now(),endedAt:Date.now()});};
  const action=async(runId:string,kind:string,extra:Partial<QaActionView>={},sessionId="s1")=>{const id=`${runId}-a${++n}`;await storage.call("addQaAction",{id,runId,sessionId,agentId:"q1",seq:n,kind,target:"x",revision:"r",manifestHash:"m",observationId:null,actionHash:"h",status:"done",detail:"",createdAt:Date.now(),endedAt:Date.now(),...extra});return id;};
  const artifact=async(runId:string,revision:string,sessionId="s1",bytes=PNG)=>{const id=`${runId}-art${++n}`;mkdirSync(join(data,"qa",runId,"artifacts"),{recursive:true});writeFileSync(join(data,"qa",runId,"artifacts",`${sha(bytes)}.png`),bytes);await storage.call("addQaArtifact",{id,runId,sessionId,mime:"image/png",width:8,height:6,sha256:sha(bytes),bytes:bytes.length,revision,manifestHash:`m-${revision}`,viewport:{width:8,height:6},observationId:`o${n}`,createdAt:Date.now()});return id;};
  const fact=(sessionId:string,payload:Record<string,unknown>)=>storage.event(sessionId,"graph_fact",{run:null,...payload});
  const entry=(file:string,id:string,role:string)=>writeFileSync(file,`${JSON.stringify({type:"message",id,message:{role,content:"x"}})}\n`,{flag:"a"});
  const gate=()=>qa.gate("s1");const step=(view:QaGateView,name:string)=>view.steps.find(item=>item.step===name)!;
  return {dir,data,state,storage,qa,rootFile,run,action,artifact,fact,entry,gate,step,session,close:async()=>{await qa.close();await storage.close();}};
}
test("gate walks R1 failure to final receipt only through durable facts; unknown blocks and prose or settled never advance it",async()=>{
  const f=await rig("walk");
  try{
    const step=f.step;
    assert.equal((await f.gate()).state,"none");
    // R1: a failed assertion without a screenshot is not enough.
    await f.run("r1","rev-1");const failed=await f.action("r1","assert",{outcome:"fail"});
    assert.equal(step(await f.gate(),"r1_failed").status,"pending");
    const shot=await f.artifact("r1","rev-1");await f.action("r1","screenshot",{artifactId:shot});
    let view=await f.gate();assert.equal(view.state,"r1_failed");assert.equal(f.step(view,"finding_recorded").status,"pending");
    // A finding that cites neither the failure nor the screenshot does not count.
    await f.storage.call("addQaFinding",{id:"f-bad",runId:"r1",sessionId:"s1",agentId:"q1",revision:"rev-1",manifestHash:"m-rev-1",summary:"x",severity:"low",artifactIds:[],actionIds:[],createdAt:Date.now()});
    assert.equal(f.step(await f.gate(),"finding_recorded").status,"pending");
    await f.storage.call("addQaFinding",{id:"f1",runId:"r1",sessionId:"s1",agentId:"q1",revision:"rev-1",manifestHash:"m-rev-1",summary:"Button label is wrong",severity:"high",artifactIds:[shot],actionIds:[failed],createdAt:Date.now()});
    view=await f.gate();assert.equal(view.state,"finding_recorded");assert.equal(step(view,"caller_receipt").status,"pending","qa child has not delivered yet");
    // Caller receipt: a dispatched fact without a native entry ID is unknown once the caller is idle, and is never replayed or promoted.
    const receiptFact={id:"receipt:s1:t1",kind:"result",source:"q1",target:"s1",actor:"s1",cause:"delegate_result",toolCallId:"t1",commandId:"pi-tool:s1:t1"};
    await f.fact("s1",{...receiptFact,outcome:"unknown"});
    await f.storage.call("status",{id:"s1",status:"running"});
    assert.equal(step(await f.gate(),"caller_receipt").status,"pending","caller still running: turn_end has not fired");
    await f.storage.call("status",{id:"s1",status:"settled"});
    view=await f.gate();assert.equal(step(view,"caller_receipt").status,"unknown");assert.match(view.blocked??"",/caller_receipt.*not replayed/);
    assert.equal(view.state,"finding_recorded");assert.equal(step(view,"fix_approved").status,"pending");
    // A receipt entry ID that is not in the caller transcript is unknown too.
    await f.fact("s1",{...receiptFact,outcome:"received",receiptEntryId:"entry-r1"});
    assert.equal(step(await f.gate(),"caller_receipt").status,"unknown");
    f.entry(f.rootFile,"entry-r1","toolResult");
    view=await f.gate();assert.equal(step(view,"caller_receipt").status,"done");assert.equal(step(view,"caller_receipt").refs.entryId,"entry-r1");assert.equal(view.state,"caller_receipt");
    // Fix: an uncertain write blocks; an applied write that leaves the revision unchanged does not advance; a new revision does.
    await sleep(5);
    await f.storage.call("approval",{id:"w1",sessionId:"s1",agentId:"s1",tool:"edit",preview:"edit",change:{path:"index.html",diff:"d",beforeHash:"a",afterHash:"b"}});await f.storage.call("approvalStatus",{id:"w1",status:"approved"});await f.storage.call("writeOutcome",{id:"w1",outcome:"unknown"});
    view=await f.gate();assert.equal(step(view,"fix_approved").status,"unknown");assert.equal(view.state,"caller_receipt");
    await f.storage.call("writeOutcome",{id:"w1",outcome:"applied"});
    view=await f.gate();assert.equal(step(view,"fix_approved").status,"pending");assert.match(step(view,"fix_approved").detail,/did not change/);
    f.state.revision="rev-2";view=await f.gate();assert.equal(step(view,"fix_approved").status,"done");assert.equal(step(view,"r1_stale").status,"done");assert.equal(view.state,"r1_stale");
    // R2: a failing run, then a passing run with a screenshot.
    await f.run("r2bad","rev-2");await f.action("r2bad","assert",{outcome:"fail"});await f.artifact("r2bad","rev-2");
    view=await f.gate();assert.equal(step(view,"r2_passed").status,"pending");assert.match(step(view,"r2_passed").detail,/failed/);
    await f.run("r2","rev-2");await f.action("r2","assert",{outcome:"pass"});
    assert.equal(step(await f.gate(),"r2_passed").status,"pending","a passing assertion without a screenshot is not enough");
    const shot2=await f.artifact("r2","rev-2");await f.action("r2","screenshot",{artifactId:shot2});
    view=await f.gate();assert.equal(step(view,"r2_passed").status,"done");assert.equal(view.state,"r2_passed");
    // Review: completed but never viewed an R2 artifact -> pending; the viewing is a durable fact.
    await f.storage.call("addReview",{id:"rv1",sessionId:"s1",checkId:"c",agentId:"rv1",revision:"rev-2",inputDigest:"d",status:"running",findings:"",createdAt:Date.now(),endedAt:null});
    await f.storage.call("reviewTransition",{id:"rv1",from:"running",to:"completed",patch:{findings:"Reviewer verdict: PASS",endedAt:Date.now()}});
    view=await f.gate();assert.equal(step(view,"reviewed").status,"pending");assert.match(step(view,"reviewed").detail,/did not view/);
    await f.storage.call("addQaView",{id:`rv1:${shot2}`,sessionId:"s1",reviewId:"rv1",artifactId:shot2,runId:"r2",revision:"rev-2",sha256:"x",at:Date.now()});
    view=await f.gate();assert.equal(step(view,"reviewed").status,"done");assert.equal(view.state,"reviewed");assert.equal(step(view,"final_receipt").status,"pending");
    // Final receipt: prose, a settled run and a bare dispatch never advance it.
    await f.storage.call("status",{id:"s1",status:"settled"});
    assert.equal(step(await f.gate(),"final_receipt").status,"pending");
    const finalFact={id:"input:cmd-1",kind:"result",source:"rv1",target:"s1",actor:"user",cause:"user_review_transfer",commandId:"cmd-1",reviewId:"rv1",revision:"rev-2"};
    await f.fact("s1",{...finalFact,outcome:"unknown"});
    view=await f.gate();assert.equal(step(view,"final_receipt").status,"unknown");assert.equal(view.state,"reviewed");assert.match(view.blocked??"",/final_receipt/);
    await f.fact("s1",{...finalFact,outcome:"received",receiptEntryId:"entry-final"});
    assert.equal(step(await f.gate(),"final_receipt").status,"unknown","entry id missing from the transcript");
    f.entry(f.rootFile,"entry-final","user");
    view=await f.gate();assert.equal(view.state,"final_receipt");assert.equal(view.blocked,null);assert.ok(view.steps.every(item=>item.status==="done"));
    // Restart: a fresh service on the same database re-derives the same gate and writes nothing else.
    const before={actions:(await f.storage.call<any[]>("qaSessionActions",{sessionId:"s1"})).length,facts:(await f.storage.call<any[]>("qaFacts",{field:"reviewId",value:"rv1"})).length,gate:JSON.stringify(await f.storage.call("qaGate",{sessionId:"s1"}))};
    const again=new Qa(f.storage,{verifiedCode:async()=>({}),assertDirectReady:async()=>{},snapshot:async()=>({status:"idle"}),changes:async()=>({cwd:f.dir,sourceCwd:f.dir,baseCommit:"",files:[],diff:"",omitted:0,revision:"rev-2"}),withPromptAdmission:(_i,a)=>a({check:()=>{}})},f.data,async()=>{});
    assert.deepEqual((await again.gate("s1")).steps,view.steps);
    assert.deepEqual({actions:(await f.storage.call<any[]>("qaSessionActions",{sessionId:"s1"})).length,facts:(await f.storage.call<any[]>("qaFacts",{field:"reviewId",value:"rv1"})).length,gate:JSON.stringify(await f.storage.call("qaGate",{sessionId:"s1"}))},before);
    // The revision moves again: R1 milestones stay, everything for the old R2 is no longer current.
    f.state.revision="rev-3";view=await f.gate();assert.equal(step(view,"r1_stale").status,"done");assert.equal(step(view,"r2_passed").status,"stale");assert.equal(view.state,"r1_stale");assert.match(view.blocked??"",/r2_passed/);
    await again.close();
  }finally{await f.close();}
});

test("qa_view_artifact: reviewer-only, same session and reviewed revision, hash re-checked, metadata or image block",async()=>{
  const f=await rig("view");
  try{
    await f.run("a","rev-2");const own=await f.artifact("a","rev-2");
    await f.run("old","rev-1");const old=await f.artifact("old","rev-1");
    await f.run("x","rev-2","other");const foreign=await f.artifact("x","rev-2","other",Buffer.concat([PNG,Buffer.from("foreign")]));
    const review=(id:string,sessionId="s1",revision="rev-2",status="running")=>f.storage.call("addReview",{id,sessionId,checkId:"c",agentId:id,revision,inputDigest:"d",status,findings:"",createdAt:Date.now(),endedAt:null});
    await review("rv");
    const viewed=await f.qa.viewArtifact("s1","rv",own);
    assert.equal(viewed.meta.sha256,sha(PNG));assert.equal(viewed.meta.revision,"rev-2");assert.equal(viewed.meta.width,8);assert.ok(viewed.bytes.equals(PNG));
    assert.deepEqual((await f.storage.call<any[]>("qaViews",{sessionId:"s1"})).map(v=>[v.reviewId,v.artifactId]),[["rv",own]],"the view is a durable fact");
    await f.qa.viewArtifact("s1","rv",own);assert.equal((await f.storage.call<any[]>("qaViews",{sessionId:"s1"})).length,1,"viewing twice records once");
    await assert.rejects(f.qa.viewArtifact("s1","rv",foreign),/not linked to the reviewed revision of this session/);
    await assert.rejects(f.qa.viewArtifact("s1","rv",old),/not linked/);
    await assert.rejects(f.qa.viewArtifact("s1","rv","missing"),/not linked/);
    await review("rv-other","other");
    await assert.rejects(f.qa.viewArtifact("s1","rv-other",own),/Only the running revision reviewer/,"a reviewer of another session cannot be used here");
    await assert.rejects(f.qa.viewArtifact("other","rv-other",own),/not linked/,"and cannot read this session's artifact");
    await assert.rejects(f.qa.viewArtifact("s1","not-a-review",own),/Only the running revision reviewer/);
    // The tool: image block only when the model accepts images.
    const call=(images:boolean,artifactId:string)=>qaReviewTools(f.qa,{rootId:"s1",reviewId:"rv",images})[0].execute("call",{artifactId},undefined,undefined,undefined as never);
    const text=await call(false,own);assert.deepEqual(text.content.map(part=>part.type),["text"]);assert.match((text.content[0] as {text:string}).text,/not attached/);
    const image=await call(true,own);assert.deepEqual(image.content.map(part=>part.type),["text","image"]);assert.equal((image.content[1] as {data:string}).data,PNG.toString("base64"));
    await assert.rejects(call(true,foreign),/not linked/);
    writeFileSync(join(f.data,"qa","a","artifacts",`${sha(PNG)}.png`),Buffer.concat([PNG,Buffer.from("x")]));
    await assert.rejects(f.qa.viewArtifact("s1","rv",own),/changed on disk/);
    await f.storage.call("reviewTransition",{id:"rv",from:"running",to:"completed",patch:{endedAt:Date.now()}});
    await assert.rejects(f.qa.viewArtifact("s1","rv",own),/Only the running revision reviewer/,"a finished reviewer can no longer read artifacts");
  }finally{await f.close();}
});

// ---- A real QA run: finding recording rules ----
const SITE=`<!doctype html><meta charset=utf-8><title>Shop</title><body style="margin:0"><h1>Shop</h1><button id=buy>Buy nwo</button>`;
test("qa_finding: only completed assertions and screenshots of the approved run; replays are idempotent; findings are current by revision",{skip,timeout:120_000},async()=>{
  const dir=join(scratch,"finding"),site=join(dir,"site"),data=join(dir,"data");mkdirSync(site,{recursive:true});mkdirSync(data,{recursive:true});writeFileSync(join(site,"index.html"),SITE);
  const state={revision:"rev-1"},storage=new Storage(join(data,"state.sqlite"));
  const qa=new Qa(storage,{verifiedCode:async()=>({}),assertDirectReady:async()=>{},snapshot:async()=>({status:"idle"}),changes:async()=>({cwd:site,sourceCwd:site,baseCommit:"",files:[],diff:"",omitted:0,revision:state.revision}),withPromptAdmission:(_id,action)=>action({check:()=>{}})},data,async()=>{});
  await storage.call("addSession",{id:"s1",cwd:site,file:"",model:"m",managerId:"s1",creation:{source:"user",actor:"user",cause:"test",commandId:"c"}});
  const allow=async()=>true;
  try{
    const first=await qa.create("s1",crypto.randomUUID(),"index.html");
    await qa.act("s1","q","navigate",{path:"/index.html"},allow);
    const shot=JSON.parse(await qa.act("s1","q","screenshot",{},allow)),bad=JSON.parse(await qa.act("s1","q","assert",{kind:"text",expected:"Buy now"},allow));
    assert.equal(bad.outcome,"fail");
    await assert.rejects(qa.recordFinding("s1","q","t0",{summary:"x",severity:"high",artifactIds:[shot.artifactId],actionIds:[]}),/actionIds/);
    await assert.rejects(qa.recordFinding("s1","q","t0",{summary:"x",severity:"urgent",artifactIds:[],actionIds:[bad.actionId]}),/Severity/);
    await assert.rejects(qa.recordFinding("s1","q","t0",{summary:"x",severity:"high",artifactIds:[],actionIds:["nope"]}),/does not belong/);
    const nav=(await storage.call<QaActionView[]>("qaActions",{runId:first.id})).find(a=>a.kind==="navigate")!;
    await assert.rejects(qa.recordFinding("s1","q","t0",{summary:"x",severity:"high",artifactIds:[],actionIds:[nav.id]}),/completed assertions/);
    await assert.rejects(qa.recordFinding("s1","q","t0",{summary:"x",severity:"high",artifactIds:["nope"],actionIds:[bad.actionId]}),/Artifact does not belong/);
    await assert.rejects(qa.recordFinding("s1","q","t0",{summary:"x",severity:"high",artifactIds:[],actionIds:[bad.actionId],runId:crypto.randomUUID()}),/active run/);
    const recorded=JSON.parse(await qa.recordFinding("s1","q","t1",{summary:"Button label is wrong",severity:"high",artifactIds:[shot.artifactId],actionIds:[bad.actionId]}));
    assert.equal(recorded.revision,"rev-1");assert.equal(recorded.duplicate,false);
    assert.equal(JSON.parse(await qa.recordFinding("s1","q","t1",{summary:"Button label is wrong",severity:"high",artifactIds:[shot.artifactId],actionIds:[bad.actionId]})).duplicate,true);
    assert.equal((await storage.call<any[]>("qaFindings",{sessionId:"s1"})).length,1,"a replayed tool call never duplicates the finding");
    assert.equal((await qa.findings("s1","rev-1"))[0].current,true);assert.equal((await qa.findings("s1","rev-2"))[0].current,false);assert.equal((await qa.findings("s1",null))[0].current,false);
    // An artifact of an earlier run cannot be cited from a later run.
    await qa.cancel("s1",first.id);state.revision="rev-2";
    await qa.create("s1",crypto.randomUUID(),"index.html");await qa.act("s1","q","navigate",{path:"/index.html"},allow);
    const pass=JSON.parse(await qa.act("s1","q","assert",{kind:"text",expected:"Buy nwo"},allow));
    await assert.rejects(qa.recordFinding("s1","q","t2",{summary:"y",severity:"low",artifactIds:[shot.artifactId],actionIds:[pass.actionId]}),/Artifact does not belong/);
    await assert.rejects(qa.recordFinding("s1","q","t3",{summary:"y",severity:"low",artifactIds:[],actionIds:[bad.actionId]}),/Action does not belong/);
  }finally{await qa.close();await storage.close();}
  assert.deepEqual(members(data),[]);
});

// ---- End to end through the real server, demo provider, qa children, approvals and a SIGKILL mid-gate ----
async function freePort(){const server=createServer();await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const port=(server.address() as {port:number}).port;await new Promise<void>(r=>server.close(()=>r()));return port;}
async function launch(port:number,dataDir:string):Promise<ChildProcess>{
  const child=spawn(process.execPath,["--import","tsx","apps/server/main.ts"],{cwd:root,env:{PATH:process.env.PATH,HOME:scratch,SIGMA_APPROVAL_MODE:"ask",PI_OFFLINE:"1",PI_CODING_AGENT_DIR:join(scratch,"agent"),SIGMA_DEMO:"1",SIGMA_QA_CHROMIUM:chromium,SIGMA_PORT:String(port),SIGMA_DATA_DIR:dataDir},stdio:["ignore","pipe","pipe"]});
  child.stdout?.resume();child.stderr?.resume();
  await waitFor(async()=>{if(child.exitCode!==null)throw new Error("server exited");try{return (await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(2000)})).ok;}catch{return false;}},120_000,"server start");
  return child;
}
async function client(origin:string){
  const boot=await fetch(`${origin}/api/bootstrap`,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:"{}"});
  const cookie=boot.headers.get("set-cookie")!.split(";")[0];
  return async(path:string,method="GET",body?:unknown,id?:string)=>{const response=await fetch(`${origin}/api${path}`,{method,headers:{Origin:origin,Cookie:cookie,...(body===undefined?{}:{"Content-Type":"application/json"}),...(id?{"X-Command-Id":id}:{})},body:body===undefined?undefined:JSON.stringify(body)});const text=await response.text();let data:any=text;try{data=JSON.parse(text);}catch{}return {status:response.status,data};};
}
const script=(...calls:Array<{name:string;arguments:Record<string,unknown>}>)=>`delegate-qa:script:${JSON.stringify(calls)}`;
const call=(name:string,args:Record<string,unknown>={})=>({name,arguments:args});

test("QA gate end to end: R1 failure, finding, caller receipt, SIGKILL mid-gate, approved fix, stale R1, fresh R2, independent review, final receipt by native entry ID",{skip,timeout:900_000},async()=>{
  const source=join(scratch,"e2e-source"),dataDir=join(scratch,"e2e-data");mkdirSync(source,{recursive:true});mkdirSync(dataDir,{recursive:true});
  writeFileSync(join(source,"index.html"),SITE);writeFileSync(join(source,"smoke.test.mjs"),"import { test } from 'node:test'; test('smoke', () => {});\n");
  execFileSync("git",["init","-q",source]);execFileSync("git",["-C",source,"add","--","."]);execFileSync("git",["-C",source,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","baseline"]);
  const port=await freePort(),origin=`http://127.0.0.1:${port}`;let server=await launch(port,dataDir),req=await client(origin);
  const sqlite=(sql:string,...args:any[])=>{const db=new DatabaseSync(join(dataDir,"state.sqlite"),{readOnly:true});try{return db.prepare(sql).all(...args) as any[];}finally{db.close();}};
  try{
    const created=await req("/sessions","POST",{cwd:source,model:"sigma-demo/offline",mode:"parallel",workspaceMode:"worktree"},crypto.randomUUID());assert.equal(created.status,200);const sid=created.data.id as string;
    const settle=()=>waitFor(async()=>{const view=(await req(`/sessions/${sid}`)).data;return view.status==="settled"&&!view.approvals.some((x:any)=>x.status==="pending")?view:false;},90_000,"session to settle");
    const say=async(text:string)=>{assert.equal((await req(`/sessions/${sid}/prompt`,"POST",{text},crypto.randomUUID())).status,200);};
    const decide=async(tool:string)=>{const approval=await waitFor(async()=>((await req(`/sessions/${sid}`)).data.approvals.find((x:any)=>x.status==="pending"&&x.tool===tool))||false,30_000,`${tool} approval`);assert.equal((await req(`/sessions/${sid}/approvals/${approval.id}`,"POST",{allow:true})).status,200);return approval;};
    const gate=async()=>{const result=await req(`/sessions/${sid}/qa/gate`);assert.equal(result.status,200,JSON.stringify(result.data));return result.data as QaGateView;};
    const at=(view:QaGateView,step:string)=>view.steps.find(item=>item.step===step)!;
    const evidence=async()=>(await req(`/sessions/${sid}/evidence`)).data as EvidenceView;
    const transcript=()=>readdirSync(join(dataDir,"sessions")).filter(name=>name.includes(sid)).flatMap(name=>readFileSync(join(dataDir,"sessions",name),"utf8").trim().split("\n").map(line=>JSON.parse(line)));
    const startRun=async()=>{const result=await req(`/sessions/${sid}/qa/runs`,"POST",{entry:"index.html"},crypto.randomUUID());assert.equal(result.status,200,JSON.stringify(result.data));return result.data;};
    const qaView=async()=>(await req(`/sessions/${sid}/qa`)).data as QaView;

    // R1: the qa child navigates (approved), screenshots, asserts the correct label (fails) and records a finding.
    const r1=await startRun();
    await say(script(call("qa_navigate",{path:"/index.html"}),call("qa_screenshot"),call("qa_assert",{kind:"text",expected:"Buy now"}),call("qa_finding",{summary:"The purchase button reads 'Buy nwo' instead of 'Buy now'",severity:"high",artifactIds:"$artifactIds",actionIds:"$assertIds"})));
    await decide("qa_action");await settle();
    const callerReceipt=await waitFor(async()=>{const view=await gate();return at(view,"caller_receipt").status==="done"?view:false;},30_000,"caller receipt");
    assert.equal(callerReceipt.state,"caller_receipt");assert.equal(at(callerReceipt,"r1_failed").refs.runId,r1.id);
    const r1Finding=(await evidence()).qaFindings[0];assert.equal(r1Finding.revision,r1.revision);assert.equal(r1Finding.current,true);assert.equal(r1Finding.severity,"high");
    const r1Actions=(await qaView()).actions.filter(a=>a.runId===r1.id);assert.deepEqual(r1Actions.map(a=>`${a.kind}:${a.status}${a.outcome?`:${a.outcome}`:""}`),["navigate:done","screenshot:done","assert:done:fail"]);
    const receiptEntry=at(callerReceipt,"caller_receipt").refs.entryId;
    assert.ok(transcript().some(entry=>entry.id===receiptEntry&&entry.type==="message"&&entry.message.role==="toolResult"),"receipt entry is a native entry of the caller transcript");
    assert.ok(sqlite("SELECT payload FROM events WHERE type='graph_fact'").map(row=>JSON.parse(row.payload)).some(f=>f.cause==="delegate_result"&&f.outcome==="received"&&f.receiptEntryId===receiptEntry));

    // SIGKILL mid-gate: nothing is replayed, the R1 run is unknown, the gate resumes from durable facts.
    const counts=()=>({actions:sqlite("SELECT count(*) AS n FROM qa_actions")[0].n,findings:sqlite("SELECT count(*) AS n FROM qa_findings")[0].n,artifacts:sqlite("SELECT count(*) AS n FROM qa_artifacts")[0].n,receipts:sqlite("SELECT count(*) AS n FROM events WHERE type='graph_fact' AND json_extract(payload,'$.outcome')='received'")[0].n,unknownReceipts:sqlite("SELECT count(*) AS n FROM events WHERE type='graph_fact' AND json_extract(payload,'$.cause')='delegate_result'")[0].n});
    const before=counts();assert.ok(members(dataDir).length>0,"R1 browser is running before the kill");
    server.kill("SIGKILL");await new Promise<void>(r=>server.once("exit",()=>r()));await waitFor(()=>members(dataDir).length===0,10_000,"browser group to die");
    server=await launch(port,dataDir);req=await client(origin);
    assert.deepEqual(counts(),before,"restart adds no actions, findings, artifacts or receipts");
    const resumed=await gate();assert.equal(resumed.state,"caller_receipt");assert.equal(at(resumed,"caller_receipt").refs.entryId,receiptEntry);assert.equal(at(resumed,"fix_approved").status,"pending");
    assert.equal((await qaView()).runs.find(run=>run.id===r1.id)!.status,"unknown");
    assert.deepEqual(counts(),before,"reading the gate writes no facts");

    // Approved fix through the existing edit path: new revision, R1 evidence stale.
    await say('edit:{"path":"index.html","edits":[{"oldText":"Buy nwo","newText":"Buy now"}]}');const write=await decide("edit");assert.ok(write);
    await waitFor(async()=>(await req(`/sessions/${sid}`)).data.approvals.find((x:any)=>x.id===write.id)?.outcome==="applied",30_000,"applied write");await settle();
    const fixed=await gate();assert.equal(at(fixed,"fix_approved").status,"done");assert.equal(at(fixed,"r1_stale").status,"done");assert.equal(fixed.state,"r1_stale");assert.equal(at(fixed,"r2_passed").status,"pending");
    const stale=await evidence();assert.equal(stale.qaFindings[0].current,false);assert.equal(stale.qaRuns.find(run=>run.id===r1.id)!.current,false);assert.notEqual(stale.revision,r1.revision);

    // Fresh R2 on the new revision.
    const r2=await startRun();assert.equal(r2.revision,stale.revision);assert.notEqual(r2.id,r1.id);
    await say(script(call("qa_navigate",{path:"/index.html"}),call("qa_screenshot"),call("qa_assert",{kind:"text",expected:"Buy now"})));
    await decide("qa_action");await settle();
    const passed=await waitFor(async()=>{const view=await gate();return at(view,"r2_passed").status==="done"?view:false;},30_000,"R2 pass");
    assert.equal(passed.state,"r2_passed");assert.equal(at(passed,"r2_passed").refs.runId,r2.id);
    assert.equal((await req(`/sessions/${sid}/qa/runs/${r2.id}/cancel`,"POST",{})).status,200);

    // Independent review of the R2 revision: the reviewer views an R2 artifact through qa_view_artifact.
    const check=await req(`/sessions/${sid}/checks`,"POST",{testPath:"smoke.test.mjs",inputPaths:[]},crypto.randomUUID());assert.equal(check.status,200,JSON.stringify(check.data));
    assert.equal((await req(`/sessions/${sid}/checks/${check.data.id}/decision`,"POST",{allow:true})).status,200);
    await waitFor(async()=>{const found=(await evidence()).checks.find(c=>c.id===check.data.id);if(found&&["failed","unknown","expired","cancelled"].includes(found.status))throw new Error(`check ${found.status}: ${found.output}`);return found?.status==="passed";},60_000,"passing check");
    const review=await req(`/sessions/${sid}/reviews`,"POST",{checkId:check.data.id});assert.equal(review.status,200,JSON.stringify(review.data));
    const done=await waitFor(async()=>{const found=(await evidence()).reviews.find(x=>x.id===review.data.id);if(found&&["error","interrupted","unknown"].includes(found.status))throw new Error(`review ${found.status}: ${found.findings}`);return found?.status==="completed"?found:false;},90_000,"review");
    const r2Artifacts=(await qaView()).artifacts.filter(a=>a.runId===r2.id);assert.equal(r2Artifacts.length,1);
    assert.match(done.findings,new RegExp(`Reviewer verdict: PASS. Inspected QA artifact ${r2Artifacts[0].id}`));
    const views=sqlite("SELECT data FROM qa_views").map(row=>JSON.parse(row.data));assert.deepEqual(views.map(v=>[v.reviewId,v.artifactId,v.sha256]),[[review.data.id,r2Artifacts[0].id,r2Artifacts[0].sha256]]);
    const reviewed=await gate();assert.equal(reviewed.state,"reviewed");assert.equal(at(reviewed,"final_receipt").status,"pending");
    assert.ok((await evidence()).qaRuns.find(run=>run.id===r2.id)!.current);

    // Final receipt: prose and a settled run do not count; only the review transfer with a persisted native turn_end entry ID does.
    await say(`The independent review ${review.data.id} passed, please treat the gate as delivered.`);await settle();
    const prose=await gate();assert.equal(at(prose,"final_receipt").status,"pending");assert.equal(prose.state,"reviewed");
    const deliveryId=crypto.randomUUID(),delivery=await req(`/sessions/${sid}/prompt`,"POST",{text:"Please read the QA review",reviewId:review.data.id},deliveryId);assert.equal(delivery.status,200);
    const final=await waitFor(async()=>{const view=await gate();return at(view,"final_receipt").status==="done"?view:false;},60_000,"final receipt");
    assert.equal(final.state,"final_receipt");assert.equal(final.blocked,null);assert.ok(final.steps.every(item=>item.status==="done"));
    const finalEntry=at(final,"final_receipt").refs.entryId;
    assert.ok(transcript().some(entry=>entry.id===finalEntry&&entry.type==="message"&&entry.message.role==="user"&&JSON.stringify(entry.message.content).includes(`Review evidence ${review.data.id}`)),"final receipt is a native user entry in the session JSONL");
    assert.ok(sqlite("SELECT payload FROM events WHERE type='graph_fact'").map(row=>JSON.parse(row.payload)).some(f=>f.reviewId===review.data.id&&f.outcome==="received"&&f.receiptEntryId===finalEntry));
    assert.equal((await req(`/sessions/${sid}/prompt`,"POST",{text:"Please read the QA review",reviewId:review.data.id},deliveryId)).data.accepted,false,"the delivered review is not replayed");
    assert.equal(sqlite("SELECT count(*) AS n FROM events WHERE type='graph_fact' AND json_extract(payload,'$.reviewId')=? AND json_extract(payload,'$.outcome')='received'",review.data.id)[0].n,1,"exactly one final receipt");
    assert.deepEqual(members(dataDir),[]);
  }finally{if(server.exitCode===null&&server.signalCode===null){const exited=new Promise<void>(r=>server.once("exit",()=>r()));server.kill("SIGTERM");await Promise.race([exited,sleep(15000)]);if(server.exitCode===null)server.kill("SIGKILL");}}
});
