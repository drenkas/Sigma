import { randomUUID, createHash } from "node:crypto";
import { constants, closeSync, fchmodSync, fsyncSync, linkSync, lstatSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ChangesView, SourceApplyFile, SourceApplyView } from "../../packages/contracts/index.js";
import { git, inspectCodePath, readCodeInput } from "./editing.js";
import { PiHost } from "./pi-host.js";
import { Storage } from "./storage.js";
import { Verification } from "./verification.js";

type Row=Omit<SourceApplyView,"current">;
type Active={cancelled:boolean;done:Promise<void>};
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
class Conflict extends Error{}

export class SourceApply {
  private active=new Map<string,Active>();
  private admissions=new Set<Promise<void>>();
  private closing=false;
  private closeWork?:Promise<void>;
  constructor(private storage:Storage,private host:PiHost,private verification:Verification,private dataDir:string,private send:(sessionId:string,type:string,payload:unknown,durable?:boolean)=>Promise<void>){}

  private admit<T>(work:()=>Promise<T>):Promise<T>{
    if(this.closing)return Promise.reject(new Conflict("Service is shutting down"));
    let finish!:()=>void;const ticket=new Promise<void>(resolve=>{finish=resolve;});this.admissions.add(ticket);
    return Promise.resolve().then(work).finally(()=>{this.admissions.delete(ticket);finish();});
  }
  beginClose(){if(this.closing)return;this.closing=true;for(const item of this.active.values())item.cancelled=true;}

