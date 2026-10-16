import { providerAllowed } from "./provider-allowlist.js";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants, lstatSync, realpathSync, openSync, readFileSync, readdirSync, closeSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, getAgentDir } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, getSupportedThinkingLevels, type ImageContent } from "@earendil-works/pi-ai";
import { CODE_PROFILE, REPOSITORY_CODE_PROFILE, PARALLEL_CODE_PROFILE, MULTI_REPO_PROFILE, READ_ONLY_PROFILE, NESTED_READ_PROFILE, NESTED_CODE_PROFILE, NESTED_REPOSITORY_PROFILE, NESTED_PARALLEL_PROFILE, NESTED_PARALLEL_WORKTREE_PROFILE, NESTED_WORKER_PROFILE, REVIEW_PROFILE, type FileChange, type WriteOutcome, type WriteRecoveryView, type WriteRecoveryState, type SessionMode, type WorkspaceMode, type AgentView, type ApprovalView, type RecoveryInput, type RecoveryAction, type SessionPolicy, type SessionView, type ProjectTaskView, type RunMetadata, type GraphFact } from "../../packages/contracts/index.js";
import { Storage } from "./storage.js";
import { registerDemoProvider } from "./demo-provider.js";
import { assertNotIgnored, assertWorkspaceHead, createCodeWorkspace, describeGitRoot, inspectCodePath, inspectWorkspaceSetup, mutationTools, workspaceChanges } from "./editing.js";
import { credentialGuard, inspectionTools, type PathGuard } from "./tool-boundary.js";
import { chromeUserDataDir } from "./chrome-path.js";
import { BROWSER_TOOLS, BrowserUse, isBrowserTool } from "./browser-use.js";
import { isQaTool, qaReviewTools, qaTools, QA_REVIEW_TOOLS, QA_TOOLS, type Qa } from "./qa-runs.js";
import { sweepCrashTemps } from "./crash-temps.js";
import { formatShellResult, killAllShells, protectedRoots, runShell, sandboxAvailable, DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS } from "./shell-tool.js";
import { commitMessage, gitBranches, gitHead, pushArgs, gitPull, gitSwitch } from "./git-actions.js";
import { prepareCommit, executeCommit, gitIdentity, dispatchGit, inspectGit, finalizeGit, type GitIntent } from "./git-intents.js";
import { stripMentionContext, type MentionTool } from "./mentions.js";
import { ASK_USER_TOOL, askQuestion, askUserTool } from "./ask-user.js";
import { defaultRoles, normalizeRoles, roleInput, resolveRole } from "./roles.js";
import { NativeCli, NATIVE_PROVIDER_IDS, AGY_UNSUPERVISED_PROVIDER_ID, CLAUDE_PROVIDER_ID } from "./native-cli.js";
import { registerAgyUnsupervisedProvider } from "./agy-provider.js";
import { registerClaudeProvider } from "./claude-provider.js";
import { ProviderAuth } from "./provider-auth.js";
import { CliproxyProvider, CLIPROXY_PROVIDER_ID } from "./cliproxy-provider.js";
import { geminiNonFlash, previousGeneration } from "./model-generations.js";
import type { ChangesView, WorkStep, WorkView, RoleCatalog, RoleReasoning, RoleType, SessionRole, WorkspaceSetup, WorkspaceRecoveryItem } from "../../packages/contracts/index.js";

/** Short, user-facing target of a tool call: a cwd-relative path, the commit subject or the delegated role. */
function toolDetail(cwd:string,tool:string,args:any):string|undefined{
  const clip=(value:string)=>value.replace(/\s+/g," ").trim().slice(0,200)||undefined;
  if(!args||typeof args!=="object")return;
  if(["read","ls","edit","write"].includes(tool)){
    const path=typeof args.path==="string"?args.path:typeof args.file_path==="string"?args.file_path:undefined;
    if(path===undefined)return tool==="ls"?".":undefined;
    const rel=path.startsWith("/")?relative(cwd,path):path;return clip(rel===""?".":rel);
  }
  if(tool==="bash"&&typeof args.command==="string")return clip(args.command);
  if(tool==="git_commit"&&typeof args.message==="string")return clip(args.message.split("\n")[0]);
  if(tool==="delegate"&&typeof args.role==="string")return clip(args.role);
  if(tool===ASK_USER_TOOL&&typeof args.question==="string")return clip(args.question);
}
const DEFAULT_REASONING:RoleReasoning="medium"; // Pi's DEFAULT_THINKING_LEVEL when no level is requested
type RecordRow = { id:string; cwd:string; file:string; managerId:string|null; dispatchStarted?:boolean; archivedAt?:number|null; model:string; policy:SessionPolicy|null; status:SessionView["status"]; parentId:string|null; role:string; rootId?:string; ancestors?:string[] };
const ORCHESTRATOR_PROMPT=`You are the orchestrator. Before starting any work, classify the task against the criteria below, then choose the agents with the delegate tool. If the user states the mode or size in their message, follow it without asking. If the criteria do not clearly determine the size, do NOT guess and do not start work. The size is unclear when: the request is vague or open-ended (e.g. 'improve', 'clean up', 'make it better', 'refactor this project') without naming specific files, behaviour or an expected outcome; the scope could reasonably be read as either a small fix or a broad change; or the task sits on the border of two sizes. In those cases ask before doing anything, including before delegating to a planner or researcher. To ask: call the ask_user tool with one short question and the two candidate sizes as options, each option saying what that size would mean, then wait for the answer. For example: question "This looks between medium and complex. Which do you prefer?", options "Medium" (I implement via a worker and get it reviewed) and "Complex" (a planner first, then worker, reviewer). Asking one extra question is better than guessing.

Small: do it yourself and delegate nothing. Use this when ALL of these hold:
- It is a question, an explanation or a lookup, or it needs only reading code to answer.
- Any change is confined to one file and is roughly 20 changed lines or fewer, or is a single function.
- It is a rename, a typo fix or a config tweak.
- It adds no new files except trivial ones, needs no design decisions, and needs no new tests beyond a one-line update.

Medium: delegate to a worker, then a reviewer. Use this when the task is a focused feature or fix and:
- It touches about 2 to 5 files or roughly 20 to 200 changed lines.
- It adds a function, endpoint or component that follows an existing pattern.
- It includes adding or updating the tests and docs for that change.
- The approach is obvious from the existing code, with no new architecture, dependencies or data model changes.

Complex: delegate a planner (plus a researcher when needed), then one or more workers, then a reviewer, then qa. Use this when ANY of these hold:
- A new module, subsystem or feature spanning several components or layers.
- More than about 5 files or about 200 changed lines.
- Design choices or trade-offs must be made.
- Non-trivial algorithms: parsing, concurrency, state machines, security, data migrations.
- Unfamiliar code areas, or external APIs or libraries that need investigation.
- Ambiguous requirements, or a cross-cutting refactor.
How to run a complex task:
- Use a researcher when facts about the codebase, the docs or external APIs must be gathered before planning.
- Use a planner to turn the findings into a concrete plan.
- If the plan has independent parts, split it into several worker tasks.
- Add qa when there is a browser UI to verify.

Rules for every delegation:
- Make each task self-contained. Agents do not see this conversation, so give each one the goal, the relevant files, the constraints and the plan.
- Only workers edit files. Planner and researcher are read-only.
- Workers' changes land in the working copy automatically when they finish: a single worker edits the working copy in place, and parallel workers are merged automatically. Independent parts of a task can be given to parallel workers; steps that depend on each other must be sequential (wait for one worker's result before delegating the next). Call the reviewer only after the worker(s) finished and each delegate result says the changes are applied. If a result says the merge is pending (changes not integrated), tell the user and do not review until it is resolved. When you call the reviewer, name exactly which files changed and what to check.
- If the reviewer finds problems, fix them yourself or through a worker, and review again when the fix was not trivial.
- Each agent runs on the model and reasoning the user configured for its role.
- There is no limit on the number of agents. Use as many as the task genuinely needs, and never delegate a small task.
- If a delegation fails, continue the work yourself.
- You and your agents can run shell commands with the bash tool (tests, builds, linters, git, package managers, curl). Tell each worker to run the project's tests and build after its changes and to fix what fails; tell each reviewer to run the tests and build to verify the work instead of only reading the diff. Report failures honestly: say which command failed and why, and never claim that something passes unless you saw it pass.`;
type DelegationContext = {root:RecordRow;depth:number;ancestors:string[];canDelegate:boolean};
type Active = { session:AgentSession; row:RecordRow; unsubscribe:()=>void; metadata?:RunMetadata };
type ApprovalMode="full"|"ask";
// Tools a user may allow for a whole chat. Commits stay one decision each: every commit shows its own message and diff.
const GRANTABLE_TOOLS=new Set(["read","ls","edit","write","bash","browser_action","qa_action"]);
type Pending = { sessionId:string; agentId:string; tool:string; ready:Promise<void>; resolve:(allow:boolean)=>void; timer:ReturnType<typeof setTimeout>; finalizing?:Promise<void> };
type ChildRun = { row:RecordRow; cancelled:boolean; stop?:Promise<void>; done:Promise<void>;registered?:boolean;solo?:boolean;working?:Promise<void> };
type AutoMerger=(rootId:string,workerId:string)=>Promise<{status:"applied"|"empty"|"pending";reason?:string}>;
type PromptAdmission = { unresolvedOwner?:boolean;cleanup?:boolean; id:string;cancelled:boolean;done:Promise<void>;check:()=>void };
type WriteApproval = {id:string;sessionId:string;agentId:string;status:string;outcome:WriteOutcome|null;change:FileChange|null;commandId:string|null;commandStatus:string|null};
type Send = (sessionId:string,type:string,payload:unknown, durable?:boolean)=>Promise<void>;

