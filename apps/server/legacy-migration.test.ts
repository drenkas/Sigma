import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Storage } from "./storage.js";
import { DataLease } from "./data-lease.js";
import { capture, journalState, publishLegacyStage, stage } from "./legacy-migration.js";

const root=resolve(import.meta.dirname,"../..");
const scratch=join(root,".scratch");
const sha=(bytes:Buffer|string)=>createHash("sha256").update(bytes).digest("hex");
const pause=()=>new Promise(resolve=>setTimeout(resolve,30));
async function waitFor(check:()=>boolean|Promise<boolean>,label:string){const deadline=Date.now()+30_000;while(Date.now()<deadline){if(await check())return;await pause();}throw new Error(`Timed out: ${label}`);}
async function freePort(){const server=createServer();await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const port=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
function launch(data:string,port:number,extra:Record<string,string>={}){
  const child=spawn(process.execPath,["--import","tsx","apps/server/main.ts"],{cwd:root,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,HOME:join(data,"home"),PI_CODING_AGENT_DIR:join(data,"sdk"),SIGMA_APPROVAL_MODE:"ask",PI_OFFLINE:"1",SIGMA_DEMO:"1",SIGMA_DATA_DIR:data,SIGMA_PORT:String(port),SIGMA_PARENT_WATCH:"1",...extra},stdio:["pipe","pipe","pipe"]});
  const run={child,ready:false,output:""};
  for(const stream of [child.stdout,child.stderr])stream?.on("data",bytes=>{run.output=(run.output+String(bytes)).slice(-4000);run.ready||=run.output.includes("Sigma API listening on");});
  return run;
}
type Run=ReturnType<typeof launch>;
const exited=(run:Run)=>run.child.exitCode!==null||run.child.signalCode!==null;
async function stop(run:Run){if(exited(run))return;run.child.stdin!.end();await waitFor(()=>exited(run),"server exit");}
async function client(port:number){
  const origin=`http://127.0.0.1:${port}`,boot=await fetch(`${origin}/api/bootstrap`,{method:"POST",headers:{origin}}),cookie=boot.headers.get("set-cookie")!.split(";")[0];
  return async(path:string,method="GET",body?:unknown,id?:string)=>{const response=await fetch(`${origin}/api${path}`,{method,headers:{origin,cookie,...(body?{"content-type":"application/json"}:{}),...(id?{"x-command-id":id}:{})},body:body?JSON.stringify(body):undefined});assert.equal(response.status,200,`${method} ${path}`);return response.json() as Promise<any>;};
}

