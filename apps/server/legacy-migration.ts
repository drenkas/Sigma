import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { DataLease } from "./data-lease.js";

// Legacy import: capture ONE stopped legacy data dir read-only, rewrite only Pi history references inside
// a staged copy, and publish it into an empty native DATA_DIR at startup. Allowlist: state.sqlite + sessions/*.jsonl.
export const MIGRATION_TOOL="sigma-legacy-migration/1";
export const JOURNAL=".migration-journal.json",JOURNAL_DONE=".migration-journal.done.json";
const sha=(bytes:Buffer|string)=>createHash("sha256").update(bytes).digest("hex");
const canon=(value:unknown):unknown=>Array.isArray(value)?value.map(canon):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canon((value as any)[key])])):value;
const stable=(value:unknown)=>JSON.stringify(canon(value),(_key,item)=>typeof item==="bigint"?`${item}n`:item instanceof Uint8Array?Buffer.from(item).toString("hex"):item);
const inside=(root:string,path:string)=>{const rel=relative(root,path);return rel===""||!rel.startsWith("..")&&!isAbsolute(rel);};
async function resolved(path:string):Promise<string>{path=resolve(path);try{return await realpath(path);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;return join(await resolved(dirname(path)),basename(path));}}
export const defaultStageRoot=(destination:string)=>join(dirname(destination),`${basename(destination)}-migration`);
const syncDir=(path:string)=>{const fd=openSync(path,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}};
const immutable=(path:string)=>new DatabaseSync(`${pathToFileURL(path).href}?immutable=1`,{readOnly:true});
function writeAtomic(path:string,text:string){const tmp=`${path}.${process.pid}.tmp`,fd=openSync(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC,0o600);try{writeSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,path);syncDir(dirname(path));}

type Entry={name:string;size:number;sha256:string;dev:string;ino:string;mtimeNs:string};
function readEntry(root:string,name:string){
  const path=join(root,name),named=lstatSync(path,{bigint:true});
  if(!named.isFile()||named.nlink!==1n)throw new Error(`${name} must be one regular file`);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const info=fstatSync(fd,{bigint:true});if(info.dev!==named.dev||info.ino!==named.ino)throw new Error(`${name} changed identity while opening`);
    const bytes=readFileSync(fd);return {bytes,entry:{name,size:bytes.length,sha256:sha(bytes),dev:String(info.dev),ino:String(info.ino),mtimeNs:String(info.mtimeNs)} as Entry};
  }finally{closeSync(fd);}
}
function snapshot(root:string){
  const entries:Entry[]=[],excluded:{name:string;kind:string;size:number}[]=[],problems:string[]=[];let walSize=0,sessions:string[]=[];
  const kind=(info:{isSymbolicLink():boolean;isDirectory():boolean;isFile():boolean})=>info.isSymbolicLink()?"symlink":info.isDirectory()?"directory":info.isFile()?"file":"other";
  for(const name of readdirSync(root).sort()){
    if(name==="state.sqlite"){try{entries.push(readEntry(root,name).entry);}catch(error){problems.push((error as Error).message);}continue;}
    if(name==="sessions"){
      const info=lstatSync(join(root,name));
      if(!info.isDirectory()){problems.push("sessions must be a real directory");continue;}
      sessions=readdirSync(join(root,name)).sort();
      for(const file of sessions){
        const rel=`sessions/${file}`,item=lstatSync(join(root,rel));
        if(file.endsWith(".jsonl")&&!item.isDirectory()){try{entries.push(readEntry(root,rel).entry);}catch(error){problems.push((error as Error).message);}}
        else excluded.push({name:rel,kind:kind(item),size:item.size});
      }
      continue;
    }
    const info=lstatSync(join(root,name));if(name==="state.sqlite-wal")walSize=info.size;
    excluded.push({name,kind:kind(info),size:info.size});
  }
  return {entries,excluded,problems,walSize,sessions};
}

