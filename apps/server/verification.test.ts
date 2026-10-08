import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import type { CheckView, EvidenceView } from "../../packages/contracts/index.js";
import { PiHost } from "./pi-host.js";
import { Storage } from "./storage.js";
import { Verification } from "./verification.js";

const root=resolve(import.meta.dirname,"../..");
const scratch=join(process.env.SIGMA_TEST_DIR||join(root,".scratch"),`verification-${Date.now()}-${process.pid}`);
async function waitFor<T>(read:()=>Promise<T|false>,ms=8000):Promise<T>{const end=Date.now()+ms;while(Date.now()<end){const value=await read();if(value)return value;await new Promise(r=>setTimeout(r,40));}throw new Error("Timed out waiting for verification state");}
async function freePort(){const server=createServer();await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const port=(server.address() as {port:number}).port;await new Promise<void>(r=>server.close(()=>r()));return port;}
async function launch(port:number,dataDir:string):Promise<ChildProcess>{
  const started=Date.now();let startup="";
  const child=spawn(process.execPath,["--import","tsx","apps/server/main.ts"],{cwd:root,env:{PATH:process.env.PATH,HOME:scratch,SIGMA_APPROVAL_MODE:"ask",PI_OFFLINE:"1",PI_CODING_AGENT_DIR:join(scratch,"agent"),SIGMA_DEMO:"1",SIGMA_PORT:String(port),SIGMA_DATA_DIR:dataDir},stdio:["ignore","pipe","pipe"]});
  for(const stream of [child.stdout,child.stderr])stream?.on("data",chunk=>{startup=(startup+String(chunk)).slice(-1000);});
  try{
    await waitFor(async()=>{
      if(child.exitCode!==null||child.signalCode!==null)throw new Error(`Fixture server exited: ${child.exitCode??child.signalCode}`);
      try{return (await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(2000)})).ok;}catch{return false;}
    },120000);
    return child;
  }catch(error){
    if(child.exitCode===null&&child.signalCode===null){
      const exited=new Promise<void>(resolve=>child.once("exit",()=>resolve()));child.kill("SIGTERM");
      await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,3000))]);
      if(child.exitCode===null&&child.signalCode===null){
        child.kill("SIGKILL");await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,3000))]);
      }
    }
    throw new Error(`Fixture server on port ${port} was not ready after ${Date.now()-started} ms: ${error instanceof Error?error.message:String(error)}; startup: ${startup.trim()||"no output"}`);
  }
}
async function client(origin:string){
  const boot=await fetch(`${origin}/api/bootstrap`,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:"{}"});
  const cookie=boot.headers.get("set-cookie")!.split(";")[0];
  return {
    cookie,
    req:async(path:string,method="GET",body?:unknown,id?:string)=>{const response=await fetch(`${origin}/api${path}`,{method,headers:{Origin:origin,Cookie:cookie,...(body===undefined?{}:{"Content-Type":"application/json"}),...(id?{"X-Command-Id":id}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};},
  };
}
const gone=(pid:number)=>{try{process.kill(pid,0);return false;}catch{return true;}};

test("approved checks and independent reviews remain revision-bound and contained through crash",async t=>{
  if(process.platform!=="darwin"){t.skip("Native sandbox profile is macOS-only");return;}
  const source=join(scratch,"source"),dataDir=join(scratch,"data");await mkdir(source,{recursive:true});await mkdir(dataDir);
  await writeFile(join(source,"sum.mjs"),"export const sum = (a, b) => a - b;\n");
  await writeFile(join(source,"sum.test.mjs"),"import { test } from 'node:test'; import assert from 'node:assert/strict'; import { sum } from './sum.mjs'; test('adds', () => assert.equal(sum(2, 3), 5));\n");
  await writeFile(join(source,"loud.test.mjs"),"import { test } from 'node:test'; test('loud', () => { console.log('\\x01'.repeat(70000)); });\n");
  await writeFile(join(source,"--env-file=trap.test.mjs"),"import { test } from 'node:test'; test('option-safe', () => {});\n");
  await writeFile(join(source,"slow.test.mjs"),"import { test } from 'node:test'; import { writeFileSync } from 'node:fs'; writeFileSync('running.pid', String(process.pid)); test('hang', () => new Promise(() => setInterval(() => {}, 1000)));\n");
  await writeFile(join(source,".env"),"dummy-private-sentinel\n");
  execFileSync("git",["init","-q",source]);execFileSync("git",["-C",source,"add","--","."]);execFileSync("git",["-C",source,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","baseline"]);
  const port=await freePort(),origin=`http://127.0.0.1:${port}`;let server=await launch(port,dataDir),api:Awaited<ReturnType<typeof client>>;
  try{
    api=await client(origin);
    const req=(path:string,method="GET",body?:unknown,id?:string)=>api.req(path,method,body,id);
    const created=await req("/sessions","POST",{cwd:source,model:"sigma-demo/offline",mode:"code",workspaceMode:"worktree"},crypto.randomUUID());assert.equal(created.status,200);const sid=created.data.id as string;
    const prepare=async(testPath:string,inputPaths:string[]=[])=>{const result=await req(`/sessions/${sid}/checks`,"POST",{testPath,inputPaths},crypto.randomUUID());assert.equal(result.status,200,JSON.stringify(result.data));return result.data as CheckView;};
    const evidence=async()=>{const result=await req(`/sessions/${sid}/evidence`);assert.equal(result.status,200);return result.data as EvidenceView;};
    const complete=async(check:CheckView)=>waitFor(async()=>{const found=(await evidence()).checks.find(x=>x.id===check.id);return found&&!["pending","approved","running"].includes(found.status)?found:false;});
    const denied=await prepare("sum.test.mjs",["sum.mjs"]);assert.equal((await req(`/sessions/${sid}/checks`,"POST",{testPath:"sum.test.mjs",inputPaths:["sum.mjs"]},crypto.randomUUID())).status,409,"Only one pending check per session");assert.equal((await req(`/sessions/${sid}/checks/${denied.id}/decision`,"POST",{allow:false})).status,200);assert.equal((await evidence()).checks.find(x=>x.id===denied.id)?.status,"denied");await assert.rejects(stat(denied.cwd));
    const wrong=await prepare("sum.test.mjs",["sum.mjs"]);assert.equal((await req(`/sessions/${sid}/checks/${wrong.id}/decision`,"POST",{allow:true})).status,200);const failed=await complete(wrong);assert.equal(failed.status,"failed",failed.output);assert.equal(failed.exitCode,1);assert.equal(failed.current,true);await assert.rejects(stat(join(wrong.cwd,".env")));
    const firstReview=await req(`/sessions/${sid}/reviews`,"POST",{checkId:wrong.id});assert.equal(firstReview.status,200);await waitFor(async()=>{const review=(await evidence()).reviews.find(x=>x.id===firstReview.data.id);return review?.status==="completed"?review:false;});
    const graphPath=`/sessions/${sid}/graph`,reviewGraph=(await req(graphPath)).data;
    assert.ok(reviewGraph.nodes.some((node:any)=>node.id===firstReview.data.agentId));
    assert.ok(reviewGraph.events.some((event:any)=>event.payload.kind==="creation"&&event.payload.actor==="user"&&event.payload.cause==="user_revision_review"));
    assert.ok(reviewGraph.events.some((event:any)=>event.payload.kind==="review_evidence"&&event.payload.reviewId===firstReview.data.id&&event.payload.revision===wrong.revision));
    assert.equal(reviewGraph.events.some((event:any)=>event.payload.kind==="result"&&event.payload.source===firstReview.data.agentId),false,"Review row and Changes display do not deliver findings to root chat");
    const deliveryId=crypto.randomUUID(),delivery=await req(`/sessions/${sid}/prompt`,"POST",{text:"Consider findings",reviewId:firstReview.data.id},deliveryId);
    assert.equal(delivery.status,200);
    await waitFor(async()=>{const view=(await req(`/sessions/${sid}`)).data;return view.status==="settled"&&view.messages.some((message:any)=>message.role==="user"&&message.text.includes(`Review evidence ${firstReview.data.id}`));});
    const deliveredGraph=(await req(graphPath)).data;
    const delivered=deliveredGraph.events.find((event:any)=>event.payload.kind==="result"&&event.payload.reviewId===firstReview.data.id&&event.payload.outcome==="received");
    assert.equal(delivered?.payload.target,sid);assert.equal(delivered?.payload.source,firstReview.data.agentId);assert.ok(delivered?.payload.receiptEntryId);
    assert.equal((await req(`/sessions/${sid}/prompt`,"POST",{text:"Consider findings",reviewId:firstReview.data.id},deliveryId)).data.accepted,false,"Observed review receipt is not replayed");
    assert.equal((await req(`/sessions/${sid}/prompt`,"POST",{text:"Foreign review",reviewId:crypto.randomUUID()},crypto.randomUUID())).status,409);
    assert.equal((await req(`/sessions/${sid}/agents/${firstReview.data.agentId}/prompt`,"POST",{text:"change your findings"},crypto.randomUUID())).status,409,"Revision-bound reviewers cannot receive child messages");
    assert.equal((await req(`/sessions/${sid}/agents/${firstReview.data.agentId}/abort`,"POST",{},crypto.randomUUID())).status,409,"Revision-bound reviewers use their review Stop control");
    const stalePending=await prepare("sum.test.mjs",["sum.mjs"]);
    const prompt=await req(`/sessions/${sid}/prompt`,"POST",{text:'edit:{"path":"sum.mjs","edits":[{"oldText":"a - b","newText":"a + b"}]}'},crypto.randomUUID());assert.equal(prompt.status,200);
    const approval=await waitFor(async()=>{const row=(await req(`/sessions/${sid}`)).data;return row.approvals.find((x:any)=>x.status==="pending"&&x.change?.path==="sum.mjs")||false;});
    assert.equal((await req(`/sessions/${sid}/approvals/${approval.id}`,"POST",{allow:true})).status,200);
    await waitFor(async()=>{const row=(await req(`/sessions/${sid}`)).data;return row.approvals.find((x:any)=>x.id===approval.id)?.outcome==="applied";});
    assert.equal((await req(`/sessions/${sid}/checks/${stalePending.id}/decision`,"POST",{allow:true})).status,409);assert.equal((await evidence()).checks.find(x=>x.id===stalePending.id)?.status,"expired");await assert.rejects(stat(stalePending.cwd));
    assert.equal((await evidence()).checks.find(x=>x.id===wrong.id)?.current,false);assert.equal((await evidence()).reviews.find(x=>x.id===firstReview.data.id)?.current,false);
    const fixed=await prepare("sum.test.mjs",["sum.mjs"]);assert.equal((await req(`/sessions/${sid}/checks/${fixed.id}/decision`,"POST",{allow:true})).status,200);const passed=await complete(fixed);assert.equal(passed.status,"passed",passed.output);assert.equal(passed.exitCode,0);
    const secondReview=await req(`/sessions/${sid}/reviews`,"POST",{checkId:fixed.id});assert.equal(secondReview.status,200);const review=await waitFor(async()=>{const found=(await evidence()).reviews.find(x=>x.id===secondReview.data.id);return found?.status==="completed"?found:false;});assert.equal(review.current,true);
    const changes=(await req(`/sessions/${sid}/changes`)).data;const patch=await fetch(`${origin}/api/sessions/${sid}/changes.patch?revision=${changes.revision}`,{headers:{Origin:origin,Cookie:api.cookie}});assert.equal(patch.status,200);assert.equal(patch.headers.get("x-code-revision"),changes.revision);assert.match(await patch.text(),/a \+ b/);
    assert.equal((await fetch(`${origin}/api/sessions/${sid}/changes.patch?revision=${wrong.revision}`,{headers:{Origin:origin,Cookie:api.cookie}})).status,409);
    assert.match(await readFile(join(source,"sum.mjs"),"utf8"),/a - b/);
    const loud=await prepare("loud.test.mjs");await req(`/sessions/${sid}/checks/${loud.id}/decision`,"POST",{allow:true});const loudResult=await complete(loud);assert.equal(loudResult.status,"passed",loudResult.output.slice(-300));assert.equal(loudResult.truncated,true);assert.ok(Buffer.byteLength(loudResult.output)<=loud.outputLimit);
    const option=await prepare("--env-file=trap.test.mjs");assert.ok(option.argv.at(-1)?.startsWith(option.cwd+"/"));await req(`/sessions/${sid}/checks/${option.id}/decision`,"POST",{allow:true});assert.equal((await complete(option)).status,"passed");
    const stopped=await prepare("slow.test.mjs");await req(`/sessions/${sid}/checks/${stopped.id}/decision`,"POST",{allow:true});
    const stoppedPid=await waitFor(async()=>{try{return Number(await readFile(join(stopped.cwd,"running.pid"),"utf8"));}catch{return false;}});
    assert.equal((await req(`/sessions/${sid}/checks/${crypto.randomUUID()}/abort`,"POST",{})).status,409);
    assert.equal((await evidence()).checks.find(x=>x.id===stopped.id)?.status,"running");
    assert.equal((await req(`/sessions/${sid}/checks/${stopped.id}/abort`,"POST",{})).status,200);
    assert.equal((await complete(stopped)).status,"cancelled");await waitFor(async()=>gone(stoppedPid));
    assert.equal((await req(`/sessions/${sid}/checks/${stopped.id}/abort`,"POST",{})).status,409);
    const slow=await prepare("slow.test.mjs");await req(`/sessions/${sid}/checks/${slow.id}/decision`,"POST",{allow:true});
    const pid=await waitFor(async()=>{try{return Number(await readFile(join(slow.cwd,"running.pid"),"utf8"));}catch{return false;}});
    server.kill("SIGKILL");await new Promise<void>(r=>server.once("exit",()=>r()));await waitFor(async()=>gone(pid));
    server=await launch(port,dataDir);api=await client(origin);
    const recovered=(await evidence()).checks.find(x=>x.id===slow.id);assert.equal(recovered?.status,"unknown");assert.equal(gone(pid),true);assert.match(await readFile(join(source,".env"),"utf8"),/dummy-private-sentinel/);
  }finally{if(server.exitCode===null&&server.signalCode===null){server.kill("SIGTERM");await new Promise<void>(r=>server.once("exit",()=>r()));}}
});

test("reviewer cannot start after Stop, write, or report provider error as findings",async()=>{
  process.env.PI_OFFLINE="1";process.env.SIGMA_DEMO="1";process.env.PI_CODING_AGENT_DIR=join(scratch,"direct-agent");
  const source=join(scratch,"review-source"),data=join(scratch,"review-data"),snapshot=join(scratch,"review-snapshot");
  await mkdir(source,{recursive:true});await mkdir(data);await mkdir(snapshot);await writeFile(join(source,"file.mjs"),"export const value = 1;\n");await writeFile(join(source,"file.test.mjs"),"import { test } from 'node:test'; test('ok', () => {});\n");await writeFile(join(snapshot,"file.mjs"),"export const value = 1;\n");
  execFileSync("git",["init","-q",source]);execFileSync("git",["-C",source,"add","--","file.mjs","file.test.mjs"]);execFileSync("git",["-C",source,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","baseline"]);
  const storage=new Storage(join(data,"state.sqlite")),host=new PiHost(storage,data,async()=>{});await host.init();
  try{
    const sid=await host.create(source,"sigma-demo/offline",crypto.randomUUID(),"code");
    const uncertain=crypto.randomUUID();await storage.call("approval",{id:uncertain,sessionId:sid,agentId:sid,tool:"write",preview:"write file.mjs",change:{path:"file.mjs",diff:"fixture",beforeHash:"fixture",afterHash:"fixture"}});await storage.call("approvalStatus",{id:uncertain,status:"approved"});await storage.call("writeOutcome",{id:uncertain,outcome:"unknown"});
    await new Promise(r=>setTimeout(r,5));
    for(let i=0;i<101;i++)await storage.call("approval",{id:crypto.randomUUID(),sessionId:sid,agentId:sid,tool:"read",preview:"read file.mjs"});
    assert.equal((await host.snapshot(sid)).approvals.some(a=>a.id===uncertain),false,"The unresolved write is older than visible history");
    const verification=new Verification(storage,host,data,async()=>{});
    await assert.rejects(verification.prepare(sid,crypto.randomUUID(),"file.test.mjs",[]),/unresolved write|unknown outcomes/);
    const stopped=new AbortController();stopped.abort();
    await assert.rejects(host.startReviewer(sid,crypto.randomUUID(),snapshot,"hello",stopped.signal),/stopped before creation/);
    assert.equal((await host.snapshot(sid)).agents.length,1);
    const error=await host.startReviewer(sid,crypto.randomUUID(),snapshot,"fail-provider",new AbortController().signal);
    await assert.rejects(error.done,/Reviewer provider failed/);
    const write=await host.startReviewer(sid,crypto.randomUUID(),snapshot,'write:{"path":"escaped.txt","content":"bad"}',new AbortController().signal);
    assert.match(await write.done,/denied or failed/);await assert.rejects(stat(join(snapshot,"escaped.txt")));
    const stoppedReviewId=crypto.randomUUID(),controller=new AbortController();
    const slow=await host.startReviewer(sid,stoppedReviewId,snapshot,"slow task",controller.signal);
    const rejected=assert.rejects(slow.done,/Reviewer stopped|interrupted/);
    controller.abort();await host.abortReviewer(sid,stoppedReviewId);await rejected;
    assert.deepEqual((await host.snapshot(sid)).agents.map(x=>x.role),["root","reviewer","reviewer","reviewer"]);
  }finally{await host.close();await storage.close();}
});


test("root Stop drains review admission before check validation, rejects arrivals and allows a fresh bounded reviewer",async t=>{
  process.env.PI_OFFLINE="1";process.env.SIGMA_DEMO="1";process.env.PI_CODING_AGENT_DIR=join(scratch,"review-admission-agent");
  if(process.platform!=="darwin"){t.skip("Native sandbox profile is macOS-only");return;}
  const data=join(scratch,"review-admission"),source=join(data,"source"),state=join(data,"state");await mkdir(source,{recursive:true});await mkdir(state);
  await writeFile(join(source,"value.mjs"),"export const value = 1;\n");await writeFile(join(source,"value.test.mjs"),"import {test} from 'node:test'; import {value} from './value.mjs'; test('value',()=>{if(value!==1)throw new Error('wrong value');});\n");
  execFileSync("git",["init","-q",source]);execFileSync("git",["-C",source,"add","--","."]);execFileSync("git",["-C",source,"-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false","-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","baseline"]);
  const storage=new Storage(join(state,"state.sqlite")),send=async(id:string,type:string,payload:unknown,durable?:boolean)=>{if(durable)await storage.event(id,type,payload);},host=new PiHost(storage,state,send),verification=new Verification(storage,host,state,send);await host.init();let release=()=>{};
  try{
    const id=await host.create(source,"sigma-demo/offline",crypto.randomUUID(),"code"),prepared=await verification.prepare(id,crypto.randomUUID(),"value.test.mjs",["value.mjs"]);await verification.decide(id,prepared.id,true);
    const checked=await waitFor(async()=>{const row=await storage.call<any>("check",{id:prepared.id});return row&&!['pending','approved','running'].includes(row.status)?row:false;},30000);assert.equal(checked.status,"passed");assert.equal(checked.exitCode,0);
    const call=storage.call.bind(storage);let reached=()=>{},heldOnce=false;const held=new Promise<void>(done=>{reached=done;}),gate=new Promise<void>(done=>{release=done;});
    (storage as any).call=async(op:string,args:any={})=>{const result=await call(op,args);if(!heldOnce&&op==="check"&&args.id===prepared.id){heldOnce=true;reached();await gate;}return result;};
    const reviewing=verification.review(id,prepared.id);await held;
    let returned=false;const stopping=(async()=>{const unfence=host.stopFence(id);try{await verification.abortSession(id);await host.abort(id);}finally{unfence();}})();void stopping.then(()=>{returned=true;},()=>{});
    await new Promise(done=>setTimeout(done,100));const returnedBeforeRelease=returned;
    await assert.rejects(verification.review(id,prepared.id),/stopped|stopping/i,"Arrivals while root Stop drains admission are rejected");release();await stopping;
    await assert.rejects(reviewing,/stopped|stopping/i,"The older review request cannot start a reviewer after Stop");assert.equal(returnedBeforeRelease,false,"Stop waits for review admission to unwind");
    assert.equal((await host.snapshot(id)).agents.length,1);assert.equal((await storage.call<any[]>("reviews",{sessionId:id})).length,0);assert.equal((await host.snapshot(id)).approvals.some(a=>a.status==="pending"),false);
    const fresh=await verification.review(id,prepared.id);await waitFor(async()=>{const row=await storage.call<any>("review",{id:fresh.id});return row.status==="completed"?row:false;});
    const reviewer=await host.snapshot(fresh.agentId);assert.deepEqual(reviewer.policy!.effective.profile.tools,["read","ls"]);assert.equal(reviewer.policy!.effective.profile.maxDepth,0);assert.equal((await host.snapshot(id)).agents.length,2);assert.equal(reviewer.policy!.version,2);
  }finally{release();await verification.close();await host.close();await storage.close();}
});

test("shutdown fences Verification approvals and drains a held approval transition",async()=>{
  process.env.PI_OFFLINE="1";process.env.SIGMA_DEMO="1";process.env.PI_CODING_AGENT_DIR=join(scratch,"shutdown-approval-agent");
  const source=join(scratch,"shutdown-approval-source"),data=join(scratch,"shutdown-approval-data");await mkdir(source,{recursive:true});await mkdir(data);
  await writeFile(join(source,"value.mjs"),"export const value=1;\n");
  await writeFile(join(source,"value.test.mjs"),"import {test} from 'node:test'; test('value',()=>{});\n");
  execFileSync("git",["init","-q",source]);execFileSync("git",["-C",source,"add","--","."]);
  execFileSync("git",["-C",source,"-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false","-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","baseline"]);
  const storage=new Storage(join(data,"state.sqlite")),host=new PiHost(storage,data,async()=>{});await host.init();const verification=new Verification(storage,host,data,async()=>{});
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),atTransition=new Promise<void>(resolve=>entered=resolve);
  const original=storage.call.bind(storage);let hold=true;
  storage.call=((op:string,args:Record<string,unknown>={})=>op==="checkTransition"&&args.from==="pending"&&args.to==="approved"&&hold
    ?(hold=false,entered(),gate.then(()=>original(op,args)))
    :original(op,args)) as typeof storage.call;
  try{
    const session=await host.create(source,"sigma-demo/offline",crypto.randomUUID(),"code");
    const prepared=await verification.prepare(session,crypto.randomUUID(),"value.test.mjs",["value.mjs"]);
    const approving=verification.decide(session,prepared.id,true);await atTransition;
    const closing=verification.close();await new Promise<void>(resolve=>setImmediate(resolve));
    await assert.rejects(verification.prepare(session,crypto.randomUUID(),"value.test.mjs",["value.mjs"]),/shutting down/);
    assert.equal((await storage.call<any>("check",{id:prepared.id})).status,"pending","close waits before deciding the held transition");
    release();await Promise.all([closing,assert.rejects(approving,/shutting down/)]);
    assert.equal((await storage.call<any>("check",{id:prepared.id})).status,"cancelled");
    assert.equal((verification as any).active.size,0,"no runner is admitted after shutdown");
  }finally{release();storage.call=original;await verification.close();await host.close();await storage.close();}
});
