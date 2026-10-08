import { createHash } from "node:crypto";
import { constants, closeSync, fchmodSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChangesView, WorkerMergeFile, WorkerMergeView } from "../../packages/contracts/index.js";
import { assertNotIgnored, assertWorkspaceHead, codeBaseFile, codePatch, git, inspectCodePath, workspaceChanges } from "./editing.js";
import { PiHost } from "./pi-host.js";
import { Storage } from "./storage.js";

type File=WorkerMergeFile&{beforeMode:number|null;afterMode:number|null};
type Row=Omit<WorkerMergeView,"current"|"files">&{requestHash:string;rootCwd:string;workerCwd:string;baseCommit:string;files:File[]};
const digest=(bytes:Buffer|null)=>bytes===null?"missing":createHash("sha256").update(bytes).digest("hex");
class Conflict extends Error{}

export class WorkerMerge {
  private active=new Set<{cancelled:boolean;done:Promise<WorkerMergeView>}>();
  private admissions=new Set<Promise<void>>();
  private closing=false;
  private closeWork?:Promise<void>;
  constructor(private storage:Storage,private host:PiHost,private dataDir:string,private send:(sessionId:string,type:string,payload:unknown,durable?:boolean)=>Promise<void>){}

  private admit<T>(work:()=>Promise<T>):Promise<T>{
    if(this.closing)return Promise.reject(new Conflict("Service is shutting down"));
    let finish!:()=>void;const ticket=new Promise<void>(resolve=>{finish=resolve;});this.admissions.add(ticket);
    return Promise.resolve().then(work).finally(()=>{this.admissions.delete(ticket);finish();});
  }
  beginClose(){if(this.closing)return;this.closing=true;for(const run of this.active)run.cancelled=true;}