const ID={a:"11111111-1111-4111-8111-111111111111",b:"22222222-2222-4222-8222-222222222222",c:"33333333-3333-4333-8333-333333333333"};
const stamp="2026-01-01T00-00-00-000Z";
const history=(id:string,cwd:string)=>`${JSON.stringify({type:"session",version:3,id,timestamp:"2026-01-01T00:00:00.000Z",cwd})}\n${JSON.stringify({type:"message",id:"m1",parentId:null,timestamp:"2026-01-01T00:00:01.000Z",message:{role:"user",content:[{type:"text",text:"hello"}],timestamp:1}})}\n`;
type Fixture={dir:string;source:string;dest:string;stageRoot:string;cwd:string};
// Real schema chain (storage worker) + legacy-shaped rows. Decoy credential dirs hold sentinels.
async function fixture(options:{alias?:boolean;missing?:boolean;duplicate?:boolean;decoys?:boolean}={}):Promise<Fixture>{
  await mkdir(scratch,{recursive:true});
  const dir=await mkdtemp(join(scratch,"legacy-")),source=join(dir,"legacy"),cwd=join(dir,"workspace");
  await mkdir(join(source,"sessions"),{recursive:true});await mkdir(cwd);
  const storage=new Storage(join(source,"state.sqlite"));await storage.call("sessions");await storage.close();
  const old="/nonexistent/pi-orchestrator/.data/sessions",mine=join(source,"sessions");
  const rows=[[ID.a,join(mine,`${stamp}_${ID.a}.jsonl`),ID.a,mine]] as [string,string,string|null,string][];
  if(options.alias)rows.push([ID.b,join(old,`${stamp}_${ID.b}.jsonl`),null,old]);
  if(options.missing)rows.push([ID.c,join(old,`${stamp}_${ID.c}.jsonl`),null,old]);
  const db=new DatabaseSync(join(source,"state.sqlite"));
  try{
    let created=1000;
    for(const [id,file,managerId,managerDir] of rows){
      const policy=JSON.stringify({version:2,requested:{cwd,model:"sigma-demo/offline",mode:"read"},effective:{cwd,model:"sigma-demo/offline",profile:{}},setup:{managerDir,managerId:id,sessionId:id}});
      db.prepare("INSERT INTO sessions(id,cwd,file,model,status,created_at,role,policy,manager_id) VALUES(?,?,?,?,?,?,?,?,?)").run(id,cwd,file,"sigma-demo/offline","idle",created++,"root",policy,managerId);
      db.prepare("INSERT INTO commands(id,session_id,kind,status,created_at,request_hash,setup) VALUES(?,?,?,?,?,?,?)").run(`c-${id}`,id,"create","completed",created,"h",JSON.stringify({managerDir,sessionId:id}));
      db.prepare("INSERT INTO events(session_id,type,payload,at) VALUES(?,?,?,?)").run(id,"session_created",JSON.stringify({id,note:`kept ${managerDir}`}),created);
      if(id!==ID.c)await writeFile(join(mine,`${stamp}_${id}.jsonl`),history(id,cwd));
    }
    db.prepare("INSERT INTO project_tasks(id,status,data) VALUES(?,?,?)").run("task-1","idle",JSON.stringify({id:"task-1",coordinatorSetup:{managerDir:mine},repositories:[{setup:{managerDir:mine}}]}));
    db.prepare("INSERT INTO checks(id,session_id,status,data) VALUES(?,?,?,?)").run("check-1",ID.a,"passed",JSON.stringify({files:["a.mjs"]}));
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }finally{db.close();}
  if(options.duplicate)await writeFile(join(mine,`2026-02-02T00-00-00-000Z_${ID.a}.jsonl`),history(ID.a,cwd));
  if(options.decoys)for(const name of ["agent","cliproxyapi","antigravity-profile"]){
    await mkdir(join(source,name));await writeFile(join(source,name,"auth.json"),`SENTINEL-${name}`);chmodSync(join(source,name),0o000);
  }
  return {dir,source,dest:join(dir,"native"),stageRoot:join(dir,"stages"),cwd};
}
// Authentic rows and Pi history written by a real (demo-provider) server, then B is turned into a legacy alias.
async function realFixture():Promise<Fixture>{
  await mkdir(scratch,{recursive:true});
  const dir=await mkdtemp(join(scratch,"legacy-real-")),source=join(dir,"legacy"),cwd=join(dir,"workspace");await mkdir(source);await mkdir(cwd);
  const port=await freePort(),run=launch(source,port);
  try{
    await waitFor(()=>run.ready||exited(run),"fixture server");assert.equal(exited(run),false,run.output);
    const req=await client(port);
    for(const id of [ID.a,ID.b]){
      await req("/sessions","POST",{cwd,model:"sigma-demo/offline"},id);await req(`/sessions/${id}/prompt`,"POST",{text:`hello ${id}`},crypto.randomUUID());
      await waitFor(async()=>{const snapshot=await req(`/sessions/${id}`);return snapshot.status==="settled"&&snapshot.messages.length===2;},"demo reply");
    }
  }finally{await stop(run);}
  const old="/nonexistent/pi-orchestrator/.data/sessions",mine=join(source,"sessions"),db=new DatabaseSync(join(source,"state.sqlite"));
  try{
    const file=(db.prepare("SELECT file FROM sessions WHERE id=?").get(ID.b) as any).file as string;
    db.prepare("UPDATE sessions SET file=?,policy=replace(policy,?,?),manager_id=NULL WHERE id=?").run(join(old,file.slice(mine.length+1)),mine,old,ID.b);
    db.prepare("UPDATE commands SET setup=replace(setup,?,?) WHERE session_id=?").run(mine,old,ID.b);db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }finally{db.close();}
  return {dir,source,dest:join(dir,"native"),stageRoot:join(dir,"stages"),cwd};
}
const cleanup=(f:Fixture)=>{for(const name of ["agent","cliproxyapi","antigravity-profile"])try{chmodSync(join(f.source,name),0o700);}catch{}};
const opts=(f:Fixture)=>({source:f.source,dest:f.dest,stageRoot:f.stageRoot});
function tree(path:string):string[]{return readdirSync(path,{withFileTypes:true}).flatMap(item=>item.isDirectory()?tree(join(path,item.name)):[join(path,item.name)]);}
const treeHash=(path:string)=>sha(tree(path).sort().map(file=>`${file}:${sha(readFileSync(file))}:${lstatSync(file).mtimeMs}`).join("\n"));
function dbRows(path:string,sql:string){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare(sql).all() as any[];}finally{db.close();}}