export function readPiHistory(path:string,managerDir:string,managerId:string|null,cwd:string){
  const absolute=resolve(path),root=resolve(managerDir),rel=relative(root,absolute);
  if(!rel||rel===".."||rel.startsWith(`..${sep}`)||lstatSync(absolute).isSymbolicLink())throw new Error("Pi history path is outside its saved session directory");
  const info=lstatSync(absolute);if(!info.isFile()||info.nlink!==1)throw new Error("Pi history must be one regular file");
  const fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:Buffer;try{bytes=readFileSync(fd);}finally{closeSync(fd);}
  let content:string;try{content=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{throw new Error("Pi history is not valid UTF-8");}
  if(!content||!content.endsWith("\n"))throw new Error("Pi history is empty or incomplete");
  const lines=content.slice(0,-1).split("\n");let header:any;const entries:unknown[]=[],ids=new Set<string>(),known=new Set(["message","thinking_level_change","model_change","compaction","branch_summary","custom","custom_message","session_info","usage","label","context_edit"]);
  try{for(const [index,line] of lines.entries()){if(!line)throw new Error();const entry=JSON.parse(line);entries.push(entry);if(index===0){header=entry;if(entry?.type!=="session"||entry.version!==3||typeof entry.id!=="string"||typeof entry.timestamp!=="string"||typeof entry.cwd!=="string")throw new Error();continue;}if(!entry||!known.has(entry.type)||typeof entry.id!=="string"||ids.has(entry.id)||!(entry.parentId===null||typeof entry.parentId==="string"&&ids.has(entry.parentId))||typeof entry.timestamp!=="string")throw new Error();
    if(entry.type==="message"&&(!entry.message||typeof entry.message.role!=="string"||!Array.isArray(entry.message.content)&&typeof entry.message.content!=="string"))throw new Error();
    if(entry.type==="thinking_level_change"&&typeof entry.thinkingLevel!=="string")throw new Error();
    if(entry.type==="model_change"&&(typeof entry.provider!=="string"||typeof entry.modelId!=="string"))throw new Error();
    ids.add(entry.id);
  }}catch{throw new Error("Pi history contains an invalid or unsupported JSONL entry");}
  if(header?.type!=="session"||managerId!==null&&header.id!==managerId||typeof header.cwd!=="string"||resolve(header.cwd)!==resolve(cwd))throw new Error("Pi history header differs from the saved manager identity");
  return {path:absolute,id:header.id,entries};
}
/** Mirrors SessionManager.open(path,dir,cwd), whose cwdOverride branch goes straight to this private constructor, but passes the entries readPiHistory already parsed so a large history is read and parsed once. */
export function openPiHistory(path:string,managerDir:string,cwd:string,entries:unknown[]):SessionManager{
  return new (SessionManager as unknown as new(cwd:string,sessionDir:string,sessionFile:string,persist:boolean,options:undefined,entries:unknown[])=>SessionManager)(cwd,managerDir,path,true,undefined,entries);
}

const delegateDescription=(profile:{maxDepth:number;childTimeoutMs:number})=>`Start a bounded child Pi agent (planner, researcher, worker, reviewer or qa). Planner and researcher are read-only. Each agent runs on the model and reasoning the user mapped to its role. Maximum depth ${profile.maxDepth}; each child has a ${profile.childTimeoutMs/1000}s timeout. Child work is not automatically verified.`;

// Snapshots are read on every chat switch and after every reply; rebuild the visible messages only when the history changed.
// Pi appends finished messages (message_end) and replaces the array on compaction, so array, length, last message and entry count identify a version.
const visibleCache=new WeakMap<AgentSession,{messages:unknown;length:number;last:unknown;entries:number;cwd:string;view:SessionView["messages"]}>();
export function cachedVisibleMessages(session:AgentSession,cwd:string):SessionView["messages"]{
  const messages=session.messages as unknown[],entries=Number((session as any).sessionManager?.fileEntries?.length??-1),hit=visibleCache.get(session);
  if(hit&&hit.messages===messages&&hit.length===messages.length&&hit.last===messages[messages.length-1]&&hit.entries===entries&&hit.cwd===cwd&&entries>=0)return hit.view;
  const view=visibleMessages(session,cwd);visibleCache.set(session,{messages,length:messages.length,last:messages[messages.length-1],entries,cwd,view});return view;
}
/** Keeps the work steps of the latest turn only; earlier turns carry `stepCount` and are read on demand. Returns new message objects, never mutates the cached view. */
export function trimWorkSteps(messages:SessionView["messages"]):SessionView["messages"]{
  let last=-1;for(let i=messages.length-1;i>=0;i--)if(messages[i].role==="user"){last=i;break;}
  return messages.map((message,index)=>message.work&&index!==last&&message.work.steps.length?{...message,work:{startedAt:message.work.startedAt,endedAt:message.work.endedAt,steps:[],stepCount:message.work.steps.length}}:message);
}

export function visibleMessages(session:AgentSession,cwd:string):SessionView["messages"] {
  const out:SessionView["messages"]=[],results=new Map<string,boolean>();
  for(const message of session.messages as any[])if(message.role==="toolResult"&&typeof message.toolCallId==="string")results.set(message.toolCallId,!!message.isError);
  // A message's own timestamp is when it began streaming; the JSONL entry is stamped when it finished, so it gives the real end of a stopped or final reply.
  const saved=new Map<unknown,number>();try{for(const entry of (session as any).sessionManager?.getEntries?.()??[])if(entry?.type==="message"){const t=Date.parse(entry.timestamp);if(Number.isFinite(t))saved.set(entry.message,t);}}catch{}
  let turn:{startedAt:number;endedAt:number;steps:WorkStep[]}|undefined,owner:SessionView["messages"][number]|undefined;
  const close=()=>{if(turn&&owner&&turn.steps.length)owner.work={...turn,steps:turn.steps.slice(-200)};turn=owner=undefined;};
  (session.messages as any[]).forEach((message,index)=>{
    const at=typeof message.timestamp==="number"?message.timestamp:undefined;
    if(message.role==="user"){
      close();const text=stripMentionContext(typeof message.content==="string"?message.content:message.content.filter((part:any)=>part.type==="text").map((part:any)=>part.text).join(""));
      const images=typeof message.content==="string"?0:message.content.filter((part:any)=>part.type==="image").length;
      if(!text&&!images)return;owner={id:String(index),role:"user",text,...(images?{images}:{}),...(at!==undefined?{at}:{})};out.push(owner);turn={startedAt:at??0,endedAt:at??0,steps:[]};return;
    }
    if(message.role!=="assistant"&&message.role!=="toolResult")return;
    if(turn)turn.endedAt=Math.max(turn.endedAt,at??0,saved.get(message)??0);
    if(message.role==="toolResult")return;
    const parts:any[]=Array.isArray(message.content)?message.content:[],text=parts.filter(part=>part.type==="text").map(part=>part.text).join(""),calls=parts.filter(part=>part.type==="toolCall");
    // A delivered ask_user call makes this message the visible reply that carries the question; a blocked or failed call shows nothing extra.
    const askCall=calls.find(call=>call.name===ASK_USER_TOOL&&results.get(call.id)===false),question=askCall?askQuestion(askCall.arguments):undefined,interim=!question&&!!text&&calls.length>0;
    if(turn)for(const part of parts){
      if(part.type==="thinking"&&!part.redacted){const t=String(part.thinking??"").trim().slice(0,8000);if(t)turn.steps.push({kind:"thinking",text:t});}
      else if(part.type==="text"&&interim){const t=String(part.text).trim();if(t)turn.steps.push({kind:"note",text:t});}
      else if(part.type==="toolCall"){const detail=toolDetail(cwd,part.name,part.arguments),failed=results.get(part.id);turn.steps.push({kind:"tool",tool:part.name,...(detail?{detail}:{}),status:failed===undefined?"running":failed?"error":"done"});}
    }
    if(question)out.push({id:String(index),role:"assistant",text:text.trim()?`${text.trim()}\n\n${question.question}`:question.question,...(at!==undefined?{at}:{}),question});
    else if(text)out.push({id:String(index),role:"assistant",text,...(at!==undefined?{at}:{}),...(interim?{interim:true as const}:{})});
  });
  close();return out;
}

export class PiHost {
  providerAuth!:ProviderAuth;
  nativeProviders!:NativeCli;
  cliproxyProviders!:CliproxyProvider;
  private agy?:ReturnType<typeof registerAgyUnsupervisedProvider>;
  private nativeIdentity?:(model?:import("@earendil-works/pi-ai").Model<any>)=>boolean;
  private runtime:ModelRuntime | null=null;
  private active = new Map<string,Active>();
  /** Loaded sessions kept in memory; idle ones beyond this are unloaded and reopened from disk on next use. */
  maxLoaded=Math.max(1,Number(process.env.SIGMA_MAX_LOADED_SESSIONS)||8);
  /** A session used within this window is never unloaded: a request may still hold its Active across awaits. */
  idleMs=30_000;
  private used=new Map<string,number>();
  private viewerCheck:(id:string)=>boolean=()=>false;
  private trimTimer?:ReturnType<typeof setInterval>;
  private trimQueued=false;
  private loading = new Map<string,Promise<Active>>();
  private pending = new Map<string,Pending>();
  private mode:ApprovalMode="full";
  // Tools the user allowed for the rest of a chat (keyed by root session); held in memory, so a restart asks again.
  private grants=new Map<string,Set<string>>();
  private autoMerger?:AutoMerger;
  setAutoMerger(merger:AutoMerger|undefined){this.autoMerger=merger;}
  /** Sessions with a live event stream (or whose root has one) are never unloaded. */
  setViewerCheck(check:(id:string)=>boolean){this.viewerCheck=check;}
  loadedCount(){return this.active.size;}
  isLoaded(id:string){return this.active.has(id);}
  private modeSave:Promise<void>=Promise.resolve();
  private approvalFinalizers = new Set<Promise<void>>();
  private children = new Map<string,ChildRun>();
  private admittingChildren = new Set<string>();
  private promptAdmissions = new Set<PromptAdmission>();
  private stopping = new Set<string>();
  private archiving = new Set<string>();
  private stoppingTasks = new Set<string>();
  private repoDispatching = new Set<string>();
  private gitReservations = new Set<string>();
  private runningChildren=0;
  private graphInputs=new Map<string,{row:RecordRow;text:string;fact:GraphFact;entries:Set<string>}>();
  private graphUserReceipts=new Set<string>();
  private deltas=new Map<string,{parts:string[];timer:ReturnType<typeof setTimeout>}>();
  private qa?:Qa;
  private browserUse?:BrowserUse;
  private closing=false;
  private closeWork?:Promise<void>;
  private background=new Set<Promise<unknown>>();
  private backgroundFailure=false;
  private bashExits=new Map<string,string>();
  private protectPath:PathGuard=()=>{throw new Error("Credential guard unavailable");};
  constructor(private storage:Storage,private dataDir:string,private send:Send,private shellControlPlanePorts:readonly number[]=[]){ }
  /** Enables QA tool registration for role "qa" sessions that start while a user-approved run is active. */
  attachQa(qa:Qa){this.qa=qa;}
  attachBrowserUse(browserUse:BrowserUse){this.browserUse=browserUse;}
  private track(work:Promise<unknown>){this.background.add(work);void work.then(()=>{this.background.delete(work);},()=>{this.background.delete(work);this.backgroundFailure=true;});}
  async init(){await chmod(this.dataDir,0o700);sweepCrashTemps(this.dataDir);this.protectPath=credentialGuard([join(this.dataDir,"sigma.lock"),join(this.dataDir,"git-intents"),join(this.dataDir,"cliproxyapi"),join(this.dataDir,"antigravity-profile"),join(this.dataDir,"browser-use"),join(this.dataDir,"agent"),getAgentDir(),chromeUserDataDir()]);await mkdir(join(this.dataDir,"sessions"),{recursive:true,mode:0o700});await mkdir(join(this.dataDir,"agent"),{recursive:true,mode:0o700});this.runtime=await ModelRuntime.create();if((process.env.SIGMA_DEMO??process.env.PI_ORCH_DEMO)==="1")registerDemoProvider(this.runtime);await this.loadApprovalMode();this.trimTimer=setInterval(()=>this.trimLoaded(),60_000);this.trimTimer.unref();this.nativeProviders=new NativeCli(this.dataDir);await this.nativeProviders.init();this.nativeIdentity=registerClaudeProvider(this.runtime,this.nativeProviders).identity;this.agy=registerAgyUnsupervisedProvider(this.runtime,this.nativeProviders);await this.runtime.refresh({allowNetwork:false});this.cliproxyProviders=new CliproxyProvider(this.runtime,this.dataDir);this.cliproxyProviders.init();this.providerAuth=new ProviderAuth(this.runtime);}
  private async availableModels(){
    // SDK auth checks can throw errors containing credentials, even for an
    // unrelated provider with no models. Every availability consumer is fenced.
    try{this.nativeIdentity?.();return (await this.runtime!.getAvailable()).filter(model=>this.modelAllowed(model));}catch{throw new Error("Model availability could not refresh");}
  }
  async models(){const all=await this.availableModels(),old=new Set([...previousGeneration(all),...geminiNonFlash(all)]);return all.map(m=>({provider:m.provider,id:m.id,name:m.name,images:!!m.input?.includes("image"),reasoningLevels:getSupportedThinkingLevels(m),...(old.has(`${m.provider}/${m.id}`)?{legacy:true}:{})}));}
  async acceptsImages(id:string){return !!(await this.get(id)).session.model?.input?.includes("image");}
  async roles():Promise<RoleCatalog>{const stored=await this.storage.call<unknown|null>("roles");return stored?normalizeRoles(stored):defaultRoles();}
  async saveRoles(value:unknown){
    const catalog=roleInput(value),models=await this.availableModels();
    for(const item of catalog.roles)if(item.model){
      const model=models.find(model=>`${model.provider}/${model.id}`===item.model);
      if(!model)throw new Error("Configured model is unavailable");
      if(item.reasoning&&!getSupportedThinkingLevels(model).includes(item.reasoning))throw new Error("Reasoning level is unavailable for the configured model");
    }
    return this.storage.call<RoleCatalog>("saveRoles",{catalog});
  }
  private assertRole(key:string,role:SessionRole,models:Awaited<ReturnType<ModelRuntime["getAvailable"]>>){
    const model=models.find(model=>`${model.provider}/${model.id}`===key);
    if(!model)throw new Error("Configured role model is unavailable; update roles or select a model explicitly");
    if(role.requestedReasoning&&!getSupportedThinkingLevels(model).includes(role.requestedReasoning))throw new Error("Configured role reasoning is unavailable for this model");
  }
  /** A role on "Same as chat model" whose saved level the chat model lacks falls back to the model default instead of failing. */
  private fitReasoning(resolved:{model:string;role:SessionRole},chatModel:string){
    const level=resolved.role.requestedReasoning,model=level&&resolved.model===chatModel?this.model(resolved.model):undefined;
    if(model&&!getSupportedThinkingLevels(model).includes(level!))resolved.role.requestedReasoning=null;
    return resolved;
  }
  private async roleSelection(type:RoleType,inheritedModel:string,catalog?:RoleCatalog,reasoning?:RoleReasoning){
    const resolved=this.fitReasoning(resolveRole(catalog??await this.roles(),type,inheritedModel),inheritedModel);if(reasoning){const chosen=this.model(resolved.model);if(chosen&&!getSupportedThinkingLevels(chosen).includes(reasoning))throw new Error("Reasoning level is unavailable for the selected model");resolved.role.requestedReasoning=reasoning;}
    if(type!=="root"&&resolved.model.startsWith(`${AGY_UNSUPERVISED_PROVIDER_ID}/`))throw new Error("The unsupervised Antigravity model is available to root sessions only");
    this.assertRole(resolved.model,resolved.role,await this.availableModels());return resolved;
  }
  private profile(mode:SessionMode,workspaceMode:WorkspaceMode){
    return mode==="multi"?MULTI_REPO_PROFILE:mode==="parallel"?(workspaceMode==="direct"?NESTED_PARALLEL_PROFILE:NESTED_PARALLEL_WORKTREE_PROFILE):mode==="code"?(workspaceMode==="direct"?NESTED_CODE_PROFILE:NESTED_REPOSITORY_PROFILE):NESTED_READ_PROFILE;
  }
  private async assertSetupSource(setup:WorkspaceSetup){
    if(!setup.sourceCwd||!setup.baseCommit)return;
    const current=await describeGitRoot(setup.sourceCwd,setup.baseCommit);
    for(const key of ["sourceCwd","sourceDev","sourceIno","gitDir","gitDev","gitIno","commonDir","commonDev","commonIno","baseCommit"] as const)if(current[key]!==setup[key])throw new Error("Source Git identity changed since setup was frozen");
    if(setup.sourceHead&&current.head!==setup.sourceHead)throw new Error("Source HEAD changed since setup was frozen");
    if(setup.workspaceMode==="direct"&&setup.sourceBaseline&&setup.sourceBaseline!==current.sourceBaseline)throw new Error("Direct source contents changed since setup was frozen");
  }
  private async setupDescriptor(input:{kind:WorkspaceSetup["kind"];id:string;commandId:string;sessionId:string;cwd:string;model:string;sessionMode:SessionMode;workspaceMode?:WorkspaceMode;baseCommit?:string;role?:SessionRole;taskId?:string;repositoryId?:string;parentId?:string;rootId?:string;agentRole?:string;policyVersion?:1|2;requestedCwd?:string;requestedModel?:string;profile?:SessionPolicy["effective"]["profile"];inPlaceCwd?:string}):Promise<WorkspaceSetup>{
    const data=await realpath(this.dataDir),managerDir=await realpath(join(data,"sessions"));
    const setup:WorkspaceSetup={version:1,kind:input.kind,phase:"reserved",policyVersion:input.policyVersion??(input.sessionMode==="multi"?1:2),id:input.id,commandId:input.commandId,sessionId:input.sessionId,managerId:input.sessionId,managerDir,...(input.agentRole?{agentRole:input.agentRole}:{}),cwd:input.sessionMode==="multi"?join(data,"tasks",input.taskId!):input.workspaceMode==="worktree"?join(data,"workspaces",input.sessionId):await realpath(input.cwd),sessionMode:input.sessionMode,model:input.model,...(input.role?{role:input.role}:{}),profile:structuredClone(input.profile??this.profile(input.sessionMode,input.workspaceMode??"direct")),...(input.taskId?{taskId:input.taskId}:{}),...(input.repositoryId?{repositoryId:input.repositoryId}:{}),...(input.parentId?{parentId:input.parentId}:{}),...(input.rootId?{rootId:input.rootId}:{})};
    if(input.sessionMode!=="read"&&input.sessionMode!=="multi"){
      const identity=await describeGitRoot(input.cwd,input.baseCommit);Object.assign(setup,{sourceCwd:identity.sourceCwd,sourceDev:identity.sourceDev,sourceIno:identity.sourceIno,sourceHead:identity.head,sourceBaseline:identity.sourceBaseline,gitDir:identity.gitDir,gitDev:identity.gitDev,gitIno:identity.gitIno,commonDir:identity.commonDir,commonDev:identity.commonDev,commonIno:identity.commonIno,baseCommit:identity.baseCommit,workspaceMode:input.workspaceMode??"direct",cwd:input.workspaceMode==="worktree"?join(data,"workspaces",input.sessionId):identity.sourceCwd});
    }else if(input.sessionMode!=="multi"){
      const path=await realpath(input.cwd),info=lstatSync(path);setup.cwd=path;setup.cwdDev=info.dev;setup.cwdIno=info.ino;
    }
    if(input.inPlaceCwd){setup.cwd=await realpath(input.inPlaceCwd);setup.inPlace=true;}
    setup.agentRole=input.agentRole??"root";setup.requested={cwd:input.requestedCwd??(input.sessionMode==="multi"?setup.cwd:input.cwd),model:input.requestedModel??input.model,mode:input.sessionMode,...(setup.workspaceMode?{workspaceMode:setup.workspaceMode}:{})};
    return setup;
  }
  async prepareProjectTask(task:ProjectTaskView):Promise<ProjectTaskView>{
    const repositories=[];
    for(const repo of task.repositories){const selected=await this.roleSelection("root",task.model,task.roleCatalog,task.reasoning);repositories.push({...repo,setup:await this.setupDescriptor({kind:"task-repository",id:task.id,commandId:task.id,sessionId:repo.sessionId,cwd:repo.sourceCwd,model:selected.model,sessionMode:"parallel",workspaceMode:task.workspaceMode??"direct",baseCommit:repo.baseCommit,role:selected.role,taskId:task.id,repositoryId:repo.id,requestedModel:task.model})});}
    const selected=await this.roleSelection("coordinator",task.model,task.roleCatalog,task.reasoning);
    const coordinatorSetup=await this.setupDescriptor({kind:"task-coordinator",id:task.id,commandId:task.id,sessionId:task.coordinatorId,cwd:task.repositories[0].sourceCwd,model:selected.model,sessionMode:"multi",role:selected.role,taskId:task.id,requestedModel:task.model});
    return {...task,repositories,coordinatorSetup,setupVersion:1} as ProjectTaskView;
  }
  private async manager(row:RecordRow):Promise<SessionManager>{
    const managerDir=await realpath(join(await realpath(this.dataDir),"sessions"));let candidates=new Set<string>();
    const saved=resolve(row.file),savedRel=relative(managerDir,saved);
    if(savedRel&&savedRel!==".."&&!savedRel.startsWith(`..${sep}`)){try{lstatSync(saved);candidates.add(saved);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
    if(row.managerId){for(const name of readdirSync(managerDir))if(name.endsWith(`_${row.managerId}.jsonl`))candidates.add(join(managerDir,name));}
    if(candidates.size>1)throw new Error("Multiple Pi histories match the saved manager ID");
    let history:string|undefined,entries:unknown[]|undefined;
    if(candidates.size){const found=readPiHistory([...candidates][0],managerDir,row.managerId,row.cwd);history=found.path;entries=found.entries;if(!row.managerId){row.managerId=found.id;await this.storage.call("sessionManager",{id:row.id,managerId:found.id});}}
    else if(row.managerId===null)throw new Error("Saved Pi history is missing; legacy manager identity cannot be reconstructed");
    else if(row.dispatchStarted)throw new Error("Pi history is missing after prompt dispatch may have started; inspect-only recovery is required");
    if(history){const manager=openPiHistory(history,managerDir,row.cwd,entries!);if(manager.getSessionId()!==row.managerId)throw new Error("Pi manager ID changed while opening history");row.file=history;return manager;}
    const manager=SessionManager.create(row.cwd,managerDir,{id:row.managerId!}),file=manager.getSessionFile();if(!file)throw new Error("Pi manager did not reserve a history path");
    if(!await this.storage.call<boolean>("sessionFile",{id:row.id,managerId:row.managerId,file}))throw new Error("Pi manager path ownership changed");row.file=file;return manager;
  }
  async refreshModels(){await this.providerAuth.refresh();return this.models();}
  private modelAllowed(model:import("@earendil-works/pi-ai").Model<any>){
    if(!providerAllowed(model.provider))return false;
    if(model.provider===CLIPROXY_PROVIDER_ID)return this.cliproxyProviders.isConnected(model);
    if(model.provider===AGY_UNSUPERVISED_PROVIDER_ID)return !!this.agy?.identity(model)&&this.nativeProviders.isAgyUnsupervisedEnabled();
    return !NATIVE_PROVIDER_IDS.has(model.provider)||!!this.nativeIdentity?.(model)&&this.nativeProviders.isConnected();
  }
  /** Unsupervised AGY may only run in an isolated allocated workspace that cannot reach Sigma data, credentials or the whole home directory. */
  private assertUnsupervisedWorkspace(cwd:string){
    const real=realpathSync(cwd),within=(root:string,path:string)=>{const rel=relative(root,path);return rel===""||rel!==".."&&!rel.startsWith(`..${sep}`)&&!rel.startsWith("/");};
    const roots=[this.dataDir,join(this.dataDir,"agent"),getAgentDir(),join(this.dataDir,"cliproxyapi"),join(this.dataDir,"antigravity-profile"),join(this.dataDir,"git-intents"),join(this.dataDir,"sigma.lock"),process.env.HOME,process.env.SIGMA_DATA_DIR].filter((root):root is string=>!!root);
    for(const root of roots){let canonical=resolve(root);try{canonical=realpathSync(root);}catch{}for(const candidate of new Set([resolve(root),canonical]))if(within(real,candidate))throw new Error("Unsupervised Antigravity cannot run in a workspace that contains Sigma data, credentials or the home directory");}
    this.protectPath(real);
  }
  private model(key:string){const at=key.indexOf("/");if(at<1)return;const model=this.runtime!.getModel(key.slice(0,at),key.slice(at+1));return model&&this.modelAllowed(model)?model:undefined;}
  async create(cwd:string,modelKey:string,id:string=randomUUID(),mode:SessionMode="read",options?:{baseCommit?:string;workspaceMode?:WorkspaceMode;task?:{id:string;repositoryId:string};roleCatalog?:RoleCatalog;reasoning?:RoleReasoning;commandId?:string;recovery?:boolean}):Promise<string>{
    return this.withPromptAdmission(id,async admission=>{
    try{
    if(mode==="multi")throw new Error("Create a multi-repository task through its project");
    let path=await realpath(resolve(cwd));if(!(await stat(path)).isDirectory()) throw new Error("Workspace must be a directory");
    let taskSetup:WorkspaceSetup|undefined;
    if(options?.task){const task=await this.storage.call<ProjectTaskView|undefined>("projectTask",{id:options.task.id});taskSetup=task?.repositories.find(repo=>repo.id===options.task!.repositoryId)?.setup;if(!task?.setupVersion||!taskSetup||taskSetup.sessionId!==id)throw new Error("Task setup descriptor is not frozen");await this.assertSetupSource(taskSetup);}
    const selected=taskSetup?{model:taskSetup.model,role:taskSetup.role!}:await this.roleSelection("root",modelKey,options?.roleCatalog,options?.reasoning);
    admission.check();
    const model=this.model(selected.model);if(!model)throw new Error("Selected model is unavailable");
    const unsupervised=model.provider===AGY_UNSUPERVISED_PROVIDER_ID;
    if(unsupervised){
      // Every UI session is created as "parallel"; the unsupervised model runs as a plain repository code session and never delegates.
      if(mode==="parallel"&&!options?.task)mode="code";
      if(mode!=="code"||options?.workspaceMode!=="worktree"||options.task)throw new Error("Unsupervised Antigravity requires an isolated Git worktree code session");
    }
    const commandId=options?.commandId??id;
    if(!options?.task&&!options?.commandId)await this.storage.call("command",{id:commandId,sessionId:id,kind:"create",requestHash:createHash("sha256").update(JSON.stringify({cwd,modelKey,mode,options})).digest("hex")});
    let setup=options?.recovery?undefined:await this.setupDescriptor({kind:options?.task?"task-repository":"session",id:options?.task?.id??id,commandId,sessionId:id,cwd:path,model:selected.model,sessionMode:mode,workspaceMode:options?.workspaceMode??"direct",baseCommit:options?.baseCommit,role:selected.role,taskId:options?.task?.id,repositoryId:options?.task?.repositoryId,requestedModel:modelKey,requestedCwd:cwd,...(unsupervised?{profile:REPOSITORY_CODE_PROFILE}:{})});
    if(setup&&options?.task)setup=taskSetup;
    if(setup&&!options?.task&&!await this.storage.call<boolean>("commandSetup",{id:commandId,setup}))throw new Error("Session setup descriptor could not be saved");
    if(setup&&!options?.task){setup=await this.storage.call<WorkspaceSetup>("commandSetupPhase",{id:commandId,from:"reserved",to:"allocating"});}
    if(taskSetup&&!options?.recovery){const phase=await this.storage.call<ProjectTaskView|undefined>("taskSetupPhase",{id:options!.task!.id,sessionId:id,from:"reserved",to:"allocating"});if(!phase)throw new Error("Task setup phase changed; inspect before allocation");taskSetup=phase.repositories.find(repo=>repo.sessionId===id)!.setup;setup=taskSetup;}
    if(setup&&!options?.recovery)await this.assertSetupSource(setup);
    admission.check();
    const copy=mode!=="read"&&!options?.recovery?await createCodeWorkspace(path,this.dataDir,id,options?.baseCommit,options?.workspaceMode??"direct",admission.check):undefined;
    admission.check();
    if(copy)path=copy.cwd;
    if(unsupervised&&copy?.workspace.kind!=="worktree")throw new Error("Unsupervised Antigravity requires an isolated Git worktree code session");
    if(unsupervised)this.assertUnsupervisedWorkspace(path);
    if(taskSetup&&!options?.recovery){if(copy?.workspace.kind==="worktree"){const workspaceIdentity=await describeGitRoot(copy.cwd,copy.workspace.baseCommit);const info=await stat(copy.cwd);const gitInfo=await stat(workspaceIdentity.gitDir);await this.storage.call("taskSetupMemberIdentity",{id:options!.task!.id,sessionId:id,identity:{cwd:copy.cwd,workspaceGitDir:workspaceIdentity.gitDir,workspaceGitDev:gitInfo.dev,workspaceGitIno:gitInfo.ino,workspaceDev:info.dev,workspaceIno:info.ino}});taskSetup={...taskSetup,cwd:copy.cwd,workspaceGitDir:workspaceIdentity.gitDir,workspaceGitDev:gitInfo.dev,workspaceGitIno:gitInfo.ino,workspaceDev:info.dev,workspaceIno:info.ino,phase:"allocated"};setup=taskSetup;}else{await this.storage.call("taskSetupPhase",{id:options!.task!.id,sessionId:id,from:"allocating",to:"allocated"});taskSetup.phase="allocated";setup=taskSetup;}}
    if(setup&&!options?.task&&!options?.recovery){if(copy?.workspace.kind==="worktree"){const workspaceIdentity=await describeGitRoot(copy.cwd,copy.workspace.baseCommit),workspaceInfo=await stat(copy.cwd),gitInfo=await stat(workspaceIdentity.gitDir);setup=await this.storage.call<WorkspaceSetup>("commandSetupIdentity",{id:commandId,identity:{cwd:copy.cwd,workspaceGitDir:workspaceIdentity.gitDir,workspaceGitDev:gitInfo.dev,workspaceGitIno:gitInfo.ino,workspaceDev:workspaceInfo.dev,workspaceIno:workspaceInfo.ino}});}else setup=await this.storage.call<WorkspaceSetup>("commandSetupPhase",{id:commandId,from:"allocating",to:"allocated"});}
    const manager=SessionManager.create(path,join(this.dataDir,"sessions"),{id});
    const policy:SessionPolicy={version:setup?.policyVersion??2,requested:setup?.requested??{cwd,model:modelKey,mode},effective:{cwd:path,model:selected.model,profile:structuredClone(unsupervised?REPOSITORY_CODE_PROFILE:mode==="parallel"?(copy?.workspace.kind==="direct"?NESTED_PARALLEL_PROFILE:NESTED_PARALLEL_WORKTREE_PROFILE):copy?(copy.workspace.kind==="direct"?NESTED_CODE_PROFILE:NESTED_REPOSITORY_PROFILE):NESTED_READ_PROFILE)},role:selected.role,...(copy?{workspace:copy.workspace}:{}),...(options?.task?{task:options.task}:{}),...(setup?{setup}:{}),...(unsupervised?{unsupervised:true as const}:{})};
    const row:RecordRow={id,cwd:path,file:manager.getSessionFile()!,managerId:id,model:selected.model,policy,status:"idle",parentId:null,role:"root"};
    await this.storage.call("addSession",{...row,managerId:id,creation:{source:"user",actor:"user",cause:options?.task?"multi_repo_setup":"user_create",commandId:options?.task?.id??id}});
    if(taskSetup&&!options?.recovery){await this.storage.call("taskSetupPhase",{id:options!.task!.id,sessionId:id,from:"allocated",to:"registered"});}
    if(setup&&!options?.task&&!options?.recovery)setup=await this.storage.call<WorkspaceSetup>("commandSetupPhase",{id:commandId,from:"allocated",to:"registered"});
    try{admission.check();await this.open(row,manager);admission.check();}catch(error){await this.setStatus(row,"error");throw error;}
    if(taskSetup&&!options?.recovery)await this.storage.call("taskSetupPhase",{id:options!.task!.id,sessionId:id,from:"registered",to:"opened"});
    if(setup&&!options?.task&&!options?.recovery)await this.storage.call("commandSetupPhase",{id:commandId,from:"registered",to:"opened"});
    await this.send(row.id,"session_created",{id:row.id},true);
    if(!options?.task&&!options?.commandId)await this.storage.call("commandStatus",{id:commandId,status:"completed"});
    return row.id;
    }catch(error){if(!options?.task&&!options?.commandId){const state=await this.storage.call<any>("commandSetupGet",{id});if(state)await this.storage.call("commandTransition",{id,from:"accepted",to:state.setup&&state.setup.phase!=="reserved"?"unknown":"rejected"});}throw error;}
    });
  }
  async createCoordinator(task:ProjectTaskView):Promise<string>{
    return this.withPromptAdmission(task.coordinatorId,async admission=>{
    const setup=task.coordinatorSetup;if(!setup||!task.setupVersion)throw new Error("Task setup descriptor is not frozen");
    const selected={model:setup.model,role:setup.role!};
    admission.check();
    const model=this.model(selected.model);if(!model)throw new Error("Saved coordinator model is unavailable; update provider authentication before continuing");
    const cwd=setup.cwd;
    if(setup.phase!=="reserved")throw new Error("Task coordinator setup is unresolved; inspect it before allocation");
    await this.storage.call("taskSetupPhase",{id:task.id,sessionId:task.coordinatorId,from:"reserved",to:"allocating"});
    admission.check();const parent=dirname(cwd);await mkdir(parent,{recursive:true,mode:0o700});if(await realpath(parent)!==parent)throw new Error("Task directory parent resolves outside application data");
    try{lstatSync(cwd);throw new Error("Task coordinator path already exists without a saved filesystem identity");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    admission.check();await mkdir(cwd,{mode:0o700});const cwdInfo=await stat(cwd);
    const saved=await this.storage.call<ProjectTaskView>("taskSetupCoordinatorIdentity",{id:task.id,identity:{cwdDev:cwdInfo.dev,cwdIno:cwdInfo.ino}});
    admission.check();
    const manager=SessionManager.create(cwd,join(this.dataDir,"sessions"),{id:task.coordinatorId});
    const policy:SessionPolicy={version:1,requested:{cwd,model:task.model,mode:"multi"},effective:{cwd,model:selected.model,profile:structuredClone(MULTI_REPO_PROFILE)},role:selected.role,setup:saved.coordinatorSetup!,task:{id:task.id}};
    const row:RecordRow={id:task.coordinatorId,cwd,file:manager.getSessionFile()!,managerId:task.coordinatorId,model:selected.model,policy,status:"idle",parentId:null,role:"root"};
    await this.storage.call("addSession",{...row,managerId:task.coordinatorId,creation:{source:"user",actor:"user",cause:"multi_repo_setup",commandId:task.id}});
    await this.storage.call("taskSetupPhase",{id:task.id,sessionId:task.coordinatorId,from:"allocated",to:"registered"});
    try{admission.check();await this.open(row,manager);admission.check();}catch(error){await this.setStatus(row,"error");throw error;}
    await this.storage.call("taskSetupPhase",{id:task.id,sessionId:task.coordinatorId,from:"registered",to:"opened"});
    await this.send(row.id,"session_created",{id:row.id},true);
    return row.id;
    });
  }
  private async open(row:RecordRow,provided?:SessionManager):Promise<Active>{
    const manager=provided??await this.manager(row);
    if(this.closing)throw new Error("Service is shutting down");
    const context=await this.storage.call<DelegationContext>("delegationContext",{id:row.id});
    if(this.closing)throw new Error("Service is shutting down");
    row.rootId=context.root.id;row.ancestors=context.ancestors;
    const channel=row.rootId;
    const unsupervised=row.model.startsWith(`${AGY_UNSUPERVISED_PROVIDER_ID}/`);
    if(unsupervised){
      if(row.policy?.unsupervised!==true||row.parentId||row.policy.requested.mode!=="code"||row.policy.workspace?.kind!=="worktree")throw new Error("Unsupervised Antigravity is limited to root worktree code sessions");
      this.assertUnsupervisedWorkspace(row.cwd);
      this.agy!.bind(row.id,{cwd:row.cwd,check:()=>this.assertUnsupervisedWorkspace(row.cwd),activity:record=>{this.track(this.send(row.id,"agy_activity",{agentId:row.id,...record},true));}});
    }else if(row.policy?.unsupervised)throw new Error("Unsupervised snapshot does not match the saved model");
    const canDelegate=context.canDelegate&&!unsupervised;
    // QA tools exist only for qa-role child sessions while an approved run exists; the tool_call gate and each execution re-check it.
    const qaEnabled=!!this.qa&&row.role==="qa"&&!!row.parentId&&!unsupervised&&await this.qa.hasApprovedRun(context.root.id);
    // The independent revision reviewer (never a delegated reviewer) gets one read-only artifact tool, bound to its own review row.
    const qaReviewer=!!this.qa&&row.role==="reviewer"&&!!row.parentId&&!unsupervised&&await this.storage.call<boolean>("reviewAgent",{agentId:row.id});
    const profile=row.policy?.effective.profile??READ_ONLY_PROFILE;
    // Shell access: root sessions that can write, and every delegated agent. Never the unsupervised AGY route, multi-repo coordinators (no tools) or the independent revision reviewer.
    const bashEnabled=!unsupervised&&!qaReviewer&&profile.tools.length>0&&(!!row.parentId||(profile.tools as readonly string[]).includes("write"));
    // Root agents may ask the user a question with suggested answers; delegated agents report back to their parent instead.
    const askEnabled=!row.parentId&&!unsupervised&&!qaReviewer;
    const browserToolsEnabled=!!this.browserUse&&row.id===context.root.id&&row.role==="root"&&!row.parentId&&!unsupervised&&profile.tools.length>0;
    const task=row.policy?.requested.mode==="multi"&&row.policy.task?await this.storage.call<ProjectTaskView|undefined>("projectTask",{id:row.policy.task.id}):undefined;
    const settings=SettingsManager.inMemory();
    const loader=new DefaultResourceLoader({cwd:row.cwd,agentDir:join(this.dataDir,"agent"),settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,appendSystemPrompt:canDelegate&&!row.parentId?[ORCHESTRATOR_PROMPT]:[],extensionFactories:[{
      name:"approval-gate",factory:(pi)=>{
      for(const tool of inspectionTools(row.cwd,this.protectPath,(tool,preview)=>this.requestApproval(row,tool,preview),()=>this.isStopping(row)))pi.registerTool(tool);
      if(row.policy?.workspace){
        const applied=new Set<string>();
        for(const tool of mutationTools(row.cwd,async(tool,change,toolCallId)=>{
          await this.storage.call("commandInput",{id:`pi-tool:${row.id}:${toolCallId}`,text:change.path});
          return this.requestApproval(row,tool,`${tool} ${change.path}`,change,`pi-tool:${row.id}:${toolCallId}`);
        },(id,outcome)=>this.writeOutcome(row,id,outcome),()=>this.isStopping(row),toolCallId=>applied.add(toolCallId),async(path,approvalId)=>{await this.assertDirectReady(row,true,approvalId);await assertWorkspaceHead(row.cwd,row.policy!.workspace!);if(row.policy!.workspace!.kind==="direct")assertNotIgnored(row.cwd,path);},path=>this.protectPath(resolve(row.cwd,path))))pi.registerTool({...tool,execute:(toolCallId,params,signal,onUpdate,ctx)=>this.journalTool(row,toolCallId,tool.name as "edit"|"write",params,()=>tool.execute(toolCallId,params,signal,onUpdate,ctx),{},()=>applied.has(toolCallId)?"unknown":"rejected",()=>applied.delete(toolCallId))});
      }
      if(bashEnabled)pi.registerTool(this.bashTool(row));
      if(askEnabled)pi.registerTool(askUserTool());
      if(qaEnabled)for(const tool of qaTools(this.qa!,{rootId:context.root.id,agentId:row.id,approve:async preview=>!!await this.requestApproval(row,"qa_action",preview)}))pi.registerTool(tool);
      if(qaReviewer)for(const tool of qaReviewTools(this.qa!,{rootId:context.root.id,reviewId:row.id,images:!!this.model(row.model)?.input?.includes("image")}))pi.registerTool(tool);
      if(browserToolsEnabled&&this.browserUse)for(const tool of this.browserUse.tools(row.id,()=>!!this.model(row.model)?.input?.includes("image"),async preview=>!!await this.requestApproval(row,"browser_action",preview)))pi.registerTool(tool);
      if(this.commitTool(row))pi.registerTool(defineTool({
        name:"git_commit",label:"Commit changes",
        description:"Commit all current working-tree changes in the selected folder with the given message. Write a concise message: a short imperative subject line (max 72 characters), optionally a blank line and a brief body. Call this tool directly when asked to commit; do not ask for confirmation in chat first. The tool itself presents the exact message and diff to the user for approval (or runs directly when the user has granted full access), so a separate chat confirmation only adds a redundant step. Repository hooks do not run.",
        parameters:Type.Object({message:Type.String({minLength:1,maxLength:4000})}),
        execute:(toolCallId,params)=>this.gitOperation(row,`pi-tool:${row.id}:${toolCallId}`,"commit",{message:commitMessage(params.message)},async(intent,save,admission)=>{
          const message=intent.message!,subject=message.split("\n")[0];
          const approved=await this.requestApproval(row,"git_commit",`git_commit ${subject} · ${intent.files!.length} files`,undefined,intent.id,{message,diff:intent.diff!,tree:intent.tree!,parent:intent.identity.head,files:intent.files!.map(file=>file.path)});
          if(!approved)throw new Error("Commit denied or approval unavailable");
          admission.check();const sha=await executeCommit(intent,save,admission.check,this.protectPath);
          return {content:[{type:"text",text:`Committed ${sha.slice(0,12)}: ${subject}`}],details:{sha}};
        }),
      }));
      if(canDelegate)pi.registerTool(defineTool({
        name:"delegate",label:"Delegate task",description:delegateDescription(profile),
        parameters:Type.Object({role:Type.Union([Type.Literal("planner"),Type.Literal("researcher"),Type.Literal("worker"),Type.Literal("reviewer"),Type.Literal("qa")]),task:Type.String({minLength:1,maxLength:4000})}),
        execute:async(toolCallId,params,signal)=>{
          const agentId=randomUUID();
          const result=await this.journalTool(row,toolCallId,"delegate",params,()=>this.delegate(row,agentId,params.role,params.task,signal,toolCallId),{inputText:params.task,behavior:params.role,agentId},async()=>{
            const child=await this.storage.call<RecordRow|undefined>("session",{id:agentId});
            const setup=await this.storage.call<any>("commandSetupGet",{id:`pi-tool:${row.id}:${toolCallId}`});
            return !child?(setup?.setup&&setup.setup.phase!=="reserved"?"unknown":"rejected"):setup?.setup?.phase==="dispatching"&&["error","interrupted"].includes(child.status)?"failed":"unknown";
          });
          const graphFact=await this.prepareReceipt(row,agentId,toolCallId,"delegate_result");
          return {content:[{type:"text",text:result}],details:{role:params.role,graphFact}};
        },
      }));
      if(task&&!row.parentId){
        const names=task.repositories.map(repo=>`${repo.id}: ${repo.sourceCwd}`).join("; ");
        pi.registerTool(defineTool({
          name:"delegate_repo",label:"Delegate to repository",
          description:`Send one bounded task to a repository agent. Allowed repository IDs and paths: ${names}. The result is only dispatch status; call repo_status for the agent result. At most two repository agents run at once. Direct work changes the selected folders after each approved edit.`,
          parameters:Type.Object({repositoryId:Type.String({minLength:1}),task:Type.String({minLength:1,maxLength:4000})}),
          execute:async(toolCallId,params,signal)=>{
            const repo=task.repositories.find(item=>item.id===params.repositoryId);
            if(!repo)throw new Error("Repository ID is not in this task");
            const result=await this.journalTool(row,toolCallId,"delegate",params,async()=>{
              if(signal?.aborted||this.isStopping(row)||this.stoppingTasks.has(task.id))throw new Error("Delegation cancelled");
              const current=await this.storage.call<ProjectTaskView|undefined>("projectTask",{id:task.id});
              if(current?.status!=="running")throw new Error("Task creation is unresolved; inspect repository sessions before continuing");
              const member=await this.storage.call<RecordRow|undefined>("session",{id:repo.sessionId});
              if(!member||member.parentId||member.policy?.task?.id!==task.id||member.policy.task.repositoryId!==repo.id||member.policy.workspace?.sourceCwd!==repo.sourceCwd||member.policy.workspace.baseCommit!==repo.baseCommit)throw new Error("Repository session is missing or differs from the saved task snapshot");
              if(member.status==="running"||this.repoDispatching.has(member.id))throw new Error("Repository agent is already running");
              this.repoDispatching.add(member.id);
              try{
                const active=await Promise.all(task.repositories.map(item=>this.storage.call<RecordRow|undefined>("session",{id:item.sessionId})));
                const busy=new Set(active.filter(item=>item?.status==="running").map(item=>item!.id));
                for(const item of task.repositories)if(this.repoDispatching.has(item.sessionId))busy.add(item.sessionId);
                if(busy.size>2)throw new Error("Two repository agents are already running");
                if(signal?.aborted||this.isStopping(row)||this.stoppingTasks.has(task.id))throw new Error("Delegation cancelled");
                const status=await this.prompt(member.id,params.task);
                return `Dispatched to repository ${repo.id} (session ${member.id}); status: ${status}. Call repo_status to inspect its result and approval requests.`;
              }finally{this.repoDispatching.delete(member.id);}
            },{inputText:params.task,behavior:repo.id,agentId:repo.sessionId});
            return {content:[{type:"text",text:result}],details:{repositoryId:repo.id,sessionId:repo.sessionId}};
          },
        }));
        pi.registerTool(defineTool({
          name:"repo_status",label:"Repository result",
          description:"Read a repository agent's saved status, recent conversation and pending approval count. A settled reply is not independent verification.",
          parameters:Type.Object({repositoryId:Type.String({minLength:1})}),
          execute:async(toolCallId,params)=>{
            const repo=task.repositories.find(item=>item.id===params.repositoryId);
            if(!repo)throw new Error("Repository ID is not in this task");
            const view=await this.snapshot(repo.sessionId);
            if(view.policy?.task?.id!==task.id||view.policy.task.repositoryId!==repo.id)throw new Error("Repository session differs from the saved task snapshot");
            const report={repositoryId:repo.id,sourceCwd:repo.sourceCwd,sessionId:repo.sessionId,status:view.status,pendingApprovals:view.approvals.filter(item=>item.status==="pending").length,uncertainActions:view.recoveryActions.length,recentMessages:view.messages.slice(-4).map(item=>({role:item.role,text:item.text.slice(0,4000)}))};
            const resultMessage=[...view.messages.slice(-4)].reverse().find(message=>message.role==="assistant"&&!message.interim)??[...view.messages.slice(-4)].reverse().find(message=>message.role==="assistant");
            const graphFact=resultMessage?await this.prepareReceipt(row,repo.sessionId,toolCallId,"repo_status",resultMessage.id):undefined;
            return {content:[{type:"text",text:JSON.stringify(report)}],details:{repositoryId:repo.id,sessionId:repo.sessionId,graphFact}};
          },
        }));
      }
      pi.on("agent_start",async(_event,ctx)=>{
        const native=this.active.get(row.id)?.session;
        if(!native)return;
        const metadata:RunMetadata={runId:randomUUID(),model:native.model?`${native.model.provider}/${native.model.id}`:row.model,reasoning:native.model?.reasoning?native.thinkingLevel:null,reasoningAvailability:native.model?native.model.reasoning?"available":"unsupported":"unavailable",title:native.sessionName??visibleMessages(native,row.cwd).find(message=>message.role==="user")?.text.slice(0,120)??null};
        const live=this.active.get(row.id);if(live)live.metadata=metadata;
        await this.storage.call("graphMetadata",{id:row.id,metadata});
      });
      // SDK turn_end supplies IDs only after SessionManager appended the messages.
      pi.on("turn_end",async(event,ctx)=>{
        const entries=ctx.sessionManager.getEntries(),native=this.active.get(row.id);
        const messageIndex=native?.session.messages.indexOf(event.message)??-1;
        if(messageIndex>=0)await this.storage.event(row.id,"graph_message",{messageIndex,entryId:event.messageEntryId,run:native?.metadata??null});
        for(const entryId of event.toolResultEntryIds){
          const entry=entries.find(entry=>entry.id===entryId);
          if(entry?.type!=="message"||entry.message.role!=="toolResult"||entry.message.isError)continue;
          const fact=(entry.message.details as {graphFact?:GraphFact}|undefined)?.graphFact;
          if(fact&&fact.target===row.id)await this.fact(row,{...fact,outcome:"received",receiptEntryId:entryId});
        }
        for(const [id,input] of this.graphInputs){
          if(input.row.id!==row.id)continue;
          const entry=entries.find(entry=>!input.entries.has(entry.id)&&!this.graphUserReceipts.has(`${row.id}:${entry.id}`)&&entry.type==="message"&&entry.message.role==="user"&&(typeof entry.message.content==="string"?entry.message.content:entry.message.content.filter(part=>part.type==="text").map(part=>(part as {text:string}).text).join(""))===input.text);
          if(entry){await this.fact(row,{...input.fact,outcome:"received",run:this.active.get(row.id)?.metadata??null,receiptEntryId:entry.id});this.graphInputs.delete(id);this.graphUserReceipts.add(`${row.id}:${entry.id}`);}
        }
      });
      pi.on("tool_call",async event=>{
        if(this.isStopping(row))return {block:true,reason:"Agent stopped"};
        if(event.toolName==="delegate"&&canDelegate)return;
        if(task&&!row.parentId&&(event.toolName==="delegate_repo"||event.toolName==="repo_status"))return;
        if(event.toolName==="git_commit"&&this.commitTool(row))return;
        if(event.toolName==="bash"&&bashEnabled)return;
        if(event.toolName===ASK_USER_TOOL&&askEnabled)return;
        if(isQaTool(event.toolName)){
          if(qaEnabled&&this.qa&&await this.qa.hasApprovedRun(context.root.id))return;
          return {block:true,reason:"QA tools require a QA session with a user-approved running QA run"};
        }
        if((QA_REVIEW_TOOLS as readonly string[]).includes(event.toolName)){
          if(qaReviewer)return;
          return {block:true,reason:"QA artifact viewing is limited to the independent revision reviewer"};
        }
        if(isBrowserTool(event.toolName)){
          if(browserToolsEnabled&&this.browserUse?.hasSelectedTarget(row.id)&&!!this.model(row.model)?.input?.includes("image"))return;
          return {block:true,reason:"Chrome tools require an image-capable model, an active supervised root session, and an explicitly selected Chrome tab"};
        }
        if(!(profile.tools as readonly string[]).includes(event.toolName))return {block:true,reason:"Tool disabled in this session profile"};
        // All enabled file tools own their approval and actual filesystem boundary.
        if(["read","ls","edit","write"].includes(event.toolName))return;
        return {block:true,reason:"Tool has no approved execution boundary"};
      });}
    }]});
    await loader.reload();
    if(this.closing)throw new Error("Service is shutting down");
    const selected=this.model(row.model);
    if(!selected)throw new Error("Saved model unavailable; select a model explicitly");
    // No saved level means Pi's default, not whatever level the journal last held (a switch back to "Default" leaves the old entry behind).
    const thinkingLevel=row.policy?.role?.requestedReasoning??(row.policy?.role&&!row.parentId?DEFAULT_REASONING:undefined); // delegated agents leave it undefined: the model's own default
    if(row.policy?.role?.requestedReasoning&&!getSupportedThinkingLevels(selected).includes(row.policy.role.requestedReasoning))throw new Error("Saved role reasoning unavailable; no fallback was used");
    const toolNames=task?[...profile.tools,"delegate_repo","repo_status"]:canDelegate?[...profile.tools,"delegate"]:[...profile.tools];
    if(this.commitTool(row))toolNames.push("git_commit");
    if(bashEnabled)toolNames.push("bash");
    if(askEnabled)toolNames.push(ASK_USER_TOOL);
    if(browserToolsEnabled)toolNames.push(...BROWSER_TOOLS);
    if(qaEnabled)toolNames.push(...QA_TOOLS);
    if(qaReviewer)toolNames.push(...QA_REVIEW_TOOLS);
    const {session,modelFallbackMessage}=await createAgentSession({cwd:row.cwd,model:selected,modelRuntime:this.runtime!,sessionManager:manager,settingsManager:settings,resourceLoader:loader,tools:toolNames,thinkingLevel});
    if(this.closing){session.dispose();throw new Error("Service is shutting down");}
    if(session.model&&NATIVE_PROVIDER_IDS.has(session.model.provider)&&(!this.nativeIdentity?.(session.model)||!this.nativeProviders.isConnected())){session.dispose();throw new Error("Native model configuration is blocked");}
    if(session.model?.provider===CLIPROXY_PROVIDER_ID&&!this.cliproxyProviders.isConnected(session.model)){session.dispose();throw new Error("Local proxy model configuration is blocked");}
    if(modelFallbackMessage){session.dispose();throw new Error("Saved model changed; reopen with explicit selection");}
    const details=new Map<string,string|undefined>();
    const unsubscribe=session.subscribe(event=>{
      if(event.type==="message_update"&&event.assistantMessageEvent.type==="text_delta"&&!row.parentId)this.queueDelta(channel,event.assistantMessageEvent.delta);
      else if(event.type==="message_update"&&event.assistantMessageEvent.type==="thinking_start")this.track(this.send(channel,"thinking",{agentId:row.id,status:"active"}));
      else if(event.type==="message_update"&&event.assistantMessageEvent.type==="thinking_delta")this.queueThinking(channel,row.id,event.assistantMessageEvent.delta);
      else if(event.type==="message_update"&&event.assistantMessageEvent.type==="thinking_end"){this.flushThinking(channel,row.id);const text=event.assistantMessageEvent.content?.trim().slice(0,8000);this.track(this.send(channel,"thinking",{agentId:row.id,status:"done",...(text?{text}:{})}));}
      else if(event.type==="message_end"){if(!row.parentId)this.flushDelta(channel);this.track(this.send(channel,row.parentId?"agent_history_changed":"history_changed",row.parentId?{id:row.id}:{},true));}
      else if(event.type==="tool_execution_start"){const detail=toolDetail(row.cwd,event.toolName,event.args);details.set(event.toolCallId,detail);this.track(this.send(channel,"tool",{agentId:row.id,tool:event.toolName,status:"requested",...(detail?{detail}:{})},true));}
      else if(event.type==="tool_execution_end"){const exit=event.toolName==="bash"?this.bashExits.get(event.toolCallId):undefined;this.bashExits.delete(event.toolCallId);const detail=exit===undefined?details.get(event.toolCallId):`${details.get(event.toolCallId)??""} → ${exit}`.trim();details.delete(event.toolCallId);this.track(this.send(channel,"tool",{agentId:row.id,tool:event.toolName,status:event.isError?"error":"done",...(detail?{detail}:{})},true));}
      else if(event.type==="agent_settled"&&row.status==="running"){
        const last=[...session.messages].reverse().find(m=>m.role==="assistant");
        const status=last?.role==="assistant"&&last.stopReason==="error"?"error":last?.role==="assistant"&&last.stopReason==="aborted"?"interrupted":"settled";
        this.track(this.setStatus(row,status));
        // Only AGY's clipped, control-stripped result error and Claude Code's clipped CLI error (e.g. usage credits required) are surfaced; other native errors stay generic.
        if(status==="error"&&last?.role==="assistant"&&typeof last.errorMessage==="string"&&(last.provider===AGY_UNSUPERVISED_PROVIDER_ID&&last.errorMessage.startsWith("Antigravity unsupervised request failed")||last.provider===CLAUDE_PROVIDER_ID&&last.errorMessage.startsWith("Claude Code: ")))this.track(this.send(row.rootId||row.id,"error",{message:last.errorMessage},true));
      }
    });
    const loaded:Active={session,row,unsubscribe};this.active.set(row.id,loaded);this.touch(row.id);return loaded;
  }
  get approvalMode():ApprovalMode{return this.mode;}
  private async loadApprovalMode(){try{const saved=JSON.parse(await readFile(join(this.dataDir,"agent-access.json"),"utf8"));this.mode=saved?.mode==="ask"?"ask":"full";}catch{this.mode=process.env.SIGMA_APPROVAL_MODE==="ask"?"ask":"full";}}
  private saveApprovalMode(mode:ApprovalMode){return this.modeSave=this.modeSave.catch(()=>{}).then(async()=>{const path=join(this.dataDir,`.agent-access-${randomUUID()}.json`);try{await writeFile(path,JSON.stringify({mode}),{mode:0o600,flag:"wx"});await rename(path,join(this.dataDir,"agent-access.json"));}finally{await rm(path,{force:true});}});}
  // Switching to full access also releases approvals that are already waiting.
  async setApprovalMode(mode:ApprovalMode){this.mode=mode;await this.saveApprovalMode(mode);if(mode==="full")await Promise.allSettled([...this.pending].map(([id,p])=>this.finishApproval(id,p,"approved")));}
  private async requestApproval(row:RecordRow,tool:string,preview:string,change?:FileChange,commandId?:string,git?:import("../../packages/contracts/index.js").GitApproval):Promise<string|null>{
    if(this.isStopping(row))return null;
    const id=randomUUID(),channel=row.rootId||row.id;let pending!:Pending;
    const allowedPromise=new Promise<boolean>(resolve=>{
      const timer=setTimeout(()=>{void this.finishApproval(id,pending,"expired").catch(()=>{});},300_000);
      pending={sessionId:channel,agentId:row.id,tool,ready:Promise.resolve(),resolve,timer};this.pending.set(id,pending);
    });
    pending.ready=(async()=>{
      await this.storage.call("approval",{id,sessionId:channel,agentId:row.id,tool,preview,change,commandId,git});
      await this.send(channel,"approval",{id,agentId:row.id,tool,preview,change,commandId,git,status:"pending",createdAt:Date.now()},true);
    })();
    try{await pending.ready;}
    catch{const p=this.pending.get(id);if(p){clearTimeout(p.timer);this.pending.delete(id);p.resolve(false);}return null;}
    if((this.mode==="full"||this.grants.get(channel)?.has(tool))&&!this.isStopping(row)){const p=this.pending.get(id);if(p)try{await this.finishApproval(id,p,"approved");}catch{return null;}}
    return await allowedPromise&&!this.isStopping(row)?id:null;
  }
  private async writeOutcome(row:RecordRow,id:string,outcome:WriteOutcome){
    await this.storage.call("writeOutcome",{id,outcome});await this.send(row.rootId||row.id,"write_outcome",{id,outcome},true);
  }
  private async inspectDirectWrite(sessionId:string,id:string):Promise<{view:WriteRecoveryView;approval:WriteApproval}>{
    const [row,approval]=await Promise.all([this.storage.call<RecordRow|undefined>("session",{id:sessionId}),this.storage.call<WriteApproval|undefined>("writeApproval",{id})]);
    const change=approval?.change;
    if(!row||row.status==="running"||row.policy?.workspace?.kind!=="direct"||!approval||approval.sessionId!==sessionId||approval.agentId!==sessionId||approval.status!=="approved"||!(["unknown","applied"] as Array<WriteOutcome|null>).includes(approval.outcome)||!approval.commandId||approval.commandStatus!=="unknown"||!change||!(change.beforeMode===null||Number.isInteger(change.beforeMode))||!Number.isInteger(change.afterMode))throw new Error("Direct write is not awaiting reconciliation");
    const observed=inspectCodePath(row.cwd,change.path),observedMode=observed.bytes===null?null:observed.mode;
    const state:WriteRecoveryState=observed.hash===change.afterHash&&observedMode===change.afterMode?"after":observed.hash===change.beforeHash&&observedMode===change.beforeMode?"before":"diverged";
    return {approval,view:{id,sessionId,path:change.path,beforeHash:change.beforeHash,afterHash:change.afterHash,beforeMode:change.beforeMode as number|null,afterMode:change.afterMode!,observedHash:observed.hash,observedMode,state}};
  }
  async directWriteRecovery(sessionId:string,id:string){return (await this.inspectDirectWrite(sessionId,id)).view;}
  async reconcileDirectWrite(sessionId:string,id:string,expected:{acknowledge:true;observedHash:string;observedMode:number|null;state:WriteRecoveryState}){
    const {view,approval}=await this.inspectDirectWrite(sessionId,id);
    if(expected?.acknowledge!==true||expected.observedHash!==view.observedHash||expected.observedMode!==view.observedMode||expected.state!==view.state)throw new Error("Observed direct file state changed; inspect it again before acknowledgement");
    const outcome:WriteOutcome=approval.outcome==="applied"?"applied":"reconciled";
    const at=Date.now();
    await this.storage.call("reconcileDirectWrite",{sessionId,id,outcome,reconciliation:{state:view.state,observedHash:view.observedHash,observedMode:view.observedMode,at}});
    await this.send(sessionId,"write_outcome",{id,outcome,reconciled:true},true);
    return {...view,reconciledAt:at};
  }
  /** Host shell for agents: approval like edit/write, then a sandbox-exec'd login shell that cannot read or write Sigma's credential files. */
  private bashTool(row:RecordRow){
    return defineTool({
      name:"bash",label:"Run command",
      description:`Run a shell command on the user's computer with /bin/zsh -lc, in this agent's own folder (${row.cwd}). Use it for tests, builds, linters, git, package managers and other project tooling. Output is stdout and stderr combined (only the last ~30 KB is kept); a non-zero exit code is reported as an error. Commands run with the user's permissions and ordinary network access. Sigma's credential and data folders and its local control-plane ports are blocked. Default timeout ${DEFAULT_TIMEOUT_SECONDS}s, at most ${MAX_TIMEOUT_SECONDS}s; the command and everything it started are killed on timeout or when the run is stopped. Commands cannot ask for input. Prefer the edit and write tools for changing files.`,
      parameters:Type.Object({command:Type.String({minLength:1,maxLength:8000}),timeoutSeconds:Type.Optional(Type.Number({minimum:1,maximum:MAX_TIMEOUT_SECONDS}))}),
      execute:async(toolCallId,params,signal)=>{
        if(!sandboxAvailable())throw new Error("The bash tool needs macOS sandbox-exec to protect Sigma's credentials; it is unavailable, so no command was run.");
        const timeoutSeconds=Math.max(1,Math.min(MAX_TIMEOUT_SECONDS,Math.floor(params.timeoutSeconds??DEFAULT_TIMEOUT_SECONDS)));
        let denied=false;
        return this.journalTool(row,toolCallId,"bash",params,async()=>{
          if(signal?.aborted||this.isStopping(row))throw new Error("Agent stopped");
          const approved=await this.requestApproval(row,"bash",`bash ${params.command}`,undefined,`pi-tool:${row.id}:${toolCallId}`);
          if(!approved){denied=true;throw new Error("Command denied or approval unavailable");}
          if(signal?.aborted||this.isStopping(row))throw new Error("Agent stopped");
          const result=await runShell({command:params.command,cwd:row.cwd,timeoutMs:timeoutSeconds*1000,signal,denied:protectedRoots(this.dataDir,getAgentDir(),undefined,undefined,this.shellControlPlanePorts)});
          const text=formatShellResult(result,timeoutSeconds),label=result.timedOut?"timed out":result.aborted?"stopped":`exit ${result.exitCode??result.signal}`;
          this.bashExits.set(toolCallId,label);
          if(result.exitCode!==0||result.timedOut||result.aborted)throw new Error(text);
          return {content:[{type:"text" as const,text}],details:{exitCode:0}};
        },{inputText:null},()=>denied?"rejected":"failed");
      },
    });
  }
  private async journalTool<T>(row:RecordRow,toolCallId:string,kind:"delegate"|"edit"|"write"|"bash",params:unknown,execute:()=>Promise<T>,details:{inputText?:string|null;behavior?:string;agentId?:string}={},failureStatus:()=>"rejected"|"failed"|"unknown"|Promise<"rejected"|"failed"|"unknown">=()=>"unknown",cleanup:()=>void=()=>{}):Promise<T>{
    const id=`pi-tool:${row.id}:${toolCallId}`,requestHash=createHash("sha256").update(kind).update("\0").update(JSON.stringify(params)).digest("hex");
    const admitted=await this.storage.call<{fresh:boolean;status:string}>("command",{id,sessionId:row.id,kind,requestHash,...details});
    if(!admitted.fresh)throw new Error(`Previous ${kind} tool call is ${admitted.status}; inspect its result before starting another`);
    const graph=kind==="delegate"?{id:`dispatch:${id}`,kind:"delegation" as const,source:row.id,target:details.agentId!,actor:row.id,cause:row.policy?.requested.mode==="multi"?"delegate_repo":"delegate",commandId:id,toolCallId,outcome:"pending"}:null;
    if(graph)await this.fact(row,graph);
    try{
      const result=await execute();
      if(!await this.storage.call<boolean>("commandTransition",{id,from:"accepted",to:"completed"}))throw new Error(`${kind} tool outcome is uncertain after restart`);
      if(graph)await this.fact(row,{...graph,outcome:"dispatched"});
      return result;
    }catch(error){const outcome=await failureStatus();await this.storage.call("commandTransition",{id,from:"accepted",to:outcome});if(graph)await this.fact(row,{...graph,outcome});throw error;}
    finally{cleanup();}
  }
  // ---------- Git actions on the selected folder ----------
  private commitTool(row:RecordRow){return !row.parentId&&row.policy?.workspace?.kind==="direct"&&(row.policy.requested.mode==="code"||row.policy.requested.mode==="parallel")&&!row.policy.task;}
  private async gitTarget(id:string){
    const row=await this.storage.call<RecordRow|undefined>("session",{id});
    if(!row||row.parentId)throw new Error("Session unavailable");
    if(row.archivedAt||row.policy?.task&& (await this.storage.call<ProjectTaskView|undefined>("projectTask",{id:row.policy.task.id}))?.archivedAt)throw new Error("Archived session or task cannot run Git actions");
    if(row.policy?.task)throw new Error("Git actions are not available for multi-repository tasks");
    if(row.policy?.workspace&&row.policy.workspace.kind!=="direct")throw new Error("This session edits an isolated workspace; use Source Apply, then manage Git from a session on the selected folder");
    if(await realpath(row.cwd)!==row.cwd)throw new Error("Saved Git folder identity changed; create a new session on the canonical root");
    return row;
  }
  async gitInfo(id:string){
    let row:RecordRow;
    try{row=await this.gitTarget(id);await gitIdentity(row.cwd);}catch(error){return {enabled:false,reason:error instanceof Error?error.message:"Unavailable",commit:false,branches:[] as string[]};}
    const branches=await gitBranches(row.cwd).catch(()=>[] as string[]);
    return {enabled:true,commit:this.commitTool(row),branches};
  }
  private async gitBarrier(row:RecordRow,commandId:string,movesHead=true){
    if(await this.storage.call<boolean>("gitBlocked",{cwd:row.cwd,exceptId:commandId}))throw new Error("Repository has an unknown Git outcome; inspect it before continuing");
    const rows=(await this.storage.call<Array<{id:string;cwd:string;status:string}>>("sessions")).filter(item=>item.cwd===row.cwd&&item.id!==row.id);
    if(rows.some(item=>item.status==="running"))throw new Error("Another session in this folder is running; stop it first");
    // Delegated agents (a Parallel code root's workers) are not listed as sessions, so their runs and approvals are checked through each root.
    const agents=(await Promise.all([row,...rows].map(item=>this.storage.call<Array<{id:string;status:string}>>("agents",{rootId:item.id})))).flat().filter(item=>item.id!==row.id);
    if(agents.some(item=>item.status==="running"))throw new Error("An agent in this folder is running; stop it first");
    const ids=new Set([row.id,...rows.map(item=>item.id),...agents.map(item=>item.id)]);if([...this.pending.values()].some(item=>ids.has(item.sessionId)))throw new Error("A session in this folder is waiting for an approval");
    if(await this.storage.call<boolean>("unresolvedDirectWrite",{cwd:row.cwd,includeMerges:true}))throw new Error("This folder has unresolved writes or merges; inspect them first");
    if(movesHead&&await this.unmergedWorker(row))throw new Error("A parallel worker's changes are not merged into this folder yet; merge or decline them in Changes → Worker changes and merges first");
  }
  /** A worker that ran in its own worktree can only be merged while the root stays on the commit both started from, so moving HEAD would strand its changes. Declined merges and conflicts were already shown to the user and do not block. */
  private async unmergedWorker(root:RecordRow){
    if(root.policy?.requested.mode!=="parallel"||root.policy.workspace?.kind!=="direct")return false;
    const merges=await this.storage.call<Array<{workerId:string;status:string}>>("workerMerges",{rootId:root.id});
    for(const agent of await this.storage.call<Array<{id:string;parentId:string|null;role:string}>>("agents",{rootId:root.id})){
      if(agent.parentId!==root.id||agent.role!=="worker")continue;
      const worker=await this.storage.call<RecordRow|undefined>("session",{id:agent.id}),workspace=worker?.policy?.workspace;
      if(!worker||!workspace||workspace.kind==="direct"||workspace.baseCommit!==root.policy.workspace.baseCommit)continue;
      const latest=merges.find(merge=>merge.workerId===worker.id)?.status;
      if(latest==="denied"||latest==="conflict")continue;
      const changes=await workspaceChanges(worker.cwd,workspace).catch(()=>null);
      if(!changes)return true;
      const same=(path:string)=>{try{return inspectCodePath(root.cwd,path).hash===inspectCodePath(worker.cwd,path).hash;}catch{return false;}};
      if(changes.omitted||!changes.files.every(same))return true;
    }
    return false;
  }
  private async syncGit(cwd:string,from:string,to:string){
    for(const {row} of this.active.values())if(row.cwd===cwd&&row.policy?.workspace?.kind==="direct"&&row.policy.workspace.baseCommit===from)row.policy={...row.policy,workspace:{...row.policy.workspace,baseCommit:to}};
    for(const row of await this.storage.call<Array<{id:string;cwd:string}>>("sessions"))if(row.cwd===cwd)await this.send(row.id,"repository_changed",{head:to},true);
  }
  private gitOperation<T>(row:RecordRow,id:string,kind:GitIntent["kind"],params:{message?:string;branch?:unknown},action:(intent:GitIntent,save:(intent:GitIntent)=>Promise<void>,admission:PromptAdmission)=>Promise<T>):Promise<T>{
    if(this.gitReservations.has(row.cwd))return Promise.reject(new Error("Repository Git action already admitted"));
    this.gitReservations.add(row.cwd);
    return this.withPromptAdmission(row.id,async admission=>{
      const requestHash=createHash("sha256").update(kind).update("\0").update(JSON.stringify(params)).digest("hex");
      const initial:GitIntent={id,kind,identity:await gitIdentity(row.cwd)};admission.check();
      const command=await this.storage.call<{fresh:boolean;status:string}>("command",{id,sessionId:row.id,kind:`git_${kind}`,requestHash,gitIntent:initial});
      if(!command.fresh)throw new Error(`Previous Git tool call is ${command.status}; inspect its receipt; it will not be replayed`);
      let intent:GitIntent|undefined=initial,completed=false;
      const save=(value:GitIntent)=>this.storage.call<void>("gitSave",{id,intent:value});
      try{
        admission.check();await this.gitBarrier(row,id,kind!=="push");admission.check();
        intent=initial;
        if(kind==="commit"){
          await assertWorkspaceHead(row.cwd,row.policy!.workspace!);
          const changes=await workspaceChanges(row.cwd,row.policy!.workspace!);
          if(changes.omitted)throw new Error("Commit scope contains unsupported or sensitive changes; inspect them first");if(!changes.files.length)throw new Error("Nothing to commit");
          intent=await prepareCommit(id,row.cwd,params.message!,changes.files,this.dataDir,this.protectPath);await save(intent);
        }
        admission.check();const result=await action(intent,save,admission);
        const after=await gitHead(row.cwd);await this.storage.call("gitComplete",{id,from:intent.identity.head,to:after,receipt:{sha:after,tree:intent.tree??null,at:Date.now()}});completed=true;
        await this.syncGit(row.cwd,intent.identity.head,after);return result;
      }catch(error){
        if(!completed){
          await this.storage.call("gitFailure",{id,status:intent?.dispatch?"unknown":"rejected"}).catch(()=>{});
          const saved=await this.storage.call<GitIntent&{status:string;receipt?:{sha:string}}>("gitGet",{id}).catch(()=>null);
          if(saved?.status==="completed"&&saved.receipt?.sha)await this.syncGit(saved.identity.cwd,saved.identity.head,saved.receipt.sha).catch(()=>{});
        }
        throw error;
      }
    }).finally(()=>this.gitReservations.delete(row.cwd));
  }
  async gitAction(id:string,action:"switch"|"pull"|"push",body:{branch?:unknown},commandId?:string){
    return this.withPromptAdmission(id,async owner=>{
    const row=await this.gitTarget(id);owner.check();if(row.status==="running")throw new Error("Wait for the run to finish");
    if(!commandId||commandId.length>200)throw new Error("X-Command-Id required for Git actions");
    return this.gitOperation(row,commandId,action,action==="switch"?{branch:body.branch}:{},async(intent,save,admission)=>{
      if((action==="pull"||action==="push")&&intent.identity.ref==="HEAD")throw new Error("HEAD is detached; switch to a branch first");
      if(action==="switch"&&(typeof body.branch!=="string"||!body.branch||body.branch.startsWith("-")||!(await gitBranches(row.cwd)).includes(body.branch)))throw new Error("Choose an existing local branch");
      admission.check();if(JSON.stringify(await gitIdentity(row.cwd))!==JSON.stringify(intent.identity))throw new Error("Repository changed before Git dispatch");
      const args=action==="switch"?["switch",body.branch as string]:action==="push"?await pushArgs(row.cwd):["pull","--ff-only","--no-rebase"];
      const output=await dispatchGit(intent,args,save,admission.check,undefined,async()=>{if(JSON.stringify(await gitIdentity(row.cwd))!==JSON.stringify(intent.identity))throw new Error("Repository changed before Git dispatch");},action==="push");return {output};
    });
    });
  }
  async gitRecovery(id:string){const row=await this.gitTarget(id),cwd=await realpath(row.cwd);return Promise.all((await this.storage.call<GitIntent[]>("gitRecoveries",{cwd})).map(inspectGit));}
  async reconcileGit(id:string,commandId:string,expected:{acknowledge?:boolean;digest?:string}){
    const row=await this.gitTarget(id);if(this.gitReservations.has(row.cwd))throw new Error("Repository Git finalization is active");this.gitReservations.add(row.cwd);
    return this.withPromptAdmission(id,async admission=>{
      const intent=await this.storage.call<GitIntent&{status:string}>("gitGet",{id:commandId});if(!intent||intent.status!=="unknown"||intent.identity.cwd!==await realpath(row.cwd))throw new Error("Git command is not awaiting reconciliation");
      if(row.status==="running")throw new Error("Wait for the run to finish before Git reconciliation");await this.gitBarrier(row,commandId,false);admission.check();
      const view=await inspectGit(intent);if(!view.canReconcile||expected?.acknowledge!==true||view.digest!==expected.digest)throw new Error(view.reason??"Git observations changed; inspect again before acknowledgement");
      admission.check();const current=await this.gitTarget(id);if(current.status==="running")throw new Error("Wait for the run to finish before Git reconciliation");await this.gitBarrier(current,commandId,false);const fresh=await inspectGit(intent);if(fresh.digest!==view.digest||!fresh.canReconcile)throw new Error("Git observations changed during acknowledgement; inspect again");await finalizeGit(intent,fresh);
      await this.storage.call("gitComplete",{id:commandId,from:intent.identity.head,to:view.head,reconciled:true,receipt:{sha:view.head,tree:view.tree,state:view.state,digest:view.digest,at:Date.now()}});
      await this.syncGit(row.cwd,intent.identity.head,view.head!);return view;
    }).finally(()=>this.gitReservations.delete(row.cwd));
  }
  /** Counts session events (set by the server). A shared changes read is reused only while no event arrived since it started. */
  eventEpoch:()=>number=()=>Number.NaN;
  private changeReads=new Map<string,{epoch:number;work:Promise<ChangesView>}>();
  /** `shared`: read-only views opened together (Changes, evidence, QA) reuse one in-flight Git read instead of each running their own. */
  changes(id:string,options:{shared?:boolean}={}):Promise<ChangesView>{
    const epoch=this.eventEpoch(),flight=options.shared?this.changeReads.get(id):undefined;
    if(flight&&flight.epoch===epoch)return flight.work;
    const work=(async()=>{
      const row=await this.storage.call<RecordRow|undefined>("session",{id});
      if(!row?.policy?.workspace)throw new Error("Session has no code workspace");
      return workspaceChanges(row.cwd,row.policy.workspace);
    })();
    if(options.shared&&!Number.isNaN(epoch)){this.changeReads.set(id,{epoch,work});const done=()=>{if(this.changeReads.get(id)?.work===work)this.changeReads.delete(id);};work.then(done,done);}
    return work;
  }
  async assertDirectReady(row:RecordRow,includeMerges=false,exceptApprovalId?:string){
    const cwd=await realpath(row.cwd);
    if(this.gitReservations.has(cwd)||await this.storage.call<boolean>("gitBlocked",{cwd}))throw new Error("Repository has active or unknown Git activity; inspect its Git journal before continuing");
    if(row.policy?.workspace?.kind!=="direct")return;
    if(await this.storage.call<boolean>("unresolvedDirectWrite",{cwd:row.cwd,includeMerges,exceptApprovalId}))throw new Error("Direct workspace has unknown outcomes or a pending merge; inspect its journal before continuing");
  }
  private async requireReadyTask(row:RecordRow){
    if(row.archivedAt)throw new Error("Archived sessions cannot accept commands");
    if(!row.policy?.task)return;
    const task=await this.storage.call<ProjectTaskView|undefined>("projectTask",{id:row.policy.task.id});
    if(task?.status!=="running"||task.archivedAt||this.stoppingTasks.has(task.id))throw new Error("Multi-repository task is unresolved, archived or stopping");
  }
  async verifiedCode(id:string){
    const row=await this.storage.call<RecordRow|undefined>("session",{id});
    if(!row?.policy?.workspace||row.parentId||!("verification" in row.policy.effective.profile))throw new Error("Verified checks are available only in new Code sessions");
    await this.requireReadyTask(row);
    return row;
  }
  async repositoryCode(id:string){
    const row=await this.verifiedCode(id);
    if(!("typecheck" in row.policy!.effective.profile))throw new Error("Repository checks require a new Code session");
    return row;
  }
  async startReviewer(rootId:string,reviewId:string,cwd:string,prompt:string,signal:AbortSignal):Promise<{done:Promise<string>}>{
    return this.withPromptAdmission(rootId,admission=>this.startReviewerAdmitted(rootId,reviewId,cwd,prompt,signal,admission));
  }
  private async startReviewerAdmitted(rootId:string,reviewId:string,cwd:string,prompt:string,signal:AbortSignal,admission:PromptAdmission):Promise<{done:Promise<string>}>{
    const root=await this.verifiedCode(rootId);
    const selected=root.policy?.role?await this.roleSelection("reviewer",root.model,root.policy.role.catalog):undefined;
    const check=()=>{admission.check();if(signal.aborted||this.isStopping(root))throw new Error("Review stopped before creation");};check();
    const timeout=AbortSignal.timeout(READ_ONLY_PROFILE.childTimeoutMs),combined=AbortSignal.any([signal,timeout]);
    if(combined.aborted)throw new Error("Review stopped before creation");
    this.runningChildren++;
    let handedOff=false,row:RecordRow|undefined;
    const commandId=`review-spawn:${reviewId}`;
    try{
    const setup=await this.setupDescriptor({kind:"review",id:commandId,commandId,sessionId:reviewId,cwd,model:selected?.model??root.model,sessionMode:"read",role:selected?.role,parentId:rootId,rootId,taskId:root.policy?.task?.id,repositoryId:root.policy?.task?.repositoryId,profile:REVIEW_PROFILE,agentRole:"reviewer",policyVersion:root.policy!.version,requestedCwd:root.policy!.workspace!.sourceCwd,requestedModel:root.model});
    await this.storage.call("command",{id:commandId,sessionId:rootId,kind:"review_spawn",requestHash:reviewId,agentId:reviewId,behavior:"reviewer",inputText:"Revision-bound reviewer admission"});check();
    await this.storage.call("reserveChild",{parentId:rootId,agentId:reviewId,commandId,reviewer:true,setup});check();
    await this.storage.call("commandSetupPhase",{id:commandId,from:"reserved",to:"allocating"});
    const manager=SessionManager.create(cwd,join(this.dataDir,"sessions"),{id:reviewId});
    const policy:SessionPolicy={version:root.policy!.version,requested:{cwd:root.policy!.workspace!.sourceCwd,model:root.model,mode:"read"},effective:{cwd,model:selected?.model??root.model,profile:structuredClone(REVIEW_PROFILE)},setup,...(selected?{role:selected.role}:{}),...(root.policy!.task?{task:root.policy!.task}:{})};
    row={id:reviewId,cwd,file:manager.getSessionFile()!,managerId:reviewId,model:selected?.model??root.model,policy,status:"idle",parentId:rootId,role:"reviewer",rootId,ancestors:[rootId]};
    await this.storage.call("addSession",{...row,admissionId:commandId,creation:{source:"user",actor:"user",cause:"user_revision_review",reviewId,commandId:reviewId}});check();
    await this.storage.call("commandSetupPhase",{id:commandId,from:"allocating",to:"allocated"});
    await this.storage.call("commandSetupPhase",{id:commandId,from:"allocated",to:"registered"});
    if(combined.aborted)throw new Error("Review stopped before creation");
    await this.send(rootId,"agent_created",{id:row.id,parentId:rootId,role:"reviewer",status:"idle",model:row.model,cwd,revisionReviewer:true},true);
    if(combined.aborted)throw new Error("Review stopped before creation");check();
    const reviewer=await this.open(row,manager);check();
    await this.storage.call("commandSetupPhase",{id:commandId,from:"registered",to:"opened"});
    if(combined.aborted){await this.abortReviewer(rootId,reviewId);throw new Error("Review stopped before prompt");}
    await this.setStatus(row,"running");check();
    if(combined.aborted){await this.abortReviewer(rootId,reviewId);throw new Error("Review stopped before prompt");}
    const session=reviewer.session;
    const onAbort=()=>{void this.abortReviewer(rootId,reviewId).catch(()=>{});};
    combined.addEventListener("abort",onAbort,{once:true});
    if(combined.aborted)onAbort();
    await this.storage.call("commandSetupPhase",{id:commandId,from:"opened",to:"dispatching"});
    if(!await this.storage.call<boolean>("markSessionDispatch",{id:row.id}))throw new Error("Session dispatch ownership is unavailable");
    check();if(combined.aborted)throw new Error("Reviewer stopped before prompt dispatch");
    const done=session.prompt(prompt).then(async()=>{
      await this.storage.call("commandStatus",{id:commandId,status:"completed"});
      if(combined.aborted)throw new Error(timeout.aborted?"Reviewer timed out":"Reviewer stopped");
      const last=[...session.messages].reverse().find(m=>m.role==="assistant");
      if(last?.role==="assistant"&&last.stopReason==="error")throw new Error("Reviewer provider failed");
      if(last?.role==="assistant"&&last.stopReason==="aborted")throw new Error("Reviewer was interrupted");
      return session.getLastAssistantText()||"Reviewer returned no findings text";
    }).catch(async error=>{await this.storage.call("commandStatus",{id:commandId,status:"unknown"});throw error;}).finally(()=>{combined.removeEventListener("abort",onAbort);this.runningChildren--;});
    handedOff=true;
    return {done};
    }catch(error){const setupState=await this.storage.call<any>("commandSetupGet",{id:commandId});if(!setupState?.setup||setupState.setup.phase==="reserved")await this.storage.call("commandTransition",{id:commandId,from:"accepted",to:"rejected"});else await this.storage.call("commandStatus",{id:commandId,status:"unknown"});if(row&&(row.status==="idle"||row.status==="running"))await this.setStatus(row,combined.aborted||this.isStopping(root)?"interrupted":"error");throw error;}
    finally{if(!handedOff)this.runningChildren--;}
  }
  async abortReviewer(rootId:string,reviewId:string){
    const active=this.active.get(reviewId);if(!active||active.row.parentId!==rootId||active.row.role!=="reviewer")return;
    this.stopping.add(reviewId);
    try{await this.denyApprovals(rootId,reviewId);await active.session.abort();await this.setStatus(active.row,"interrupted");}
    finally{this.stopping.delete(reviewId);}
  }
  private async get(id:string):Promise<Active>{
    if(this.closing)throw new Error("Service is shutting down");
    const cached=this.active.get(id);if(cached){this.touch(id);return cached;}
    const existing=this.loading.get(id);if(existing)return existing;
    const loading=(async()=>{const row=await this.storage.call<RecordRow|undefined>("session",{id});if(!row)throw new Error("Unknown session");return this.open(row);})();
    this.loading.set(id,loading);try{const loaded=await loading;this.touch(id);this.queueTrim();return loaded;}finally{this.loading.delete(id);}
  }
  private touch(id:string){this.used.set(id,Date.now());}
  private queueTrim(){if(this.trimQueued||this.active.size<=this.maxLoaded)return;this.trimQueued=true;setTimeout(()=>{this.trimQueued=false;this.trimLoaded();},0).unref();}
  /** Ids (sessions, roots, channels) with in-flight work; a session or its root listed here is not unloaded. null: unresolved owner work, unload nothing. */
  private pinned():Set<string>|null{
    const ids=new Set<string>();
    for(const admission of this.promptAdmissions){if(admission.unresolvedOwner)return null;ids.add(admission.id);}
    for(const [id,run] of this.children){ids.add(id);ids.add(run.row.id);ids.add(run.row.rootId||run.row.id);for(const ancestor of run.row.ancestors??[])ids.add(ancestor);}
    for(const pending of this.pending.values()){ids.add(pending.sessionId);ids.add(pending.agentId);}
    for(const id of [...this.loading.keys(),...this.stopping,...this.archiving,...this.admittingChildren,...this.repoDispatching,...this.deltas.keys()])ids.add(id);
    for(const key of this.thinkings.keys())for(const id of key.split("\0"))ids.add(id);
    for(const input of this.graphInputs.values())ids.add(input.row.id);
    // A running agent keeps its whole delegation tree: the root awaits its children and the children report to the root.
    for(const {row,session} of this.active.values())if(row.status==="running"||session.isStreaming){ids.add(row.id);ids.add(row.rootId||row.id);for(const ancestor of row.ancestors??[])ids.add(ancestor);}
    return ids;
  }
  /** Idle, fully saved, unwatched and with no in-flight work. A history file exists only after the first assistant reply, so a session without one lives in memory alone. */
  private evictable({row,session}:Active,now:number,pinned:Set<string>){
    const root=row.rootId||row.id;
    if(now-(this.used.get(row.id)??0)<this.idleMs||row.status==="running"||session.isStreaming||pinned.has(row.id)||pinned.has(root)||this.isStopping(row)||this.gitReservations.has(row.cwd)||this.viewerCheck(row.id)||this.viewerCheck(root))return false;
    try{lstatSync(row.file);return true;}catch{return false;}
  }
  /** Unloads the least recently used evictable sessions until at most `maxLoaded` remain; sessions that cannot be unloaded may leave more. */
  trimLoaded(){
    if(this.closing||this.active.size<=this.maxLoaded)return;
    const pinned=this.pinned();if(!pinned)return;
    const now=Date.now(),idle=[...this.active.values()].filter(item=>this.evictable(item,now,pinned)).sort((a,b)=>(this.used.get(a.row.id)??0)-(this.used.get(b.row.id)??0));
    for(const item of idle){if(this.active.size<=this.maxLoaded)break;this.evict(item);}
  }
  /** Unloaded sessions whose latest reply was an open ask_user question, so the sidebar keeps showing them as waiting. */
  private askOpen=new Set<string>();
  private asksUser({row,session}:Active){
    if(row.status==="running"||!session.messages.length)return false;
    const last=[...cachedVisibleMessages(session,row.cwd)].reverse().find(message=>!message.interim);
    return last?.role==="assistant"&&!!last.question;
  }
  private evict({session,row,unsubscribe}:Active){
    if(this.asksUser({session,row} as Active))this.askOpen.add(row.id);
    this.active.delete(row.id);this.used.delete(row.id);
    try{unsubscribe();}catch{}
    try{session.dispose();}catch{}
    try{this.agy?.unbind(row.id);}catch{}
  }
  private async setStatus(row:RecordRow,status:SessionView["status"]){await this.storage.call("status",{id:row.id,status});row.status=status;this.touch(row.id);await this.send(row.rootId||row.id,row.parentId?"agent_status":"status",{id:row.id,status},true);}
  private queueDelta(id:string,text:string){
    const current=this.deltas.get(id);
    if(current){current.parts.push(text);return;}
    const parts=[text],timer=setTimeout(()=>this.flushDelta(id),32);
    this.deltas.set(id,{parts,timer});
  }
  private thinkings=new Map<string,{parts:string[];timer:ReturnType<typeof setTimeout>}>();
  private queueThinking(channel:string,agentId:string,text:string){
    const key=`${channel}\0${agentId}`,current=this.thinkings.get(key);
    if(current){current.parts.push(text);return;}
    this.thinkings.set(key,{parts:[text],timer:setTimeout(()=>this.flushThinking(channel,agentId),100)});
  }
  private flushThinking(channel:string,agentId:string){const key=`${channel}\0${agentId}`,current=this.thinkings.get(key);if(!current)return;clearTimeout(current.timer);this.thinkings.delete(key);const text=current.parts.join("");if(text)this.track(this.send(channel,"thinking",{agentId,status:"active",text}));}
  private flushDelta(id:string){const current=this.deltas.get(id);if(!current)return;clearTimeout(current.timer);this.deltas.delete(id);this.track(this.send(id,"delta",{text:current.parts.join("")}));}
  private async delegate(parent:RecordRow,agentId:string,role:"planner"|"researcher"|"worker"|"reviewer"|"qa",task:string,signal?:AbortSignal,toolCallId?:string):Promise<string>{
    const profile=parent.policy?.effective.profile??READ_ONLY_PROFILE;
    const selected=parent.policy?.role?this.fitReasoning(resolveRole(parent.policy.role.catalog,role,parent.model),parent.model):undefined;
    if(signal?.aborted||this.isStopping(parent))throw new Error("Delegation cancelled");
    this.runningChildren++;
    let child:Active|undefined,row:RecordRow|undefined,run:ChildRun|undefined,finish=()=>{},timer:ReturnType<typeof setTimeout>|undefined,registered=false,aborted=false,timedOut=false;
    const onAbort=()=>{aborted=true;if(run)void this.stopChild(run).catch(()=>{});};signal?.addEventListener("abort",onAbort,{once:true});
    if(signal?.aborted)onAbort();
    const commandId=`pi-tool:${parent.id}:${toolCallId}`;
    row={id:agentId,parentId:parent.id,role,cwd:parent.cwd,file:"",managerId:agentId,model:parent.model,policy:parent.policy,status:"idle",rootId:parent.rootId||parent.id,ancestors:[parent.id,...parent.ancestors??[]]};
    // Decided synchronously, before any await, so two concurrent workers can never both claim the working copy.
    const ancestorIds=new Set([parent.id,...parent.ancestors??[]]);
    let workDone=()=>{};
    run={row,cancelled:false,registered:false,done:new Promise<void>(resolve=>{finish=resolve;}),working:new Promise<void>(resolve=>{workDone=resolve;}),solo:role==="worker"&&![...this.children.values()].some(other=>other.row.role==="worker"&&other.row.rootId===row!.rootId&&!ancestorIds.has(other.row.id))};this.children.set(agentId,run);
    const check=()=>{if(aborted||run!.cancelled||this.isStopping(parent))throw new Error("Delegation cancelled");};
    try{
      check();if(selected){this.assertRole(selected.model,selected.role,await this.availableModels());check();}await this.requireReadyTask(parent);check();
      const context=await this.storage.call<DelegationContext>("delegationContext",{id:parent.id});
      const writer=role==="worker"&&!!parent.policy?.workspace&&(parent.policy.requested.mode==="parallel"||context.root.policy?.version===2&&context.root.policy.requested.mode==="parallel"&&(parent.policy.effective.profile.tools as readonly string[]).includes("write"));
      // A lone worker edits the parent's own working copy; only a worker that overlaps another worker of the same root gets an isolated worktree.
      const inPlace=writer&&!!run.solo&&!!parent.policy!.workspace!.kind;
      const workspaceKind:WorkspaceMode=inPlace?parent.policy!.workspace!.kind!:"worktree";
      const nestedSetup=await this.setupDescriptor({kind:"nested",id:commandId,commandId,sessionId:agentId,cwd:writer?parent.policy!.workspace!.sourceCwd:parent.cwd,...(inPlace?{inPlaceCwd:parent.cwd}:{}),model:selected?.model??parent.model,sessionMode:writer?"code":"read",workspaceMode:writer?workspaceKind:undefined,baseCommit:writer?parent.policy!.workspace!.baseCommit:undefined,role:selected?.role,taskId:parent.policy?.task?.id,repositoryId:parent.policy?.task?.repositoryId,parentId:parent.id,rootId:parent.rootId||parent.id,agentRole:role,policyVersion:context.root.policy?.version??1,requestedCwd:parent.policy?.workspace?.sourceCwd??parent.policy?.requested.cwd??parent.cwd,requestedModel:parent.model,profile:writer?(context.root.policy?.version===2?NESTED_WORKER_PROFILE:CODE_PROFILE):(context.root.policy?.version===2?NESTED_READ_PROFILE:READ_ONLY_PROFILE)});
      await this.storage.call("reserveChild",{parentId:parent.id,agentId,commandId,setup:nestedSetup});check();
      const allocating=await this.storage.call<WorkspaceSetup>("commandSetupPhase",{id:commandId,from:"reserved",to:"allocating"});
      check();const copy=writer&&!inPlace?await createCodeWorkspace(parent.policy!.workspace!.sourceCwd,this.dataDir,agentId,parent.policy!.workspace!.baseCommit,"worktree",check):undefined;
      check();
      let allocated=allocating;
      if(copy){const workspaceIdentity=await describeGitRoot(copy.cwd,copy.workspace.baseCommit),workspaceInfo=await stat(copy.cwd),gitInfo=await stat(workspaceIdentity.gitDir);allocated=await this.storage.call<WorkspaceSetup>("commandSetupIdentity",{id:commandId,identity:{cwd:copy.cwd,workspaceGitDir:workspaceIdentity.gitDir,workspaceGitDev:gitInfo.dev,workspaceGitIno:gitInfo.ino,workspaceDev:workspaceInfo.dev,workspaceIno:workspaceInfo.ino}});}else allocated=await this.storage.call<WorkspaceSetup>("commandSetupPhase",{id:commandId,from:"allocating",to:"allocated"});
      const cwd=copy?.cwd??parent.cwd;
      const version=context.root.policy?.version??1;
      const taskIdentity=parent.policy?.task?{task:parent.policy.task}:{};
      const policy:SessionPolicy|null=writer?{version,requested:{cwd:parent.policy!.workspace!.sourceCwd,model:parent.model,mode:"code",workspaceMode:workspaceKind},effective:{cwd,model:parent.model,profile:structuredClone(version===2?NESTED_WORKER_PROFILE:CODE_PROFILE)},workspace:inPlace?{sourceCwd:parent.policy!.workspace!.sourceCwd,baseCommit:parent.policy!.workspace!.baseCommit,kind:workspaceKind}:copy!.workspace,...taskIdentity}:parent.policy?.workspace?{version,requested:{cwd:parent.policy.workspace.sourceCwd,model:parent.model,mode:"read"},effective:{cwd,model:parent.model,profile:structuredClone(version===2?NESTED_READ_PROFILE:READ_ONLY_PROFILE)},...taskIdentity}:parent.policy;
      const rolePolicy=policy?{...structuredClone(policy),...(selected?{role:selected.role}:{}),setup:allocated,effective:{...policy.effective,model:selected?.model??parent.model},requested:{...policy.requested,model:parent.model}}:policy;
      const manager=SessionManager.create(cwd,join(this.dataDir,"sessions"),{id:agentId});
      Object.assign(row,{cwd,file:manager.getSessionFile()!,policy:rolePolicy,model:selected?.model??parent.model});check();
      await this.storage.call("addSession",{...row,admissionId:commandId,creation:{source:parent.id,actor:parent.id,cause:"delegate_tool",sourceRun:this.active.get(parent.id)?.metadata??null,toolCallId,commandId}});
      await this.storage.call("commandSetupPhase",{id:commandId,from:"allocated",to:"registered"});
      registered=true;run.registered=true;check();
      const agent:AgentView={id:row.id,parentId:parent.id,role,status:row.status,model:row.model,cwd:row.cwd};
      await this.send(row.rootId!,"agent_created",agent,true);check();
      child=await this.open(row,manager);
      await this.storage.call("commandSetupPhase",{id:commandId,from:"registered",to:"opened"});
      check();await this.setStatus(row,"running");check();
      timer=setTimeout(()=>{timedOut=true;void this.stopChild(run!).catch(()=>{});},profile.childTimeoutMs);
      await this.storage.call("commandSetupPhase",{id:commandId,from:"opened",to:"dispatching"});
      if(!await this.storage.call<boolean>("markSessionDispatch",{id:row.id}))throw new Error("Session dispatch ownership is unavailable");
      check();try{await child.session.prompt(`Role: ${role}. Task: ${task}\nReturn a concise result and state what you verified.`);}finally{workDone();}
      if(aborted||run.cancelled||timedOut)throw new Error(timedOut?"Child time limit reached":"Delegation cancelled");
      const last=[...child.session.messages].reverse().find(m=>m.role==="assistant");
      if(last?.role==="assistant"&&last.stopReason==="error")throw new Error("Child provider failed");
      if(last?.role==="assistant"&&last.stopReason==="aborted")throw new Error("Child was interrupted");
      const answer=child.session.getLastAssistantText()||"No assistant result";
      const where=writer?inPlace?"; its changes were applied in the working copy (it edited the working copy directly)":await this.integrateWorker(parent,row,context.root,run,check):"";
      return `${role} ${row.id} returned (not independently verified)${where}: ${answer}`;
    }catch(error){if(registered&&row&&(row.status==="idle"||row.status==="running"))await this.setStatus(row,aborted||run?.cancelled||timedOut?"interrupted":"error");throw error;}
    finally{workDone();signal?.removeEventListener("abort",onAbort);if(timer)clearTimeout(timer);try{if(run?.stop)await run.stop;}finally{if(row&&this.children.get(row.id)===run)this.children.delete(row.id);finish();this.runningChildren--;}}
  }
  /** Reports where a finished isolated worker's changes ended up, merging them automatically when Full access is on. Never loses work: on any problem the merge stays for the user. */
  private async integrateWorker(parent:RecordRow,worker:RecordRow,root:RecordRow,run:ChildRun,check:()=>void):Promise<string>{
    const pending=(reason:string)=>`; changes not integrated: ${reason}; the user must merge them from Changes (pending merge in Changes)`;
    if(parent.id!==root.id)return pending(`a worker started by another worker ran in an isolated workspace (${worker.cwd}) that is not merged automatically`);
    if(this.mode!=="full")return `; pending merge in Changes (Full access is off, so the user approves the merge from Changes, Worker changes)`;
    if(!this.autoMerger)return pending("automatic merge is unavailable");
    const ancestorIds=new Set([parent.id,...parent.ancestors??[]]);
    // Let overlapping workers finish their own edits first so the merge sees a quiet working copy.
    await Promise.all([...this.children.values()].filter(other=>other!==run&&other.row.role==="worker"&&other.row.rootId===worker.rootId&&!ancestorIds.has(other.row.id)).map(other=>other.working));check();
    const until=Date.now()+5000;while(worker.status==="running"&&Date.now()<until){await new Promise(resolve=>setTimeout(resolve,20));check();}
    const result=await this.autoMerger(root.id,worker.id);check();
    if(result.status==="applied")return "; its changes were merged into the working copy automatically (applied in the working copy)";
    if(result.status==="empty")return "; it made no file changes (nothing to integrate)";
    return pending(result.reason??"the merge did not complete");
  }
  async list(){const rows=await this.storage.call<RecordRow[]>("sessions"),waiting=new Set([...this.pending.values()].filter(p=>!p.finalizing).map(p=>p.sessionId));
    // A settled loaded session whose latest reply is an ask_user question also waits for the user.
    for(const [id,active] of this.active)if(this.asksUser(active))waiting.add(id);
    for(const id of this.askOpen)if(this.active.has(id))this.askOpen.delete(id);else waiting.add(id);
    return rows.map(r=>waiting.has(r.id)?{...r,waiting:true}:r);}
  private async assertRegisteredSetup(row:RecordRow,setup:WorkspaceSetup){
    const immutable=(value:WorkspaceSetup|undefined)=>{if(!value)return null;const {phase,observedRevision,...identity}=value;return identity;};
    if(row.id!==setup.sessionId||row.cwd!==setup.cwd||row.managerId!==setup.managerId||row.parentId!==(setup.parentId??null)||row.model!==setup.model||row.role!==(setup.agentRole??"root")||row.policy?.version!==setup.policyVersion||JSON.stringify(row.policy?.requested)!==JSON.stringify(setup.requested)||row.policy?.effective.cwd!==setup.cwd||row.policy?.effective.model!==setup.model||JSON.stringify(row.policy?.effective.profile)!==JSON.stringify(setup.profile)||JSON.stringify(row.policy?.role??null)!==JSON.stringify(setup.role??null)||JSON.stringify(immutable(row.policy?.setup))!==JSON.stringify(immutable(setup)))throw new Error("Registered session differs from the exact saved setup owner and policy");
    const expectedTask=setup.taskId?{id:setup.taskId,...(setup.repositoryId?{repositoryId:setup.repositoryId}:{})}:undefined;
    if(JSON.stringify(row.policy?.task)!==JSON.stringify(expectedTask))throw new Error("Registered session task membership differs from frozen setup");
    const workspace=setup.sourceCwd&&setup.baseCommit?{sourceCwd:setup.sourceCwd,baseCommit:setup.baseCommit,kind:setup.workspaceMode}:undefined;
    if(JSON.stringify(row.policy?.workspace)!==JSON.stringify(workspace))throw new Error("Registered workspace differs from frozen setup");
    if(setup.parentId){const context=await this.storage.call<DelegationContext>("delegationContext",{id:row.id});if(context.root.id!==setup.rootId)throw new Error("Registered parent/root lineage differs from frozen setup");}
  }
  async workspaceRecovery():Promise<WorkspaceRecoveryItem[]>{
    const items:WorkspaceRecoveryItem[]=[],commands=await this.storage.call<any[]>("commandSetupRecovery"),tasks=await this.storage.call<ProjectTaskView[]>("taskSetupRecovery"),sessions=await this.storage.call<any[]>("sessions");
    const registered=new Map<string,RecordRow>();for(const rootRef of sessions){const root=await this.storage.call<RecordRow|undefined>("session",{id:rootRef.id});if(root)registered.set(root.id,root);for(const childRef of await this.storage.call<any[]>("agents",{rootId:rootRef.id})){const child=await this.storage.call<RecordRow|undefined>("session",{id:childRef.id});if(child)registered.set(child.id,child);}}
    const inspect=async(id:string,kind:string,setup:WorkspaceSetup|null|undefined,row?:RecordRow,status="unknown")=>{
      if(!setup){items.push({id,kind,status:"inspect-only",canContinue:false,cwdExists:false,registered:!!row,head:null,managerFile:row?.file??null,reason:"Legacy setup has no durable ownership descriptor"});return;}
      let reason:string|undefined,cwdExists=false,head:string|null=null,workspaceRegistered=false,workspaceGitDir:string|null=null;
      if(setup.workspaceMode){const observed=await inspectWorkspaceSetup(setup);cwdExists=observed.cwdExists;head=observed.head;workspaceRegistered=observed.registered;workspaceGitDir=observed.workspaceGitDir;reason=observed.reason;}
      else if(setup.kind==="task-coordinator"&&setup.phase==="reserved"){
        if(!setup.taskId||setup.cwd!==join(await realpath(this.dataDir),"tasks",setup.taskId))reason="Reserved coordinator path differs from its task owner";
        else try{lstatSync(setup.cwd);reason="Reserved coordinator path already exists without allocation proof";}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")reason="Reserved coordinator path cannot be inspected";}
      }
      else try{if(await realpath(setup.cwd)!==setup.cwd)reason="Saved working directory resolves elsewhere";else{const info=lstatSync(setup.cwd);cwdExists=info.isDirectory()&&setup.cwdDev===info.dev&&setup.cwdIno===info.ino;if(!cwdExists)reason="Saved working directory identity changed";}}catch{reason="Saved working directory is unavailable";}
      let managerFile:string|null=null,historyValid=false,historyReason:string|undefined;
      try{const dir=await realpath(setup.managerDir),matches=new Set<string>();if(row){const candidate=resolve(row.file),rel=relative(dir,candidate);if(rel&&rel!==".."&&!rel.startsWith(`..${sep}`)){try{lstatSync(candidate);matches.add(candidate);}catch{}}}for(const name of readdirSync(dir))if(name.endsWith(`_${setup.managerId}.jsonl`))matches.add(join(dir,name));if(matches.size>1)throw new Error("Multiple Pi histories match the saved manager ID");if(matches.size){managerFile=[...matches][0];readPiHistory(managerFile,dir,setup.managerId,setup.cwd);historyValid=true;}}catch(error){historyReason=error instanceof Error?error.message:"Pi history cannot be inspected";}
      if(historyReason)reason=reason??historyReason;
      if(setup.workspaceMode==="worktree"&&!setup.inPlace&&setup.cwd!==join(await realpath(this.dataDir),"workspaces",setup.sessionId))reason="Saved workspace path differs from the reserved session owner";
      if(setup.managerDir!==join(await realpath(this.dataDir),"sessions"))reason="Saved Pi directory differs from the application owner";
      if(!setup.profile||!setup.policyVersion||!setup.requested)reason="Legacy setup lacks saved policy provenance";
      if(row)try{await this.assertRegisteredSetup(row,setup);}catch(error){reason=error instanceof Error?error.message:"Registered setup ownership changed";}
      if(!managerFile&&(row?.dispatchStarted||setup.phase==="dispatching"))reason="Pi history is missing after prompt dispatch may have started";
      const allocated=["reserved","allocating","allocated","registered","opened"].includes(setup.phase);
      const reservedAbsent=setup.phase==="reserved"&&(setup.workspaceMode==="worktree"||setup.kind==="task-coordinator")&&!cwdExists&&!reason;
      const canContinue=!reason&&(cwdExists||reservedAbsent)&&(!setup.workspaceMode||workspaceRegistered||reservedAbsent)&&allocated&&(!row||!row.dispatchStarted||historyValid)&&(!row||row.status!=="running")&&!row?.archivedAt;
      items.push({id,kind,setup,status:canContinue?"unknown":"inspect-only",canContinue,cwd:setup.cwd,workspaceGitDir,worktreeRegistered:setup.workspaceMode==="worktree"&&workspaceRegistered,cwdExists,registered:!!row,head,managerFile,reason});
    };
    for(const command of commands){const row=registered.get(command.setup?.sessionId??command.sessionId);await inspect(command.id,command.kind,command.setup,row,command.status);}
    for(const task of tasks){for(const repo of task.repositories)await inspect(task.id,`task-repository:${repo.id}`,repo.setup,registered.get(repo.sessionId),task.status);await inspect(task.id,"task-coordinator",task.coordinatorSetup,registered.get(task.coordinatorId),task.status);}
    const workspaces=join(await realpath(this.dataDir),"workspaces"),known=new Set([...items.map(item=>item.setup?.cwd).filter((value):value is string=>!!value),...[...registered.values()].map(row=>row.cwd)]);
    try{for(const name of readdirSync(workspaces)){const path=join(workspaces,name);if(known.has(path))continue;items.push({id:`workspace:${name}`,cwd:path,kind:"unregistered-workspace",status:"inspect-only",canContinue:false,cwdExists:true,registered:false,head:null,managerFile:null,reason:"Owned worktree directory has no matching saved setup proof"});}}catch{}
    const managerDir=join(await realpath(this.dataDir),"sessions"),knownFiles=new Set(items.map(item=>item.managerFile).filter((value):value is string=>!!value));
    try{for(const name of readdirSync(managerDir)){if(!name.endsWith(".jsonl"))continue;const path=join(managerDir,name);if(knownFiles.has(path)||[...registered.values()].some(row=>row.file===path))continue;items.push({id:`history:${name}`,kind:"unregistered-history",status:"inspect-only",canContinue:false,cwdExists:false,registered:false,head:null,managerFile:path,reason:"Pi history has no matching registered session or saved setup descriptor"});}}catch{}
    return items.map(item=>({...item,observedRevision:createHash("sha256").update(JSON.stringify(item)).digest("hex")}));
  }
  private async savedSetupManager(setup:WorkspaceSetup){
    const managerDir=await realpath(setup.managerDir);if(managerDir!==setup.managerDir||managerDir!==await realpath(join(this.dataDir,"sessions")))throw new Error("Saved Pi directory identity changed");
    const matches=readdirSync(managerDir).filter(name=>name.endsWith(`_${setup.managerId}.jsonl`)).map(name=>join(managerDir,name));
    if(matches.length>1)throw new Error("Multiple Pi histories match the saved manager ID");
    if(matches.length){const found=readPiHistory(matches[0],managerDir,setup.managerId,setup.cwd);return openPiHistory(found.path,managerDir,setup.cwd,found.entries);}
    if(["dispatching","ready","unknown"].includes(setup.phase))throw new Error("Pi dispatch may have started; missing history is inspect-only");
    return SessionManager.create(setup.cwd,managerDir,{id:setup.managerId});
  }
  async continueWorkspaceSetup(commandId:string,observation?:string){
    // Register the command owner synchronously, before even looking up the saved child.
    return this.withPromptAdmission(commandId,async admission=>{
      admission.unresolvedOwner=true;
      const command=await this.storage.call<any>("commandSetupGet",{id:commandId});admission.check();
      if(!command||command.status!=="unknown"||!command.setup)throw new Error("Saved setup is not awaiting continuation");
      const setup=command.setup as WorkspaceSetup;
      return this.withPromptAdmission(setup.rootId??setup.sessionId,async owner=>{
        admission.unresolvedOwner=false;
        const check=()=>{admission.check();owner.check();};check();
        if(!["session","nested","review"].includes(setup.kind)||["dispatching","ready","unknown"].includes(setup.phase))throw new Error("This setup is inspect-only; its original dispatch may have started");
        const item=(await this.workspaceRecovery()).find(candidate=>candidate.id===commandId);check();
        if(!item?.canContinue||observation!==item.observedRevision)throw new Error(item?.reason??"Workspace observation changed; refresh inspection before continuing");
        if(!await this.storage.call<boolean>("claimSetupContinuation",{id:commandId,setup}))throw new Error("Setup continuation was already claimed or changed");
        let completed=false;
        try{
          check();const fresh=(await this.workspaceRecovery()).find(candidate=>candidate.id===commandId);check();
          if(!fresh?.canContinue||fresh.observedRevision!==item.observedRevision)throw new Error("Workspace observation changed during continuation");
          const existing=await this.storage.call<RecordRow|undefined>("session",{id:setup.sessionId});check();
          const context=setup.parentId?await this.storage.call<DelegationContext>("delegationContext",{id:setup.parentId}):undefined;check();
          if(setup.parentId&&(!context||context.root.id!==setup.rootId))throw new Error("Saved parent lineage changed");
          if(context){await this.requireReadyTask(context.root);check();}
          if(setup.taskId){const task=await this.storage.call<ProjectTaskView>("projectTask",{id:setup.taskId});if(!task||task.archivedAt||task.status!=="running")throw new Error("Saved task owner is unavailable");check();}
          if(existing){await this.requireReadyTask(existing);check();await this.get(existing.id);check();}
          else{
            if(setup.phase==="reserved"){
              await this.assertSetupSource(setup);check();
              await this.storage.call("commandSetupPhase",{id:commandId,from:"reserved",to:"allocating"});check();
              const copy=setup.workspaceMode&&!setup.inPlace?await createCodeWorkspace(setup.sourceCwd!,this.dataDir,setup.sessionId,setup.baseCommit,setup.workspaceMode,check):undefined;check();
              if(copy?.workspace.kind==="worktree"){
                const identity=await describeGitRoot(copy.cwd,setup.baseCommit),info=await stat(copy.cwd),gitInfo=await stat(identity.gitDir);check();
                Object.assign(setup,await this.storage.call<WorkspaceSetup>("commandSetupIdentity",{id:commandId,identity:{workspaceGitDir:identity.gitDir,workspaceDev:info.dev,workspaceIno:info.ino,workspaceGitDev:gitInfo.dev,workspaceGitIno:gitInfo.ino}}));
              }else Object.assign(setup,await this.storage.call<WorkspaceSetup>("commandSetupPhase",{id:commandId,from:"allocating",to:"allocated"}));
            }
            check();const manager=await this.savedSetupManager(setup);check();
            const profile=setup.profile as SessionPolicy["effective"]["profile"];if(!profile)throw new Error("Saved effective profile is missing");
            const workspace=setup.sourceCwd&&setup.baseCommit?{sourceCwd:setup.sourceCwd,baseCommit:setup.baseCommit,kind:setup.workspaceMode}:undefined;
            const policy:SessionPolicy={version:setup.policyVersion!,requested:setup.requested!,effective:{cwd:setup.cwd,model:setup.model,profile},...(workspace?{workspace}:{}),...(setup.role?{role:setup.role}:{}),setup,...(setup.taskId?{task:{id:setup.taskId,...(setup.repositoryId?{repositoryId:setup.repositoryId}:{})}}:{})};
            const row:RecordRow={id:setup.sessionId,cwd:setup.cwd,file:manager.getSessionFile()!,managerId:setup.managerId,model:setup.model,policy,status:"idle",parentId:setup.parentId??null,role:setup.agentRole??setup.role?.type??"root",rootId:setup.rootId};
            check();await this.storage.call("addSession",{...row,...(setup.parentId?{admissionId:setup.commandId,recoveryAdmission:true}:{}),creation:{source:"recovery",actor:"user",cause:"workspace_setup_continuation",commandId}});check();
            await this.storage.call("commandSetupPhase",{id:commandId,from:setup.phase,to:"registered"});check();await this.open(row,manager);check();
            await this.storage.call("commandSetupPhase",{id:commandId,from:"registered",to:"opened"});check();
          }
          await this.storage.call("commandStatus",{id:commandId,status:setup.kind==="session"?"completed":"reconciled"});completed=true;
          await this.send(setup.rootId??setup.sessionId,"session_created",{id:setup.sessionId,recovered:true},true);
          return {id:setup.sessionId,rootId:setup.rootId??setup.sessionId,status:"registered",replayed:false};
        }finally{if(!completed)await this.storage.call("commandTransition",{id:commandId,from:"continuing",to:"unknown"});}
      });
    },true);
  }
  async continueProjectTask(taskId:string,observations?:string[]){
    return this.withPromptAdmission(taskId,async admission=>{
      const task=await this.storage.call<ProjectTaskView|undefined>("taskSetupGet",{id:taskId});admission.check();
      if(!task||task.status!=="unknown"||task.archivedAt||!task.setupVersion||!task.coordinatorSetup)throw new Error("Task setup is not eligible for explicit continuation");
      const inspected=(await this.workspaceRecovery()).filter(item=>item.id===taskId);admission.check();
      if(!Array.isArray(observations)||observations.length!==inspected.length||observations.some((value,index)=>value!==inspected[index].observedRevision))throw new Error("Task observation changed; refresh inspection before continuing");
      const all=[...task.repositories.map(repo=>({setup:repo.setup!,repo})),{setup:task.coordinatorSetup,repo:undefined}];
      // Inspect ALL frozen sources and histories before allocating or registering ANY member.
      for(const {setup,repo} of all){
        if(!setup||setup.sessionId!==(repo?.sessionId??task.coordinatorId)||setup.managerId!==setup.sessionId||!setup.role||!setup.profile||!setup.requested||!setup.policyVersion||setup.taskId!==task.id)throw new Error("Task member lacks exact saved ownership");
        await this.assertSetupSource(setup);admission.check();
        const existing=await this.storage.call<RecordRow|undefined>("session",{id:setup.sessionId});admission.check();
        if(existing){await this.assertRegisteredSetup(existing,setup);if(existing.status==="running")throw new Error("Stop active task members before continuing setup");}
        if(repo){const observed=await inspectWorkspaceSetup(setup);if(observed.reason||(!observed.cwdExists&&setup.phase!=="reserved"))throw new Error(`Repository ${repo.id} is inspect-only: ${observed.reason??"allocation ownership is unavailable"}`);}
        else if(setup.phase==="reserved"){try{lstatSync(setup.cwd);throw new Error("Reserved coordinator path already exists");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
        else{const info=lstatSync(setup.cwd);if(await realpath(setup.cwd)!==setup.cwd||info.dev!==setup.cwdDev||info.ino!==setup.cwdIno||!info.isDirectory())throw new Error("Coordinator directory differs from frozen identity");}
        if(["dispatching","ready","unknown"].includes(setup.phase)&&!existing)throw new Error("Task member dispatch is uncertain");
        const dir=await realpath(setup.managerDir),matches=readdirSync(dir).filter(name=>name.endsWith(`_${setup.managerId}.jsonl`));
        if(matches.length>1)throw new Error("Multiple Pi histories match a saved task manager ID");
        if(matches.length)readPiHistory(join(dir,matches[0]),dir,setup.managerId,setup.cwd);
        else if(existing?.dispatchStarted)throw new Error("Task member history is missing after possible dispatch");
        admission.check();
      }
      if(!await this.storage.call<boolean>("claimTaskContinuation",{id:task.id,task}))throw new Error("Task continuation was already claimed or changed");
      let completed=false;
      try{
        const fresh=(await this.workspaceRecovery()).filter(item=>item.id===taskId);admission.check();if(JSON.stringify(fresh.map(item=>item.observedRevision))!==JSON.stringify(observations))throw new Error("Task observation changed during continuation");
        for(const {setup,repo} of all){
          admission.check();await this.assertSetupSource(setup);admission.check();
          const existing=await this.storage.call<RecordRow|undefined>("session",{id:setup.sessionId});admission.check();
          if(existing){await this.get(existing.id);admission.check();continue;}
          if(setup.phase==="reserved"){
            if(repo){const observed=await inspectWorkspaceSetup(setup);if(observed.reason)throw new Error(observed.reason);}
            await this.storage.call("taskSetupPhase",{id:task.id,sessionId:setup.sessionId,from:"reserved",to:"allocating"});admission.check();
            if(repo){
              const copy=await createCodeWorkspace(setup.sourceCwd!,this.dataDir,setup.sessionId,setup.baseCommit,setup.workspaceMode,admission.check);admission.check();
              if(copy.workspace.kind==="worktree"){
                const identity=await describeGitRoot(copy.cwd,setup.baseCommit),info=await stat(copy.cwd),gitInfo=await stat(identity.gitDir);admission.check();
                const saved=await this.storage.call<ProjectTaskView>("taskSetupMemberIdentity",{id:task.id,sessionId:setup.sessionId,identity:{cwd:copy.cwd,workspaceGitDir:identity.gitDir,workspaceDev:info.dev,workspaceIno:info.ino,workspaceGitDev:gitInfo.dev,workspaceGitIno:gitInfo.ino}});Object.assign(setup,saved.repositories.find(member=>member.sessionId===setup.sessionId)!.setup);
              }else{await this.storage.call("taskSetupPhase",{id:task.id,sessionId:setup.sessionId,from:"allocating",to:"allocated"});setup.phase="allocated";}
            }else{
              admission.check();const parent=dirname(setup.cwd);await mkdir(parent,{recursive:true,mode:0o700});if(await realpath(parent)!==parent)throw new Error("Coordinator parent resolves elsewhere");admission.check();
              await mkdir(setup.cwd,{mode:0o700});const info=await stat(setup.cwd);admission.check();
              const saved=await this.storage.call<ProjectTaskView>("taskSetupCoordinatorIdentity",{id:task.id,identity:{cwdDev:info.dev,cwdIno:info.ino}});Object.assign(setup,saved.coordinatorSetup);
            }
          }
          admission.check();const manager=await this.savedSetupManager(setup);admission.check();
          const workspace=repo?{sourceCwd:setup.sourceCwd!,baseCommit:setup.baseCommit!,kind:setup.workspaceMode}:undefined;
          const policy:SessionPolicy={version:setup.policyVersion!,requested:setup.requested!,effective:{cwd:setup.cwd,model:setup.model,profile:setup.profile as SessionPolicy["effective"]["profile"]},role:setup.role!,setup,...(workspace?{workspace}:{}),task:{id:task.id,...(repo?{repositoryId:repo.id}:{})}};
          const row:RecordRow={id:setup.sessionId,cwd:setup.cwd,file:manager.getSessionFile()!,managerId:setup.managerId,model:setup.model,policy,status:"idle",parentId:null,role:"root"};
          await this.storage.call("addSession",{...row,creation:{source:"recovery",actor:"user",cause:"task_setup_continuation",commandId:task.id}});admission.check();
          await this.storage.call("taskSetupPhase",{id:task.id,sessionId:setup.sessionId,from:setup.phase,to:"registered"});admission.check();
          await this.open(row,manager);admission.check();
          await this.storage.call("taskSetupPhase",{id:task.id,sessionId:setup.sessionId,from:"registered",to:"opened"});
        }
        admission.check();if(!await this.storage.call<boolean>("continueProjectTask",{id:task.id}))throw new Error("Task status changed during continuation");completed=true;
        await this.send(task.coordinatorId,"session_created",{id:task.coordinatorId,recovered:true},true);return {id:task.id,status:"running",replayed:false};
      }finally{if(!completed)await this.storage.call("releaseTaskContinuation",{id:task.id});}
    });
  }
  /** `steps:"latest"` leaves the work steps of earlier turns out (the chat view reads them on demand with `workSteps`). */
  async snapshot(id:string,options:{steps?:"all"|"latest"}={}):Promise<SessionView>{
    const cursor=await this.storage.call<number>("latest",{sessionId:id});
    const {session,row}=await this.get(id);const approvals=await this.storage.call<ApprovalView[]>("approvals",{sessionId:id});
    const agents=(await this.storage.call<Array<RecordRow&{revisionReviewer:boolean}>>("agents",{rootId:id})).map((item):AgentView=>({id:item.id,parentId:item.parentId,role:item.role,status:item.status,model:item.model,cwd:item.cwd,revisionReviewer:item.revisionReviewer}));
    const visible=cachedVisibleMessages(session,row.cwd),messages=options.steps==="latest"?trimWorkSteps(visible):visible,[recoveryInputs,recoveryActions]=await Promise.all([this.storage.call<RecoveryInput[]>("recoveryInputs",{sessionId:id}),this.storage.call<RecoveryAction[]>("recoveryActions",{sessionId:id})]);
    return {id,cwd:row.cwd,model:row.model,policy:row.policy,status:row.status,cursor,agents,approvals,grants:this.grantedTools(id),recoveryInputs,recoveryActions,messages,archivedAt:await this.storage.call<number|null>("ownerArchivedAt",{id})};
  }
  /** The open session's saved state without building its messages: for routes that only check existence, folder, policy or run status. */
  async state(id:string):Promise<Pick<SessionView,"id"|"cwd"|"model"|"policy"|"status">>{
    const {row}=await this.get(id);return {id,cwd:row.cwd,model:row.model,policy:row.policy,status:row.status};
  }
  /** Work steps of one turn (the user message ID from `snapshot`); undefined when that message has none. */
  async workSteps(id:string,messageId:string):Promise<WorkView|undefined>{
    const {session,row}=await this.get(id);
    return cachedVisibleMessages(session,row.cwd).find(message=>message.id===messageId)?.work;
  }
  /** One image of one user message (the message id from `snapshot`, the 0-based image position); undefined when it does not exist. */
  async messageImage(id:string,messageId:string,position:number):Promise<{mimeType:string;data:Buffer}|undefined>{
    const {session}=await this.get(id),message=/^\d+$/.test(messageId)?(session.messages as any[])[Number(messageId)]:undefined;
    if(message?.role!=="user"||!Array.isArray(message.content))return;
    const part=message.content.filter((item:any)=>item?.type==="image")[position];
    return part&&typeof part.mimeType==="string"&&typeof part.data==="string"?{mimeType:part.mimeType,data:Buffer.from(part.data,"base64")}:undefined;
  }
  /** Tools a new root session (parallel mode, as the new-session screen creates) would get, for the @-picker before a session exists. */
  newSessionTools(cwd:string):MentionTool[]{
    const allow=async()=>true,defs:Array<{name:string;description?:string}>=[...inspectionTools(cwd,this.protectPath,allow,()=>false),...mutationTools(cwd,allow as any,async()=>{},()=>false),this.bashTool({cwd} as RecordRow),askUserTool(),{name:"delegate",description:delegateDescription(PARALLEL_CODE_PROFILE)},...this.browserUse?this.browserUse.tools("",()=>true,allow):[]];
    return defs.map((tool):MentionTool=>({name:tool.name,description:String(tool.description??"").split("\n")[0].slice(0,160)}));
  }
  /** Working folder, active tools and protected roots that @-mentions may not reach, for one open session. */
  async mentionContext(id:string){
    const {session,row}=await this.get(id),active=new Set(session.getActiveToolNames());
    const tools=session.getAllTools().filter(tool=>active.has(tool.name)).map((tool):MentionTool=>({name:tool.name,description:String(tool.description??"").split("\n")[0].slice(0,160)}));
    return {cwd:row.cwd,tools,deny:[this.dataDir,getAgentDir()]};
  }
  async childSnapshot(rootId:string,childId:string){
    await this.storage.call("descendantMember",{rootId,agentId:childId});
    return this.snapshot(childId,{steps:"latest"});
  }
  async archiveOwner(id:string,archived:boolean,taskOwner=false){
    const task=taskOwner?await this.storage.call<ProjectTaskView|undefined>("projectTask",{id}):undefined;
    if(taskOwner&&!task)throw new Error("Task unavailable");
    const roots=task?[task.coordinatorId,...task.repositories.map(repo=>repo.sessionId)]:[id];
    const ids=new Set([id,...roots]);
    for(const root of roots)for(const member of await this.storage.call<Array<{id:string}>>("agents",{rootId:root}))ids.add(member.id);
    // Freeze every tree member before the storage transaction. Existing owners keep their ticket.
    if([...ids].some(member=>this.archiving.has(member)))throw new Error("Archive or restore already in progress");
    for(const member of ids)this.archiving.add(member);
    try{
      if(!archived&&[...this.promptAdmissions].some(item=>item.cleanup))throw new Error("Cleanup is running; wait for it before restoring");
      if(archived&&([...this.promptAdmissions].some(item=>ids.has(item.id)||item.unresolvedOwner)||[...this.children.values()].some(run=>ids.has(run.row.id)||run.row.ancestors?.some(parent=>ids.has(parent)))||[...this.loading.keys()].some(member=>ids.has(member))))throw new Error("Owner work is admitted; wait for it to finish before archiving");
      return await this.storage.call(taskOwner?"archiveProjectTask":"archiveSession",{id,archived});
    }finally{for(const member of ids)this.archiving.delete(member);}
  }
  /** Switch the model (and reasoning) a root session uses for its NEXT prompts. Persisted first-class so a restart reopens with it. */
  async switchModel(id:string,modelKey:string,reasoning:RoleReasoning|null,admission:PromptAdmission){
    const row=await this.storage.call<RecordRow|undefined>("session",{id});
    if(!row)throw new Error("Unknown session");
    if(row.parentId)throw new Error("The model can be changed on the main session only");
    await this.requireReadyTask(row);
    if(row.policy?.task)throw new Error("Multi-repository task sessions keep the task model");
    if(row.model.startsWith(`${AGY_UNSUPERVISED_PROVIDER_ID}/`)||row.policy?.unsupervised||modelKey.startsWith(`${AGY_UNSUPERVISED_PROVIDER_ID}/`))throw new Error("Unsupervised Antigravity needs its own dedicated worktree session; the model cannot be switched to or from it");
    const cached=this.active.get(id);
    if(row.status==="running"||cached?.row.status==="running"||cached?.session.isStreaming||this.cleanupBusy(new Set([id]),id)||[...this.promptAdmissions].some(item=>item!==admission&&item.id===id))throw new Error("Session is busy; wait for the current run to finish before switching the model");
    admission.check();
    const model=(await this.availableModels()).find(item=>`${item.provider}/${item.id}`===modelKey);
    if(!model)throw new Error("Selected model is unavailable");
    const levels=getSupportedThinkingLevels(model);
    if(reasoning&&!levels.includes(reasoning))throw new Error("Reasoning level is unavailable for the selected model");
    // No explicit level: the model's default (DEFAULT_REASONING when supported). Root has no role reasoning.
    const level=reasoning??null;
    const previous=cached?.session.model;
    // Pi falls back to its own default when no level is requested; apply it explicitly so a live session does not keep the previous (e.g. high) level.
    const fallbackLevel=level??(levels.includes(DEFAULT_REASONING)?DEFAULT_REASONING:levels[0]??"off");
    let effective:string=fallbackLevel;
    if(cached){
      await cached.session.setModel(model);cached.session.setThinkingLevel(fallbackLevel);effective=cached.session.thinkingLevel;
      const live=cached.session.model;
      const blocked=live&&NATIVE_PROVIDER_IDS.has(live.provider)&&(!this.nativeIdentity?.(live)||!this.nativeProviders.isConnected())?"Native model configuration is blocked":live?.provider===CLIPROXY_PROVIDER_ID&&!this.cliproxyProviders.isConnected(live)?"Local proxy model configuration is blocked":"";
      if(blocked){if(previous)await cached.session.setModel(previous).catch(()=>{});throw new Error(blocked);}
    }
    try{
      admission.check();
      const saved=await this.storage.call<RecordRow>("switchModel",{id,model:modelKey,reasoning:level});
      if(cached){cached.row.model=saved.model;(cached.row as {policy:unknown}).policy=saved.policy;}
      await this.send(id,"model_changed",{model:modelKey,reasoning:level,effective},true);
      return {model:modelKey,reasoning:level};
    }catch(error){if(cached&&previous)await cached.session.setModel(previous).catch(()=>{});throw error;}
  }
  // Why Sigma still owns any of these sessions in memory (admissions, children, loading, running); null when quiescent.
  cleanupBusy(ids:Set<string>,self:string):string|null{
    if([...this.promptAdmissions].some(item=>item.id!==self&&(ids.has(item.id)||item.unresolvedOwner)))return "Owner work is admitted";
    if([...this.children.values()].some(run=>ids.has(run.row.id)||run.row.ancestors?.some(parent=>ids.has(parent))))return "A child run is active";
    if([...this.loading.keys()].some(member=>ids.has(member)))return "Session is loading";
    if([...this.active.values()].some(item=>ids.has(item.row.id)&&item.row.status==="running"))return "Session is running";
    if([...ids].some(id=>this.archiving.has(id)||this.stopping.has(id)))return "Archive, restore or Stop is in progress";
    return null;
  }
  async withPromptAdmission<T>(id:string,action:(admission:PromptAdmission)=>Promise<T>,unresolvedOwner=false):Promise<T>{
    let finish=()=>{};
    const admission:PromptAdmission={id,unresolvedOwner,cancelled:false,done:new Promise<void>(resolve=>{finish=resolve;}),check:()=>{const row=this.active.get(id)?.row;if(this.closing||this.backgroundFailure||this.archiving.has(id)||admission.cancelled||this.stopping.has(id)||row&&this.isStopping(row))throw new Error("Session stopped before prompt dispatch");}};
    this.promptAdmissions.add(admission);
    try{admission.check();await this.storage.call("assertOwnerAvailable",{id});admission.check();return await action(admission);}finally{this.promptAdmissions.delete(admission);finish();}
  }
  async prompt(id:string,text:string,behavior?:"steer"|"followUp",commandId?:string,rootId?:string,review?:{agentId:string;id:string;revision:string},promptAdmission?:PromptAdmission,images?:ImageContent[]):Promise<"queued"|"dispatched">{
    if(!promptAdmission)return this.withPromptAdmission(id,admission=>this.prompt(id,text,behavior,commandId,rootId,review,admission,images));
    let admission:"rejected"|"dispatched"|"unknown"="rejected";
    let childRun:ChildRun|undefined,finish=()=>{},timer:ReturnType<typeof setTimeout>|undefined;
    let run:Promise<void>|undefined,unsubscribeQueue=()=>{},released=false,admissionLock=false;
    const releaseChild=()=>{if(!childRun||released)return;released=true;if(timer)clearTimeout(timer);if(this.children.get(id)===childRun)this.children.delete(id);this.runningChildren--;finish();};
    try{
      promptAdmission.check();
      if(rootId){if(this.admittingChildren.has(id))throw new Error("Child prompt admission is already in progress");this.admittingChildren.add(id);admissionLock=true;}
      const {session,row}=await this.get(id);
      if(images?.length&&!session.model?.input?.includes("image"))throw new Error("The selected model cannot read images");
      promptAdmission.check();await this.requireReadyTask(row);promptAdmission.check();
      if(rootId){
        if((await this.storage.call<DelegationContext>("descendantMember",{rootId,agentId:id})).root.id!==rootId||await this.storage.call<boolean>("reviewAgent",{agentId:id}))throw new Error("Child messaging unavailable");
        promptAdmission.check();
        if(session.isStreaming){if(!this.children.has(id)||row.status!=="running")throw new Error("Child run is unavailable");}
        else{
          if(this.children.has(id))throw new Error("Child turn is settling; inspect history before trying again");
          if(row.status!=="settled")throw new Error("Child run is unavailable");
          this.runningChildren++;
          childRun={row,cancelled:false,done:new Promise<void>(resolve=>{finish=resolve;})};this.children.set(id,childRun);
          timer=setTimeout(()=>{void this.stopChild(childRun!).catch(()=>{});},row.policy?.effective.profile.childTimeoutMs??READ_ONLY_PROFILE.childTimeoutMs);
        }
      }else if(row.parentId)throw new Error("Child sessions require the root session child control");
      if(this.isStopping(row))throw new Error("Session is stopping");
      if(session.isStreaming&&!behavior)throw new Error("Session is running; choose steer or follow-up");
      const previous=row.status,queued=session.isStreaming;
      if(!queued)await this.setStatus(row,"running");
      promptAdmission.check();
      if(this.isStopping(row)||row.status==="interrupted")throw new Error("Session stopped before prompt dispatch");
      if(row.policy?.task&&this.stoppingTasks.has(row.policy.task.id)){if(!queued)await this.setStatus(row,previous);throw new Error("Task is stopping");}
      let decide!:(accepted:boolean|null)=>void,callbackSeen=false;
      const preflight=new Promise<boolean|null>(resolve=>{decide=resolve;});
      let observedQueue=false,queuedCount=session.pendingMessageCount;
      if(rootId&&queued)unsubscribeQueue=session.subscribe(event=>{if(event.type==="queue_update"){const count=event.steering.length+event.followUp.length;if(count>queuedCount)observedQueue=true;queuedCount=count;}});
      if(commandId){
        const factId=`input:${commandId}`,first=!review&&!behavior&&!await this.storage.call<boolean>("graphHasPriorInput",{id,excludeFactId:factId});
        const fact:GraphFact={id:factId,kind:review?"result":behavior??(first?"prompt":"followUp"),source:review?.agentId??"user",target:id,actor:"user",cause:review?"user_review_transfer":rootId?"user_child_message":"user_prompt",commandId,...(review?{reviewId:review.id,revision:review.revision}:{}),outcome:"unknown",run:null,sourceRun:review?await this.storage.call<RunMetadata|null>("graphMetadataFor",{id:review.agentId}):undefined};
        this.graphInputs.set(commandId,{row,text,fact,entries:new Set(session.sessionManager.getEntries().map(entry=>entry.id))});await this.fact(row,fact);
      }
      promptAdmission.check();
      if(!await this.storage.call<boolean>("markSessionDispatch",{id:row.id}))throw new Error("Session dispatch ownership is unavailable");
      promptAdmission.check();
      run=session.prompt(text,{...(behavior?{streamingBehavior:behavior}:{}),...(images?.length?{images}:{}),preflightResult:disposition=>{callbackSeen=true;try{promptAdmission.check();}catch(error){decide(false);if(disposition!=="started")throw error;void session.abort().catch(()=>{});return;}decide(true);}});
      if(childRun)void run.finally(releaseChild).catch(()=>{});
      void run.then(()=>{if(!callbackSeen)decide(null);},()=>{if(!callbackSeen)decide(false);});
      const accepted=await preflight;
      unsubscribeQueue();unsubscribeQueue=()=>{};
      if(accepted===null){admission="unknown";if(rootId)await session.abort();throw new Error("Prompt admission is uncertain; inspect session history before retrying");}
      if(!accepted){if(commandId){const input=this.graphInputs.get(commandId);if(input){await this.fact(row,{...input.fact,outcome:"rejected"});this.graphInputs.delete(commandId);}}await run.catch(()=>{});if(!this.isStopping(row))await this.setStatus(row,previous);throw new Error("Pi rejected prompt before dispatch; check model authentication");}
      if(rootId&&queued&&!observedQueue){admission="unknown";await session.abort();throw new Error("Child run ended during prompt admission; inspect its history before sending a new command");}
      admission="dispatched";
      if(commandId)await this.storage.call("commandStatus",{id:commandId,status:queued?"queued":"dispatched"});
      this.track(run.then(async()=>{if(commandId&&!queued)await this.storage.call("commandStatus",{id:commandId,status:childRun?.cancelled?"unknown":"completed"});},async()=>{
        if(commandId)await this.storage.call("commandStatus",{id:commandId,status:"unknown"});
        if(!this.isStopping(row)&&row.status==="running")await this.setStatus(row,"error");await this.send(row.rootId||id,"error",{message:"Pi run failed; inspect session history before retrying"},true);
      }));
      return queued?"queued":"dispatched";
    }catch(error){if(!run)releaseChild();if(commandId)await this.storage.call("commandStatus",{id:commandId,status:admission});throw error;}
    finally{unsubscribeQueue();if(admissionLock)this.admittingChildren.delete(id);}
  }
  private async fact(row:RecordRow,fact:Omit<GraphFact,"run">&{run?:RunMetadata|null;receiptEntryId?:string}){
    const payload={...fact,run:fact.run===undefined?this.active.get(row.id)?.metadata??null:fact.run};
    await this.send(row.id,"graph_fact",payload,true);return payload;
  }
  private async prepareReceipt(row:RecordRow,source:string,toolCallId:string,cause:string,sourceMessageId?:string){
    const messageId=sourceMessageId??[...visibleMessages((await this.get(source)).session,row.cwd)].reverse().find(message=>message.role==="assistant")?.id;
    const observed=messageId===undefined?null:await this.storage.call<{run:RunMetadata|null;entryId:string}|null>("graphMessageRun",{id:source,messageIndex:Number(messageId)});
    return this.fact(row,{id:`receipt:${row.id}:${toolCallId}`,kind:"result",source,target:row.id,actor:row.id,cause,toolCallId,commandId:`pi-tool:${row.id}:${toolCallId}`,outcome:"unknown",sourceRun:observed?.run??null,...(messageId?{sourceMessageId:messageId,sourceEntryId:observed?.entryId}:{})});
  }
  private isStopping(row:RecordRow){return this.closing||!!row.policy?.task&&this.stoppingTasks.has(row.policy.task.id)||[row.id,...row.ancestors??[]].some(id=>this.stopping.has(id)||this.children.get(id)?.cancelled);}
  private finishApproval(id:string,p:Pending,status:"approved"|"denied"|"expired"):Promise<void>{
    if(p.finalizing)return p.finalizing;
    if(this.pending.get(id)!==p)return Promise.resolve();
    this.pending.delete(id);clearTimeout(p.timer);
    const finalizing=(async()=>{
      try{await p.ready;await this.storage.call("approvalStatus",{id,status});await this.send(p.sessionId,"approval_decision",{id,status},true);p.resolve(status==="approved");}
      catch(error){p.resolve(false);throw error;}
    })();
    p.finalizing=finalizing;this.approvalFinalizers.add(finalizing);
    void finalizing.then(()=>this.approvalFinalizers.delete(finalizing),()=>this.approvalFinalizers.delete(finalizing));
    return finalizing;
  }
  private async denyApprovals(rootId:string,agentId?:string){await Promise.all([...this.pending].filter(([,p])=>p.sessionId===rootId&&(!agentId||p.agentId===agentId)).map(([id,p])=>this.finishApproval(id,p,"denied")));}
  private stopChild(run:ChildRun):Promise<void>{
    if(run.stop)return run.stop;
    if(run.row.status!=="idle"&&run.row.status!=="running")return Promise.resolve();
    run.cancelled=true;
    run.stop=(async()=>{if(run.registered!==false)await this.setStatus(run.row,"interrupted");await this.denyApprovals(run.row.rootId||run.row.id,run.row.id);await this.active.get(run.row.id)?.session.abort();})();
    return run.stop;
  }
  // Establish the fence synchronously, before API cancellation can wait on checks or reviews.
  stopFence(id:string){
    if(this.stopping.has(id))throw new Error("Session stop is already in progress");
    this.stopping.add(id);this.browserUse?.revoke(id);for(const admission of this.promptAdmissions)if(admission.id===id||admission.unresolvedOwner)admission.cancelled=true;return ()=>this.stopping.delete(id);
  }
  private async abortTree(id:string){
    const members=await this.storage.call<Array<{id:string}>>("agents",{rootId:id});
    const memberIds=new Set([id,...members.map(member=>member.id)]);
    const admissions=()=>[...this.promptAdmissions].filter(admission=>memberIds.has(admission.id)||admission.unresolvedOwner);
    for(const admission of admissions())admission.cancelled=true;
    const runs=[...this.children.values()].filter(run=>run.row.id===id||run.row.ancestors?.includes(id));
    for(const run of runs)run.cancelled=true;
    const agents=[...this.active.values()].filter(active=>active.row.id===id||active.row.ancestors?.includes(id));
    const ids=new Set([id,...runs.map(run=>run.row.id),...agents.map(active=>active.row.id)]);
    await Promise.all([...this.pending].filter(([,p])=>ids.has(p.agentId)).map(([approvalId,p])=>this.finishApproval(approvalId,p,"denied")));
    await Promise.all([
      ...runs.map(run=>this.stopChild(run)),
      ...agents.map(async active=>{if(active.row.status==="running"){await this.setStatus(active.row,"interrupted");await active.session.abort();}}),
    ]);
    await Promise.all(runs.map(run=>run.done));
    // Keep the fence until admissions at API/SDK awaits have unwound, including arrivals during Stop.
    for(let pending=admissions();pending.length;pending=admissions()){
      for(const admission of pending)admission.cancelled=true;
      await Promise.all(pending.map(admission=>admission.done));
    }
  }
  async abortChild(rootId:string,childId:string){
    await this.storage.call("descendantMember",{rootId,agentId:childId});
    if(await this.storage.call<boolean>("reviewAgent",{agentId:childId}))throw new Error("Use the revision-bound review control");
    const release=this.stopFence(childId);
    try{await this.abortTree(childId);}finally{release();}
  }
  async abort(id:string){
    const release=this.stopping.has(id)?()=>{}:this.stopFence(id);
    try{const row=await this.storage.call<RecordRow|undefined>("session",{id});if(row?.parentId)throw new Error("Use the root session child control");await this.abortTree(id);}finally{release();}
  }
  async stopProjectTask(task:ProjectTaskView,stopMember:(id:string)=>Promise<void>){
    if(this.stoppingTasks.has(task.id))throw new Error("Task stop is already in progress");
    this.stoppingTasks.add(task.id);
    const ids=[task.coordinatorId,...task.repositories.map(repo=>repo.sessionId)],releases=ids.map(id=>this.stopping.has(id)?()=>{}:this.stopFence(id));
    try{
      const admissions=[...this.promptAdmissions].filter(item=>item.id===task.id||ids.includes(item.id));for(const item of admissions)item.cancelled=true;
      const stops=ids.map(async id=>{if(await this.storage.call<RecordRow|undefined>("session",{id}))await (id===task.coordinatorId?this.abort(id):stopMember(id));});
      const outcomes=await Promise.allSettled([...stops,...admissions.map(item=>item.done)]);
      if(outcomes.some(outcome=>outcome.status==="rejected"))throw new Error("Some task sessions could not be stopped; inspect each repository");
    }finally{for(const release of releases)release();this.stoppingTasks.delete(task.id);}
  }
  /** `scope:"chat"` also allows this tool without asking for the rest of the chat (every agent under the same root) and releases its other waiting calls. */
  async decide(id:string,approvalId:string,allow:boolean,scope:"once"|"chat"="once"){
    const p=this.pending.get(approvalId);if(!p||p.sessionId!==id)throw new Error("Approval is no longer pending");
    if(allow&&scope==="chat"&&!GRANTABLE_TOOLS.has(p.tool))throw new Error("This tool is approved one call at a time");
    const row=this.active.get(p.agentId)?.row??this.children.get(p.agentId)?.row;
    if(this.stopping.has(id)||row&&this.isStopping(row))throw new Error("Agent stopped");
    if(allow&&scope==="chat"){const set=this.grants.get(id)??new Set<string>();set.add(p.tool);this.grants.set(id,set);await this.send(id,"approval_grants",{tools:[...set]},false);}
    await this.finishApproval(approvalId,p,allow?"approved":"denied");
    if(allow&&scope==="chat")await Promise.allSettled([...this.pending].filter(([,other])=>other.sessionId===id&&other.tool===p.tool).map(([otherId,other])=>this.finishApproval(otherId,other,"approved")));
  }
  /** Tools allowed for the rest of this chat. */
  grantedTools(id:string):string[]{return [...this.grants.get(id)??[]];}
  /** Ask again for every call in this chat. */
  async revokeGrants(id:string){this.grants.delete(id);await this.send(id,"approval_grants",{tools:[]},false);}
  beginShutdown(){this.closing=true;clearInterval(this.trimTimer);killAllShells();this.providerAuth?.beginShutdown();this.nativeProviders?.beginShutdown();}
  close(){
    this.beginShutdown();
    return this.closeWork??=(async()=>{
    const failures:unknown[]=[],settle=async(work:()=>unknown|Promise<unknown>)=>{try{await work();}catch(error){failures.push(error);}};
    const authDrain=settle(()=>this.providerAuth?.close());const nativeDrain=settle(()=>this.nativeProviders?.close());const proxyDrain=settle(()=>this.cliproxyProviders?.close());
    const loading=[...this.loading.values()],admissions=[...this.promptAdmissions];let runs=[...this.children.values()];
    for(const run of runs)run.cancelled=true;for(const admission of admissions)admission.cancelled=true;
    const approvalDrain=Promise.all([...this.pending].map(([id,p])=>settle(()=>this.finishApproval(id,p,"expired"))));
    await Promise.allSettled(loading);
    runs=[...new Set([...runs,...this.children.values()])];for(const run of runs)run.cancelled=true;
    const active=[...this.active.values()];
    await approvalDrain;
    await Promise.all([
      ...runs.map(run=>settle(()=>this.stopChild(run))),
      ...active.map(({session,row})=>settle(async()=>{await session.abort();if(row.status==="running")await this.setStatus(row,"interrupted");})),
    ]);
    await Promise.allSettled([...runs.map(run=>run.done),...admissions.map(admission=>admission.done)]);
    while(this.approvalFinalizers.size)await Promise.allSettled([...this.approvalFinalizers]);
    for(const id of this.deltas.keys())await settle(()=>this.flushDelta(id));
    for(const key of this.thinkings.keys()){const [channel,agentId]=key.split("\0");await settle(()=>this.flushThinking(channel,agentId));}
    for(const {session,unsubscribe} of active)await settle(()=>{unsubscribe();session.dispose();});
    while(this.background.size)await Promise.allSettled([...this.background]);
    await Promise.all([authDrain,nativeDrain,proxyDrain]);
    if(this.backgroundFailure)failures.push(new Error("Pi journal update failed before shutdown"));
    if(failures.length)throw new AggregateError(failures,"Pi host shutdown did not finish cleanly");
    })();
  }
}