  private async pair(rootId:string,workerId:string,auto=false){
    const root=await this.host.repositoryCode(rootId);
    if(root.policy?.workspace?.kind==="direct")await this.host.assertDirectReady(root);
    const worker=await this.storage.call<Awaited<ReturnType<PiHost["repositoryCode"]>>|undefined>("session",{id:workerId});
    if(root.policy?.requested.mode!=="parallel"||!worker||worker.parentId!==rootId||worker.role!=="worker"||!worker.policy?.workspace||worker.policy.workspace.sourceCwd!==root.policy.workspace!.sourceCwd||worker.policy.workspace.baseCommit!==root.policy.workspace!.baseCommit)throw new Conflict("Select a worker from this parallel Code session");
    if(!(root.status==="settled"||auto&&root.status==="running")||worker.status!=="settled")throw new Conflict("Root and worker must be settled before merge preview");
    return {root,worker};
  }
  private async mergedText(root:Buffer,base:Buffer,worker:Buffer){
    const folder=join(this.dataDir,"worker-merge-temp");mkdirSync(folder,{recursive:true,mode:0o700});
    const temp=mkdtempSync(join(folder,"merge-"));
    try{
      const ours=join(temp,"ours"),ancestor=join(temp,"base"),theirs=join(temp,"worker");
      writeFileSync(ours,root,{mode:0o600});writeFileSync(ancestor,base,{mode:0o600});writeFileSync(theirs,worker,{mode:0o600});
      try{return {bytes:Buffer.from(await git(temp,["merge-file","-p","--diff3","-L","root","-L","base","-L","worker",ours,ancestor,theirs])),conflict:false};}
      catch(error){if((error as {code?:number}).code===1)return {bytes:Buffer.from((error as {stdout:string}).stdout),conflict:true};throw error;}
    }finally{rmSync(temp,{recursive:true,force:true});}
  }
  private async plan(rootId:string,workerId:string,auto=false){
    const {root,worker}=await this.pair(rootId,workerId,auto);
    const [rootChanges,workerChanges]=await Promise.all([this.host.changes(rootId),this.host.changes(workerId)]);
    if(rootChanges.omitted||workerChanges.omitted)throw new Conflict("An unsupported or sensitive file is changed; inspect both copies before merging");
    if(!workerChanges.files.length||workerChanges.files.length>20)throw new Conflict("Worker needs 1–20 exportable changed files");
    const files:File[]=[];let diff="";
    for(const path of workerChanges.files){
      if(root.policy!.workspace!.kind==="direct")await assertNotIgnored(root.cwd,path);
      const base=await codeBaseFile(root.cwd,root.policy!.workspace!.baseCommit,path);
      const ours=inspectCodePath(root.cwd,path),theirs=inspectCodePath(worker.cwd,path);
      if(theirs.bytes===null)throw new Conflict(`Worker deletion is not supported: ${path}`);
      if(base.mode!==null&&ours.bytes!==null&&ours.mode!==base.mode||base.mode!==null&&theirs.bytes!==null&&theirs.mode!==base.mode||base.mode===null&&theirs.bytes!==null&&theirs.mode!==0o644)throw new Conflict(`Unsupported mode change: ${path}`);
      let next:Buffer|null=theirs.bytes,conflict=false;
      if(digest(ours.bytes)===digest(theirs.bytes))continue;
      if(digest(ours.bytes)!==digest(base.bytes)){
        if(base.bytes===null||ours.bytes===null||theirs.bytes===null)conflict=true;
        else{const result=await this.mergedText(ours.bytes,base.bytes,theirs.bytes);next=result.bytes;conflict=result.conflict;}
      }
      if(!conflict&&digest(next)===digest(ours.bytes))continue;
      const preview=codePatch(path,ours.bytes,next);
      if(Buffer.byteLength(preview)>256*1024)throw new Conflict(`Merge preview is too large: ${path}`);
      if(!conflict)diff+=preview;
      files.push({path,status:conflict?"conflict":"ready",preview,beforeHash:ours.hash,afterHash:conflict?null:digest(next),beforeMode:ours.bytes===null?null:ours.mode,afterMode:conflict||next===null?null:theirs.mode});
    }
    if(!files.length)throw new Conflict("Worker changes are already present in the root copy");
    if(Buffer.byteLength(diff)>1024*1024)throw new Conflict("Merge diff exceeds 1 MiB");
    const [rootNow,workerNow]=await Promise.all([this.host.changes(rootId),this.host.changes(workerId)]);
    if(rootChanges.revision!==rootNow.revision||workerChanges.revision!==workerNow.revision)throw new Conflict("A Code copy changed during merge preview; try again");
    return {root,worker,rootChanges,workerChanges,files,diff,status:files.some(f=>f.status==="conflict")?"conflict" as const:"pending" as const};
  }
  private async current(row:Row){
    if(row.status!=="pending")return false;
    try{
      const plan=await this.plan(row.rootId,row.workerId,!!row.auto);
      return plan.status==="pending"&&plan.rootChanges.revision===row.rootRevision&&plan.workerChanges.revision===row.workerRevision&&plan.diff===row.diff&&plan.files.every((file,index)=>file.path===row.files[index]?.path&&file.afterHash===row.files[index]?.afterHash);
    }catch{return false;}
  }
  private observe(row:Row,strict=false):File[]{
    return row.files.map(file=>{
      try{
        const current=inspectCodePath(row.rootCwd,file.path);
        const after=current.hash===file.afterHash&&(file.afterHash==="missing"||current.mode===file.afterMode);
        const before=current.hash===file.beforeHash&&(file.beforeHash==="missing"||current.mode===file.beforeMode);
        return {...file,observedHash:current.hash,observation:after?"after":before?"before":"diverged"};
      }catch(error){if(strict)throw error;return {...file,observedHash:"unavailable",observation:"diverged",error:String(error)};}
    });
  }
  private async view(row:Row):Promise<WorkerMergeView>{return {...row,files:["unknown","partial"].includes(row.status)?this.observe(row):row.files,current:await this.current(row)};}
  async list(rootId:string){
    const root=await this.host.repositoryCode(rootId);
    if(root.policy!.requested.mode!=="parallel")throw new Conflict("Worker merges require a parallel Code session");
    const rows=await this.storage.call<Row[]>("workerMerges",{rootId});
    return Promise.all(rows.map(row=>this.view(row)));
  }
  prepare(rootId:string,workerId:string,id:string,auto=false):Promise<WorkerMergeView>{return this.host.withPromptAdmission(rootId,admission=>this.admit(()=>this.prepareAdmitted(rootId,workerId,id,admission,auto)));}
  private async prepareAdmitted(rootId:string,workerId:string,id:string,admission:{check:()=>void},auto=false):Promise<WorkerMergeView>{
    const requestHash=createHash("sha256").update(`${rootId}\0${workerId}`).digest("hex");
    const prior=await this.storage.call<Row|undefined>("workerMerge",{id});
    if(prior){if(prior.rootId!==rootId||prior.workerId!==workerId||prior.requestHash!==requestHash)throw new Conflict("Merge command ID conflict");return this.view(prior);}
    const plan=await this.plan(rootId,workerId,auto);
    const row:Row={...(auto?{auto:true}:{}),id,rootId,workerId,requestHash,rootCwd:plan.root.cwd,workerCwd:plan.worker.cwd,baseCommit:plan.root.policy!.workspace!.baseCommit,rootRevision:plan.rootChanges.revision,workerRevision:plan.workerChanges.revision,status:plan.status,files:plan.files,diff:plan.diff,createdAt:Date.now(),endedAt:plan.status==="conflict"?Date.now():null};
    admission.check();
    await this.storage.call("addWorkerMerge",row);
    try{admission.check();}catch(error){await this.storage.call("workerMergeTransition",{id,from:row.status,to:"cancelled",patch:{endedAt:Date.now()}});throw error;}
    if(this.closing&&row.status==="pending"){
      const cancelled=await this.storage.call<Row|undefined>("workerMergeTransition",{id,from:"pending",to:"cancelled",patch:{endedAt:Date.now(),error:"Service shutdown before merge approval"}});
      if(cancelled)await this.send(rootId,"worker_merge_changed",{id,status:"cancelled"},true);
      throw new Conflict("Service is shutting down");
    }
    await this.send(rootId,"worker_merge_changed",{id,status:row.status},true);
    return this.view(row);
  }
  private async validate(row:Row){
    const plan=await this.plan(row.rootId,row.workerId,!!row.auto);
    if(plan.status!=="pending"||plan.root.cwd!==row.rootCwd||plan.worker.cwd!==row.workerCwd||plan.rootChanges.revision!==row.rootRevision||plan.workerChanges.revision!==row.workerRevision||plan.diff!==row.diff||plan.files.length!==row.files.length||plan.files.some((file,index)=>file.path!==row.files[index].path||file.beforeHash!==row.files[index].beforeHash||file.afterHash!==row.files[index].afterHash))throw new Conflict("Merge preview changed; prepare a new one");
    return plan;
  }
  private publish(row:Row,file:File,bytes:Buffer|null){
    const before=inspectCodePath(row.rootCwd,file.path);
    if(before.hash!==file.beforeHash||before.bytes!==null&&before.mode!==file.beforeMode||digest(bytes)!==file.afterHash)throw new Conflict(`Root file changed: ${file.path}`);
    if(bytes===null)throw new Conflict(`Worker deletion is not supported: ${file.path}`);
    else{
      mkdirSync(dirname(before.target),{recursive:true,mode:0o700});
      const now=inspectCodePath(row.rootCwd,file.path);
      if(now.hash!==file.beforeHash||now.bytes!==null&&now.mode!==file.beforeMode)throw new Conflict(`Root file changed: ${file.path}`);
      const temp=join(dirname(before.target),`.pi-edit-${row.id}`);
      let fd:number;
      try{fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,file.afterMode!);}
      catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")throw new Conflict(`A leftover merge temp file from an earlier crash blocks this merge: ${temp}. Inspect it and remove it yourself, then retry`);throw error;}
      try{writeFileSync(fd,bytes);fchmodSync(fd,file.afterMode!);fsyncSync(fd);}finally{closeSync(fd);}
      try{if(before.bytes===null)linkSync(temp,before.target);else renameSync(temp,before.target);}
      finally{try{unlinkSync(temp);}catch{}}
    }
    const after=inspectCodePath(row.rootCwd,file.path);
    if(after.hash!==file.afterHash||bytes!==null&&after.mode!==file.afterMode)throw new Error(`Merge receipt uncertain: ${file.path}`);
  }
  decide(rootId:string,id:string,allow:boolean):Promise<WorkerMergeView>{return this.host.withPromptAdmission(rootId,admission=>this.admit(()=>this.decideAdmitted(rootId,id,allow,admission)));}
  private async decideAdmitted(rootId:string,id:string,allow:boolean,admission:{check:()=>void}):Promise<WorkerMergeView>{
    let row=await this.storage.call<Row|undefined>("workerMerge",{id});
    if(!row||row.rootId!==rootId||row.status!=="pending")throw new Conflict("Merge decision is no longer pending");
    if(!allow){row=await this.storage.call<Row|undefined>("workerMergeTransition",{id,from:"pending",to:"denied",patch:{endedAt:Date.now()}});if(!row)throw new Conflict("Merge decision was already recorded");await this.send(rootId,"worker_merge_changed",{id,status:"denied"},true);return this.view(row);}
    let plan:Awaited<ReturnType<WorkerMerge["plan"]>>;
    try{plan=await this.validate(row);}catch(error){await this.storage.call("workerMergeTransition",{id,from:"pending",to:"expired",patch:{error:String(error),endedAt:Date.now()}});await this.send(rootId,"worker_merge_changed",{id,status:"expired"},true);throw error;}
    if(this.closing){row=await this.storage.call<Row|undefined>("workerMergeTransition",{id,from:"pending",to:"cancelled",patch:{endedAt:Date.now(),error:"Service shutdown before merge started"}});if(row)await this.send(rootId,"worker_merge_changed",{id,status:"cancelled"},true);throw new Conflict("Service is shutting down");}
    admission.check();
    row=await this.storage.call<Row|undefined>("workerMergeTransition",{id,from:"pending",to:"running"});
    if(!row)throw new Conflict("Merge decision was already recorded");
    try{admission.check();}catch(error){await this.storage.call("workerMergeTransition",{id,from:"running",to:"cancelled",patch:{endedAt:Date.now()}});throw error;}
    if(this.closing){const cancelled=await this.storage.call<Row|undefined>("workerMergeTransition",{id,from:"running",to:"cancelled",patch:{endedAt:Date.now(),error:"Service shutdown before merge started"}});if(cancelled)await this.send(rootId,"worker_merge_changed",{id,status:"cancelled"},true);throw new Conflict("Service is shutting down");}
    await this.send(rootId,"worker_merge_changed",{id,status:"running"},true);
    try{admission.check();}catch(error){await this.storage.call("workerMergeTransition",{id,from:"running",to:"cancelled",patch:{endedAt:Date.now()}});throw error;}
    const active:{cancelled:boolean;done:Promise<WorkerMergeView>}={cancelled:this.closing,done:Promise.resolve(undefined as never)};
    if(active.cancelled){const cancelled=await this.storage.call<Row|undefined>("workerMergeTransition",{id,from:"running",to:"cancelled",patch:{endedAt:Date.now(),error:"Service shutdown before merge started"}});if(cancelled)await this.send(rootId,"worker_merge_changed",{id,status:"cancelled"},true);throw new Conflict("Service is shutting down");}
    const task=this.run(row,plan,active);active.done=task;this.active.add(active);
    try{return await task;}finally{this.active.delete(active);}
  }
  private autoChains=new Map<string,Promise<unknown>>();
  /** Integrates a finished parallel worker into the root working copy without user interaction (Full access only; the caller checks the mode). Never throws: any failure leaves the work untouched and reports why. */
  auto(rootId:string,workerId:string):Promise<{status:"applied"|"empty"|"pending";reason?:string}>{
    const prior=this.autoChains.get(rootId)??Promise.resolve();
    const task=prior.catch(()=>{}).then(()=>this.autoAdmitted(rootId,workerId));
    const tail=task.finally(()=>{if(this.autoChains.get(rootId)===tail)this.autoChains.delete(rootId);});
    this.autoChains.set(rootId,tail);
    return task;
  }
  private async autoAdmitted(rootId:string,workerId:string):Promise<{status:"applied"|"empty"|"pending";reason?:string}>{
    const message=(error:unknown)=>error instanceof Error?error.message:String(error);
    try{
      const changes=await this.host.changes(workerId);
      if(!changes.files.length&&!changes.omitted)return {status:"empty"};
      const id=crypto.randomUUID();
      let view:WorkerMergeView;
      try{view=await this.prepare(rootId,workerId,id,true);}
      catch(error){if(/already present in the root copy/.test(message(error)))return {status:"applied"};throw error;}
      if(view.status==="conflict")return {status:"pending",reason:`merge conflict in ${view.files.filter(file=>file.status==="conflict").map(file=>file.path).join(", ")}`};
      if(view.status!=="pending")return {status:"pending",reason:`the merge is ${view.status}${view.error?`: ${view.error}`:""}`};
      view=await this.decide(rootId,id,true);
      if(view.status==="applied")return {status:"applied"};
      return {status:"pending",reason:`the merge ended as ${view.status}${view.error?`: ${view.error}`:""}`};
    }catch(error){return {status:"pending",reason:message(error)};}
  }
  reconcile(rootId:string,id:string){return this.host.withPromptAdmission(rootId,admission=>this.admit(()=>this.reconcileAdmitted(rootId,id,admission)));}
  private async reconcileAdmitted(rootId:string,id:string,admission:{check:()=>void}){
    const row=await this.storage.call<Row|undefined>("workerMerge",{id});
    if(!row||row.rootId!==rootId||!["unknown","partial"].includes(row.status))throw new Conflict("No unresolved worker merge to inspect");
    const root=await this.storage.call<{status:string}|undefined>("session",{id:rootId});
    const worker=await this.storage.call<{status:string}|undefined>("session",{id:row.workerId});
    if(root?.status==="running"||worker?.status==="running")throw new Conflict("Wait for root and worker to stop before reconciling");
    const files=this.observe(row,true);admission.check();const updated=await this.storage.call<Row|undefined>("workerMergeTransition",{id,from:row.status,to:"reconciled",patch:{files,endedAt:Date.now()}});
    if(!updated)throw new Conflict("Merge state changed during reconciliation");
    await this.send(rootId,"worker_merge_changed",{id,status:"reconciled"},true);
    return this.view(updated);
  }
  private async stopped(row:Row,applied:number){
    const status=applied===row.files.length?"applied":applied?"partial":"cancelled";
    const updated=await this.storage.call<Row|undefined>("workerMergeTransition",{id:row.id,from:"running",to:status,patch:{endedAt:Date.now(),...(status==="cancelled"?{error:"Stopped before any merge file was published"}:{})}});
    if(updated)await this.send(row.rootId,"worker_merge_changed",{id:row.id,status},true);
    return this.view(updated??await this.storage.call<Row>("workerMerge",{id:row.id}));
  }
  private async run(row:Row,plan:Awaited<ReturnType<WorkerMerge["plan"]>>,active:{cancelled:boolean;done:Promise<WorkerMergeView>}):Promise<WorkerMergeView>{
    let applied=row.files.filter(file=>file.status==="applied").length;
    for(const [index,file] of row.files.entries()){
      if(file.status==="applied")continue;
      if(active.cancelled)return this.stopped(row,applied);
      try{
        await assertWorkspaceHead(row.rootCwd,plan.root.policy!.workspace!);
        if(plan.root.policy?.workspace?.kind==="direct")await this.host.assertDirectReady(plan.root);
        const planned=plan.files[index];
        if(plan.root.policy!.workspace!.kind==="direct")await assertNotIgnored(row.rootCwd,file.path);
        const workerFile=inspectCodePath(row.workerCwd,file.path);
        const rootFile=inspectCodePath(row.rootCwd,file.path);
        const base=await codeBaseFile(row.rootCwd,row.baseCommit,file.path);
        let next=workerFile.bytes;
        if(digest(rootFile.bytes)!==digest(base.bytes)&&base.bytes&&rootFile.bytes&&workerFile.bytes)next=(await this.mergedText(rootFile.bytes,base.bytes,workerFile.bytes)).bytes;
        if(file.beforeHash!==rootFile.hash||file.afterHash!==digest(next)||planned.afterHash!==file.afterHash)throw new Conflict(`Merge inputs changed: ${file.path}`);
        const folder=join(this.dataDir,"worker-merges",row.id);mkdirSync(folder,{recursive:true,mode:0o700});
        let recoveryPath:string|undefined;
        if(rootFile.bytes!==null){recoveryPath=join(folder,`preimage-${index}`);const fd=openSync(recoveryPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,rootFile.bytes);fsyncSync(fd);}finally{closeSync(fd);}}
        const intent=await this.storage.call<Row|undefined>("workerMergeFile",{id:row.id,path:file.path,from:"ready",to:"applying",patch:{recoveryPath}});
        if(!intent)throw new Error("Merge file intent was not recorded");
        if(active.cancelled){await this.storage.call("workerMergeFile",{id:row.id,path:file.path,from:"applying",to:"ready"});return this.stopped(row,applied);}
        await assertWorkspaceHead(row.rootCwd,plan.root.policy!.workspace!);
        if(active.cancelled){await this.storage.call("workerMergeFile",{id:row.id,path:file.path,from:"applying",to:"ready"});return this.stopped(row,applied);}
        this.publish(row,file,next);
        await this.storage.call("workerMergeFile",{id:row.id,path:file.path,from:"applying",to:"applied"});applied++;
        await this.send(row.rootId,"worker_merge_changed",{id:row.id,path:file.path,status:"applied"},true);
      }catch(error){
        const current=await this.storage.call<Row|undefined>("workerMerge",{id:row.id});
        const state=current?.files[index]?.status;
        if(state==="ready"||state==="applying")await this.storage.call("workerMergeFile",{id:row.id,path:file.path,from:state,to:state==="applying"?"unknown":"conflict",patch:{error:String(error)}});
        const status=state==="applying"?"unknown":applied?"partial":"expired";
        const updated=await this.storage.call<Row|undefined>("workerMergeTransition",{id:row.id,from:"running",to:status,patch:{error:String(error),endedAt:Date.now()}});
        await this.send(row.rootId,"worker_merge_changed",{id:row.id,status},true);
        return this.view(updated!);
      }
    }
    const updated=await this.storage.call<Row|undefined>("workerMergeTransition",{id:row.id,from:"running",to:"applied",patch:{endedAt:Date.now()}});
    await this.send(row.rootId,"worker_merge_changed",{id:row.id,status:"applied"},true);
    return this.view(updated!);
  }
  close(){
    this.beginClose();
    return this.closeWork??=(async()=>{
      while(this.admissions.size)await Promise.allSettled([...this.admissions]);
      await Promise.allSettled([...this.active].map(run=>run.done));
    })();
  }
}