test("capture copies only the allowlist; credential decoys are never opened or copied",async()=>{
  const f=await fixture({alias:true,missing:true,decoys:true});
  try{
    const result=await capture(opts(f));
    assert.equal(result.state,"captured");
    const staged=tree(result.dir).filter(file=>!file.endsWith("STAGE.json")&&!file.endsWith("preview.json")&&!file.endsWith("preview.md"));
    assert.deepEqual(staged.map(file=>file.slice(result.dir.length+1)).sort(),["data/sessions/"+`${stamp}_${ID.a}.jsonl`,"data/sessions/"+`${stamp}_${ID.b}.jsonl`,"data/state.sqlite","orig/state.sqlite"].sort());
    for(const file of tree(result.dir))assert.doesNotMatch(readFileSync(file,"latin1"),/SENTINEL-/);
    const excluded=result.report.excluded.map((e:any)=>e.name);
    for(const name of ["agent","cliproxyapi","antigravity-profile"])assert.ok(excluded.includes(name),`${name} listed by name`);
  }finally{cleanup(f);}
});

test("preview reports counts and classification, is deterministic and leaves the source untouched",async()=>{
  const f=await fixture({alias:true,missing:true});
  const before=treeHash(f.source);
  const one=await capture(opts(f)),two=await capture(opts(f));
  assert.equal(treeHash(f.source),before,"source bytes and mtimes unchanged");
  assert.equal(one.reportSha256,two.reportSha256,"report hash is deterministic");assert.notEqual(one.stageId,two.stageId);
  assert.deepEqual(one.report.sessions.map((s:any)=>[s.id,s.class]),[[ID.a,"moved"],[ID.b,"alias"],[ID.c,"foreign"]]);
  assert.equal(one.report.counts.sessions,3);assert.equal(one.report.counts.events,3);assert.equal(one.report.counts.project_tasks,1);
  assert.deepEqual(one.report.blockers.map((b:any)=>[b.kind,b.session]),[["alias",ID.b],["missing-history",ID.c]]);
  assert.equal(existsSync(f.dest),false,"destination untouched by preview");
  assert.equal(one.report.destination.state,"absent");
  assert.ok(readFileSync(join(one.dir,"preview.md"),"utf8").includes(one.reportSha256));
});

test("a live Sigma writer blocks capture; after graceful stop capture succeeds",async()=>{
  const f=await fixture({}),port=await freePort(),run=launch(f.source,port);
  try{
    await waitFor(()=>run.ready||exited(run),"server start");assert.equal(exited(run),false,run.output);
    await assert.rejects(capture(opts(f)),/held by a running Sigma process/);
    assert.equal(DataLease.probe(f.source),"held");
    await stop(run);
    assert.equal(DataLease.probe(f.source),"free");
    const result=await capture(opts(f));assert.equal(result.state,"captured",JSON.stringify(result.report.blockers));
  }finally{await stop(run);}
});