const ALLOWED_DESTINATION=new Set(["agent","cliproxyapi","antigravity-profile","sdk","home","sigma.lock",".DS_Store","sessions","state.sqlite","state.sqlite-wal","state.sqlite-shm"]);
// Names only: provisioned credential dirs are never opened. Empty means no user data of any kind.
export function inspectDestination(dir:string,leased=false):{state:"absent"|"empty"|"non-empty"|"held";reasons:string[]}{
  if(!existsSync(dir))return {state:"absent",reasons:[]};
  if(!leased&&DataLease.probe(dir)==="held")return {state:"held",reasons:["Destination is owned by a running Sigma process"]};
  const reasons:string[]=[];
  for(const name of readdirSync(dir).sort()){
    if(!ALLOWED_DESTINATION.has(name))reasons.push(`unexpected entry ${name}`);
    else if(name==="sessions"){if(!lstatSync(join(dir,name)).isDirectory()||readdirSync(join(dir,name)).length)reasons.push("sessions is not an empty directory");}
  }
  if(existsSync(join(dir,JOURNAL)))reasons.push("unfinished migration journal");
  const db=join(dir,"state.sqlite");
  if(existsSync(db)){
    if(existsSync(`${db}-wal`)&&lstatSync(`${db}-wal`).size>0)reasons.push("state.sqlite has uncheckpointed WAL data");
    else try{
      const handle=immutable(db);
      try{for(const {name} of handle.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[])if((handle.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as {n:number}).n)reasons.push(`state.sqlite table ${name} is not empty`);}finally{handle.close();}
    }catch{reasons.push("state.sqlite is unreadable");}
  }
  return {state:reasons.length?"non-empty":"empty",reasons};
}

type Marker={stageId:string;state:"captured"|"rejected"|"blocked"|"staged"|"refused"|"published";destination:string;source:string;reportSha256?:string;reason?:string;authorization?:{reportSha256:string;acceptAlias:string[];acceptMissingHistory:string[];authorizedAt:string};files?:Record<string,string>};
const markerPath=(dir:string)=>join(dir,"STAGE.json");
const readMarker=(dir:string)=>JSON.parse(readFileSync(markerPath(dir),"utf8")) as Marker;
const setMarker=(dir:string,patch:Partial<Marker>)=>{const next={...readMarker(dir),...patch};writeAtomic(markerPath(dir),JSON.stringify(next,null,2));return next;};

export type CaptureOptions={source:string;dest:string;stageRoot:string;afterCopy?:()=>void|Promise<void>};
type Blocker={kind:string;session?:string;detail:string;acceptable?:"alias"|"missing"};
export async function capture(o:CaptureOptions){
  const given=resolve(o.source),info=lstatSync(given);
  if(info.isSymbolicLink()||!info.isDirectory())throw new Error("Source must be one real directory, not a symlink");
  if(info.uid!==process.getuid!())throw new Error("Source is owned by a different user");
  const source=await realpath(given),dest=await resolved(o.dest),stageRoot=await resolved(o.stageRoot);
  if(inside(source,dest)||inside(dest,source))throw new Error("Source and destination must not contain each other");
  if(inside(source,stageRoot)||inside(dest,stageRoot))throw new Error("Stage root must be outside source and destination");
  if(DataLease.probe(source)==="held")throw new Error("Source is held by a running Sigma process. Stop the old Sigma yourself; migration never kills processes.");
  const destination=inspectDestination(dest),stageId=randomUUID(),dir=join(stageRoot,stageId);
  mkdirSync(stageRoot,{recursive:true,mode:0o700});mkdirSync(dir,{mode:0o700});mkdirSync(join(dir,"orig"),{mode:0o700});mkdirSync(join(dir,"data","sessions"),{recursive:true,mode:0o700});
  writeAtomic(markerPath(dir),JSON.stringify({stageId,state:"captured",destination:dest,source}));
  const blockers:Blocker[]=[],warnings:string[]=[],before=snapshot(source);
  for(const problem of before.problems)blockers.push({kind:"unsafe-source",detail:problem});
  if(!before.entries.some(entry=>entry.name==="state.sqlite")&&!before.problems.length)blockers.push({kind:"unsafe-source",detail:"state.sqlite is missing"});
  if(before.walSize>0)blockers.push({kind:"wal",detail:`state.sqlite-wal has ${before.walSize} bytes; capture would need to modify the source WAL`});
  if(destination.state==="held")blockers.push({kind:"destination",detail:destination.reasons[0]});
  else if(destination.state==="non-empty")for(const reason of destination.reasons)blockers.push({kind:"destination",detail:`Destination is not empty: ${reason}`});
  const report:any={tool:MIGRATION_TOOL,source,destination:{path:dest,...destination},files:before.entries.map(({name,size,sha256})=>({name,size,sha256})),excluded:before.excluded,blockers,warnings};
  const finish=(state:Marker["state"])=>{
    blockers.sort((a,b)=>stable(a)<stable(b)?-1:1);warnings.sort();
    const reportSha256=sha(stable(report));writeAtomic(join(dir,"preview.json"),JSON.stringify(report,null,2));writeAtomic(join(dir,"preview.md"),renderReport(report,reportSha256));
    setMarker(dir,{state,reportSha256});return {dir,stageId,state,report,reportSha256};
  };
  if(blockers.some(b=>b.kind==="wal"||b.kind==="unsafe-source"))return finish("blocked");
  for(const entry of before.entries){const copy=readEntry(source,entry.name);if(copy.entry.sha256!==entry.sha256)blockers.push({kind:"source-changed",detail:`${entry.name} changed during capture`});writeFileSync(join(dir,entry.name==="state.sqlite"?"orig/state.sqlite":`data/${entry.name}`),copy.bytes,{flag:"wx",mode:0o600});}
  await o.afterCopy?.();
  const after=snapshot(source);
  if(stable(after.entries)!==stable(before.entries)||stable(after.sessions)!==stable(before.sessions)||after.walSize!==before.walSize)blockers.push({kind:"source-changed",detail:"Source inventory changed during capture"});
  if(DataLease.probe(source)==="held")blockers.push({kind:"source-changed",detail:"Source became held during capture"});
  if(blockers.some(b=>b.kind==="source-changed"))return finish("rejected");
  analyse(dir,source,given,dest,report);
  return finish("captured");
}

