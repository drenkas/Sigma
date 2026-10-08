import { Cleanup } from "./cleanup.js";
import Fastify from "fastify";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PiHost } from "./pi-host.js";
import { Verification } from "./verification.js";
import { Qa } from "./qa-runs.js";
import { SourceApply } from "./source-apply.js";
import { WorkerMerge } from "./worker-merge.js";
import { Storage } from "./storage.js";
import type { JournalEvent, RoleReasoning, ProjectTaskView, ProjectView } from "../../packages/contracts/index.js";
import { folderStatus, projectInput, projectStatus } from "./projects.js";
import { snapshotProjectTask } from "./project-task.js";
import { chooseFolders } from "./folder-picker.js";
import { CliproxyProcess } from "./cliproxy-process.js";
import { proxyEnabled, writeProxyEnabled } from "./cliproxy-provision.js";
import { PINNED_BINARY_NAME } from "./cliproxy-config.mjs";
import { DataLease } from "./data-lease.js";
import { createScratchDir } from "./scratch.js";
import { defaultStageRoot, startupMigration } from "./legacy-migration.js";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
// SIGMA_* settings; the pre-rename PI_ORCH_* names still work as fallbacks.
const setting=(name:string)=>process.env[`SIGMA_${name}`]??process.env[`PI_ORCH_${name}`];
const lease=await DataLease.acquire(setting("DATA_DIR")?resolve(setting("DATA_DIR")!):join(root,".data"));
await startupMigration(lease,setting("MIGRATE_PUBLISH"),process.env.SIGMA_MIGRATION_STAGE?resolve(process.env.SIGMA_MIGRATION_STAGE):defaultStageRoot(lease.directory));
const dataDir=lease.directory;
const defaultWorkspace=setting("DEFAULT_WORKSPACE")??process.cwd();
let parentGone=false,serviceListening=false,appClosing=false,shutdown:(()=>Promise<void>)|undefined;
if(setting("PARENT_WATCH")==="1"){
  process.stdin.resume();
  process.stdin.once("end",()=>{
    parentGone=true;
    if(shutdown)void shutdown().then(()=>process.exit(0),()=>process.exit(1));
    else process.exit(1);
  });
}
const storage=new Storage(join(dataDir,"state.sqlite"));
const app=Fastify({logger:false,bodyLimit:100_000});
const port=Number(setting("PORT")||4318);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error("Invalid local port");
const devOrigin=setting("DEV_ORIGIN")==="1";
const acceptedOrigins=new Set([`http://127.0.0.1:${port}`,...(devOrigin?["http://127.0.0.1:4317"]:[])]);
const cookie=randomBytes(32).toString("hex");
const cookieName=`pi_session_${port}`;
const listeners=new Map<string,Set<(event:JournalEvent|{type:string;payload:unknown})=>void>>();
const streamClosers=new Set<()=>void>();
const pickerShutdown=new AbortController();
const isUUID=(value:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
async function emit(sessionId:string,type:string,payload:unknown,durable=false){
  const event=durable?await storage.event(sessionId,type,payload):{type,payload};
  for(const listener of listeners.get(sessionId)||[])listener(event);
}
const host=new PiHost(storage,dataDir,emit);
await host.init();
// Packaged runtime carries an optional pinned proxy binary under resources/; absent in dev, where provisioning reports not_installed.
const localProxy=new CliproxyProcess(dataDir,{binarySource:fileURLToPath(new URL(`../../resources/cliproxyapi/${PINNED_BINARY_NAME}`,import.meta.url))});
const proxyView=(view:ReturnType<typeof host.cliproxyProviders.view>)=>({...view,proxy:localProxy.status()});
const verification=new Verification(storage,host,dataDir,emit);
const qa=new Qa(storage,host,dataDir,emit);
host.attachQa(qa);
const sourceApply=new SourceApply(storage,host,verification,dataDir,emit);
const workerMerge=new WorkerMerge(storage,host,dataDir,emit);
host.setAutoMerger((rootId,workerId)=>workerMerge.auto(rootId,workerId));
const cleanup=new Cleanup(storage,host,dataDir);

app.addHook("onRequest",async(req,reply)=>{
  reply.header("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost");
  reply.header("X-Content-Type-Options","nosniff");reply.header("Referrer-Policy","no-referrer");
  const h=req.headers.host||"";
  if(![`127.0.0.1:${port}`,...(devOrigin?["127.0.0.1:4317"]:[])].includes(h)){reply.code(403).send({error:"Local host required"});return;}
  const origin=req.headers.origin;
  if(origin&&!acceptedOrigins.has(origin)){reply.code(403).send({error:"Origin denied"});return;}
  if(appClosing&&req.method!=="GET"){reply.code(503).send({error:"Service is shutting down"});return;}
  if(req.method!=="GET"&&origin===undefined){reply.code(403).send({error:"Origin required"});return;}
  if(!req.url.startsWith("/api/")||req.url==="/api/bootstrap")return;
  const supplied=(req.headers.cookie||"").split(";").map(x=>x.trim()).find(x=>x.startsWith(`${cookieName}=`))?.slice(cookieName.length+1)||"";
  const a=Buffer.from(supplied),b=Buffer.from(cookie);
  if(a.length!==b.length||!timingSafeEqual(a,b)){reply.code(401).send({error:"Unauthenticated"});return;}
});
app.post("/api/bootstrap",async(_req,reply)=>{reply.header("Set-Cookie",`${cookieName}=${cookie}; HttpOnly; SameSite=Strict; Path=/api`);return {ok:true,defaultWorkspace};});
app.get("/api/models",async(_req,reply)=>{try{return {models:await host.models()};}catch{return reply.code(503).send({error:"Model availability could not refresh"});}});
app.post("/api/models/refresh",async(_req,reply)=>{try{return {models:await host.refreshModels()};}catch{return reply.code(409).send({error:"Model availability could not refresh. Complete or cancel sign-in before refreshing."});}});
// These interaction routes share the bootstrap cookie, host and origin guards above.
// SDK errors may contain credentials: return only our fixed boundary messages.
app.get("/api/v2/providers",async(_req,reply)=>{reply.header("Cache-Control","no-store");return {providers:host.nativeProviders.list()};});
app.get("/api/v2/access",async(_req,reply)=>{reply.header("Cache-Control","no-store");return {mode:host.approvalMode};});
app.post<{Body:{mode?:unknown}}>("/api/v2/access",async(req,reply)=>{
  reply.header("Cache-Control","no-store");const body=req.body as unknown,mode=body&&typeof body==="object"&&!Array.isArray(body)&&Object.keys(body).length===1?(body as {mode?:unknown}).mode:undefined;
  if(mode!=="full"&&mode!=="ask")return reply.code(400).send({error:"mode must be full or ask"});
  try{await host.setApprovalMode(mode);return {mode:host.approvalMode};}catch{return reply.code(409).send({error:"Access mode could not be saved."});}
});
app.get("/api/cliproxy",async(_req,reply)=>{reply.header("Cache-Control","no-store");return {provider:proxyView(host.cliproxyProviders.view())};});
for(const action of ["connect","refresh","disconnect","cancel"] as const)app.post(`/api/cliproxy/${action}`,async(_req,reply)=>{
  reply.header("Cache-Control","no-store");
  try{
    if(action==="connect"){
      // Connecting is the opt-in: remember it so the private proxy autostarts on every launch.
      writeProxyEnabled(dataDir,true);await localProxy.start().catch(()=>false);
      // A freshly started proxy may have no sign-in yet; report its status instead of failing the action.
      try{return {provider:proxyView(await host.cliproxyProviders.connect())};}catch{return {provider:proxyView(host.cliproxyProviders.view())};}
    }
    if(action==="disconnect"){const view=await host.cliproxyProviders.disconnect();writeProxyEnabled(dataDir,false);await localProxy.stop();return {provider:proxyView(view)};}
    return {provider:proxyView(await host.cliproxyProviders[action]())};
  }catch{return reply.code(409).send({error:"Local proxy action could not complete. Refresh status to inspect the connection."});}
});
for(const action of ["refresh","connect","disconnect","cancel"] as const)app.post<{Params:{id:string}}>(`/api/v2/providers/:id/${action}`,async(req,reply)=>{
  reply.header("Cache-Control","no-store");try{return {providers:await host.nativeProviders[action](req.params.id)};}catch{return reply.code(409).send({error:"Native provider action could not complete. Refresh local status."});}
});
// Explicit opt-in for the UNSUPERVISED Antigravity route (AGY runs its own tools without Pi approvals).
app.post<{Body:{confirm?:unknown}}>("/api/v2/antigravity-unsupervised/enable",async(req,reply)=>{
  reply.header("Cache-Control","no-store");if(req.body?.confirm!==true)return reply.code(400).send({error:"Explicit confirmation required"});
  try{return {providers:await host.nativeProviders.enableAgyUnsupervised(true)};}catch{return reply.code(409).send({error:"Unsupervised Antigravity could not be enabled. Check the CLI and its private profile."});}
});
app.post("/api/v2/antigravity-unsupervised/disable",async(_req,reply)=>{
  reply.header("Cache-Control","no-store");try{return {providers:await host.nativeProviders.disableAgyUnsupervised()};}catch{return reply.code(409).send({error:"Unsupervised Antigravity could not be disabled. Refresh local status."});}
});
app.get("/api/providers",async(_req,reply)=>{reply.header("Cache-Control","no-store");try{return {providers:await host.providerAuth.list()};}catch{return reply.code(503).send({error:"Provider status unavailable"});}});
app.post<{Params:{id:string}}>("/api/providers/:id/login",async(req,reply)=>{
  const id=req.headers["x-command-id"];if(typeof id!=="string"||!isUUID(id))return reply.code(400).send({error:"Sign-in operation ID required"});
  reply.header("Cache-Control","no-store");try{return {operation:host.providerAuth.start(req.params.id,id)};}catch{return reply.code(409).send({error:"Sign-in is unavailable or another operation is active. Refresh provider status."});}
});
app.get<{Params:{id:string;operationId:string}}>("/api/providers/:id/login/:operationId",async(req,reply)=>{
  reply.header("Cache-Control","no-store");try{return {operation:host.providerAuth.operation(req.params.id,req.params.operationId)};}catch{return reply.code(409).send({error:"Sign-in operation is no longer current"});}
});
app.post<{Params:{id:string;operationId:string};Body:{promptId?:unknown;answer?:unknown}}>("/api/providers/:id/login/:operationId/answer",async(req,reply)=>{
  reply.header("Cache-Control","no-store");try{if(typeof req.body?.promptId!=="string")throw new Error();return {operation:host.providerAuth.answer(req.params.id,req.params.operationId,req.body.promptId,req.body.answer)};}catch{return reply.code(409).send({error:"Sign-in response is invalid or the prompt is no longer pending"});}
});
app.post<{Params:{id:string;operationId:string}}>("/api/providers/:id/login/:operationId/cancel",async(req,reply)=>{
  reply.header("Cache-Control","no-store");try{return {operation:await host.providerAuth.cancel(req.params.id,req.params.operationId)};}catch{return reply.code(409).send({error:"Sign-in operation is no longer current"});}
});
app.post<{Params:{id:string;operationId:string}}>("/api/providers/:id/login/:operationId/open",async(req,reply)=>{
  try{return await host.providerAuth.open(req.params.id,req.params.operationId);}catch{return reply.code(409).send({error:"Browser could not open. Use the current provider sign-in link."});}
});
app.post<{Params:{id:string}}>("/api/providers/:id/refresh",async(req,reply)=>{
  reply.header("Cache-Control","no-store");try{return {providers:await host.providerAuth.refresh(req.params.id)};}catch{return reply.code(409).send({error:"Provider status could not synchronize. Complete or cancel sign-in before refreshing."});}
});
app.get("/api/cleanup/preview",async(_req,reply)=>{try{return await cleanup.preview();}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Cleanup preview unavailable"});}});
app.post("/api/cleanup",async(req,reply)=>{
  const body=req.body as {digest?:unknown;approve?:unknown}|null,id=req.headers["x-command-id"];
  if(typeof id!=="string"||!isUUID(id))return reply.code(400).send({error:"Command ID required"});
  if(body?.approve!==true||typeof body.digest!=="string")return reply.code(400).send({error:"Preview digest and explicit approval required"});
  try{return await cleanup.run(id,body.digest,body.approve);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Cleanup failed"});}
});
app.get("/api/roles",async()=>({catalog:await host.roles()}));
app.put("/api/roles",async(req,reply)=>{
  try{return {catalog:await host.saveRoles(req.body)};}catch(error){return reply.code(String(error).includes("reload before saving")?409:400).send({error:error instanceof Error?error.message:"Cannot save roles"});}
});
app.get("/api/projects",async()=>({projects:await storage.call<ProjectView[]>("projects")}));
app.post("/api/folders/choose",async(_req,reply)=>{
  const closed=new AbortController(),cancel=()=>closed.abort();
  reply.raw.once("close",cancel);
  try{return {folders:await chooseFolders(AbortSignal.any([closed.signal,pickerShutdown.signal]))};}
  finally{reply.raw.off("close",cancel);}
});
app.put<{Params:{id:string}}>("/api/projects/:id",async(req,reply)=>{
  if(!isUUID(req.params.id))return reply.code(400).send({error:"Valid project ID required"});
  try{
    const project={id:req.params.id,...await projectInput(req.body)};
    await storage.call("saveProject",project);
    return {project};
  }catch(error){return reply.code(400).send({error:error instanceof Error?error.message:"Cannot save project"});}
});
app.post<{Params:{id:string};Body:{archived?:unknown}}>("/api/projects/:id/archive",async(req,reply)=>{
  if(!isUUID(req.params.id))return reply.code(400).send({error:"Valid project ID required"});
  if(!await storage.call<ProjectView|undefined>("project",{id:req.params.id}))return reply.code(404).send({error:"Project unavailable"});
  await storage.call("archiveProject",{id:req.params.id,archived:req.body?.archived!==false});
  return {ok:true};
});
app.delete<{Params:{id:string}}>("/api/projects/:id",async(req,reply)=>{
  if(!isUUID(req.params.id))return reply.code(400).send({error:"Valid project ID required"});
  if(!await storage.call<ProjectView|undefined>("project",{id:req.params.id}))return reply.code(404).send({error:"Project unavailable"});
  await storage.call("deleteProject",{id:req.params.id});
  return {ok:true};
});
app.get<{Params:{id:string}}>("/api/projects/:id/status",async(req,reply)=>{
  const project=await storage.call<ProjectView|undefined>("project",{id:req.params.id});
  if(!project)return reply.code(404).send({error:"Project unavailable"});
  return projectStatus(project);
});
app.get("/api/project-tasks",async()=>({tasks:await storage.call<ProjectTaskView[]>("projectTasks")}));
app.get("/api/workspace-recovery",async()=>({items:await host.workspaceRecovery()}));
app.post<{Params:{id:string};Body:{observedRevision?:unknown}}>("/api/workspace-recovery/:id/continue",async(req,reply)=>{
  if(!req.params.id||req.params.id.length>256)return reply.code(400).send({error:"Setup ID required"});
  try{return await host.continueWorkspaceSetup(req.params.id,typeof req.body?.observedRevision==="string"?req.body.observedRevision:undefined);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Setup continuation unavailable"});}
});
app.get<{Params:{id:string}}>("/api/project-tasks/:id",async(req,reply)=>{
  if(!isUUID(req.params.id))return reply.code(400).send({error:"Valid task ID required"});
  const task=await storage.call<ProjectTaskView|undefined>("projectTask",{id:req.params.id});
  return task??reply.code(404).send({error:"Task unavailable"});
});
app.post<{Params:{id:string};Body:{archived?:unknown}}>("/api/project-tasks/:id/archive",async(req,reply)=>{
  if(!isUUID(req.params.id))return reply.code(400).send({error:"Valid task ID required"});
  try{return await host.archiveOwner(req.params.id,req.body?.archived!==false,true);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Cannot archive task"});}
});
app.post<{Params:{id:string};Body:{observedRevisions?:unknown}}>("/api/project-tasks/:id/continue",async(req,reply)=>{
  if(!isUUID(req.params.id))return reply.code(400).send({error:"Valid task ID required"});
  try{return await host.continueProjectTask(req.params.id,Array.isArray(req.body?.observedRevisions)?req.body.observedRevisions:undefined);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Task continuation unavailable"});}
});
const REASONING_LEVELS=["off","minimal","low","medium","high","xhigh","max"];
const validReasoning=(value:unknown)=>value===undefined||value===null||typeof value==="string"&&REASONING_LEVELS.includes(value);
app.post("/api/project-tasks",async(req,reply)=>{
  const body=req.body as {projectId?:unknown;model?:unknown;workspaceMode?:unknown;reasoning?:unknown}|null,id=req.headers["x-command-id"];
  if(!validReasoning(body?.reasoning))return reply.code(400).send({error:"Valid reasoning level required"});
  if(typeof id!=="string"||!isUUID(id)||typeof body?.projectId!=="string"||!isUUID(body.projectId)||typeof body.model!=="string"||!body.model||!(body.workspaceMode===undefined||body.workspaceMode==="direct"||body.workspaceMode==="worktree"))return reply.code(400).send({error:"Task command, project, model and valid workspace mode required"});
  const reasoning=(body.reasoning as RoleReasoning|null|undefined)??undefined,requestHash=createHash("sha256").update(`${body.projectId}\0${body.model}${body.workspaceMode==="worktree"?"\0worktree":""}${reasoning?`\0reasoning:${reasoning}`:""}`).digest("hex");
  let admitted=false;
  try{return await host.withPromptAdmission(id,async admission=>{try{
    const existing=await storage.call<ProjectTaskView|undefined>("projectTask",{id});
    if(existing){if(existing.requestHash!==requestHash)throw new Error("Task command ID was used for a different request");return {id,status:existing.status};}
    const project=await storage.call<ProjectView|undefined>("project",{id:body.projectId});
    if(!project)return reply.code(404).send({error:"Project unavailable"});
    if(!(await host.models()).some(model=>`${model.provider}/${model.id}`===body.model))throw new Error("Selected model is unavailable");
    let snapshot=await snapshotProjectTask(project,body.model as string,id,requestHash,body.workspaceMode==="worktree"?"worktree":"direct");
    snapshot.roleCatalog=await host.roles();if(reasoning)snapshot.reasoning=reasoning;
    snapshot=await host.prepareProjectTask(snapshot);admission.check();
    const inserted=await storage.call<{fresh:boolean;task:ProjectTaskView}>("addProjectTask",{...snapshot});
    if(!inserted.fresh)return {id,status:inserted.task.status};
    admitted=true;admission.check();
    for(const repo of snapshot.repositories){admission.check();await host.create(repo.sourceCwd,snapshot.model,repo.sessionId,"parallel",{baseCommit:repo.baseCommit,workspaceMode:snapshot.workspaceMode??"direct",task:{id:snapshot.id,repositoryId:repo.id},roleCatalog:snapshot.roleCatalog,reasoning:snapshot.reasoning});}
    admission.check();await host.createCoordinator(snapshot);
    admission.check();await storage.call("projectTaskStatus",{id,status:"running"});
    return {id,status:"running"};
  }catch(error){
    if(admitted)await storage.call("projectTaskStatus",{id,status:"unknown"});
    return reply.code(admitted?409:400).send({id,status:admitted?"unknown":"rejected",error:error instanceof Error?error.message:"Cannot create task"});
  }});}catch(error){return reply.code(400).send({id,status:"rejected",error:error instanceof Error?error.message:"Cannot admit task"});}
});
app.get("/api/sessions",async()=>({sessions:await host.list()}));
app.post<{Params:{id:string};Body:{archived?:unknown}}>("/api/sessions/:id/archive",async(req,reply)=>{
  if(!isUUID(req.params.id))return reply.code(400).send({error:"Valid session ID required"});
  try{return await host.archiveOwner(req.params.id,req.body?.archived!==false);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Cannot archive session"});}
});
app.post("/api/sessions",async(req,reply)=>{
  const body=req.body as {cwd?:unknown;scratch?:unknown;model?:unknown;mode?:unknown;workspaceMode?:unknown;reasoning?:unknown};
  if(!validReasoning(body?.reasoning))return reply.code(400).send({error:"Valid reasoning level required"});
  const scratch=body?.scratch===true;
  if(body?.scratch!==undefined&&(body.scratch!==true||body.cwd!==undefined))return reply.code(400).send({error:"Scratch chats take no workspace"});
  if(!scratch&&typeof body?.cwd!=="string"||typeof body?.model!=="string"||!(body.mode===undefined||body.mode==="read"||body.mode==="code"||body.mode==="parallel")||!(body.workspaceMode===undefined||body.workspaceMode==="direct"||body.workspaceMode==="worktree")||(body.workspaceMode!==undefined&&(body.mode===undefined||body.mode==="read")))return reply.code(400).send({error:"Workspace, model and valid mode required"});
  const id=req.headers["x-command-id"];
  if(typeof id!=="string"||!isUUID(id))return reply.code(400).send({error:"Command ID required"});
  let cwd=scratch?"":body.cwd as string;const model=body.model,mode=body.mode??"read",workspaceMode=body.workspaceMode??"direct",reasoning=(body.reasoning as RoleReasoning|null|undefined)??undefined;
  try{return await host.withPromptAdmission(id,async admission=>{
    let fresh=false;
    try{
      const requestHash=createHash("sha256").update(`${scratch?"\0scratch":cwd}\0${model}${mode!=="read"?`\0${mode}`:""}${workspaceMode==="worktree"?"\0worktree":""}${reasoning?`\0reasoning:${reasoning}`:""}`).digest("hex");
      const command=await storage.call<{fresh:boolean;status:string}>("command",{id,sessionId:id,kind:"create",requestHash});fresh=command.fresh;
      admission.check();
      if(!command.fresh)return {id,status:command.status};
      if(scratch)cwd=await createScratchDir(id);admission.check();
      await host.create(cwd,model,id,mode,{workspaceMode,commandId:id,...(reasoning?{reasoning}:{})});admission.check();await storage.call("commandStatus",{id,status:"completed"});return {id,status:"completed"};
    }catch(error){let unresolved=false;if(fresh){const saved=await storage.call<any>("commandSetupGet",{id});unresolved=["allocating","allocated","registered","opened","dispatching"].includes(saved?.setup?.phase);await storage.call("commandStatus",{id,status:unresolved?"unknown":"rejected"});}return reply.code(unresolved?409:400).send({id,status:unresolved?"unknown":"rejected",error:error instanceof Error?error.message:"Cannot create session"});}
  });}catch(error){return reply.code(400).send({id,status:"rejected",error:error instanceof Error?error.message:"Cannot admit session"});}
});
app.get<{Params:{id:string}}>("/api/sessions/:id",async(req,reply)=>{try{return await host.snapshot(req.params.id);}catch{return reply.code(404).send({error:"Session unavailable"});}});
// One storage operation reads membership, node state and a consistent journal cursor.
app.get<{Params:{id:string}}>("/api/sessions/:id/graph",async(req,reply)=>{
  try{return await storage.call("graphSnapshot",{scopeId:req.params.id});}catch{return reply.code(404).send({error:"Graph scope unavailable"});}
});
app.get<{Params:{id:string};Querystring:{after?:string}}>("/api/sessions/:id/graph/events",async(req,reply)=>{
  const after=Number(req.query.after??0);
  if(!Number.isSafeInteger(after)||after<0)return reply.code(400).send({error:"Invalid graph cursor"});
  try{return await storage.call("graphSnapshot",{scopeId:req.params.id,after});}catch(error){return reply.code(String(error).includes("cursor")?400:404).send({error:"Graph scope or cursor unavailable"});}
});
app.get<{Params:{id:string;nodeId:string}}>("/api/sessions/:id/graph/nodes/:nodeId/history",async(req,reply)=>{
  try{await storage.call("graphMember",{scopeId:req.params.id,nodeId:req.params.nodeId});return await host.snapshot(req.params.nodeId);}catch{return reply.code(404).send({error:"Graph node unavailable"});}
});
// Read-only Git status of the session's selected folder and, when separate, its isolated workspace.
app.get<{Params:{id:string}}>("/api/sessions/:id/repository",async(req,reply)=>{
  let snapshot;try{snapshot=await host.snapshot(req.params.id);}catch{return reply.code(404).send({error:"Session unavailable"});}
  const source=snapshot.policy?.workspace?.sourceCwd??snapshot.cwd;
  const [sourceStatus,workspaceStatus,git]=await Promise.all([folderStatus(source),snapshot.cwd!==source?folderStatus(snapshot.cwd):Promise.resolve(null),host.gitInfo(req.params.id)]);
  return {checkedAt:Date.now(),source:sourceStatus,workspace:workspaceStatus,git};
});
app.post<{Params:{id:string;action:string};Body:{branch?:unknown}}>("/api/sessions/:id/git/:action",async(req,reply)=>{
  const action=req.params.action;
  if(action!=="switch"&&action!=="pull"&&action!=="push")return reply.code(404).send({error:"Unknown Git action"});
  try{return await host.gitAction(req.params.id,action,req.body??{},typeof req.headers["x-command-id"]==="string"?req.headers["x-command-id"]:undefined);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Git action failed"});}
});
app.get<{Params:{id:string}}>("/api/sessions/:id/git-recovery",async(req,reply)=>{try{return await host.gitRecovery(req.params.id);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Git recovery unavailable"});}});
app.post<{Params:{id:string};Body:{commandId:string;acknowledge:true;digest:string}}>("/api/sessions/:id/git-reconcile",async(req,reply)=>{try{return await host.reconcileGit(req.params.id,req.body?.commandId,req.body);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Git reconciliation unavailable"});}});
app.get<{Params:{id:string;agentId:string}}>("/api/sessions/:id/agents/:agentId",async(req,reply)=>{
  try{return await host.childSnapshot(req.params.id,req.params.agentId);}catch{return reply.code(404).send({error:"Child unavailable"});}
});
app.get<{Params:{id:string}}>("/api/sessions/:id/worker-merges",async(req,reply)=>{
  try{return {merges:await workerMerge.list(req.params.id)};}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Worker merges unavailable"});}
});
app.post<{Params:{id:string}}>("/api/sessions/:id/worker-merges",async(req,reply)=>{
  const workerId=(req.body as {workerId?:unknown})?.workerId,id=req.headers["x-command-id"];
  if(typeof workerId!=="string"||!isUUID(workerId)||typeof id!=="string"||!isUUID(id))return reply.code(400).send({error:"Worker and merge command IDs required"});
  try{return await workerMerge.prepare(req.params.id,workerId,id);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Merge preview unavailable"});}
});
app.post<{Params:{id:string;mergeId:string}}>("/api/sessions/:id/worker-merges/:mergeId/decision",async(req,reply)=>{
  const body=req.body as {allow?:unknown};if(typeof body?.allow!=="boolean")return reply.code(400).send({error:"Decision required"});
  try{return await workerMerge.decide(req.params.id,req.params.mergeId,body.allow);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Merge decision unavailable"});}
});
app.post<{Params:{id:string;mergeId:string}}>("/api/sessions/:id/worker-merges/:mergeId/reconcile",async(req,reply)=>{
  const body=req.body as {acknowledge?:unknown};if(body?.acknowledge!==true)return reply.code(400).send({error:"Explicit reconciliation acknowledgement required"});
  try{return await workerMerge.reconcile(req.params.id,req.params.mergeId);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Merge reconciliation unavailable"});}
});
app.get<{Params:{id:string;approvalId:string}}>("/api/sessions/:id/writes/:approvalId/reconcile",async(req,reply)=>{
  if(!isUUID(req.params.id)||!isUUID(req.params.approvalId))return reply.code(400).send({error:"Valid session and approval IDs required"});
  try{return await host.directWriteRecovery(req.params.id,req.params.approvalId);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Direct write reconciliation unavailable"});}
});
app.post<{Params:{id:string;approvalId:string}}>("/api/sessions/:id/writes/:approvalId/reconcile",async(req,reply)=>{
  const body=req.body as {acknowledge?:unknown;observedHash?:unknown;observedMode?:unknown;state?:unknown}|null;
  if(!isUUID(req.params.id)||!isUUID(req.params.approvalId)||body?.acknowledge!==true||typeof body.observedHash!=="string"||!(body.observedMode===null||Number.isInteger(body.observedMode))||!(body.state==="before"||body.state==="after"||body.state==="diverged"))return reply.code(400).send({error:"Exact observed state and acknowledgement required"});
  try{return await host.reconcileDirectWrite(req.params.id,req.params.approvalId,{acknowledge:true,observedHash:body.observedHash,observedMode:body.observedMode as number|null,state:body.state});}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Direct write reconciliation unavailable"});}
});
app.get<{Params:{id:string}}>("/api/sessions/:id/changes",async(req,reply)=>{
  try{return await host.changes(req.params.id);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Changes unavailable"});}
});
app.get<{Params:{id:string};Querystring:{revision?:string}}>("/api/sessions/:id/changes.patch",async(req,reply)=>{
  try{
    const changes=await host.changes(req.params.id);
    if(changes.omitted)throw new Error("Some changed files cannot be exported; inspect the isolated copy directly");
    if(req.query.revision!==changes.revision)throw new Error("Patch revision changed; refresh Code changes");
    return reply.header("Content-Type","text/x-patch; charset=utf-8").header("Content-Disposition",`attachment; filename="changes-${req.params.id.slice(0,8)}-${changes.revision.slice(0,8)}.patch"`).header("X-Code-Revision",changes.revision).header("Cache-Control","no-store").send(changes.diff);
  }catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Patch unavailable"});}
});
app.get<{Params:{id:string}}>("/api/sessions/:id/evidence",async(req,reply)=>{
  try{return await verification.evidence(req.params.id);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Evidence unavailable"});}
});
app.get<{Params:{id:string}}>("/api/sessions/:id/qa",async(req,reply)=>{
  try{return await qa.list(req.params.id);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"QA unavailable"});}
});
app.get<{Params:{id:string}}>("/api/sessions/:id/qa/gate",async(req,reply)=>{
  try{return await qa.gate(req.params.id);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"QA gate unavailable"});}
});
// The user's POST is the approval of this QA run: it freezes the current Code revision and its static site.
app.post<{Params:{id:string}}>("/api/sessions/:id/qa/runs",async(req,reply)=>{
  const body=req.body as {entry?:unknown}|null,id=req.headers["x-command-id"];
  if(typeof id!=="string"||!isUUID(id)||typeof body?.entry!=="string")return reply.code(400).send({error:"QA command ID and entry file required"});
  try{return await qa.create(req.params.id,id,body.entry);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"QA run unavailable"});}
});
app.post<{Params:{id:string;runId:string}}>("/api/sessions/:id/qa/runs/:runId/cancel",async(req,reply)=>{
  try{await qa.cancel(req.params.id,req.params.runId);return {stopped:true};}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"QA cancel unavailable"});}
});
app.get<{Params:{id:string;artifactId:string}}>("/api/sessions/:id/qa/artifacts/:artifactId",async(req,reply)=>{
  if(!isUUID(req.params.artifactId))return reply.code(400).send({error:"Valid artifact ID required"});
  try{const artifact=await qa.artifact(req.params.id,req.params.artifactId);return reply.header("Content-Type",artifact.mime).header("X-Content-Type-Options","nosniff").header("Cache-Control","private, max-age=31536000, immutable").header("Content-Disposition","inline").send(artifact.bytes);}
  catch{return reply.code(404).send({error:"Artifact unavailable"});}
});
app.get<{Params:{id:string}}>("/api/sessions/:id/source-applies",async(req,reply)=>{
  try{return {applies:await sourceApply.evidence(req.params.id)};}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Source Apply unavailable"});}
});
app.post<{Params:{id:string}}>("/api/sessions/:id/source-applies",async(req,reply)=>{
  const id=req.headers["x-command-id"];
  if(typeof id!=="string"||!isUUID(id))return reply.code(400).send({error:"Apply command ID required"});
  try{return await sourceApply.prepare(req.params.id,id);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Source Apply unavailable"});}
});
app.post<{Params:{id:string;applyId:string}}>("/api/sessions/:id/source-applies/:applyId/decision",async(req,reply)=>{
  const body=req.body as {allow?:unknown};if(typeof body?.allow!=="boolean")return reply.code(400).send({error:"Decision required"});
  try{await sourceApply.decide(req.params.id,req.params.applyId,body.allow);return {recorded:true};}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Source Apply approval unavailable"});}
});
app.post<{Params:{id:string;applyId:string}}>("/api/sessions/:id/source-applies/:applyId/abort",async(req,reply)=>{
  try{await sourceApply.abort(req.params.id,req.params.applyId);return {stopped:true};}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Source Apply Stop unavailable"});}
});
app.post<{Params:{id:string;applyId:string}}>("/api/sessions/:id/source-applies/:applyId/reconcile",async(req,reply)=>{
  const body=req.body as {acknowledge?:unknown;sourceCwd?:unknown;files?:unknown}|null;
  if(!isUUID(req.params.id)||!isUUID(req.params.applyId)||body?.acknowledge!==true||typeof body.sourceCwd!=="string"||!Array.isArray(body.files))return reply.code(400).send({error:"Exact source and per-file observations required"});
  try{return await sourceApply.reconcile(req.params.id,req.params.applyId,body as import("./source-apply.js").SourceApplyAcknowledgement);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Source Apply reconciliation unavailable"});}
});
app.post<{Params:{id:string}}>("/api/sessions/:id/checks",async(req,reply)=>{
  const body=req.body as {testPath?:unknown;inputPaths?:unknown},id=req.headers["x-command-id"];
  if(typeof id!=="string"||!isUUID(id)||typeof body?.testPath!=="string"||!Array.isArray(body.inputPaths))return reply.code(400).send({error:"Check ID, test file and explicit input files required"});
  try{return await verification.prepare(req.params.id,id,body.testPath,body.inputPaths);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Check unavailable"});}
});
app.post<{Params:{id:string}}>("/api/sessions/:id/typechecks",async(req,reply)=>{
  const body=req.body as {configPath?:unknown;inputPaths?:unknown},id=req.headers["x-command-id"];
  if(typeof id!=="string"||!isUUID(id)||typeof body?.configPath!=="string"||!Array.isArray(body.inputPaths))return reply.code(400).send({error:"TypeScript check ID, config and explicit inputs required"});
  try{return await verification.prepareTypecheck(req.params.id,id,body.configPath,body.inputPaths);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"TypeScript check unavailable"});}
});
app.post<{Params:{id:string;checkId:string}}>("/api/sessions/:id/checks/:checkId/decision",async(req,reply)=>{
  const body=req.body as {allow?:unknown};if(typeof body?.allow!=="boolean")return reply.code(400).send({error:"Decision required"});
  try{await verification.decide(req.params.id,req.params.checkId,body.allow);return {recorded:true};}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Check approval unavailable"});}
});
app.post<{Params:{id:string;checkId:string}}>("/api/sessions/:id/checks/:checkId/abort",async(req,reply)=>{
  try{await verification.abortCheck(req.params.id,req.params.checkId);return {stopped:true};}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Stop failed"});}
});
app.post<{Params:{id:string}}>("/api/sessions/:id/reviews",async(req,reply)=>{
  const body=req.body as {checkId?:unknown};if(typeof body?.checkId!=="string")return reply.code(400).send({error:"Check ID required"});
  try{return await verification.review(req.params.id,body.checkId);}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Review unavailable"});}
});
app.post<{Params:{id:string;reviewId:string}}>("/api/sessions/:id/reviews/:reviewId/abort",async(req,reply)=>{
  try{await verification.abortReview(req.params.id,req.params.reviewId);return {stopped:true};}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Reviewer stop failed"});}
});
app.post<{Params:{id:string}}>("/api/sessions/:id/prompt",async(req,reply)=>{
  const {text,behavior,reviewId}=req.body as {text?:unknown;behavior?:unknown;reviewId?:unknown};
  if(typeof text!=="string"||!text.trim()||text.length>20_000||!(behavior===undefined||behavior==="steer"||behavior==="followUp"))return reply.code(400).send({error:"Invalid prompt"});
  const commandId=req.headers["x-command-id"];
  if(typeof commandId!=="string"||!isUUID(commandId))return reply.code(400).send({error:"Command ID required"});
  try{
    return await host.withPromptAdmission(req.params.id,async promptAdmission=>{
      let submitted=text,review: {id:string;agentId:string;revision:string}|undefined;
      if(reviewId!==undefined){
        if(typeof reviewId!=="string"||!isUUID(reviewId))throw new Error("Valid review ID required");
        const stored=await storage.call<{id:string;agentId:string;sessionId:string;status:string;revision:string;findings:string}|undefined>("review",{id:reviewId});
        if(!stored||stored.sessionId!==req.params.id||stored.status!=="completed")throw new Error("Completed review does not belong to this chat");
        await storage.call("graphMember",{scopeId:req.params.id,nodeId:stored.agentId});
        review=stored;
        submitted=`${text}\n\nReview evidence ${stored.id}, revision ${stored.revision} (advisory):\n${stored.findings.slice(0,12000)}${stored.findings.length>12000?"\n[Findings truncated]":""}`;
      }
      const requestHash=createHash("sha256").update(`${text}\0${behavior||""}${reviewId?`\0${reviewId}`:""}`).digest("hex");
      const command=await storage.call<{fresh:boolean;status:string}>("command",{id:commandId,sessionId:req.params.id,kind:"prompt",requestHash,inputText:text,behavior:behavior||null});
      if(!command.fresh)return {accepted:false,status:command.status};
      const status=await host.prompt(req.params.id,submitted,behavior as "steer"|"followUp"|undefined,commandId,undefined,review,promptAdmission);
      return {accepted:true,status};
    });
  }catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Prompt rejected"});}
});
app.post<{Params:{id:string}}>("/api/sessions/:id/model",async(req,reply)=>{
  const body=req.body as {model?:unknown;reasoning?:unknown};
  if(!isUUID(req.params.id)||typeof body?.model!=="string"||!body.model||!validReasoning(body.reasoning))return reply.code(400).send({error:"Model and valid reasoning level required"});
  const commandId=req.headers["x-command-id"];
  if(typeof commandId!=="string"||!isUUID(commandId))return reply.code(400).send({error:"Command ID required"});
  const model=body.model,reasoning=(body.reasoning as RoleReasoning|null|undefined)??null;
  try{return await host.withPromptAdmission(req.params.id,admission=>host.switchModel(req.params.id,model,reasoning,admission));}
  catch(error){const message=error instanceof Error?error.message:"Model switch rejected";return reply.code(/unavailable|Reasoning level/.test(message)?400:409).send({error:message});}
});
app.post<{Params:{id:string;agentId:string}}>("/api/sessions/:id/agents/:agentId/prompt",async(req,reply)=>{
  const {id,agentId}=req.params,{text,behavior}=req.body as {text?:unknown;behavior?:unknown},commandId=req.headers["x-command-id"];
  if(!isUUID(id)||!isUUID(agentId)||typeof commandId!=="string"||!isUUID(commandId)||typeof text!=="string"||!text.trim()||text.length>20_000||!(behavior===undefined||behavior==="steer"||behavior==="followUp"))return reply.code(400).send({error:"Valid root, child, command and prompt required"});
  try{
    return await host.withPromptAdmission(agentId,async promptAdmission=>{
      await host.childSnapshot(id,agentId);
      const requestHash=createHash("sha256").update(`${id}\0${text}\0${behavior||""}`).digest("hex");
      const command=await storage.call<{fresh:boolean;status:string}>("command",{id:commandId,sessionId:agentId,kind:"child_prompt",requestHash,inputText:text,behavior:behavior||null});
      if(!command.fresh)return {accepted:false,status:command.status};
      const status=await host.prompt(agentId,text,behavior as "steer"|"followUp"|undefined,commandId,id,undefined,promptAdmission);
      return {accepted:true,status};
    });
  }catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Child prompt rejected"});}
});
app.post<{Params:{id:string}}>("/api/sessions/:id/abort",async(req,reply)=>{
  const row=await storage.call<{parentId:string|null;policy?:{requested?:{mode?:string};task?:{id:string}}}|undefined>("session",{id:req.params.id});
  if(!row){const task=await storage.call<ProjectTaskView|undefined>("projectTaskByCoordinator",{id:req.params.id});if(!task){const setup=await storage.call<any>("commandSetupGet",{id:req.params.id});if(!setup||setup.sessionId!==req.params.id||setup.kind!=="create")return reply.code(404).send({error:"Session unavailable"});await host.abort(req.params.id);return {stopped:true};}try{await host.stopProjectTask(task,async id=>{await sourceApply.abortSession(id);await verification.abortSession(id);await qa.abortSession(id);await host.abort(id);});return {stopped:true};}catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Stop outcome is uncertain"});}}
  if(row.parentId)return reply.code(409).send({error:"Use the root session child control"});
  let release:(()=>unknown)|undefined;
  try{
    release=host.stopFence(req.params.id);
    if(row.policy?.requested?.mode==="multi"&&row.policy.task){
      const task=await storage.call<ProjectTaskView|undefined>("projectTask",{id:row.policy.task.id});
      if(!task||task.coordinatorId!==req.params.id)throw new Error("Task snapshot unavailable");
      await host.stopProjectTask(task,async id=>{await sourceApply.abortSession(id);await verification.abortSession(id);await qa.abortSession(id);await host.abort(id);});
    }else{await sourceApply.abortSession(req.params.id);await verification.abortSession(req.params.id);await qa.abortSession(req.params.id);await host.abort(req.params.id);}
    return {stopped:true};
  }catch(error){return reply.code(409).send({error:error instanceof Error?error.message:"Stop outcome is uncertain"});}
  finally{release?.();}
});
app.post<{Params:{id:string;agentId:string}}>("/api/sessions/:id/agents/:agentId/abort",async(req,reply)=>{
  const {id,agentId}=req.params,commandId=req.headers["x-command-id"];
  if(!isUUID(id)||!isUUID(agentId)||typeof commandId!=="string"||!isUUID(commandId))return reply.code(400).send({error:"Valid root, child and command IDs required"});
  let fresh=false;
  try{
    const requestHash=createHash("sha256").update(agentId).digest("hex");
    const command=await storage.call<{fresh:boolean;status:string}>("command",{id:commandId,sessionId:id,kind:"child_abort",requestHash});fresh=command.fresh;
    if(!fresh)return {status:command.status};
    try{await storage.call("descendantMember",{rootId:id,agentId});}catch{await storage.call("commandStatus",{id:commandId,status:"rejected"});return reply.code(404).send({error:"Child does not belong to this root session"});}
    if(await storage.call<boolean>("reviewAgent",{agentId})){await storage.call("commandStatus",{id:commandId,status:"rejected"});return reply.code(409).send({error:"Use the revision-bound review control"});}
    await storage.call("commandStatus",{id:commandId,status:"dispatched"});
    await host.abortChild(id,agentId);
    await storage.call("commandStatus",{id:commandId,status:"completed"});return {status:"completed"};
  }catch{if(fresh)await storage.call("commandStatus",{id:commandId,status:"unknown"});return reply.code(409).send({error:"Child stop was not confirmed; inspect its state before retrying"});}
});
app.post<{Params:{id:string;approvalId:string}}>("/api/sessions/:id/approvals/:approvalId",async(req,reply)=>{
  const body=req.body as {allow?:unknown};if(typeof body?.allow!=="boolean")return reply.code(400).send({error:"Decision required"});
  try{await host.decide(req.params.id,req.params.approvalId,body.allow);return {recorded:true};}catch{return reply.code(409).send({error:"Approval unavailable"});}
});
app.get<{Params:{id:string};Querystring:{after?:string}}>("/api/sessions/:id/events",async(req,reply)=>{
  const sessionId=req.params.id;
  if(appClosing)return reply.code(503).send({error:"Service is shutting down"});
  try{await host.snapshot(sessionId);}catch{return reply.code(appClosing?503:404).send({error:appClosing?"Service is shutting down":"Session unavailable"});}
  if(appClosing)return reply.code(503).send({error:"Service is shutting down"});
  const after=Number(req.query.after||0);if(!Number.isSafeInteger(after)||after<0)return reply.code(400).send({error:"Invalid cursor"});
  reply.hijack();reply.raw.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache","Connection":"keep-alive","X-Accel-Buffering":"no"});reply.raw.flushHeaders();
  const write=(event:JournalEvent|{type:string;payload:unknown})=>{if(reply.raw.writableLength>1_000_000){close();return;}if(!reply.raw.destroyed&&!reply.raw.writableEnded)reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);};
  let replaying=true,lastSeq=after;const buffered:Array<JournalEvent|{type:string;payload:unknown}>=[];
  const live=(event:JournalEvent|{type:string;payload:unknown})=>{if(!replaying)write(event);else if(buffered.length>=5000)close();else buffered.push(event);};
  const set=listeners.get(sessionId)||new Set();set.add(live);listeners.set(sessionId,set);
  let heartbeat:ReturnType<typeof setInterval>|undefined,closed=false;
  const close=()=>{if(closed)return;closed=true;if(heartbeat)clearInterval(heartbeat);set.delete(live);if(!set.size)listeners.delete(sessionId);streamClosers.delete(close);if(!reply.raw.destroyed&&!reply.raw.writableEnded)reply.raw.end();};
  streamClosers.add(close);req.raw.on("close",close);if(req.raw.socket?.destroyed||reply.raw.destroyed)close();
  const highWater=await storage.call<number>("latest",{sessionId});
  while(!closed&&lastSeq<highWater){
    const page=await storage.call<JournalEvent[]>("events",{sessionId,after:lastSeq,before:highWater});
    if(!page.length)break;for(const event of page){write(event);lastSeq=event.seq;}
  }
  if(closed)return;
  let lastComplete=-1;buffered.forEach((event,index)=>{if(event.type==="history_changed")lastComplete=index;});
  for(const [index,event] of buffered.entries()){
    if("seq" in event){if(event.seq<=lastSeq)continue;lastSeq=event.seq;}
    else if(event.type==="delta"&&index<lastComplete)continue;
    write(event);
  }
  replaying=false;
  heartbeat=setInterval(()=>{if(!reply.raw.destroyed&&!reply.raw.writableEnded)reply.raw.write(": keepalive\n\n");},15_000);
});
const webDir=join(root,"dist/web");
app.get("/*",async(req,reply)=>{
  const raw=decodeURIComponent(req.url.split("?")[0]);
  const file=resolve(webDir,`.${raw==="/"?"/index.html":raw}`);
  if(!file.startsWith(webDir+sep)&&file!==join(webDir,"index.html"))return reply.code(404).send();
  const target=existsSync(file)?file:join(webDir,"index.html");if(!existsSync(target))return reply.code(404).send({error:"Build web UI first"});
  const mime:Record<string,string>={".html":"text/html",".js":"text/javascript",".css":"text/css",".svg":"image/svg+xml"};
  reply.type(mime[extname(target)]||"application/octet-stream");return readFileSync(target);
});
let shutdownWork:Promise<void>|undefined;
shutdown=()=>shutdownWork??=(async()=>{
  appClosing=true;localProxy.cancelStartup();host.beginShutdown();workerMerge.beginClose();sourceApply.beginClose();verification.beginClose();qa.beginClose();
  pickerShutdown.abort();
  const failures:unknown[]=[];
  const settle=(work:()=>unknown|Promise<unknown>)=>{try{return Promise.resolve(work()).catch(error=>{failures.push(error);});}catch(error){failures.push(error);return Promise.resolve();}};
  await Promise.all([
    settle(()=>workerMerge.close()),settle(()=>sourceApply.close()),settle(()=>verification.close()),settle(()=>qa.close()),
    settle(()=>host.close()),settle(()=>serviceListening?app.close():undefined),...[...streamClosers].map(close=>settle(close)),
  ]);
  await settle(()=>localProxy.close());
  await settle(()=>storage.close());
  if(failures.length)throw new AggregateError(failures,"Shutdown did not finish cleanly");
  lease.close();
})();
process.once("SIGINT",()=>{if(shutdown)void shutdown().then(()=>process.exit(0),()=>process.exit(1));});
process.once("SIGTERM",()=>{if(shutdown)void shutdown().then(()=>process.exit(0),()=>process.exit(1));});
if(parentGone)await shutdown();
else try{
  const proxyOptedIn=proxyEnabled(dataDir);
  // Always provision (binary copy, config, install state); launch the private proxy only after the user opted in.
  if(!proxyOptedIn)localProxy.prepare();
  try{if(proxyOptedIn&&await localProxy.start()&&!appClosing){
    // CLIProxyAPI can accept HTTP before its auth/catalog registration settles.
    // Only retry this read-only catalog action; no model input is dispatched.
    const deadline=Date.now()+8_000;
    const timeout=setTimeout(()=>{void host.cliproxyProviders.cancel().catch(()=>{});},8_000);
    try{
      while(!appClosing&&Date.now()<deadline){
        try{await host.cliproxyProviders.connect();break;}
        catch{if(appClosing||Date.now()>=deadline)break;await new Promise(resolve=>setTimeout(resolve,100));}
      }
      if(!appClosing&&!host.cliproxyProviders.view().connected)throw new Error("Local catalog is unavailable.");
    }finally{clearTimeout(timeout);}
  }}
  catch{if(!appClosing)console.warn("Local CLIProxyAPI is unavailable. Check its private deployment and provider status.");}
  if(!appClosing){await app.listen({host:"127.0.0.1",port});serviceListening=true;console.log(`Sigma API listening on http://127.0.0.1:${port}`);}
}catch{await shutdown();throw new Error("Sigma could not start its local service.");}