test("non-empty source WAL blocks capture without touching the source",async()=>{
  const f=await fixture({});await writeFile(join(f.source,"state.sqlite-wal"),"pending frames");
  const before=treeHash(f.source),result=await capture(opts(f));
  assert.equal(result.state,"blocked");assert.deepEqual(result.report.blockers.map((b:any)=>b.kind),["wal"]);
  assert.equal(treeHash(f.source),before);assert.equal(existsSync(join(result.dir,"data/state.sqlite")),false);
  await assert.rejects(stage({...opts(f),authorize:result.reportSha256}),/blocked/);
});

test("source drift during capture rejects the stage",async()=>{
  const f=await fixture({});
  const result=await capture({...opts(f),afterCopy:()=>writeFile(join(f.source,"sessions",`${stamp}_${ID.a}.jsonl`),history(ID.a,f.cwd)+"{}\n")});
  assert.equal(result.state,"rejected");assert.ok(result.report.blockers.some((b:any)=>b.kind==="source-changed"));
  const marker=JSON.parse(readFileSync(join(result.dir,"STAGE.json"),"utf8"));assert.equal(marker.state,"rejected");
  await assert.rejects(publishLegacyStage(f.stageRoot,result.stageId,await DataLease.acquire(f.dest)),/rejected/);
});

test("rewrite changes only history references; IDs, other columns and JSONL bytes are preserved",async()=>{
  const f=await fixture({alias:true});
  const preview=await capture(opts(f)),staged=await stage({...opts(f),authorize:preview.reportSha256,acceptAlias:[ID.b]});
  const orig=join(staged.dir,"orig/state.sqlite"),data=join(staged.dir,"data/state.sqlite"),destSessions=join(f.dest,"sessions");
  assert.deepEqual(dbRows(data,"SELECT id FROM sessions ORDER BY id"),dbRows(orig,"SELECT id FROM sessions ORDER BY id"));
  const files=dbRows(data,"SELECT id,file FROM sessions ORDER BY id");
  assert.deepEqual(files.map(r=>r.file),[ID.a,ID.b].map(id=>join(f.dest,"sessions",`${stamp}_${id}.jsonl`)));
  assert.ok(files.every(r=>r.file.startsWith(destSessions)));
  const policy=JSON.parse(dbRows(data,"SELECT policy FROM sessions WHERE id=?".replace("?",`'${ID.b}'`))[0].policy);
  assert.equal(policy.setup.managerDir.endsWith("/native/sessions"),true);assert.equal(policy.setup.managerId,ID.b);
  assert.deepEqual(dbRows(data,"SELECT setup FROM commands ORDER BY id").map(r=>JSON.parse(r.setup).managerDir),[destSessions,destSessions]);
  const task=JSON.parse(dbRows(data,"SELECT data FROM project_tasks")[0].data);assert.equal(task.coordinatorSetup.managerDir,destSessions);assert.equal(task.repositories[0].setup.managerDir,destSessions);
  // Unchanged tables are identical, including event payloads that merely mention old paths.
  for(const sql of ["SELECT * FROM events ORDER BY seq","SELECT * FROM checks","SELECT id,cwd,model,status,created_at,role,manager_id FROM sessions ORDER BY id"])assert.deepEqual(dbRows(data,sql),dbRows(orig,sql));
  for(const r of staged.report.rewrites)assert.ok(["sessions.file","sessions.policy","commands.setup","project_tasks.data"].includes(`${r.table}.${r.column}`));
  for(const id of [ID.a,ID.b])assert.equal(sha(readFileSync(join(staged.dir,"data/sessions",`${stamp}_${id}.jsonl`))),sha(readFileSync(join(f.source,"sessions",`${stamp}_${id}.jsonl`))));
  const again=await capture(opts(f));assert.equal(again.reportSha256,preview.reportSha256,"rewrite is idempotent for identical input");
});