const MOVE_KEYS=new Set(["managerDir"]);
function analyse(dir:string,source:string,given:string,dest:string,report:any){
  const {blockers,warnings}=report as {blockers:Blocker[];warnings:string[]},orig=join(dir,"orig/state.sqlite"),data=join(dir,"data/state.sqlite");
  const check=immutable(orig);
  try{
    const integrity=(check.prepare("PRAGMA integrity_check").all() as any[]).map(row=>row.integrity_check);
    report.integrity=integrity;if(integrity.length!==1||integrity[0]!=="ok"){blockers.push({kind:"integrity",detail:"Captured database failed integrity_check"});return;}
    const tables=(check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(row=>row.name);
    report.counts=Object.fromEntries(tables.map(name=>[name,(check.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as {n:number}).n]));
    const columns=(table:string)=>new Set((check.prepare(`PRAGMA table_info("${table}")`).all() as any[]).map(col=>col.name as string));
    if(!tables.includes("sessions")||!columns("sessions").has("file")){blockers.push({kind:"unsupported-schema",detail:"Source has no Sigma sessions table"});return;}
    if(!Object.values(report.counts as Record<string,number>).some(n=>n>0)){blockers.push({kind:"nothing-to-import",detail:"Source database has no rows"});return;}
    const sc=columns("sessions"),srcSessions=join(source,"sessions"),givenSessions=join(given,"sessions"),destSessions=join(dest,"sessions");
    const names=new Set(report.files.map((f:Entry)=>f.name).filter((n:string)=>n.startsWith("sessions/")).map((n:string)=>n.slice(9)));
    const rows=check.prepare(`SELECT id,cwd,file,${sc.has("manager_id")?"manager_id":"NULL"} AS managerId,${sc.has("policy")?"policy":"NULL"} AS policy FROM sessions ORDER BY id`).all() as any[];
    const referenced=new Set<string>(),moved=new Map<string,string>(),oldDirs=new Set([srcSessions,givenSessions]);
    report.sessions=rows.map(row=>{
      const base=basename(row.file),from=dirname(row.file);let target:string|undefined,kind:string;
      if(names.has(base))target=base;
      else if(row.managerId){const found=[...names].filter(n=>(n as string).endsWith(`_${row.managerId}.jsonl`)) as string[];if(found.length>1){kind="ambiguous";blockers.push({kind:"ambiguous-history",session:row.id,detail:`${found.length} histories match manager ${row.managerId}`});return {id:row.id,managerId:row.managerId,file:row.file,class:kind,cwdExists:existsSync(row.cwd)};}target=found[0];}
      if(!target){kind=from===srcSessions||from===givenSessions?"missing":"foreign";blockers.push({kind:"missing-history",session:row.id,detail:`History ${row.file} is not in the source`,acceptable:"missing"});}
      else{
        referenced.add(target);
        try{
          const header=JSON.parse(readFileSync(join(dir,"data/sessions",target),"utf8").split("\n",1)[0]);
          if(header?.type!=="session"||typeof header.id!=="string"||typeof header.cwd!=="string")throw new Error("not a Pi session header");
          if(row.managerId&&header.id!==row.managerId)throw new Error("header ID differs from manager ID");
          if(header.cwd!==row.cwd)warnings.push(`Session ${row.id}: history cwd differs from the session cwd`);
        }catch(error){blockers.push({kind:"invalid-history",session:row.id,detail:`${target}: ${(error as Error).message}`});}
        if(from===srcSessions||from===givenSessions)kind="moved";
        else{kind="alias";oldDirs.add(from);blockers.push({kind:"alias",session:row.id,detail:`History ${row.file} is outside the source; ${target} matched by name`,acceptable:"alias"});}
        moved.set(row.id,join(destSessions,target));
      }
      return {id:row.id,managerId:row.managerId,file:row.file,class:kind!,target:target??null,cwdExists:existsSync(row.cwd)};
    });
    report.orphanHistory=[...names].filter(n=>!referenced.has(n as string)).sort();
    if(report.orphanHistory.length)warnings.push(`${report.orphanHistory.length} history file(s) are not referenced by any session; copied unchanged`);

    // Rewrite on the staged copy only: sessions.file and managerDir fields (policy, command setup, task data).
    const rewrites:any[]=[],move=(path:string)=>{for(const old of oldDirs)if(path===old||path.startsWith(`${old}/`))return destSessions+path.slice(old.length);return path;};
    const remap=(value:any,table:string,id:string,column:string):any=>Array.isArray(value)?value.map(item=>remap(item,table,id,column)):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).map(([key,item])=>{
      if(MOVE_KEYS.has(key)&&typeof item==="string"){const next=move(item);if(next!==item)rewrites.push({table,id,column,from:item,to:next});return [key,next];}
      return [key,remap(item,table,id,column)];})):value;
    writeFileSync(data,readFileSync(orig),{flag:"wx",mode:0o600});
    const staged=new DatabaseSync(data);
    try{
      staged.exec("BEGIN");
      for(const [id,to] of moved){const row=rows.find(r=>r.id===id);rewrites.push({table:"sessions",id,column:"file",from:row.file,to});staged.prepare("UPDATE sessions SET file=? WHERE id=?").run(to,id);}
      const json=(table:string,column:string,key:string)=>{
        if(!tables.includes(table)||!columns(table).has(column))return;
        for(const row of staged.prepare(`SELECT ${key} AS id,${column} AS value${table==="commands"?",session_id AS owner":table==="sessions"?",id AS owner":""} FROM ${table}`).all() as any[]){
          if(!row.value||(table!=="project_tasks"&&!moved.has(row.owner)))continue;
          let parsed:any;try{parsed=JSON.parse(row.value);}catch{continue;}
          const before=rewrites.length,next=remap(parsed,table,row.id,column);
          if(rewrites.length>before)staged.prepare(`UPDATE ${table} SET ${column}=? WHERE ${key}=?`).run(JSON.stringify(next),row.id);
        }
      };
      json("sessions","policy","id");json("commands","setup","id");json("project_tasks","data","id");
      staged.exec("COMMIT");staged.exec("PRAGMA wal_checkpoint(TRUNCATE)");staged.exec("PRAGMA journal_mode=DELETE");
    }finally{staged.close();}
    report.rewrites=rewrites.sort((a,b)=>stable(a)<stable(b)?-1:1);
    verifyRewrite(orig,data,tables,moved,report,oldDirs);
    // External references stay where they are; list them so the user can judge.
    const missingCwd=rows.filter(row=>!existsSync(row.cwd)).length;if(missingCwd)warnings.push(`${missingCwd} session cwd path(s) do not exist; paths are not migrated`);
    const worktrees=rows.filter(row=>row.policy&&(row.policy.includes(`${source}/workspaces/`)||row.policy.includes(`${source}/tasks/`))).length;
    if(worktrees)warnings.push(`${worktrees} session(s) reference workspaces/tasks inside the source data dir; those directories are not moved`);
    for(const table of ["project_tasks","projects"])if(report.counts[table])warnings.push(`${report.counts[table]} ${table} row(s) keep their saved Git/workspace paths unchanged`);
    report.dataHashes=Object.fromEntries(["state.sqlite",...report.files.map((f:Entry)=>f.name).filter((n:string)=>n.startsWith("sessions/"))].map(name=>[name,sha(readFileSync(join(dir,"data",name)))]));
  }finally{check.close();}
}