  private async code(sessionId:string):Promise<ChangesView&{verified:{check:boolean;review:boolean}}>{
    const session=await this.host.repositoryCode(sessionId);
    if(session.policy!.workspace!.kind==="direct")throw new Conflict("Source Apply is unavailable for a direct workspace");
    const changes=await this.host.changes(sessionId);
    const proof=await this.verification.evidence(sessionId);
    if(changes.omitted||proof.revision!==changes.revision)throw new Conflict("Code changes or evidence are unavailable");
    // Verification is advisory: the user's approval of the exact diff is the gate; the view reports what was verified so the UI can warn.
    const passed=proof.checks.filter(c=>c.current&&c.status==="passed");
    return {...changes,verified:{check:passed.length>0,review:passed.some(c=>proof.reviews.some(r=>r.current&&r.status==="completed"&&r.checkId===c.id))}};
  }
  private async header(source:string){
    if(realpathSync(source)!==source||(await git(source,["rev-parse","--show-toplevel"])).trim()!==source)throw new Conflict("Source repository moved");
    const gitDir=realpathSync(resolve(source,(await git(source,["rev-parse","--git-dir"])).trim()));
    const commonDir=realpathSync(resolve(source,(await git(source,["rev-parse","--git-common-dir"])).trim()));
    const head=(await git(source,["rev-parse","--verify","HEAD^{commit}"])).trim();
    let branch:string|null=null;
    try{branch=(await git(source,["symbolic-ref","-q","HEAD"])).trim();}catch{}
    const gitStat=statSync(gitDir),commonStat=statSync(commonDir);
    return {gitDir,commonDir,identity:`${gitStat.dev}:${gitStat.ino}:${commonStat.dev}:${commonStat.ino}`,head,branch};
  }
  private async baseFile(cwd:string,commit:string,path:string){
    const tree=await git(cwd,["ls-tree","-z",commit,"--",`:(literal)${path}`]);
    if(!tree)return null;
    const match=/^(100644|100755) blob ([0-9a-f]{40,64})\t/.exec(tree);
    if(!match)throw new Conflict(`Unsupported Git file: ${path}`);
    const bytes=await git(cwd,["cat-file","blob",match[2]]);
    return {mode:match[1],oid:match[2],hash:createHash("sha256").update(bytes).digest("hex")};
  }
  private async indexEntry(source:string,path:string){
    const entry=await git(source,["--literal-pathspecs","ls-files","--stage","-z","--",path]);
    if(!entry)return null;
    const match=/^(100644|100755) ([0-9a-f]{40,64}) 0\t/.exec(entry);
    if(!match||entry.indexOf("\0")!==entry.length-1)throw new Conflict(`Source index has an unsupported entry: ${path}`);
    return {mode:match[1],oid:match[2]};
  }
  private async indexMatches(source:string,file:SourceApplyFile){
    const entry=await this.indexEntry(source,file.path);
    const mode=file.baseOid===null?null:file.beforeMode!==null&&Boolean(file.beforeMode&0o111)?"100755":"100644";
    return (entry?.oid??null)===(file.baseOid??null)&&(entry?.mode??null)===mode;
  }
  private async clean(source:string,path:string){
    const status=await git(source,["--literal-pathspecs","status","--porcelain=v1","-z","--untracked-files=all","--",path]);
    if(status)throw new Conflict(`Touched source path is dirty or staged: ${path}`);
  }
  private async fileState(row:Row,file:SourceApplyFile){
    await this.clean(row.sourceCwd,file.path);
    if(!await this.indexMatches(row.sourceCwd,file))throw new Conflict(`Source index changed: ${file.path}`);
    const source=inspectCodePath(row.sourceCwd,file.path);
    if(source.hash!==file.beforeHash||source.mode!==file.beforeMode&&file.beforeMode!==null)throw new Conflict(`Source path changed: ${file.path}`);
    if(file.beforeMode===null&&source.bytes!==null)throw new Conflict(`New source path already exists: ${file.path}`);
    if(file.beforeMode!==null&&source.bytes===null)throw new Conflict(`Source file disappeared: ${file.path}`);
    if(file.beforeMode===null){
      const parent=lstatSync(dirname(source.target));
      if(!parent.isDirectory())throw new Conflict(`Source parent is unavailable: ${file.path}`);
    }
    const code=readCodeInput((await this.host.snapshot(row.sessionId)).cwd,file.path);
    if(code.hash!==file.afterHash||code.mode!==file.afterMode)throw new Conflict(`Code file changed: ${file.path}`);
    return {source,code};
  }
  private async matches(row:Row,current?:ChangesView|null){
    try{
      const changes=current===undefined?await this.code(row.sessionId):current;
      if(!changes)return false;
      if(changes.revision!==row.revision||changes.sourceCwd!==row.sourceCwd)return false;
      const identity=await this.header(row.sourceCwd);
      if(identity.gitDir!==row.gitDir||identity.commonDir!==row.gitCommonDir||identity.identity!==row.gitIdentity||identity.head!==row.head||identity.branch!==row.branch)return false;
      if(row.status==="applied")return row.files.every(file=>{
        try{const source=inspectCodePath(row.sourceCwd,file.path);return source.hash===file.afterHash&&source.mode===file.afterMode;}catch{return false;}
      });
      if(row.status==="reconciled")return row.files.every(file=>{
        try{const source=inspectCodePath(row.sourceCwd,file.path);return !!file.observation&&source.hash===file.observedHash&&(source.bytes===null?file.observedMode===null:source.mode===file.observedMode);}catch{return false;}
      });
      if(["pending","approved","running"].includes(row.status)){
        for(const file of row.files){if(file.status==="waiting")await this.fileState(row,file);else if(file.status==="applied")await this.appliedFileState(row,file);}
        return true;
      }
      return false;
    }catch{return false;}
  }
  private async appliedFileState(row:Row,file:SourceApplyFile){
    const source=inspectCodePath(row.sourceCwd,file.path);
    if(source.hash!==file.afterHash||source.mode!==file.afterMode)throw new Conflict(`Previously applied source path changed: ${file.path}`);
    if(!await this.indexMatches(row.sourceCwd,file))throw new Conflict(`Source index changed: ${file.path}`);
  }
  prepare(sessionId:string,id:string):Promise<SourceApplyView>{return this.host.withPromptAdmission(sessionId,admission=>this.admit(()=>this.prepareAdmitted(sessionId,id,admission)));}
  private async prepareAdmitted(sessionId:string,id:string,admission:{check:()=>void}):Promise<SourceApplyView>{
    const requestHash=hash({sessionId,kind:"source-apply"});
    const prior=await this.storage.call<Row|undefined>("sourceApply",{id});
    if(prior){if(prior.sessionId!==sessionId||prior.requestHash!==requestHash)throw new Conflict("Apply command ID conflict");return {...prior,current:await this.matches(prior)};}
    const changes=await this.code(sessionId);
    if(!changes.files.length||changes.files.length>20)throw new Conflict("Choose a change with 1–20 exportable files");
    const sourceCwd=realpathSync(changes.sourceCwd),identity=await this.header(sourceCwd);
    if(identity.head!==changes.baseCommit)throw new Conflict("Source HEAD changed since Code session creation");
    const acknowledgedAfter=new Map<string,{hash:string;mode:number}>();
    for(const row of await this.storage.call<Row[]>("sourceApplies",{sessionId})){
      if(row.status!=="reconciled"||row.sourceCwd!==sourceCwd||!await this.matches(row,changes))continue;
      for(const file of row.files)if(file.observation==="after"&&file.observedHash===file.afterHash&&file.observedMode===file.afterMode)acknowledgedAfter.set(file.path,{hash:file.afterHash,mode:file.afterMode});
    }
    const files:SourceApplyFile[]=[];
    for(const path of changes.files){
      const after=readCodeInput(changes.cwd,path),base=await this.baseFile(changes.cwd,changes.baseCommit,path);
      const before=inspectCodePath(sourceCwd,path);
      const indexEntry=await this.indexEntry(sourceCwd,path);
      if(indexEntry?.oid!==base?.oid||indexEntry?.mode!==(base?.mode??undefined))throw new Conflict(`Source index changed: ${path}`);
      const acknowledged=acknowledgedAfter.get(path);
      if(before.hash===after.hash&&before.mode===after.mode&&acknowledged?.hash===after.hash&&acknowledged.mode===after.mode){
        files.push({path,beforeHash:before.hash,afterHash:after.hash,beforeMode:before.mode,baseOid:base?.oid??null,afterMode:after.mode,status:"applied"});
        continue;
      }
      await this.clean(sourceCwd,path);
      if(base){
        if(before.bytes===null||before.hash!==base.hash||Boolean(before.mode&0o111)!==(base.mode==="100755")||before.mode!==after.mode)throw new Conflict(`Source mode or content changed: ${path}`);
      }else{
        if(before.bytes!==null||after.mode!==0o644)throw new Conflict(`New source path conflicts or has unsupported mode: ${path}`);
        if(!lstatSync(dirname(before.target)).isDirectory())throw new Conflict(`Source parent is unavailable: ${path}`);
      }
      files.push({path,beforeHash:before.hash,afterHash:after.hash,beforeMode:base?before.mode:null,baseOid:base?.oid??null,afterMode:after.mode,status:"waiting"});
    }
    if((await this.code(sessionId)).revision!==changes.revision)throw new Conflict("Code revision changed while preparing Apply");
    const latest=await this.header(sourceCwd);
    if(latest.gitDir!==identity.gitDir||latest.commonDir!==identity.commonDir||latest.identity!==identity.identity||latest.head!==identity.head||latest.branch!==identity.branch)throw new Conflict("Source Git identity, branch or HEAD changed while preparing Apply");
    const row:Row={id,sessionId,requestHash,revision:changes.revision,status:"pending",sourceCwd,gitDir:identity.gitDir,gitCommonDir:identity.commonDir,gitIdentity:identity.identity,head:identity.head,branch:identity.branch,diff:changes.diff,files,createdAt:Date.now(),startedAt:null,endedAt:null,verified:changes.verified};
    admission.check();
    await this.storage.call("addSourceApply",row);
    try{admission.check();}catch(error){await this.storage.call("sourceApplyTransition",{id,from:row.status,to:"cancelled",patch:{endedAt:Date.now()}});throw error;}
    if(this.closing){const cancelled=await this.storage.call<Row|undefined>("sourceApplyTransition",{id,from:"pending",to:"cancelled",patch:{endedAt:Date.now(),error:"Service shutdown before Apply approval"}});if(cancelled)await this.send(sessionId,"source_apply_changed",{id,status:"cancelled"},true);throw new Conflict("Service is shutting down");}
    await this.send(sessionId,"source_apply_changed",{id,status:"pending"},true);
    return {...row,current:true};
  }
  private async validate(row:Row){
    const changes=await this.code(row.sessionId);
    if(changes.revision!==row.revision||changes.sourceCwd!==row.sourceCwd)throw new Conflict("Code revision changed");
    const identity=await this.header(row.sourceCwd);
    if(identity.gitDir!==row.gitDir||identity.commonDir!==row.gitCommonDir||identity.identity!==row.gitIdentity||identity.head!==row.head||identity.branch!==row.branch)throw new Conflict("Source Git identity, branch or HEAD changed");
    for(const file of row.files){if(file.status==="waiting")await this.fileState(row,file);else if(file.status==="applied")await this.appliedFileState(row,file);}
  }
  decide(sessionId:string,id:string,allow:boolean){return this.host.withPromptAdmission(sessionId,admission=>this.admit(()=>this.decideAdmitted(sessionId,id,allow,admission)));}
  private async decideAdmitted(sessionId:string,id:string,allow:boolean,admission:{check:()=>void}){
    const row=await this.storage.call<Row|undefined>("sourceApply",{id});
    if(!row||row.sessionId!==sessionId||row.status!=="pending")throw new Conflict("Source Apply approval is no longer pending");
    if(!allow){await this.storage.call("sourceApplyTransition",{id,from:"pending",to:"denied",patch:{endedAt:Date.now()}});await this.send(sessionId,"source_apply_changed",{id,status:"denied"},true);return;}
    try{await this.validate(row);}catch(error){await this.storage.call("sourceApplyTransition",{id,from:"pending",to:"expired",patch:{error:String(error),endedAt:Date.now()}});await this.send(sessionId,"source_apply_changed",{id,status:"expired"},true);throw error;}
    if(this.closing){await this.storage.call("sourceApplyTransition",{id,from:"pending",to:"cancelled",patch:{endedAt:Date.now(),error:"Service shutdown before Apply started"}});await this.send(sessionId,"source_apply_changed",{id,status:"cancelled"},true);throw new Conflict("Service is shutting down");}
    admission.check();
    const approved=await this.storage.call<Row|undefined>("sourceApplyTransition",{id,from:"pending",to:"approved"});
    if(!approved)throw new Conflict("Source Apply approval was already decided");
    const active:Active={cancelled:this.closing,done:Promise.resolve()};this.active.set(id,active);
    try{
      admission.check();
      if(active.cancelled)throw new Conflict("Service is shutting down");
      await this.send(sessionId,"source_apply_changed",{id,status:"approved"},true);
      admission.check();if(this.closing||active.cancelled)throw new Conflict("Service is shutting down");
    }catch(error){
      try{
        const cancelled=await this.storage.call<Row|undefined>("sourceApplyTransition",{id,from:"approved",to:"cancelled",patch:{endedAt:Date.now(),error:error instanceof Error?error.message:String(error)}});
        if(cancelled)await this.send(sessionId,"source_apply_changed",{id,status:"cancelled"},true);
      }finally{this.active.delete(id);}
      throw error;
    }
    active.done=this.run(approved,active).catch(async error=>{
      const current=await this.storage.call<Row|undefined>("sourceApply",{id});
      if(current&&["approved","running"].includes(current.status)){
        await this.storage.call("sourceApplyTransition",{id,from:current.status,to:"unknown",patch:{error:error instanceof Error?error.message:String(error),endedAt:Date.now()}});
        await this.send(sessionId,"source_apply_changed",{id,status:"unknown"},true);
      }
    }).finally(()=>{this.active.delete(id);});void active.done.catch(()=>{});
  }
  private recovery(row:Row,index:number,bytes:Buffer|null){
    if(bytes===null)return undefined;
    const path=join(this.dataDir,"source-applies",row.id,`preimage-${index}`);
    const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
    return path;
  }
  private publish(row:Row,file:SourceApplyFile,bytes:Buffer){
    const before=inspectCodePath(row.sourceCwd,file.path);
    if(before.hash!==file.beforeHash||file.beforeMode!==null&&before.mode!==file.beforeMode)throw new Conflict(`Late source edit: ${file.path}`);
    const temp=join(dirname(before.target),`.pi-apply-${row.id}-${randomUUID()}`);
    const fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,file.afterMode);
    try{writeFileSync(fd,bytes);fchmodSync(fd,file.afterMode);fsyncSync(fd);}finally{closeSync(fd);}
    try{
      const now=inspectCodePath(row.sourceCwd,file.path);
      if(now.hash!==file.beforeHash||file.beforeMode!==null&&now.mode!==file.beforeMode)throw new Conflict(`Late source edit: ${file.path}`);
      if(file.beforeMode===null){
        try{linkSync(temp,before.target);}catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")throw new Conflict(`New source path appeared: ${file.path}`);throw error;}
      } // no-clobber publication for additions
      else renameSync(temp,before.target);
    }finally{try{unlinkSync(temp);}catch{}}
    const applied=inspectCodePath(row.sourceCwd,file.path);
    if(applied.hash!==file.afterHash||applied.mode!==file.afterMode)throw new Error(`Source receipt uncertain: ${file.path}`);
  }
  private async run(row:Row,active:Active){
    try{
      if(active.cancelled)return;
      await this.validate(row);
      if(active.cancelled||this.closing){await this.finish(row,"cancelled","Stopped before source writes","approved");return;}
      const running=await this.storage.call<Row|undefined>("sourceApplyTransition",{id:row.id,from:"approved",to:"running",patch:{startedAt:Date.now()}});
      if(!running)return;
      let applied=row.files.filter(file=>file.status==="applied").length;
      await this.send(row.sessionId,"source_apply_changed",{id:row.id,status:"running"},true);
      for(const [index,file] of row.files.entries()){
        if(file.status==="applied")continue;
        if(active.cancelled){await this.finish(row,applied?"partial":"cancelled","Stopped between source files");return;}
        try{
          const current=await this.storage.call<Row>("sourceApply",{id:row.id});
          await this.validate(current);
          const {source}=await this.fileState(current,file);
          const folder=join(this.dataDir,"source-applies",row.id);await mkdir(folder,{recursive:true,mode:0o700});
          const recoveryPath=this.recovery(row,index,source.bytes);
          const intent=await this.storage.call<Row|undefined>("sourceApplyFile",{id:row.id,path:file.path,from:"waiting",to:"applying",patch:{recoveryPath}});
          if(!intent)throw new Error("Source file intent was not recorded");
          if(active.cancelled){await this.storage.call("sourceApplyFile",{id:row.id,path:file.path,from:"applying",to:"conflict",patch:{error:"Stopped before source write"}});await this.finish(row,applied?"partial":"cancelled","Stopped before source write");return;}
          await this.clean(row.sourceCwd,file.path);
          if(!await this.indexMatches(row.sourceCwd,file))throw new Conflict(`Source index changed: ${file.path}`);
          if((await this.code(row.sessionId)).revision!==row.revision)throw new Conflict("Code revision changed");
          const latest=readCodeInput((await this.host.snapshot(row.sessionId)).cwd,file.path);
          if(latest.hash!==file.afterHash||latest.mode!==file.afterMode)throw new Conflict(`Code file changed: ${file.path}`);
          const identity=await this.header(row.sourceCwd);
          if(identity.gitDir!==row.gitDir||identity.commonDir!==row.gitCommonDir||identity.identity!==row.gitIdentity||identity.head!==row.head||identity.branch!==row.branch)throw new Conflict("Source Git identity, branch or HEAD changed");
          if(active.cancelled)throw new Conflict("Stopped before source write");
          this.publish(row,file,latest.bytes);
          await this.storage.call("sourceApplyFile",{id:row.id,path:file.path,from:"applying",to:"applied"});applied++;
          await this.send(row.sessionId,"source_apply_changed",{id:row.id,path:file.path,status:"applied"},true);
        }catch(error){
          const current=await this.storage.call<Row|undefined>("sourceApply",{id:row.id});
          const status=error instanceof Conflict?"conflict":"unknown";
          if(current?.files.find(f=>f.path===file.path)?.status==="applying"||current?.files.find(f=>f.path===file.path)?.status==="waiting")await this.storage.call("sourceApplyFile",{id:row.id,path:file.path,from:current.files.find(f=>f.path===file.path)!.status,to:status,patch:{error:error instanceof Error?error.message:String(error)}});
          await this.finish(row,status==="unknown"?"unknown":applied?"partial":"conflict",error instanceof Error?error.message:String(error));return;
        }
      }
      await this.finish(row,"applied");
    }catch(error){
      const current=await this.storage.call<Row|undefined>("sourceApply",{id:row.id});
      if(current&&["approved","running"].includes(current.status))await this.finish(row,current.status==="approved"?(this.closing||active.cancelled?"cancelled":"expired"):"unknown",error instanceof Error?error.message:String(error),current.status);
    }
  }
  private async finish(row:Row,status:Row["status"],error?:string,from="running"){
    const updated=await this.storage.call("sourceApplyTransition",{id:row.id,from,to:status,patch:{endedAt:Date.now(),...(error?{error}:{})}});
    if(updated)await this.send(row.sessionId,"source_apply_changed",{id:row.id,status},true);
  }
  async evidence(sessionId:string):Promise<SourceApplyView[]>{
    const session=await this.host.repositoryCode(sessionId);
    if(session.policy!.workspace!.kind==="direct")throw new Conflict("Source Apply is unavailable for a direct workspace");
    const rows=await this.storage.call<Row[]>("sourceApplies",{sessionId});
    const current=rows.length?await this.code(sessionId).catch(()=>null):null;
    const visible:SourceApplyView[]=[];
    for(const row of rows)visible.push({...row,...(["unknown","partial"].includes(row.status)?{files:this.observe(row)}:{}),...(current&&current.revision===row.revision?{verified:current.verified}:{}),current:await this.matches(row,current)});
    return visible;
  }
  abort(sessionId:string,id:string,requireActive=true){return this.admit(()=>this.abortAdmitted(sessionId,id,requireActive));}
  private async abortAdmitted(sessionId:string,id:string,requireActive=true){
    const row=await this.storage.call<Row|undefined>("sourceApply",{id});
    if(!row||row.sessionId!==sessionId)throw new Conflict("Source Apply does not belong to this session");
    if(!["pending","approved","running"].includes(row.status)){if(requireActive)throw new Conflict("Source Apply is no longer active");return;}
    const active=this.active.get(id);if(active)active.cancelled=true;
    if(row.status==="pending"||row.status==="approved"){
      const updated=await this.storage.call("sourceApplyTransition",{id,from:row.status,to:"cancelled",patch:{endedAt:Date.now()}});
      if(updated)await this.send(sessionId,"source_apply_changed",{id,status:"cancelled"},true);
    }
    if(active)await active.done;
  }
  async abortSession(sessionId:string){
    const rows=await this.storage.call<Row[]>("activeSourceApplies",{sessionId});
    for(const row of rows)await this.abort(sessionId,row.id,false);
  }
  private observe(row:Row,strict=false):SourceApplyFile[]{
    return row.files.map(file=>{
      try{
        const current=inspectCodePath(row.sourceCwd,file.path);
        const after=current.hash===file.afterHash&&current.mode===file.afterMode;
        const before=current.hash===file.beforeHash&&(file.beforeMode===null?current.bytes===null:current.mode===file.beforeMode);
        return {...file,observedHash:current.hash,observedMode:current.bytes===null?null:current.mode,observation:after?"after":before?"before":"diverged"};
      }catch(error){if(strict)throw error;return {...file,observedHash:"unavailable",observedMode:null,observation:"diverged",error:String(error)};}
    });
  }
  reconcile(sessionId:string,id:string,ack:SourceApplyAcknowledgement){return this.host.withPromptAdmission(sessionId,admission=>this.admit(()=>this.reconcileAdmitted(sessionId,id,ack,admission)));}
  private async reconcileAdmitted(sessionId:string,id:string,ack:SourceApplyAcknowledgement,admission:{check:()=>void}){
    const row=await this.storage.call<Row|undefined>("sourceApply",{id});
    if(!row||row.sessionId!==sessionId||!["unknown","partial"].includes(row.status))throw new Conflict("No unresolved Source Apply belongs to this session");
    if(!row.gitDir||!row.gitCommonDir||!row.gitIdentity)throw new Conflict("Registered Source Apply Git identity is unavailable; outcome remains unknown");
    if(this.active.has(id))throw new Conflict("Wait for Source Apply to stop before reconciliation");
    const session=await this.host.repositoryCode(sessionId);if(session.status==="running")throw new Conflict("Wait for Code to stop before reconciliation");
    if(ack?.acknowledge!==true||ack.sourceCwd!==row.sourceCwd||realpathSync(row.sourceCwd)!==row.sourceCwd||(await git(row.sourceCwd,["rev-parse","--show-toplevel"])).trim()!==row.sourceCwd)throw new Conflict("Acknowledge the exact source repository");
    const files=this.observe(row,true),given=Array.isArray(ack.files)?ack.files:[];
    if(given.length!==files.length||new Set(given.map(file=>file.path)).size!==files.length)throw new Conflict("Acknowledge every Source Apply path exactly once");
    for(const current of files){
      const accepted=given.find(file=>file.path===current.path);
      if(!accepted||accepted.observedHash!==current.observedHash||accepted.observedMode!==current.observedMode||accepted.observation!==current.observation)throw new Conflict(`Source Apply observation changed: ${current.path}`);
    }
    const identity=await this.header(row.sourceCwd);
    if(identity.gitDir!==row.gitDir||identity.commonDir!==row.gitCommonDir||identity.identity!==row.gitIdentity||identity.head!==row.head||identity.branch!==row.branch)throw new Conflict("Registered source Git identity, branch or HEAD changed");
    if(this.closing)throw new Conflict("Service is shutting down");
    admission.check();
    const updated=await this.storage.call<Row|undefined>("sourceApplyTransition",{id,from:row.status,to:"reconciled",patch:{files,endedAt:Date.now()}});
    if(!updated)throw new Conflict("Source Apply state changed during reconciliation");
    await this.send(sessionId,"source_apply_changed",{id,status:"reconciled"},true);
    return {...updated,current:await this.matches(updated)};
  }
  close(){
    this.beginClose();
    return this.closeWork??=(async()=>{
      while(this.admissions.size)await Promise.allSettled([...this.admissions]);
      await Promise.allSettled([...this.active.values()].map(run=>run.done));
    })();
  }
}

export interface SourceApplyAcknowledgement {acknowledge:true;sourceCwd:string;files:Array<{path:string;observedHash:string;observedMode:number|null;observation:"before"|"after"|"diverged"}>;}