test("alias, missing and ambiguous histories block unless explicitly accepted",async()=>{
  const f=await fixture({alias:true,missing:true});
  const preview=await capture(opts(f)),base={...opts(f),authorize:preview.reportSha256};
  await assert.rejects(stage(base),/Unresolved blockers: alias .*missing-history/);
  await assert.rejects(stage({...base,acceptAlias:[ID.b]}),/Unresolved blockers: missing-history/);
  await assert.rejects(stage({...base,acceptAlias:[ID.c],acceptMissingHistory:[ID.c]}),/names .*no alias finding/);
  const ok=await stage({...base,acceptAlias:[ID.b],acceptMissingHistory:[ID.c]});
  assert.equal(ok.state,"staged".replace("staged","captured"));
  const marker=JSON.parse(readFileSync(join(ok.dir,"STAGE.json"),"utf8"));assert.equal(marker.state,"staged");assert.deepEqual(marker.authorization.acceptMissingHistory,[ID.c]);
  const rows=dbRows(join(ok.dir,"data/state.sqlite"),`SELECT file FROM sessions WHERE id='${ID.c}'`);assert.match(rows[0].file,/^\/nonexistent\/pi-orchestrator/,"missing row imported unchanged");
  const dup=await fixture({duplicate:true}),dupPreview=await capture(opts(dup));
  assert.deepEqual(dupPreview.report.blockers.map((b:any)=>b.kind),[]);// exact saved name wins; duplicates are orphans
  assert.equal(dupPreview.report.orphanHistory.length,1);
  const amb=await fixture({duplicate:true}),ambDb=new DatabaseSync(join(amb.source,"state.sqlite"));
  ambDb.prepare("UPDATE sessions SET file=? WHERE id=?").run(`/old/dir/${stamp.replace("00-00","09-09")}_${ID.a}.jsonl`,ID.a);ambDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");ambDb.close();
  const ambiguous=await capture(opts(amb));assert.deepEqual(ambiguous.report.blockers.map((b:any)=>b.kind),["ambiguous-history"]);
  await assert.rejects(stage({...opts(amb),authorize:ambiguous.reportSha256,acceptMissingHistory:[ID.a]}),/no missing finding/);
});

test("stale hash, two sources and unsafe locations are refused",async()=>{
  const f=await fixture({}),preview=await capture(opts(f));
  await assert.rejects(stage({...opts(f),authorize:"0".repeat(64)}),/changed since the reviewed preview/);
  await writeFile(join(f.source,"sessions",`${stamp}_${ID.a}.jsonl`),history(ID.a,f.cwd)+JSON.stringify({type:"message",id:"m2",parentId:"m1",timestamp:"2026-01-01T00:00:02.000Z",message:{role:"user",content:"x",timestamp:2}})+"\n");
  await assert.rejects(stage({...opts(f),authorize:preview.reportSha256}),/changed since the reviewed preview/);
  const cli=spawnSync(process.execPath,["--import","tsx","apps/server/legacy-migrate-cli.ts","preview","--source",f.source,"--source",f.dir,"--dest",f.dest,"--stage-root",f.stageRoot],{cwd:root,encoding:"utf8"});
  assert.notEqual(cli.status,0);assert.match(cli.stderr,/exactly one --source/);
  await assert.rejects(capture({...opts(f),dest:join(f.source,"inner")}),/must not contain each other/);
  await assert.rejects(capture({...opts(f),stageRoot:join(f.source,"stages")}),/Stage root must be outside/);
  assert.equal(readdirSync(f.source).includes("stages"),false);
});

async function published(f:Fixture,port:number){
  const preview=await capture(opts(f)),staged=await stage({...opts(f),authorize:preview.reportSha256,acceptAlias:[ID.b]});
  return {staged,run:launch(f.dest,port,{SIGMA_MIGRATE_PUBLISH:staged.stageId,SIGMA_MIGRATION_STAGE:f.stageRoot})};
}