// Everything except the rewritten columns must be identical row for row.
function verifyRewrite(orig:string,data:string,tables:string[],moved:Map<string,string>,report:any,oldDirs:Set<string>){
  const a=immutable(orig),b=immutable(data);
  const mask=(value:any):any=>Array.isArray(value)?value.map(mask):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,MOVE_KEYS.has(k)&&typeof v==="string"?"<dir>":mask(v)])):value;
  const norm=(table:string,row:any)=>{
    const copy={...row};
    if(table==="sessions"&&moved.has(copy.id))copy.file="<file>";
    for(const column of ["policy","setup","data"])if(typeof copy[column]==="string"&&(table==="sessions"&&column==="policy"||table==="commands"&&column==="setup"||table==="project_tasks"&&column==="data"))try{copy[column]=mask(JSON.parse(copy[column]));}catch{}
    return copy;
  };
  try{
    for(const table of tables){
      const rowsOf=(db:DatabaseSync)=>{const statement=db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`);statement.setReadBigInts(true);return statement.all();};
      const x=rowsOf(a),y=rowsOf(b);
      if(x.length!==y.length)throw new Error(`Row count changed in ${table}`);
      for(let i=0;i<x.length;i++)if(stable(norm(table,x[i]))!==stable(norm(table,y[i])))throw new Error(`Unexpected change in ${table} row ${i}`);
    }
    for(const rewrite of report.rewrites as any[]){
      const row=b.prepare(`SELECT * FROM "${rewrite.table}" WHERE id=?`).get(rewrite.id) as any;
      for(const old of oldDirs)if(stable(row[rewrite.column]).includes(old))throw new Error(`Residual source path in ${rewrite.table}.${rewrite.column}`);
    }
  }finally{a.close();b.close();}
}

function renderReport(report:any,hash:string){
  const lines=[`# Legacy migration preview`,``,`Report SHA-256: ${hash}`,`Source: ${report.source}`,`Destination: ${report.destination.path} (${report.destination.state})`,``,`Rows: ${Object.entries(report.counts??{}).map(([t,n])=>`${t}=${n}`).join(", ")||"n/a"}`,`History files: ${report.files.filter((f:Entry)=>f.name.startsWith("sessions/")).length}`,`Rewrites: ${report.rewrites?.length??0}`,``,`## Sessions`,...(report.sessions??[]).map((s:any)=>`- ${s.id} ${s.class}${s.target?` -> ${s.target}`:""}`),``,`## Blockers`,...(report.blockers.length?report.blockers.map((b:Blocker)=>`- ${b.kind}${b.session?` [${b.session}]`:""}: ${b.detail}${b.acceptable?` (accept with --accept-${b.acceptable==="alias"?"alias":"missing-history"} ${b.session})`:""}`):["- none"]),``,`## Warnings`,...(report.warnings.length?report.warnings.map((w:string)=>`- ${w}`):["- none"]),``,`## Not copied (names only)`,...report.excluded.map((e:any)=>`- ${e.name} ${e.kind} ${e.size}`),``];
  return lines.join("\n");
}

export async function stage(o:CaptureOptions&{authorize:string;acceptAlias?:string[];acceptMissingHistory?:string[]}){
  const result=await capture(o),refuse=(reason:string)=>{setMarker(result.dir,{state:"refused",reason});throw new Error(reason);};
  if(result.state!=="captured")throw new Error(`Capture ended ${result.state}; see ${join(result.dir,"preview.md")}`);
  if(result.reportSha256!==o.authorize)refuse("Source or destination changed since the reviewed preview; run preview again and review it");
  const alias=new Set(o.acceptAlias??[]),missing=new Set(o.acceptMissingHistory??[]),blockers=result.report.blockers as Blocker[];
  for(const [set,kind] of [[alias,"alias"],[missing,"missing"]] as const)for(const id of set)if(!blockers.some(b=>b.session===id&&b.acceptable===kind))refuse(`--accept flag names ${id}, which has no ${kind} finding`);
  const open=blockers.filter(b=>!(b.acceptable==="alias"&&alias.has(b.session!))&&!(b.acceptable==="missing"&&missing.has(b.session!)));
  if(open.length)refuse(`Unresolved blockers: ${open.map(b=>`${b.kind}${b.session?` ${b.session}`:""}`).join(", ")}`);
  setMarker(result.dir,{state:"staged",files:result.report.dataHashes,authorization:{reportSha256:result.reportSha256,acceptAlias:[...alias].sort(),acceptMissingHistory:[...missing].sort(),authorizedAt:new Date().toISOString()}});
  return result;
}

export function listStages(stageRoot:string){
  if(!existsSync(stageRoot))return [];
  return readdirSync(stageRoot).sort().flatMap(name=>{try{const m=readMarker(join(stageRoot,name));return [{stageId:m.stageId,state:m.state,source:m.source,destination:m.destination,reportSha256:m.reportSha256,reason:m.reason}];}catch{return [];}});
}
export const journalState=(dest:string)=>existsSync(join(dest,JOURNAL))?"unfinished":existsSync(join(dest,JOURNAL_DONE))?"done":"none";

type Phase="begin"|"files-copied"|"db-installed";
export async function publishLegacyStage(stageRoot:string,stageId:string,lease:DataLease,afterPhase?:(phase:Phase)=>void){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(stageId))throw new Error("Invalid migration stage ID");
  const dir=join(stageRoot,stageId),dest=lease.directory;
  if(!existsSync(markerPath(dir)))throw new Error("Migration stage was not found");
  const marker=readMarker(dir);
  if(marker.state!=="staged"||!marker.authorization||!marker.files)throw new Error(`Migration stage is ${marker.state}, not an authorized staged import`);
  if(marker.destination!==dest)throw new Error("Migration stage was authorized for a different destination");
  const state=inspectDestination(dest,true);if(state.state==="non-empty")throw new Error(`Destination is not empty (${state.reasons.join("; ")}); migration never merges`);
  const names=Object.keys(marker.files);
  const actual=readdirSync(join(dir,"data")).filter(n=>n!=="sessions").concat(readdirSync(join(dir,"data","sessions")).map(n=>`sessions/${n}`)).sort();
  if(stable(actual)!==stable([...names].sort()))throw new Error("Staged files differ from the authorized manifest");
  for(const name of names)if(readEntry(join(dir,"data"),name).entry.sha256!==marker.files[name])throw new Error(`Staged file ${name} changed since authorization`);
  if(existsSync(join(dest,"state.sqlite.pre-migration")))throw new Error("state.sqlite.pre-migration already exists; inspect it first");
  const journal={tool:MIGRATION_TOOL,stageId,destination:dest,phases:[] as Phase[]};
  const record=(phase:Phase)=>{journal.phases.push(phase);writeAtomic(join(dest,JOURNAL),JSON.stringify(journal,null,2));afterPhase?.(phase);};
  record("begin");
  const put=(from:string,to:string)=>{
    if(existsSync(to))throw new Error(`${basename(to)} already exists; refusing to overwrite`);
    const bytes=readFileSync(from),fd=openSync(`${to}.partial`,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
    try{writeSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
    linkSync(`${to}.partial`,to);unlinkSync(`${to}.partial`);
  };
  mkdirSync(join(dest,"sessions"),{recursive:true,mode:0o700});
  for(const name of names.filter(n=>n.startsWith("sessions/")))put(join(dir,"data",name),join(dest,name));
  syncDir(join(dest,"sessions"));record("files-copied");
  for(const suffix of ["","-wal","-shm"])if(existsSync(join(dest,`state.sqlite${suffix}`)))renameSync(join(dest,`state.sqlite${suffix}`),join(dest,`state.sqlite.pre-migration${suffix}`));
  put(join(dir,"data/state.sqlite"),join(dest,"state.sqlite"));syncDir(dest);record("db-installed");
  renameSync(join(dest,JOURNAL),join(dest,JOURNAL_DONE));syncDir(dest);setMarker(dir,{state:"published"});
}

// Called with the destination lease held and before Storage opens.
export async function startupMigration(lease:DataLease,stageId:string|undefined,stageRoot:string){
  if(existsSync(join(lease.directory,JOURNAL)))throw new Error(`Unfinished legacy migration journal in ${lease.directory}. Sigma will not replay or roll back; inspect the journal and the stage, then resolve it yourself.`);
  if(!stageId)return;
  await publishLegacyStage(stageRoot,stageId,lease);
  console.log(`Legacy migration ${stageId} published. Remove SIGMA_MIGRATE_PUBLISH before the next start.`);
}