test("startup publish installs sessions and history; non-empty or held destinations refuse",async()=>{
  const f=await realFixture(),port=await freePort(),{staged,run}=await published(f,await freePort());
  try{
    await waitFor(()=>run.ready||exited(run),"publish start");assert.equal(exited(run),false,run.output);
    assert.equal(journalState(f.dest),"done");
    const marker=JSON.parse(readFileSync(join(staged.dir,"STAGE.json"),"utf8"));assert.equal(marker.state,"published");
    const actual=Number(run.output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)![1]),req=await client(actual);
    const {sessions}=await req("/sessions");assert.deepEqual(sessions.map((s:any)=>s.id).sort(),[ID.a,ID.b]);
    assert.equal(readdirSync(join(f.dest,"sessions")).length,2);
    for(const id of [ID.a,ID.b]){const snapshot=await req(`/sessions/${id}`);assert.equal(snapshot.messages[0].text,`hello ${id}`,"history opens through the Pi manager");}
    const rows=dbRows(join(f.dest,"state.sqlite"),"SELECT file FROM sessions");assert.ok(rows.every(r=>r.file.startsWith(join(f.dest,"sessions"))));
    // A second publish into the now non-empty destination must refuse; the first owner still holds the lease.
    await stop(run);
    const again=launch(f.dest,await freePort(),{SIGMA_MIGRATE_PUBLISH:staged.stageId,SIGMA_MIGRATION_STAGE:f.stageRoot});
    await waitFor(()=>again.ready||exited(again),"second publish");assert.equal(again.ready,false);assert.match(again.output,/is published, not an authorized staged import/);await stop(again);
    // Held destination: a live owner makes a contender fail on the lease before any publish logic.
    const owner=launch(f.dest,port);await waitFor(()=>owner.ready||exited(owner),"owner");
    const contender=launch(f.dest,await freePort(),{SIGMA_MIGRATE_PUBLISH:staged.stageId,SIGMA_MIGRATION_STAGE:f.stageRoot});
    await waitFor(()=>exited(contender),"contender");assert.match(contender.output,/already owned/);await stop(owner);
  }finally{await stop(run);}
});

test("a non-empty destination refuses at stage preview and at publish",async()=>{
  const f=await fixture({alias:true});await mkdir(join(f.dest,"sessions"),{recursive:true});await writeFile(join(f.dest,"sessions","x.jsonl"),"{}\n");
  const preview=await capture(opts(f));assert.ok(preview.report.blockers.some((b:any)=>b.kind==="destination"));
  const clean=await fixture({alias:true}),good=await capture(opts(clean)),staged=await stage({...opts(clean),authorize:good.reportSha256,acceptAlias:[ID.b]});
  await mkdir(join(clean.dest,"sessions"),{recursive:true});await writeFile(join(clean.dest,"notes.txt"),"user data");
  const lease=await DataLease.acquire(clean.dest);
  try{await assert.rejects(publishLegacyStage(clean.stageRoot,staged.stageId,lease),/Destination is not empty/);}finally{lease.close();}
  assert.equal(existsSync(join(clean.dest,"state.sqlite")),false);
});

test("crash at each journal phase leaves the stage intact and the next start refuses",async()=>{
  for(const phase of ["begin","files-copied","db-installed"] as const){
    const f=await fixture({alias:true}),preview=await capture(opts(f)),staged=await stage({...opts(f),authorize:preview.reportSha256,acceptAlias:[ID.b]});
    const lease=await DataLease.acquire(f.dest);
    try{await assert.rejects(publishLegacyStage(f.stageRoot,staged.stageId,lease,at=>{if(at===phase)throw new Error("injected crash");}),/injected crash/);}finally{lease.close();}
    assert.equal(journalState(f.dest),"unfinished");
    assert.equal(JSON.parse(readFileSync(join(staged.dir,"STAGE.json"),"utf8")).state,"staged","stage retained for inspection");
    const run=launch(f.dest,await freePort(),{SIGMA_MIGRATE_PUBLISH:staged.stageId,SIGMA_MIGRATION_STAGE:f.stageRoot});
    try{await waitFor(()=>exited(run),"refusal");assert.equal(run.ready,false);assert.match(run.output,/Unfinished legacy migration journal/);}finally{await stop(run);}
    assert.equal(journalState(f.dest),"unfinished","no replay or cleanup");
  }
});
