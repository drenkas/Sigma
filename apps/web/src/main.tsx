import { createEffect, createMemo, createSignal, For, Show, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import { READ_ONLY_PROFILE, type AgentView, type ApprovalView, type ChangesView, type EvidenceView, type ProjectTaskView, type RecoveryInput, type SessionView, type WorkStep, type WorkView, type SourceApplyView, type ProjectView, type WorkspaceMode, type GraphNode, type WorkspaceRecoveryItem } from "../../../packages/contracts/index.js";
import { api } from "./api.js";
import { Projects } from "./Projects.js";
import { Changes } from "./Changes.js";
import { Qa } from "./Qa.js";
import { BrowserUsePanel } from "./BrowserUse.js";
import { WorkerMerges } from "./WorkerMerges.js";
import { Logo } from "./Logo.js";
import { Markdown } from "./Markdown.js";
import { Graph } from "./Graph.js";
import { Repository } from "./Repository.js";
import { Roles } from "./Roles.js";
import { Cleanup } from "./Cleanup.js";
import { Providers } from "./Providers.js";
import { UpdateButton } from "./UpdateButton.js";
import { MAX_IMAGES, IMAGE_TYPES, fingerprint, readImages, type Attachment } from "./attachments.js";
import { createMention, renderMentions } from "./MentionPicker.js";
import "./style.css";

type Model = { provider:string; id:string; name:string; images:boolean; reasoningLevels?:string[]; legacy?:boolean };
type Listed = { id:string; cwd:string; sourceCwd?:string; model:string; status:string; created_at?:number; title?:string|null; archived_at?:number|null };
type Notice = { kind:"error"|"warning"|"info"; text:string };
type Conn = "connecting"|"ready"|"live"|"reconnecting"|"unreachable";
type Tool = { agentId?:string; tool:string; status:string; detail?:string };
type AgyRecord = { agentId:string; step:string; tool:string; params:string; status:"running"|"done"|"error" };
const AGY_WARNING="AGY runs its own file, shell, browser and other tools without Sigma approvals; Sigma only sees what AGY reports.";
type MemberSummary = {available:boolean;status:string;result:string;pending:number;files:number|null;omitted:number;check:string;review:string;sourceApply:string;evidenceError?:boolean};
type WorkspaceKind = WorkspaceMode|"clone";
type DetailTab = "overview"|"changes"|"repository"|"activity"|"graph";
type WriteObservation = {id:string;sessionId:string;path:string;beforeHash:string;afterHash:string;beforeMode:number|null;afterMode:number;observedHash:string;observedMode:number|null;state:"before"|"after"|"diverged"};

// ---------- presentation helpers ----------
const RUN:Record<string,{label:string;hint:string}>={
  idle:{label:"Idle",hint:"No Pi run in progress."},
  running:{label:"Running",hint:"A Pi run is in progress."},
  settled:{label:"Settled",hint:"The Pi run ended. This is not proof that the engineering task succeeded."},
  interrupted:{label:"Interrupted",hint:"Stopped by you or by a service restart."},
  error:{label:"Error",hint:"The Pi run ended with an error."},
};
const APPROVAL:Record<string,string>={pending:"Waiting",approved:"Allowed",denied:"Denied",expired:"Expired"};
const isDemo=(model:string)=>model.startsWith("sigma-demo/")||model.startsWith("pi-orch-demo/");
const MODE_LABEL:Record<string,string>={read:"Read only",code:"Editing",parallel:"Editing",multi:"Multi-repository"};
const humanError=(text:string,path="")=>{
  const m=/^(ENOENT|ENOTDIR|EACCES|EPERM)\b[^,]*,\s*\w+(?:\s+'?([^']+?)'?)?\s*$/.exec(text.trim());if(!m)return text;
  const where=m[2]||path;return m[1]==="ENOENT"?`Folder not found: ${where}`:m[1]==="ENOTDIR"?`Not a folder: ${where}`:`No access to ${where}`;
};
const modelName=(model:string)=>model.split("/").slice(1).join("/")||model;
const base=(path:string)=>path.split("/").filter(Boolean).pop()||path||"Workspace";
const short=(id:string)=>id.slice(0,8);
/** Titles show `@"my dir/a.md"` mention tokens as `@my dir/a.md`. */
const plainMentions=(text:string)=>text.replace(/(?<!\S)@"([^"\n]+)"/g,"@$1");
const firstLine=(text:string,max=72)=>{const line=text.trim().split("\n")[0];return line.length>max?`${line.slice(0,max-1)}…`:line;};
const message=(e:unknown)=>e instanceof Error?e.message:String(e);
const cap=(s:string)=>s.charAt(0).toUpperCase()+s.slice(1);
const taskState=(status:ProjectTaskView["status"])=>status==="running"?"Available":cap(status);
const workspaceKind=(session:SessionView|null):WorkspaceKind=>session?.policy?.workspace?.kind??"clone";
const taskWorkspaceKind=(task:ProjectTaskView):WorkspaceKind=>task.workspaceMode??"clone";
const elapsed=(ms:number)=>{const t=Math.max(0,Math.floor(ms/1000)),h=Math.floor(t/3600),m=Math.floor(t%3600/60),sec=t%60;return h?`${h}h ${String(m).padStart(2,"0")}m`:m?`${m}m ${String(sec).padStart(2,"0")}s`:`${sec}s`;};
type ToolStep=Extract<WorkStep,{kind:"tool"}>;
type WorkItem={kind:"note";text:string}|{kind:"thinking";text:string}|{kind:"tools";calls:ToolStep[]};
const groupWork=(steps:WorkStep[]):WorkItem[]=>{const out:WorkItem[]=[];for(const st of steps){if(st.kind!=="tool")out.push(st);else{const last=out[out.length-1];if(last?.kind==="tools")last.calls.push(st);else out.push({kind:"tools",calls:[st]});}}return out;};
const TOOL_VERB:Record<string,string>={read:"Read",ls:"Listed",find:"Explored",grep:"Searched",edit:"Edited",write:"Edited",bash:"Ran",delegate:"Delegated to",git_commit:"Committed"};
const toolSummary=(calls:ToolStep[])=>{
  if(calls.length===1){const c=calls[0],verb=TOOL_VERB[c.tool];if(c.tool==="ls"&&(!c.detail||c.detail==="."))return "Listed files";if(c.detail&&verb)return `${verb} ${c.detail}`;}
  const counts=new Map<string,number>();for(const c of calls){const key=["edit","write"].includes(c.tool)?"edit":c.tool==="find"?"grep":TOOL_VERB[c.tool]?c.tool:`use:${c.tool}`;counts.set(key,(counts.get(key)||0)+1);}
  const parts=[...counts].map(([key,n])=>key==="read"?`read ${n} file${n>1?"s":""}`:key==="edit"?`edited ${n} file${n>1?"s":""}`:key==="bash"?`ran ${n} command${n>1?"s":""}`:key==="ls"?`listed ${n} folder${n>1?"s":""}`:key==="find"||key==="grep"?`ran ${n} search${n>1?"es":""}`:key==="delegate"?`delegated ${n} task${n>1?"s":""}`:key==="git_commit"?`made ${n} commit${n>1?"s":""}`:`used ${key.slice(4)}`);
  return cap(parts.join(", "));
};
const liveActivity=(t:{tool:string;detail?:string})=>{const d=t.detail?` ${t.detail}`:"";return t.tool==="bash"?`Running${d}`:t.tool==="read"?`Reading${d}`:t.tool==="edit"||t.tool==="write"?`Editing${d}`:t.tool==="ls"?`Listing${d}`:t.tool==="grep"||t.tool==="find"?`Searching${d}`:t.tool==="delegate"?`Delegating${d?` to${d}`:""}`:`Using ${t.tool}${d}`;};
function ago(at?:number){
  if(!at)return "";const s=Math.max(0,(Date.now()-at)/1000);
  if(s<60)return "just now";if(s<3600)return `${Math.floor(s/60)} min ago`;if(s<86400)return `${Math.floor(s/3600)} h ago`;
  return new Date(at).toLocaleDateString(undefined,{month:"short",day:"numeric"});
}
const clock=(at:number)=>new Date(at).toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit"});

function RunBadge(p:{status:string;quiet?:boolean}){
  const known=()=>RUN[p.status]?p.status:"unknown";
  const info=()=>RUN[p.status]||{label:"Unknown",hint:`Unrecognized status “${p.status||"none"}”.`};
  return <span classList={{badge:true,[`st-${known()}`]:true,quiet:!!p.quiet}} title={info().hint}><span class="glyph" aria-hidden="true"/>{info().label}</span>;
}
function Icon(p:{name:"menu"|"panel"|"sidebar"|"close"|"refresh"|"plus"|"stop"|"send"|"copy"|"folder"|"cpu"|"bot"|"compose"|"up"|"chevron"|"pencil"|"archive"|"restore"|"more"|"attach"|"image"}){
  const d:Record<string,string>={
    menu:"M3 5h14M3 10h14M3 15h14",panel:"M3 4h14v12H3zM12 4v12",sidebar:"M3 4h14v12H3zM8 4v12",close:"M5 5l10 10M15 5L5 15",refresh:"M16 10a6 6 0 1 1-2-4.5M16 3v4h-4",
    plus:"M10 4v12M4 10h12",stop:"M6 6h8v8H6z",send:"M4 10h11M11 5l5 5-5 5",copy:"M7 7h9v9H7zM4 13V4h9",
    folder:"M3 6h5l2 2h7v8H3z",compose:"M11 4H4v12h12V9M8 12l1-3 6-6 2 2-6 6z",chevron:"M8 5l5 5-5 5",pencil:"M4 16l1-4 8-8 3 3-8 8zM12 5l3 3",archive:"M3 5h14v3H3zM4 8v8h12V8M8 11h4",more:"M5 10h.01M10 10h.01M15 10h.01",attach:"M16 9.5l-6 6a3.5 3.5 0 0 1-5-5l7-7a2.5 2.5 0 0 1 3.5 3.5l-7 7a1.2 1.2 0 0 1-1.7-1.7l6-6",image:"M3 4h14v12H3zM3 14l4-4 3 3 3-3 4 4M13.5 7.5h.01",restore:"M4 10a6 6 0 1 0 2-4.5M4 3v4h4",up:"M10 16V4M5 9l5-5 5 5",bot:"M4 7h12v9H4zM10 4v3M8 3.5h4M7.5 10.5v1.5M12.5 10.5v1.5M7.5 14h5M2 10v3M18 10v3",cpu:"M6 6h8v8H6zM8 3v3M12 3v3M8 14v3M12 14v3M3 8h3M3 12h3M14 8h3M14 12h3",
  };
  return <svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d={d[p.name]}/></svg>;
}
/** Small thumbnails of the images sent with a user message, loaded one by one from the session; the plain "N images" label stays as the fallback. */
function SentImages(p:{session:string;message:string;count:number}){
  const [failed,setFailed]=createSignal(false),label=()=>`${p.count} image${p.count===1?"":"s"}`;
  return <Show when={!failed()} fallback={<div class="msg-images"><Icon name="image"/>{label()}</div>}>
    <ul class="msg-thumbs" aria-label={label()}><For each={Array.from({length:p.count},(_,i)=>i)}>{i=>{const src=`/api/sessions/${p.session}/messages/${p.message}/images/${i}`;return <li><a href={src} target="_blank" rel="noopener noreferrer" title="Open the full image"><img src={src} alt={`Sent image ${i+1} of ${p.count}`} loading="lazy" onError={()=>setFailed(true)}/></a></li>;}}</For></ul>
  </Show>;
}
function WriteRecovery(p:{sessionId:string;approval:ApprovalView;offline:boolean;onDone:(id:string)=>Promise<void>}){
  const [observed,setObserved]=createSignal<WriteObservation|null>(null),[busy,setBusy]=createSignal(false),[error,setError]=createSignal(""),[done,setDone]=createSignal(false);
  const endpoint=()=>`/sessions/${p.sessionId}/writes/${p.approval.id}/reconcile`;
  const mode=(value:number|null)=>value===null?"absent":`0${value.toString(8)}`;
  async function review(){setBusy(true);setError("");try{setObserved(await api<WriteObservation>(endpoint()));}catch(e){setObserved(null);setError(message(e));}finally{setBusy(false);}}
  async function acknowledge(){const view=observed();if(!view)return;setBusy(true);setError("");try{
    await api(endpoint(),"POST",{acknowledge:true,observedHash:view.observedHash,observedMode:view.observedMode,state:view.state});setDone(true);setObserved(null);
    try{await p.onDone(p.sessionId);}catch{setError("Observation was recorded, but the session could not refresh. Reload before further work.");}
  }catch(e){setObserved(null);setError((e as {status?:number}).status===409?`Observation changed or reconciliation is unavailable: ${message(e)}. Refresh the session, then review again if needed; no write was replayed.`:`Acknowledgement result is uncertain: ${message(e)}. Refresh the session before another decision; no write was replayed.`);void p.onDone(p.sessionId).catch(()=>{});}finally{setBusy(false);}}
  return <div class="recovery-item">
    <strong>{p.approval.outcome==="applied"?"Write recorded; command completion unknown":"Uncertain approved write"} · <span class="mono dd-wrap">{p.approval.change?.path}</span></strong>
    <p class="hint">Inspect the file's current state. Acknowledgement records what is observed now; it does not repeat the write or establish when the file changed.</p>
    <Show when={!observed()&&!done()}><button class="btn ghost sm" disabled={busy()||p.offline} onClick={()=>void review()}>{busy()?"Inspecting…":"Review observed state"}</button></Show>
    <Show when={observed()}>{view=><>
      <dl class="summary"><div class="stack"><dt>Path</dt><dd class="mono dd-wrap">{view().path}</dd></div><div class="stack"><dt>Saved before</dt><dd class="mono dd-wrap">{view().beforeHash} · {mode(view().beforeMode)}</dd></div><div class="stack"><dt>Approved after</dt><dd class="mono dd-wrap">{view().afterHash} · {mode(view().afterMode)}</dd></div><div class="stack"><dt>Observed now</dt><dd class="mono dd-wrap">{view().observedHash} · {mode(view().observedMode)}</dd></div><div><dt>Match</dt><dd>{view().state}</dd></div></dl>
      <button class="btn primary sm" disabled={busy()||p.offline} onClick={()=>void acknowledge()}>{busy()?"Recording…":"Acknowledge observed state · no replay"}</button>
    </>}</Show>
    <Show when={done()}><p class="hint">Observed state recorded; no write was replayed.</p></Show>
    <Show when={error()}><p class="field-help warn" role="alert">{error()}</p></Show>
  </div>;
}

function App(){
  const [models,setModels]=createSignal<Model[]>([]),[sessions,setSessions]=createSignal<Listed[]>([]),[current,setCurrent]=createSignal<SessionView|null>(null);
  const [graphNode,setGraphNode]=createSignal<GraphNode|null>(null),[graphHistory,setGraphHistory]=createSignal<SessionView|null>(null),[graphHistoryError,setGraphHistoryError]=createSignal("");
  const conversation=()=>graphHistory()??current();
  let graphReadGeneration=0;
  async function readGraphNode(node:GraphNode,close=true){
    const scope=current()?.id;if(!scope)return;
    const generation=++graphReadGeneration;setGraphNode(node);setGraphHistoryError("");
    sessionStorage.setItem("sigma-graph-view",JSON.stringify({scope,node:node.id}));
    if(node.id===scope){setGraphHistory(null);return;}
    if(close)setGraphHistory(null);
    try{const view=await api<SessionView>(`/sessions/${scope}/graph/nodes/${node.id}/history`);if(generation===graphReadGeneration&&current()?.id===scope&&graphNode()?.id===node.id)setGraphHistory(view);}
    catch(e){if(generation===graphReadGeneration)setGraphHistoryError(message(e));}
    if(close&&overlayDetails())closeDetails();
  }
  function returnGraphRoot(){++graphReadGeneration;setGraphNode(null);setGraphHistory(null);setGraphHistoryError("");if(current())sessionStorage.setItem("sigma-graph-view",JSON.stringify({scope:current()!.id,node:current()!.id}));}
  const [switching,setSwitching]=createSignal(false);
  const [workspaceMode,setWorkspaceMode]=createSignal<"direct"|"worktree">("direct"),[access,setAccess]=createSignal<"full"|"ask">("full"),[thinking,setThinking]=createSignal<string[]>([]);
  const [workspace,setWorkspace]=createSignal(""),[selectedModel,setSelectedModel]=createSignal(""),[reasoning,setReasoning]=createSignal(""),[prompt,setPrompt]=createSignal(""),[draft,setDraft]=createSignal(""),[attachments,setAttachments]=createSignal<Attachment[]>([]),[dragging,setDragging]=createSignal(false);
  const [notice,setNotice]=createSignal<Notice|null>(null),[busy,setBusy]=createSignal(false),[tools,setTools]=createSignal<Tool[]>([]),[agyActivity,setAgyActivity]=createSignal<AgyRecord[]>([]),[shown,setShown]=createSignal(200);
  const [conn,setConn]=createSignal<Conn>("connecting"),[attempt,setAttempt]=createSignal(0),[booted,setBooted]=createSignal(false);
  const [loadingId,setLoadingId]=createSignal<string|null>(null),[openFailed,setOpenFailed]=createSignal<{id:string;text:string}|null>(null);
  const [refreshing,setRefreshing]=createSignal(false),[deciding,setDeciding]=createSignal<string[]>([]),[queued,setQueued]=createSignal<{id:string;count:number}|null>(null);
  const [stoppingChildren,setStoppingChildren]=createSignal<string[]>([]);
  const [selectedChildId,setSelectedChildId]=createSignal<string|null>(null),[childView,setChildView]=createSignal<SessionView|null>(null),[childText,setChildText]=createSignal(""),[childBehavior,setChildBehavior]=createSignal<"steer"|"followUp">("followUp"),[childBusy,setChildBusy]=createSignal(false);
  const [evidenceVersion,setEvidenceVersion]=createSignal(0);
  const [mergePending,setMergePending]=createSignal(0);
  const [navOpen,setNavOpen]=createSignal(false),[detailsOpen,setDetailsOpen]=createSignal(false),[detailTab,setDetailTab]=createSignal<DetailTab>("overview");
  const readCollapsed=(k:string)=>{try{return localStorage.getItem(k)==="1";}catch{return false;}};
  const [navCollapsed,setNavCollapsed]=createSignal(readCollapsed("sigma-nav-collapsed")),[detailsCollapsed,setDetailsCollapsed]=createSignal(readCollapsed("sigma-details-collapsed"));
  function toggleNavCollapsed(){const v=!navCollapsed();setNavCollapsed(v);try{localStorage.setItem("sigma-nav-collapsed",v?"1":"0");}catch{/* per-viewer convenience only */}queueMicrotask(()=>document.querySelector<HTMLElement>(v?".dock-nav-show":".dock-nav-hide")?.focus());}
  function toggleDetailsCollapsed(){const v=!detailsCollapsed();setDetailsCollapsed(v);try{localStorage.setItem("sigma-details-collapsed",v?"1":"0");}catch{/* per-viewer convenience only */}queueMicrotask(()=>document.querySelector<HTMLElement>(v?".dock-details-show":".dock-details-hide")?.focus());}
  const NavShow=()=><Show when={navCollapsed()}><button class="icon-btn dock-nav dock-nav-show" onClick={toggleNavCollapsed} aria-label="Show sidebar" title="Show sidebar" aria-controls="nav" aria-expanded="false"><Icon name="sidebar"/></button></Show>;
  const [projects,setProjects]=createSignal<ProjectView[]>([]),[projectId,setProjectId]=createSignal(""),[showProjects,setShowProjects]=createSignal(false);
  const [showRoles,setShowRoles]=createSignal(false),[showProviders,setShowProviders]=createSignal(false);
  const [projectTasks,setProjectTasks]=createSignal<ProjectTaskView[]>([]),[taskFocusId,setTaskFocusId]=createSignal<string|null>(null),[taskMembers,setTaskMembers]=createSignal<Record<string,MemberSummary>>({}),[taskCoordinatorAvailable,setTaskCoordinatorAvailable]=createSignal(false),[taskBusy,setTaskBusy]=createSignal(false);
  const sourceCwd=(s:SessionView)=>s.policy?.workspace?.sourceCwd??s.cwd;
  const selectedProject=createMemo(()=>projects().find(p=>p.id===projectId()));
  const taskSessionIds=createMemo(()=>new Set(projectTasks().flatMap(t=>[t.coordinatorId,...t.repositories.map(r=>r.sessionId)])));
  const inProject=(project:ProjectView,s:Listed)=>project.folders.includes(s.sourceCwd??s.cwd);
  const liveSessions=createMemo(()=>sessions().filter(s=>!taskSessionIds().has(s.id)&&!s.archived_at));
  const archivedSessions=createMemo(()=>sessions().filter(s=>!taskSessionIds().has(s.id)&&!!s.archived_at));
  const activeProjects=createMemo(()=>projects().filter(p=>!p.archivedAt));
  const archivedProjects=createMemo(()=>projects().filter(p=>!!p.archivedAt));
  const looseSessions=createMemo(()=>liveSessions().filter(s=>!projects().some(project=>inProject(project,s))));
  const looseTasks=createMemo(()=>projectTasks().filter(t=>!projects().some(project=>project.id===t.projectId)));
  const readExpanded=()=>{try{return new Set<string>(JSON.parse(localStorage.getItem("sigma-expanded-projects")||"[]"));}catch{return new Set<string>();}};
  const [expanded,setExpanded]=createSignal(readExpanded()),[showArchived,setShowArchived]=createSignal(false),[editRequest,setEditRequest]=createSignal(0),[showArchivedProjects,setShowArchivedProjects]=createSignal(false),[menu,setMenu]=createSignal<{project:ProjectView;top:number;left:number}|null>(null);
  const [workspaceRecovery,setWorkspaceRecovery]=createSignal<WorkspaceRecoveryItem[]>([]),[recoveryBusy,setRecoveryBusy]=createSignal<string|null>(null);
  function toggleProject(id:string,open=!expanded().has(id)){const next=new Set(expanded());if(open)next.add(id);else next.delete(id);setExpanded(next);try{localStorage.setItem("sigma-expanded-projects",JSON.stringify([...next]));}catch{/* per-viewer convenience only */}}
  const taskForSession=(id:string)=>projectTasks().find(t=>t.coordinatorId===id||t.repositories.some(r=>r.sessionId===id));
  const focusedTask=createMemo(()=>projectTasks().find(t=>t.id===taskFocusId()));
  const sessionArchived=()=>!!current()?.archivedAt;
  const taskUnresolved=()=>sessionArchived()||!!focusedTask()&&(focusedTask()!.status!=="running"||!!focusedTask()!.archivedAt);
  const prompts=new Map<string,string>(),attachmentDrafts=new Map<string,Attachment[]>();
  let stream:EventSource|undefined;let cursor=0;let reconnectTimer:ReturnType<typeof setTimeout>|undefined;let historyTimer:ReturnType<typeof setTimeout>|undefined;let recovering=false;let openGeneration=0;
  let scroller:HTMLDivElement|undefined,composer:HTMLTextAreaElement|undefined,detailsPanel:HTMLElement|undefined,detailsTitle:HTMLHeadingElement|undefined,recoverySection:HTMLElement|undefined,treeSection:HTMLElement|undefined,navPanel:HTMLElement|undefined,navTitle:HTMLHeadingElement|undefined,stick=true;

  const fail=(e:unknown)=>setNotice({kind:"error",text:humanError(message(e),workspace())});
  const askMode=()=>access()==="ask",editing=()=>{const m=current()?.policy?.requested.mode;return m==="code"||m==="parallel";};
  const delegates=()=>editing()&&profile().maxDepth>0,canCommit=()=>editing()&&workspaceKind(current())==="direct";
  const rootWs=()=>workspaceKind(current())==="direct"?"the selected folder":"the root workspace";
  async function refreshAccess(){try{const r=await api<{mode:"full"|"ask"}>("/v2/access");setAccess(r.mode==="ask"?"ask":"full");}catch{/* keep last known mode */}}
  const pending=createMemo(()=>current()?.approvals.filter(a=>a.status==="pending")||[]);
  const directNeeds=createMemo(()=>workspaceKind(current())==="direct"?current()?.approvals.filter(a=>a.needsReconciliation).length??0:0);
  const agents=createMemo(()=>current()?.agents||[]);
  const root=createMemo(()=>agents().find(a=>!a.parentId));
  const children=createMemo(()=>agents().filter(a=>a.parentId));
  const profile=()=>current()?.policy?.effective.profile??READ_ONLY_PROFILE;
  const childTrouble=createMemo(()=>children().filter(a=>a.status==="error"||a.status==="interrupted"));
  const roleOf=(agentId?:string)=>{const a=agents().find(x=>x.id===agentId);return a?(a.parentId?cap(a.role):"Root"):"Agent";};
  const attention=()=>pending().length+mergePending()+(current()?.recoveryInputs.length||0)+(current()?.recoveryActions.length||0)+childTrouble().filter(a=>a.status==="error").length;
  const listed=()=>sessions().find(s=>s.id===current()?.id);
  const sessionTitle=(s:Listed)=>s.title?firstLine(plainMentions(s.title),64):"Untitled session";
  const duplicate=(s:Listed)=>sessions().some(o=>o.id!==s.id&&sessionTitle(o)===sessionTitle(s));
  const currentTitle=()=>{const first=current()?.messages.find(m=>m.role==="user");return first?firstLine(plainMentions(first.text)||"Image",90):listed()?.title?firstLine(plainMentions(listed()!.title!),90):"Untitled session";};
  const running=()=>current()?.status==="running";
  const composing=()=>!showProjects()&&!showRoles()&&!showProviders()&&!current()&&!loadingId()&&!openFailed()&&!focusedTask();
  const activeRepositoryWork=()=>focusedTask()?.coordinatorId===current()?.id&&focusedTask()!.repositories.some(repo=>taskMembers()[repo.id]?.status==="running");
  const offline=()=>conn()==="reconnecting"||conn()==="unreachable";
  const composerModel=()=>models().find(model=>`${model.provider}/${model.id}`===(current()?.model??selectedModel())),imagesAllowed=()=>composerModel()?.images!==false,imageWarning=()=>`${composerModel()?.name||modelName(current()?.model??selectedModel())} can't read images. Switch to a model that accepts images or remove them.`;
  async function attach(files:File[]){
    if(!files.length)return;
    if(!imagesAllowed()){setNotice({kind:"warning",text:imageWarning()});return;}
    const {added,errors}=await readImages(files,MAX_IMAGES-attachments().length);
    if(added.length)setAttachments(x=>[...x,...added].slice(0,MAX_IMAGES));
    if(errors.length)setNotice({kind:"warning",text:errors.join(" ")});
  }
  function removeAttachment(id:string){setAttachments(x=>x.filter(a=>a.id!==id));composer?.focus();}
  // Image-only clipboards (screenshots) become attachments; anything carrying text keeps the browser's normal paste.
  function onPasteImages(e:ClipboardEvent){
    const data=e.clipboardData;if(!data||[...data.types].includes("text/plain"))return;
    const files=[...data.items].filter(item=>item.kind==="file"&&item.type.startsWith("image/")).map(item=>item.getAsFile()).filter((file):file is File=>!!file);
    if(files.length){e.preventDefault();void attach(files);}
  }
  const dropTarget={
    onDragOver:(e:DragEvent)=>{if(![...(e.dataTransfer?.types??[])].includes("Files"))return;e.preventDefault();setDragging(true);},
    onDragLeave:(e:DragEvent)=>{if(!(e.relatedTarget instanceof Node&&(e.currentTarget as HTMLElement).contains(e.relatedTarget)))setDragging(false);},
    onDrop:(e:DragEvent)=>{if(![...(e.dataTransfer?.types??[])].includes("Files"))return;e.preventDefault();setDragging(false);void attach([...e.dataTransfer!.files]);},
  };
  function AttachTool(p:{id:string;disabled?:boolean}){
    let input!:HTMLInputElement;
    return <>
      <input ref={input} id={p.id} type="file" class="sr-only" tabindex="-1" accept={IMAGE_TYPES.join(",")} multiple aria-label="Attach images" onChange={e=>{const files=[...e.currentTarget.files??[]];e.currentTarget.value="";void attach(files);}}/>
      <button type="button" class="icon-btn sm" onClick={()=>input.click()} disabled={p.disabled||!imagesAllowed()||attachments().length>=MAX_IMAGES} aria-label="Attach images" title={!imagesAllowed()?imageWarning():attachments().length>=MAX_IMAGES?`At most ${MAX_IMAGES} images per message`:"Attach images (or paste / drop them)"}><Icon name="attach"/></button>
    </>;
  }
  function AttachmentStrip(){
    return <>
      <Show when={attachments().length}><ul class="attach-strip" aria-label="Attached images"><For each={attachments()}>{a=><li class="attach-thumb"><img src={`data:${a.mimeType};base64,${a.data}`} alt={a.name}/><button type="button" class="attach-remove" aria-label={`Remove ${a.name}`} title="Remove" onClick={()=>removeAttachment(a.id)} onKeyDown={e=>{if(e.key==="Delete"||e.key==="Backspace"){e.preventDefault();removeAttachment(a.id);}}}><Icon name="close"/></button></li>}</For></ul></Show>
      <Show when={attachments().length&&!imagesAllowed()}><p class="attach-warn" role="alert">{imageWarning()}</p></Show>
    </>;
  }
  const opening=()=>{const id=loadingId();return !!id&&current()?.id!==id;};
  const detailsBreakpoint=matchMedia("(max-width: 1279px)"),navBreakpoint=matchMedia("(max-width: 899px)");
  const overlayDetails=()=>detailsBreakpoint.matches,overlayNav=()=>navBreakpoint.matches;
  // Resizable details panel: user width wins over defaults, persisted per viewer, clamped on every render.
  const DETAILS_MIN=300,SIDE_W=268,CHAT_RESERVE=420;
  const readDetailsW=()=>{try{const n=Number(localStorage.getItem("sigma-details-w"));return Number.isFinite(n)&&n>=DETAILS_MIN?n:null;}catch{return null;}};
  const [detailsW,setDetailsW]=createSignal<number|null>(readDetailsW()),[vw,setVw]=createSignal(window.innerWidth),[resizing,setResizing]=createSignal(false);
  const onWinResize=()=>setVw(window.innerWidth);window.addEventListener("resize",onWinResize);onCleanup(()=>window.removeEventListener("resize",onWinResize));
  const detailsMax=()=>{const v=vw();return Math.max(DETAILS_MIN,Math.min(900,v<1280?v:v-(v>=900&&!navCollapsed()?SIDE_W:0)-CHAT_RESERVE));};
  const clampDetailsW=(w:number)=>Math.round(Math.min(detailsMax(),Math.max(DETAILS_MIN,w)));
  const detailsNow=()=>{const w=detailsW();return w==null?Math.round(detailsPanel?.getBoundingClientRect().width??368):clampDetailsW(w);};
  const saveDetailsW=(w:number|null)=>{setDetailsW(w);try{if(w==null)localStorage.removeItem("sigma-details-w");else localStorage.setItem("sigma-details-w",String(w));}catch{/* per-viewer convenience only */}};
  let resizeDrag:{x:number;w:number}|undefined;
  function resizeDown(e:PointerEvent){if(e.button!==0)return;e.preventDefault();(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);resizeDrag={x:e.clientX,w:detailsNow()};setResizing(true);document.body.style.userSelect="none";}
  function resizeMove(e:PointerEvent){if(resizeDrag)setDetailsW(clampDetailsW(resizeDrag.w+resizeDrag.x-e.clientX));}
  function resizeUp(){if(!resizeDrag)return;resizeDrag=undefined;setResizing(false);document.body.style.userSelect="";const w=detailsW();if(w!=null)saveDetailsW(clampDetailsW(w));}
  function resizeKey(e:KeyboardEvent){
    const step=e.shiftKey?64:16,w=detailsNow();let n:number|null|undefined;
    if(e.key==="ArrowLeft")n=clampDetailsW(w+step);else if(e.key==="ArrowRight")n=clampDetailsW(w-step);else if(e.key==="Home")n=DETAILS_MIN;else if(e.key==="End")n=detailsMax();else if(e.key==="Enter")n=null;
    if(n===undefined)return;e.preventDefault();saveDetailsW(n);
  }
  onCleanup(()=>{document.body.style.userSelect="";});

  async function refresh(){const data=await api<{sessions:Listed[]}>("/sessions");setSessions(data.sessions);}
  async function refreshTasks(){const data=await api<{tasks:ProjectTaskView[]}>("/project-tasks");setProjectTasks(data.tasks);}
  async function refreshWorkspaceRecovery(){const data=await api<{items:WorkspaceRecoveryItem[]}>("/workspace-recovery");setWorkspaceRecovery(data.items);}
  async function continueWorkspaceSetup(item:WorkspaceRecoveryItem){setRecoveryBusy(item.id);try{const result=await api<{id:string;rootId:string}>(`/workspace-recovery/${encodeURIComponent(item.id)}/continue`,"POST",{observedRevision:item.observedRevision});await Promise.all([refresh(),refreshWorkspaceRecovery()]);await select(result.rootId);setNotice({kind:"info",text:"Workspace setup recovered. The original input was not rerun."});if(result.id!==result.rootId){setSelectedChildId(result.id);await refreshChild(result.rootId,result.id);setDetailsOpen(true);setDetailTab("overview");}}catch(e){fail(e);void refreshWorkspaceRecovery().catch(()=>{});}finally{setRecoveryBusy(null);}}
  async function continueTask(task:ProjectTaskView){setRecoveryBusy(task.id);try{await api(`/project-tasks/${task.id}/continue`,"POST",{observedRevisions:workspaceRecovery().filter(item=>item.id===task.id).map(item=>item.observedRevision)});await refreshTasks();await refreshTask(task.id);await refreshWorkspaceRecovery();}catch(e){fail(e);void refreshWorkspaceRecovery().catch(()=>{});}finally{setRecoveryBusy(null);}}
  async function archiveTask(task:ProjectTaskView,archived:boolean){try{await api(`/project-tasks/${task.id}/archive`,"POST",{archived});await refreshTasks();if(current()?.policy?.task?.id===task.id)await resync(current()!.id);await refreshWorkspaceRecovery();}catch(e){fail(e);}}
  async function stopSetup(item:WorkspaceRecoveryItem){if(!item.setup)return;try{await api(`/sessions/${item.setup.rootId??item.setup.sessionId}/abort`,"POST",{});await refreshWorkspaceRecovery();}catch(e){fail(e);}}
  async function stopTaskSetup(task:ProjectTaskView){try{await api(`/sessions/${task.coordinatorId}/abort`,"POST",{});await refreshTasks();await refreshWorkspaceRecovery();}catch(e){fail(e);}}
  const refreshingTasks=new Set<string>();
  async function refreshTask(id:string){
    if(refreshingTasks.has(id))return;refreshingTasks.add(id);
    try{
      const task=await api<ProjectTaskView>(`/project-tasks/${id}`);
      setProjectTasks(items=>[task,...items.filter(item=>item.id!==id)]);
      const coordinator=await api<SessionView>(`/sessions/${task.coordinatorId}`).catch(()=>null);
      if(taskFocusId()===id)setTaskCoordinatorAvailable(coordinator?.policy?.requested.mode==="multi"&&coordinator.policy.task?.id===task.id);
      const results=await Promise.allSettled(task.repositories.map(async repo=>{
        const prefix=`/sessions/${repo.sessionId}`;
        const snapshot=await api<SessionView>(prefix);
        if(snapshot.policy?.task?.id!==task.id||snapshot.policy.task.repositoryId!==repo.id||snapshot.policy.workspace?.sourceCwd!==repo.sourceCwd||snapshot.policy.workspace.baseCommit!==repo.baseCommit||workspaceKind(snapshot)!==taskWorkspaceKind(task))throw new Error("Repository session differs from the saved task snapshot");
        const summary:MemberSummary={available:true,status:snapshot.status,result:[...snapshot.messages].reverse().find(m=>m.role==="assistant")?.text||"No assistant result yet",pending:snapshot.approvals.filter(a=>a.status==="pending").length,files:null,omitted:0,check:"unknown",review:"unknown",sourceApply:"unknown"};
        const proof=await Promise.all([api<ChangesView>(`${prefix}/changes`),api<EvidenceView>(`${prefix}/evidence`),taskWorkspaceKind(task)==="direct"?Promise.resolve({applies:[]}):api<{applies:SourceApplyView[]}>(`${prefix}/source-applies`)]).catch(()=>null);
        if(!proof){summary.evidenceError=true;return {id:repo.id,summary};}
        const [changes,evidence,source]=proof;
        if(changes.sourceCwd!==repo.sourceCwd||changes.baseCommit!==repo.baseCommit||evidence.checks.some(item=>item.sessionId!==repo.sessionId)||evidence.reviews.some(item=>item.sessionId!==repo.sessionId)||source.applies.some(item=>item.sessionId!==repo.sessionId||item.sourceCwd!==repo.sourceCwd)){summary.evidenceError=true;return {id:repo.id,summary};}
        const current=evidence.revision===changes.revision;
        const latest=<T extends {createdAt:number}>(items:T[])=>[...items].sort((a,b)=>b.createdAt-a.createdAt)[0];
        const check=current?latest(evidence.checks.filter(item=>item.current&&item.revision===changes.revision)):undefined;
        const review=current?latest(evidence.reviews.filter(item=>item.current&&item.revision===changes.revision)):undefined;
        const apply=latest(source.applies);
        Object.assign(summary,{files:changes.files.length,omitted:changes.omitted,check:current?check?.status??"none":"unknown revision",review:current?review?.status??"none":"unknown revision",sourceApply:apply?`${apply.status}${apply.current&&apply.revision===changes.revision?"":" · earlier revision or changed source"}`:"none"});
        return {id:repo.id,summary};
      }));
      if(taskFocusId()===id)setTaskMembers(Object.fromEntries(results.map((result,index)=>result.status==="fulfilled"?[result.value.id,result.value.summary]:[task.repositories[index].id,{available:false,status:"unknown",result:"Session unavailable or does not match the saved task.",pending:0,files:null,omitted:0,check:"unknown",review:"unknown",sourceApply:"unknown"}])));
    }catch(e){if(taskFocusId()===id)fail(e);}finally{refreshingTasks.delete(id);}
  }
  function reconcileModels(items:Model[]){setModels(items);if(!items.some(model=>`${model.provider}/${model.id}`===selectedModel()&&!model.legacy)){const first=items.find(model=>!model.legacy)??items[0];setSelectedModel(first?`${first.provider}/${first.id}`:"");}}
  let modelReadGeneration=0;
  async function readModels(path="/models",method="GET",signal?:AbortSignal,isCurrent=()=>true){
    const generation=++modelReadGeneration;
    const data=await api<{models:Model[]}>(path,method,method==="POST"?{}:undefined,undefined,signal);
    if(generation===modelReadGeneration&&!signal?.aborted&&isCurrent())reconcileModels(data.models);
    return data;
  }
  async function refreshModels(){setRefreshing(true);try{await readModels("/models/refresh","POST");setNotice(null);}catch(e){fail(e);}finally{setRefreshing(false);}}
  function reconcilePrompt(snapshot:SessionView){
    const key=`pi-prompt-${snapshot.id}`,saved=JSON.parse(sessionStorage.getItem(key)||"null");
    if(!saved)return;
    if(!prompt())setPrompt(saved.text);
    setNotice({kind:"warning",text:snapshot.recoveryInputs.some(input=>input.id===saved.id)?"Previous prompt outcome is unknown. Inspect Pi history before sending it again.":"Previous request result was not confirmed. Inspect Pi history before retrying."});
  }
  async function open(id:string){
    const generation=++openGeneration;
    if(current()?.id!==id){++graphReadGeneration;setGraphNode(null);setGraphHistory(null);setGraphHistoryError("");setSelectedChildId(null);setChildView(null);setChildText("");setMergePending(0);}
    stream?.close();if(reconnectTimer)clearTimeout(reconnectTimer);if(historyTimer)clearTimeout(historyTimer);cursor=0;setDraft("");setThinking([]);setTools([]);setAgyActivity([]);setShown(200);setLoadingId(id);setOpenFailed(null);
    if(queued()?.id!==id)setQueued(null);
    const snapshot=await api<SessionView>(`/sessions/${id}`);if(generation!==openGeneration)return;
    if(current()?.id!==id){if(current()){prompts.set(current()!.id,prompt());attachmentDrafts.set(current()!.id,attachments());}setPrompt(prompts.get(id)||"");setAttachments(attachmentDrafts.get(id)||[]);}
    cursor=snapshot.cursor;stick=true;setCurrent(snapshot);setLoadingId(null);setSessions(x=>x.map(s=>s.id===id?{...s,status:snapshot.status}:s));setNotice(null);reconcilePrompt(snapshot);
    if(selectedChildId())void refreshChild(id,selectedChildId()!);
    if(snapshot.status!=="running")setQueued(null);
    if(conn()!=="reconnecting")setConn("connecting");
    stream=new EventSource(`/api/sessions/${id}/events?after=${cursor}`);
    let historyVersion=0;
    const sync=()=>{const version=++historyVersion;if(historyTimer)clearTimeout(historyTimer);historyTimer=setTimeout(async()=>{
      historyTimer=undefined;
      try{const latest=await api<SessionView>(`/sessions/${id}`);if(generation===openGeneration&&version===historyVersion){setCurrent(x=>x?.id===id?{...x,messages:latest.messages,recoveryInputs:latest.recoveryInputs,recoveryActions:latest.recoveryActions}:x);reconcilePrompt(latest);}}catch{/* reconnect retries */}
    },20);};
    stream.onopen=()=>{if(generation===openGeneration){setConn("live");setAttempt(0);}};
    stream.onmessage=(event_)=>{
      if(generation!==openGeneration)return;
      const event=JSON.parse(event_.data);if(event.seq&&event.seq<=cursor)return;if(event.seq)cursor=event.seq;
      if(event.type==="delta")setDraft(x=>x+event.payload.text);
      if(event.type==="history_changed"){sync();setDraft("");}
      if(event.type==="thinking"){const t=event.payload as {agentId:string;status:"active"|"done"};setThinking(x=>t.status==="active"?[...x.filter(a=>a!==t.agentId),t.agentId]:x.filter(a=>a!==t.agentId));}
      if(event.type==="status"){
        setCurrent(x=>x?{...x,status:event.payload.status,agents:x.agents.map(a=>a.id===id?{...a,status:event.payload.status}:a)}:x);setSessions(x=>x.map(s=>s.id===id?{...s,status:event.payload.status}:s));
        if(event.payload.status!=="running"){setQueued(null);setThinking([]);}
      }
      if(event.type==="model_changed")void api<SessionView>(`/sessions/${id}`).then(latest=>{if(generation===openGeneration)setCurrent(x=>x?.id===id?{...x,model:latest.model,policy:latest.policy}:x);}).catch(()=>{});
      if(event.type==="agent_created")setCurrent(x=>x?{...x,agents:x.agents.some(a=>a.id===event.payload.id)?x.agents:[...x.agents,event.payload]}:x);
      if(event.type==="agent_status"){setCurrent(x=>x?{...x,agents:x.agents.map(a=>a.id===event.payload.id?{...a,status:event.payload.status}:a)}:x);setEvidenceVersion(x=>x+1);}
      if((event.type==="agent_history_changed"||event.type==="agent_status")&&event.payload.id===selectedChildId()){
        void refreshChild(id,event.payload.id);
        if(event.type==="agent_history_changed"||event.payload.status!=="running")setNotice(x=>x?.kind==="info"&&x.text.startsWith("Message queued for")?null:x);
      }
      if(event.type==="approval")setCurrent(x=>x?{...x,approvals:x.approvals.some(a=>a.id===event.payload.id)?x.approvals:[event.payload,...x.approvals]}:x);
      if(event.type==="approval_decision"){setCurrent(x=>x?{...x,approvals:x.approvals.map(a=>a.id===event.payload.id?{...a,status:event.payload.status}:a)}:x);setDeciding(x=>x.filter(d=>d!==event.payload.id));handoffFocus();}
      if(event.type==="write_outcome"){setCurrent(x=>x?{...x,approvals:x.approvals.map(a=>a.id===event.payload.id?{...a,outcome:event.payload.outcome}:a)}:x);setEvidenceVersion(x=>x+1);}
      if(event.type==="check_changed"||event.type==="review_changed"||event.type==="source_apply_changed"||event.type==="worker_merge_changed"||event.type==="repository_changed"||event.type==="qa_changed"||event.type==="browser_use_changed"||event.type==="browser_mode_command")setEvidenceVersion(x=>x+1);
      if(event.type==="agy_activity"){const record=event.payload as AgyRecord;setAgyActivity(x=>{const at=x.findIndex(item=>item.agentId===record.agentId&&item.step===record.step);return at>=0?x.map((item,index)=>index===at?record:item):[...x.slice(-299),record];});}
      if(event.type==="tool"){setTools(x=>[...x.slice(-11),event.payload]);if(event.payload.status==="error")sync();}
      if(event.type==="error"){fail(event.payload.message);sync();}
      if(taskFocusId()&&["status","history_changed","write_outcome","check_changed","review_changed","source_apply_changed","worker_merge_changed"].includes(event.type))void refreshTask(taskFocusId()!);
    };
    stream.onerror=()=>{
      if(generation!==openGeneration)return;
      setConn("reconnecting");
      if(recovering||reconnectTimer)return;
      const recover=async()=>{
        reconnectTimer=undefined;if(current()?.id!==id)return;recovering=true;setAttempt(x=>x+1);
        try{await api("/bootstrap","POST",{});if(current()?.id===id)await open(id);}
        catch{if(current()?.id===id)reconnectTimer=setTimeout(()=>{void recover();},1000);}
        finally{recovering=false;}
      };
      reconnectTimer=setTimeout(()=>{void recover();},1000);
    };
  }
  // After a prompt, keep the live stream (deltas are not durable) and only merge fresh history.
  async function resync(id:string){
    if(current()?.id!==id)return;
    if(!stream||stream.readyState===EventSource.CLOSED){await open(id);return;}
    const latest=await api<SessionView>(`/sessions/${id}`);stick=true;
    setCurrent(x=>x?.id===id?{...x,messages:latest.messages,recoveryInputs:latest.recoveryInputs,recoveryActions:latest.recoveryActions}:x);
  }
  async function refreshWriteRecovery(id:string){
    const latest=await api<SessionView>(`/sessions/${id}`);
    setCurrent(x=>x?.id===id?{...x,approvals:latest.approvals,recoveryActions:latest.recoveryActions}:x);
    setEvidenceVersion(x=>x+1);
  }
  async function select(id:string){
    setShowRoles(false);setShowProviders(false);
    setShowProjects(false);
    if(overlayNav())setNavOpen(false);
    const task=taskForSession(id);setTaskFocusId(task?.id??null);if(task)void refreshTask(task.id);
    try{await open(id);}catch(e){if(loadingId()===id){setLoadingId(null);setOpenFailed({id,text:message(e)});}}
  }
  async function selectTask(task:ProjectTaskView){
    setShowRoles(false);setShowProviders(false);
    setShowProjects(false);if(overlayNav())setNavOpen(false);
    setTaskFocusId(task.id);setTaskMembers({});setTaskCoordinatorAvailable(false);void refreshTask(task.id);
    if(task.status==="creating"||task.status==="unknown"){clearCurrent();return;}
    await select(task.coordinatorId);
  }
  const reasoningLevels=()=>models().find(model=>`${model.provider}/${model.id}`===selectedModel())?.reasoningLevels??[],canReason=()=>reasoningLevels().some(level=>level!=="off"),chosenReasoning=()=>canReason()&&reasoningLevels().includes(reasoning())?reasoning():"";
  async function create(){const goal=prompt().trim(),images=attachments();if(!selectedModel()||!goal&&!images.length||images.length&&!imagesAllowed())return;const selected=projectId();setBusy(true);setNotice(null);const key="pi-create",fingerprint=`${workspace()||"scratch"}|${selectedModel()}|parallel${workspaceMode()==="worktree"?"|worktree":""}${chosenReasoning()?`|reasoning:${chosenReasoning()}`:""}`,saved=JSON.parse(sessionStorage.getItem(key)||"null"),id=saved?.fingerprint===fingerprint?saved.id:crypto.randomUUID();sessionStorage.setItem(key,JSON.stringify({id,fingerprint}));try{const result=await api<{id:string;status:string}>("/sessions","POST",{...(workspace()?{cwd:workspace()}:{scratch:true}),model:selectedModel(),mode:"parallel",workspaceMode:workspaceMode(),...(chosenReasoning()?{reasoning:chosenReasoning()}:{})},id);if(result.status==="unknown")throw new Error("Previous create outcome is unknown. Inspect sessions before starting a new one.");sessionStorage.removeItem(key);setWorkspaceMode("direct");await refresh();if(projectId()!==selected)return;setTaskFocusId(null);setShowProjects(false);if(overlayNav())setNavOpen(false);await open(result.id);setPrompt(goal);setAttachments(images);queueMicrotask(resize);composer?.focus();await send();}catch(e){fail(e);void refreshWorkspaceRecovery().catch(()=>{});}finally{setBusy(false);}}
  async function switchModel(model:string,level:string){const s=current();if(!s||switching())return;setSwitching(true);setNotice(null);try{await api(`/sessions/${s.id}/model`,"POST",{model,reasoning:level||null},crypto.randomUUID());const latest=await api<SessionView>(`/sessions/${s.id}`);setCurrent(x=>x?.id===s.id?{...x,model:latest.model,policy:latest.policy}:x);void refresh().catch(()=>{});}catch(e){fail(e);}finally{setSwitching(false);}}
  function ModelPicker(p:{welcome?:boolean}){
    const s=()=>p.welcome?null:current(),value=()=>s()?.model??selectedModel(),levels=()=>models().find(model=>`${model.provider}/${model.id}`===value())?.reasoningLevels??[],can=()=>levels().some(level=>level!=="off");
    const level=()=>{const v=s()?s()!.policy?.role?.requestedReasoning??"":reasoning();return levels().includes(v)?v:"";};
    const locked=()=>!!s()&&(running()||offline()||taskUnresolved()||switching()||!!s()!.policy?.task||!!s()!.policy?.unsupervised||!!graphNode()&&graphNode()!.id!==s()!.id);
    const options=()=>models().filter(m=>!(m.provider==="sigma-agy-unsupervised"&&!!s())&&(!m.legacy||`${m.provider}/${m.id}`===value()));
    const change=(el:HTMLSelectElement,next:string)=>{if(!s()){setSelectedModel(next);if(!(models().find(m=>`${m.provider}/${m.id}`===next)?.reasoningLevels??[]).includes(reasoning()))setReasoning("");return;}const keep=(models().find(m=>`${m.provider}/${m.id}`===next)?.reasoningLevels??[]).includes(level())?level():"";void switchModel(next,keep).finally(()=>{el.value=value();});};
    return <>
      <label class="sr-only" for={p.welcome?"model-welcome":"model-picker"}>Model</label>
      <span class="pill pick" title={value()}><Icon name="cpu"/>
        <select id={p.welcome?"model-welcome":"model-picker"} aria-label="Model" class="pick-select" value={value()} disabled={locked()||!models().length} onChange={e=>change(e.currentTarget,e.currentTarget.value)}>
          <Show when={!models().length}><option value="">No authenticated models</option></Show>
          <Show when={models().length&&!models().some(m=>`${m.provider}/${m.id}`===value())}><option value={value()} disabled>{modelName(value())||"Select a model"}</option></Show>
          <For each={options()}>{m=><option value={`${m.provider}/${m.id}`}>{m.provider} · {m.name||m.id}</option>}</For>
        </select></span>
      <Show when={can()}><label class="sr-only" for={p.welcome?"reasoning-welcome":"reasoning-picker"}>Reasoning</label>
        <span class="pill pick"><select id={p.welcome?"reasoning-welcome":"reasoning-picker"} aria-label="Reasoning" class="pick-select" value={level()} disabled={locked()} onChange={e=>{const el=e.currentTarget;if(!s())setReasoning(el.value);else void switchModel(s()!.model,el.value).finally(()=>{el.value=level();});}}>
          <option value="">Default reasoning</option>
          <For each={levels()}>{item=><option value={item}>{item}</option>}</For>
        </select></span></Show>
      <button type="button" class="icon-btn sm" onClick={refreshModels} disabled={refreshing()} aria-label="Refresh model list" title="Refresh model list"><Icon name="refresh"/></button>
      <Show when={isDemo(value())}><DemoTag/></Show>
      <Show when={p.welcome&&booted()&&!models().length&&conn()!=="unreachable"}><span class="hint warn">No authenticated Pi models. Open Providers to sign in, then refresh.</span></Show>
    </>;
  }
  async function createProjectTask(project:ProjectView,taskWorkspaceMode:"direct"|"worktree"){
    if(!selectedModel()||taskBusy())return;
    const key="pi-project-task-create",fingerprint=`${project.id}|${selectedModel()}${taskWorkspaceMode==="worktree"?"|worktree":""}${chosenReasoning()?`|reasoning:${chosenReasoning()}`:""}`,saved=JSON.parse(sessionStorage.getItem(key)||"null"),commandId=saved?.fingerprint===fingerprint?saved.id:crypto.randomUUID();
    sessionStorage.setItem(key,JSON.stringify({id:commandId,fingerprint}));setTaskBusy(true);setNotice(null);
    try{
      const result=await api<{id:string;status:string}>("/project-tasks","POST",{projectId:project.id,model:selectedModel(),workspaceMode:taskWorkspaceMode,...(chosenReasoning()?{reasoning:chosenReasoning()}:{})},commandId);
      await refreshTasks();
      if(result.status==="unknown")throw new Error("Task creation outcome is unknown. Inspect saved tasks and repository sessions before starting another task.");
      sessionStorage.removeItem(key);
      const task=projectTasks().find(item=>item.id===result.id);
      if(task)await selectTask(task);else throw new Error("Task was created but its snapshot is unavailable. Refresh the task list before continuing.");
    }catch(e){fail(e);void refreshTasks().catch(()=>{});void refreshWorkspaceRecovery().catch(()=>{});}finally{setTaskBusy(false);}
  }
  async function send(){const text=prompt().trim(),images=attachments(),s=current();if(!s||!text&&!images.length||images.length&&!imagesAllowed()||taskUnresolved())return;setBusy(true);setNotice(null);const key=`pi-prompt-${s.id}`,saved=JSON.parse(sessionStorage.getItem(key)||"null"),print=fingerprint(images),reuse=saved?.text===text&&(saved.images??"")===print,id=reuse?saved.id:crypto.randomUUID(),behavior=reuse?saved.behavior:s.status==="running"?"followUp":undefined;sessionStorage.setItem(key,JSON.stringify({id,text,behavior,...(print?{images:print}:{})}));try{const result=await api<{accepted:boolean;status:string;receipt?:string;mode?:"chrome"|"internal"}>(`/sessions/${s.id}/prompt`,"POST",{text,behavior,...(images.length?{images:images.map(({mimeType,data})=>({mimeType,data}))}:{})},id);if(text==="/browser internal"||text==="/browser chrome"){
      sessionStorage.removeItem(key);if(current()?.id!==s.id){void refresh().catch(()=>{});return;}setPrompt("");resize();setNotice({kind:result.status==="completed"?"info":"warning",text:result.receipt??(result.status==="completed"?`Browser mode changed to ${result.mode}.`:`Browser mode command is ${result.status}; inspect Browser control before trying again.`)});void refresh().catch(()=>{});return;
    }if(result.status==="unknown"||result.status==="accepted")throw new Error("Previous prompt outcome is uncertain. Inspect Pi session history before retrying.");if(result.status==="rejected"){sessionStorage.removeItem(key);throw new Error("Pi rejected the prompt. Check model authentication and retry.");}if(!["dispatched","queued","completed"].includes(result.status))throw new Error("Unexpected prompt state; inspect Pi session history before retrying.");sessionStorage.removeItem(key);prompts.delete(s.id);attachmentDrafts.delete(s.id);if(current()?.id!==s.id){void refresh().catch(()=>{});return;}setPrompt("");setAttachments(x=>x.filter(a=>!images.includes(a)));resize();await resync(s.id);if(result.status==="queued"&&current()?.id===s.id)setQueued(q=>({id:s.id,count:(q?.id===s.id?q.count:0)+1}));void refresh().catch(()=>{});}catch(e){if((e as {status?:number}).status===409)sessionStorage.removeItem(key);fail(e);}finally{setBusy(false);}}
  async function stop(){const s=current();if(!s)return;try{await api(`/sessions/${s.id}/abort`,"POST",{});}catch(e){fail(e);}}
  async function stopChild(agent:AgentView){
    const s=current();if(!s||offline()||stoppingChildren().includes(agent.id))return;
    const key=`pi-stop-child-${s.id}-${agent.id}`,id=sessionStorage.getItem(key)||crypto.randomUUID();sessionStorage.setItem(key,id);
    setStoppingChildren(x=>[...x,agent.id]);
    try{const result=await api<{status:string}>(`/sessions/${s.id}/agents/${agent.id}/abort`,"POST",{},id);if(result.status!=="completed")throw new Error("Child stop outcome is uncertain. Inspect the agent state; nothing is retried automatically.");sessionStorage.removeItem(key);}
    catch(e){fail(e);}finally{setStoppingChildren(x=>x.filter(value=>value!==agent.id));handoffFocus();}
  }
  async function refreshChild(rootId:string,agentId:string){
    try{const detail=await api<SessionView>(`/sessions/${rootId}/agents/${agentId}`);if(current()?.id===rootId&&selectedChildId()===agentId)setChildView(detail);}catch(e){if(current()?.id===rootId&&selectedChildId()===agentId)fail(e);}
  }
  function selectChild(agent:AgentView){
    if(selectedChildId()===agent.id){setSelectedChildId(null);setChildView(null);return;}
    setSelectedChildId(agent.id);setChildView(null);setChildText("");void refreshChild(current()!.id,agent.id);
  }
  async function sendChild(agent:AgentView){
    const rootId=current()?.id,text=childText().trim();if(!rootId||!text||childBusy()||taskUnresolved())return;
    const behavior=agent.status==="running"?childBehavior():undefined,key=`pi-child-prompt-${agent.id}`,saved=JSON.parse(sessionStorage.getItem(key)||"null"),id=saved?.text===text&&saved?.behavior===behavior?saved.id:crypto.randomUUID();
    sessionStorage.setItem(key,JSON.stringify({id,text,behavior}));setChildBusy(true);setNotice(null);
    try{
      const result=await api<{status:string}>(`/sessions/${rootId}/agents/${agent.id}/prompt`,"POST",{text,behavior},id);
      if(!["dispatched","queued","completed"].includes(result.status))throw new Error("Child message outcome is uncertain. Inspect its history before sending a new command.");
      sessionStorage.removeItem(key);setChildText("");await refreshChild(rootId,agent.id);
      if(result.status==="queued")setNotice({kind:"info",text:`Message queued for ${cap(agent.role)} ${short(agent.id)}; delivery is not yet confirmed.`});
    }catch(e){if((e as {status?:number}).status===409)sessionStorage.removeItem(key);fail(e);}finally{setChildBusy(false);}
  }
  async function decide(approval:ApprovalView,allow:boolean){const s=current();if(!s||taskUnresolved())return;setDeciding(x=>[...x,approval.id]);try{await api(`/sessions/${s.id}/approvals/${approval.id}`,"POST",{allow});handoffFocus();}catch(e){setDeciding(x=>x.filter(d=>d!==approval.id));fail(e);}}
  function copyRecovery(input:RecoveryInput){const s=current();if(!s)return;sessionStorage.removeItem(`pi-prompt-${s.id}`);setPrompt(input.text);setNotice({kind:"warning",text:"Copied to the composer, not sent. Check Pi history first; the earlier outcome is uncertain. Send it yourself as a new command if it is still needed."});if(overlayDetails())closeDetails(false);queueMicrotask(()=>{resize();composer?.focus();});}
  // A decided approval card unmounts; keep keyboard users on the next request or the composer.
  function handoffFocus(){setTimeout(()=>{const a=document.activeElement;if(a&&a!==document.body&&a.isConnected)return;(overlayDetails()&&detailsOpen()?treeSection||detailsTitle:document.querySelector<HTMLElement>(".approval .btn.primary")||composer)?.focus();},60);}
  const COMMIT_PROMPT="Commit the current changes now: inspect the working-tree diff, write a concise commit message (imperative subject up to 72 characters, optional short body) and call git_commit directly with that message. Do not ask me to confirm the message in chat; the git_commit tool shows its own approval.";
  async function requestCommit(){if(running()||busy())return;const draft=prompt();setPrompt(COMMIT_PROMPT);await send();if(draft.trim()&&!prompt())setPrompt(draft);}
  function insertExample(text:string){setPrompt(text);queueMicrotask(()=>{resize();composer?.focus();});}
  function resize(){if(!composer)return;composer.style.height="auto";composer.style.height=`${Math.min(composer.scrollHeight,window.innerHeight*0.4)}px`;}
  const welcomeMention=createMention({id:"mention-welcome",scope:()=>workspace()?{cwd:workspace()}:null,el:()=>composer,set:setPrompt,resize}),sessionMention=createMention({id:"mention-session",scope:()=>current()?{session:current()!.id}:null,el:()=>composer,set:setPrompt,resize});
  function clearCurrent(){
    if(current()){prompts.set(current()!.id,prompt());attachmentDrafts.set(current()!.id,attachments());}
    ++openGeneration;stream?.close();stream=undefined;
    if(reconnectTimer)clearTimeout(reconnectTimer);if(historyTimer)clearTimeout(historyTimer);reconnectTimer=historyTimer=undefined;
    returnGraphRoot();setCurrent(null);setLoadingId(null);setOpenFailed(null);setPrompt("");setAttachments([]);setDraft("");setTools([]);setQueued(null);setNotice(null);setConn("ready");
    setSelectedChildId(null);setChildView(null);setChildText("");setMergePending(0);
  }
  function chooseProject(id:string){
    setProjectId(id);localStorage.setItem("pi-project",id);
    const project=projects().find(p=>p.id===id);if(project&&!project.folders.includes(workspace()))setWorkspace(project.folders[0]);
  }
  function manageProjects(){setShowRoles(false);setShowProviders(false);setDetailsOpen(false);setNavOpen(false);setShowProjects(true);queueMicrotask(()=>document.getElementById("projects-title")?.focus());}
  function projectSaved(project:ProjectView){toggleProject(project.id,true);setProjects(items=>[...items.filter(p=>p.id!==project.id),{...project,archivedAt:items.find(p=>p.id===project.id)?.archivedAt??null}].sort((a,b)=>a.name.localeCompare(b.name)));chooseProject(project.id);}
  function startNew(){setWorkspaceMode("direct");setShowRoles(false);setShowProviders(false);setShowProjects(false);setTaskFocusId(null);clearCurrent();if(overlayNav())setNavOpen(false);queueMicrotask(()=>composer?.focus());}
  function newChat(){setProjectId("");setWorkspace("");startNew();}
  function useProjectFolder(path:string){setWorkspace(path);startNew();}
  function newInProject(project:ProjectView){chooseProject(project.id);toggleProject(project.id,true);startNew();}
  function editProject(project?:ProjectView){if(project)chooseProject(project.id);else setProjectId("");setEditRequest(Date.now());manageProjects();}
  async function refreshProjects(){const data=await api<{projects:ProjectView[]}>("/projects");setProjects(data.projects);}
  async function archiveProject(project:ProjectView,archived:boolean){try{await api(`/projects/${project.id}/archive`,"POST",{archived});await refreshProjects();}catch(e){fail(e);}}
  async function deleteProject(project:ProjectView){
    if(!window.confirm(`Delete project “${project.name}”? Its sessions and folders are kept.`))return;
    try{
      await api(`/projects/${project.id}`,"DELETE");
      if(projectId()===project.id){setProjectId("");try{localStorage.removeItem("pi-project");}catch{/* per-viewer convenience only */}if(showProjects())setShowProjects(false);}
      await refreshProjects();
    }catch(e){fail(e);}
  }
  function openProjectMenu(project:ProjectView,button:HTMLElement){
    if(menu()?.project.id===project.id){setMenu(null);return;}
    const r=button.getBoundingClientRect();setMenu({project,top:r.bottom+4,left:Math.max(8,Math.min(r.right-148,window.innerWidth-156))});
  }
  createEffect(()=>{
    if(!menu())return;
    const close=(e:Event)=>{if(!(e.target as Element|null)?.closest?.(".project-menu,.project-more"))setMenu(null);};
    const key=(e:KeyboardEvent)=>{if(e.key==="Escape"){setMenu(null);document.querySelector<HTMLElement>(".project-more[aria-expanded=true]")?.focus();}};
    document.addEventListener("mousedown",close);document.addEventListener("keydown",key);window.addEventListener("resize",()=>setMenu(null),{once:true});
    document.querySelector<HTMLElement>(".project-menu [role=menuitem]")?.focus();
    onCleanup(()=>{document.removeEventListener("mousedown",close);document.removeEventListener("keydown",key);});
  });
  async function archive(s:Listed,archived:boolean){
    try{await api(`/sessions/${s.id}/archive`,"POST",{archived});await refresh();if(archived&&current()?.id===s.id)startNew();}
    catch(e){fail(e);}
  }

  // drawers (overlay only on narrower windows)
  let detailsReturn:HTMLElement|null=null,navReturn:HTMLElement|null=null;
  function isVisible(element:HTMLElement|null){return !!element?.isConnected&&element.getClientRects().length>0&&getComputedStyle(element).visibility!=="hidden";}
  function detailsBreakpointChanged(event:MediaQueryListEvent){
    const active=document.activeElement as HTMLElement;
    if(event.matches){
      if(detailsPanel?.contains(active)){detailsReturn=document.querySelector<HTMLElement>(".details-toggle");setDetailsOpen(true);queueMicrotask(()=>{(isVisible(active)?active:detailsTitle)?.focus();});}
      else{setDetailsOpen(false);if(active===document.body)document.querySelector<HTMLElement>(".details-toggle")?.focus();}
      return;
    }
    const wasOpen=detailsOpen();setDetailsOpen(false);
    if(wasOpen&&((detailsPanel?.contains(active)&&!isVisible(active))||active===document.body))detailsTitle?.focus();
  }
  function navBreakpointChanged(event:MediaQueryListEvent){
    const active=document.activeElement as HTMLElement;
    if(event.matches){
      if(navPanel?.contains(active)){navReturn=document.querySelector<HTMLElement>(".main-head .only-nav");setNavOpen(true);queueMicrotask(()=>{(isVisible(active)?active:navTitle)?.focus();});}
      else{setNavOpen(false);if(active===document.body)document.querySelector<HTMLElement>(".main-head .only-nav")?.focus();}
      return;
    }
    const wasOpen=navOpen();setNavOpen(false);
    if(wasOpen&&((navPanel?.contains(active)&&!isVisible(active))||active===document.body))navTitle?.focus();
  }
  function openDetails(section?:"recovery"|"tree"|"merges"|"writes"){
    if(section)setDetailTab(section==="merges"||section==="writes"?"changes":"overview");
    const target=()=>section==="recovery"?recoverySection:section==="tree"?treeSection:section==="merges"?document.getElementById("h-worker-merges")?.closest<HTMLElement>("section"):section==="writes"?document.getElementById("h-approvals")?.closest<HTMLElement>("section"):undefined;
    if(!overlayDetails()){if(detailsCollapsed()){setDetailsCollapsed(false);try{localStorage.setItem("sigma-details-collapsed","0");}catch{/* per-viewer convenience only */}}const t=target();t?.scrollIntoView({block:"start"});t?.focus({preventScroll:true});return;}
    detailsReturn=document.activeElement as HTMLElement|null;setDetailsOpen(true);
    queueMicrotask(()=>{const t=target();if(t){t.scrollIntoView({block:"start"});t.focus();}else detailsPanel?.querySelector<HTMLElement>(".drawer-close")?.focus();});
  }
  function goToDecision(){if(detailsOpen())closeDetails(false);queueMicrotask(()=>document.querySelector<HTMLElement>(".approval .btn.primary")?.focus());}
  function closeDetails(restore=true){setDetailsOpen(false);if(restore)detailsReturn?.focus();}
  function openNav(){navReturn=document.activeElement as HTMLElement|null;setNavOpen(true);queueMicrotask(()=>navPanel?.querySelector<HTMLElement>(".drawer-close")?.focus());}
  function closeNav(){setNavOpen(false);navReturn?.focus();}
  function onKey(e:KeyboardEvent){
    const detailsTrap=overlayDetails()&&detailsOpen(),navTrap=overlayNav()&&navOpen();
    if(e.key==="Escape"){if(detailsTrap){e.preventDefault();closeDetails();}else if(navTrap){e.preventDefault();closeNav();}return;}
    const trap=detailsTrap?detailsPanel:navTrap?navPanel:undefined;
    if(e.key==="Tab"&&trap){
      const items=[...trap.querySelectorAll<HTMLElement>("button:not(:disabled),input,select,textarea,[tabindex='0']")].filter(isVisible);if(!items.length)return;
      const first=items[0],last=items[items.length-1],index=items.indexOf(document.activeElement as HTMLElement);
      if(index<0){e.preventDefault();(e.shiftKey?last:first).focus();}
      else if(e.shiftKey&&index===0){e.preventDefault();last.focus();}
      else if(!e.shiftKey&&index===items.length-1){e.preventDefault();first.focus();}
      return;
    }
    const t=e.target as HTMLElement;
    if(e.key==="/"&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&!["INPUT","TEXTAREA","SELECT"].includes(t.tagName)&&composer){e.preventDefault();composer.focus();}
  }
  function listKeys(e:KeyboardEvent){
    if(e.key!=="ArrowDown"&&e.key!=="ArrowUp"&&e.key!=="Home"&&e.key!=="End")return;
    const items=[...(e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("button.session")];const i=items.indexOf(document.activeElement as HTMLButtonElement);if(!items.length)return;
    e.preventDefault();const next=e.key==="Home"?0:e.key==="End"?items.length-1:e.key==="ArrowDown"?Math.min(items.length-1,i+1):Math.max(0,i-1);items[next].focus();
  }

  createEffect(()=>{const scope=current()?.id,node=graphNode()?.id;if(detailTab()==="graph"&&scope)sessionStorage.setItem("sigma-graph-view",JSON.stringify({scope,node:node??scope}));});
  createEffect(()=>{detailTab();detailsOpen();queueMicrotask(()=>document.getElementById(`tab-${detailTab()}`)?.scrollIntoView({block:"nearest",inline:"nearest"}));});
  createEffect(()=>{current()?.messages.length;draft();current()?.status;pending().length;queueMicrotask(()=>{if(stick&&scroller)scroller.scrollTop=scroller.scrollHeight;});});
  let taskPoll:ReturnType<typeof setInterval>|undefined,sessionPoll:ReturnType<typeof setInterval>|undefined,focusHandler:(()=>void)|undefined;
  onMount(async()=>{
    document.addEventListener("keydown",onKey);
    detailsBreakpoint.addEventListener("change",detailsBreakpointChanged);
    navBreakpoint.addEventListener("change",navBreakpointChanged);
    const pollSessions=()=>{if(conn()==="unreachable")return;if(sessions().some(s=>s.status==="running")||current()?.status==="running")void refresh().catch(()=>{});};
    sessionPoll=setInterval(pollSessions,4_000);const onFocus=()=>{void refresh().catch(()=>{});void refreshAccess();};window.addEventListener("focus",onFocus);document.addEventListener("visibilitychange",()=>{if(!document.hidden)onFocus();});focusHandler=onFocus;
    taskPoll=setInterval(()=>{const node=graphNode();if(node&&node.id!==current()?.id)void readGraphNode(node,false);const id=taskFocusId();if(id&&conn()!=="unreachable")void refreshTask(id);},10_000);
    try{
      const boot=await api<{defaultWorkspace:string}>("/bootstrap","POST",{});setConn("ready");setWorkspace(boot.defaultWorkspace);
      await readModels().catch(()=>{});void refreshAccess();
      await refresh();try{await refreshTasks();await refreshWorkspaceRecovery();}catch{setNotice({kind:"warning",text:"Project task or setup recovery details could not be loaded. Reload when the local service is available."});}setBooted(true);
      const latest=sessions()[0];
      if(latest){
        setWorkspace(latest.sourceCwd??latest.cwd);
        if(models().some(model=>`${model.provider}/${model.id}`===latest.model))setSelectedModel(latest.model);
        const saved=JSON.parse(sessionStorage.getItem("sigma-graph-view")||"null");
        const selected=saved?.scope&&sessions().some(session=>session.id===saved.scope)?saved.scope:latest.id;
        await select(selected);
        if(saved?.scope===selected){
          setDetailTab("graph");
          const snapshot=await api<{nodes:GraphNode[]}>(`/sessions/${selected}/graph`),node=snapshot.nodes.find(node=>node.id===saved.node);
          if(node)await readGraphNode(node,false);
        }
      }
      try{const data=await api<{projects:ProjectView[]}>("/projects");setProjects(data.projects);const saved=localStorage.getItem("pi-project");if(saved&&data.projects.some(p=>p.id===saved))chooseProject(saved);}
      catch{setNotice({kind:"warning",text:"Projects could not be loaded. Reload when the local service is available."});}
    }
    catch(e){setBooted(true);if(conn()==="connecting")setConn("unreachable");fail(e);}
  });
  onCleanup(()=>{document.removeEventListener("keydown",onKey);detailsBreakpoint.removeEventListener("change",detailsBreakpointChanged);navBreakpoint.removeEventListener("change",navBreakpointChanged);stream?.close();if(reconnectTimer)clearTimeout(reconnectTimer);if(historyTimer)clearTimeout(historyTimer);if(taskPoll)clearInterval(taskPoll);if(sessionPoll)clearInterval(sessionPoll);if(focusHandler)window.removeEventListener("focus",focusHandler);});

  const CONN:Record<Conn,{label:string;detail:string}>={
    connecting:{label:"Connecting…",detail:"Contacting the local service"},
    ready:{label:"Service reachable",detail:"No session stream open"},
    live:{label:"Event stream live",detail:"Local service · 127.0.0.1"},
    reconnecting:{label:"Reconnecting…",detail:"Saved events replay after reconnect"},
    unreachable:{label:"Service unreachable",detail:"Start the local service, then reload"},
  };

  const DemoTag=()=><span class="tag demo" title="Deterministic local provider for UI and protocol checks. Not a real model.">Offline demo</span>;
  const TaskOverview=()=><Show when={focusedTask()}>{task=><section class="task-overview" aria-label="Multi-repository task">
    <div class="task-head"><div><h2>{task().projectName} · {task().repositories.length} repositories</h2><p class="muted small">{taskWorkspaceKind(task())==="direct"?"Selected folders":taskWorkspaceKind(task())==="worktree"?"Separate Git worktrees":"Legacy Git copies"} · saved base commits · task {short(task().id)} · availability is not completion</p></div>
      <div class="project-actions"><span class={`badge ${task().status==="unknown"?"st-unknown":"st-running"}`}>{task().archivedAt?"Archived":taskState(task().status)}</span><button class="btn ghost sm" onClick={()=>void refreshTask(task().id)}><Icon name="refresh"/>Refresh task</button><Show when={task().status==="unknown"&&task().setupVersion&&!task().archivedAt}><button class="btn ghost sm" disabled={recoveryBusy()===task().id||offline()} onClick={()=>void continueTask(task())}>{recoveryBusy()===task().id?"Inspecting…":"Continue verified setup · no prompt replay"}</button></Show><Show when={!task().archivedAt&&(task().status==="creating"||recoveryBusy()===task().id||task().repositories.some(repo=>taskMembers()[repo.id]?.status==="running"))}><button class="btn danger-ghost sm" onClick={()=>void stopTaskSetup(task())}>Stop task setup and active members</button></Show><Show when={task().status==="running"&&!task().archivedAt}><button class="btn ghost sm" onClick={()=>void archiveTask(task(),true)}>Archive task</button></Show><Show when={task().archivedAt}><button class="btn ghost sm" onClick={()=>void archiveTask(task(),false)}>Restore task</button></Show><Show when={current()?.id!==task().coordinatorId}><button class="btn ghost sm" disabled={!taskCoordinatorAvailable()||!!task().archivedAt} onClick={()=>void select(task().coordinatorId)}>Open coordinator</button></Show></div>
    </div>
    <Show when={task().status==="unknown"}><p class="field-help warn">Creation outcome is unknown. Existing sessions are shown when found; nothing is created or retried automatically.</p></Show>
    <div class="task-repositories"><For each={task().repositories}>{repo=>{
      const summary=()=>taskMembers()[repo.id];
      return <article class="task-repo"><div class="repo-heading"><h3>{base(repo.sourceCwd)}</h3><RunBadge status={summary()?.status??"unknown"} quiet/></div>
        <p class="mono repo-path" title={repo.sourceCwd}>{repo.sourceCwd}</p><p class="muted small">Base commit <span class="mono">{repo.baseCommit.slice(0,12)}</span> · session <span class="mono">{short(repo.sessionId)}</span></p>
        <Show when={summary()} fallback={<p class="muted small">Loading this repository’s session…</p>}>
          <p class="task-result">{summary()!.status==="unknown"?summary()!.result:`Latest reply, unverified: ${firstLine(summary()!.result,180)}`}</p>
          <dl class="task-proof"><div><dt>{taskWorkspaceKind(task())==="direct"?"Working-tree files":"Changed files"}</dt><dd>{summary()!.files===null?"unknown":summary()!.files}{summary()!.omitted?` · ${summary()!.omitted} omitted`:""}</dd></div><div><dt>Check</dt><dd>{summary()!.check}</dd></div><div><dt>Review</dt><dd>{summary()!.review}</dd></div><Show when={taskWorkspaceKind(task())!=="direct"}><div><dt>Source Apply</dt><dd>{summary()!.sourceApply}</dd></div></Show></dl>
          <Show when={summary()!.evidenceError}><p class="field-help warn">Evidence unavailable or does not match this repository’s saved snapshot.</p></Show>
          <Show when={summary()!.pending}><p class="field-help warn">{summary()!.pending} tool approval{summary()!.pending===1?"":"s"} waiting in this repository</p></Show>
        </Show>
        <button class="btn ghost sm" disabled={!summary()?.available} onClick={()=>void select(repo.sessionId)}>{current()?.id===repo.sessionId?"Viewing repository":"Open repository"}</button>
      </article>;
    }}</For></div>
    <p class="field-help">{taskWorkspaceKind(task())==="direct"?"Each repository session edits its selected folder after approval. Current working-tree changes may include earlier user edits; inspect them before attributing results. No Source Apply is needed.":"Each repository has its own isolated workspace, approvals, checks and review. Source Apply requires separate approval per repository and is not atomic across repositories."} Stopping the coordinator stops active repository work; stopping one repository affects only that repository.</p>
  </section>}</Show>;

  // ---------- sidebar ----------
  const ProjectGroup=(p:{project:ProjectView})=>{
        const project=p.project;
        const open=()=>expanded().has(project.id);
        const items=createMemo(()=>liveSessions().filter(s=>inProject(project,s)));
        const tasks=createMemo(()=>projectTasks().filter(t=>t.projectId===project.id));
        return <div class="project-group">
          <div class="project-row" classList={{active:showProjects()&&projectId()===project.id}}>
            <button class="project-toggle" aria-expanded={open()} onClick={()=>toggleProject(project.id)} title={project.folders.join("\n")}>
              <span class="chevron" classList={{open:open()}}><Icon name="chevron"/></span><span class="truncate">{project.name}</span><span class="project-count">{items().length+tasks().length||""}</span>
            </button>
            <Show when={!project.archivedAt}><button class="icon-btn xs row-action" onClick={()=>newInProject(project)} aria-label={`New session in ${project.name}`} title="New session"><Icon name="compose"/></button></Show>
            <button class="icon-btn xs row-action project-more" classList={{"menu-open":menu()?.project.id===project.id}} aria-haspopup="menu" aria-expanded={menu()?.project.id===project.id} onClick={e=>openProjectMenu(project,e.currentTarget)} aria-label={`More actions for project ${project.name}`} title="More"><Icon name="more"/></button>
          </div>
          <Show when={open()}><div class="project-items">
            <For each={tasks()}>{task=><TaskRow task={task}/>}</For>
            <For each={items()}>{s=><SessionRow s={s}/>}</For>
            <Show when={!items().length&&!tasks().length}><p class="side-empty">No sessions yet</p></Show>
          </div></Show>
        </div>;
      };
  const TaskRow=(p:{task:ProjectTaskView})=><button class="session" classList={{active:!showProjects()&&taskFocusId()===p.task.id}} aria-current={!showProjects()&&taskFocusId()===p.task.id?"page":undefined} onClick={()=>void selectTask(p.task)}>
    <span class="session-title">{p.task.projectName} · multi-repo</span><span class="tag session-demo">{taskState(p.task.status)}</span>
    <span class="session-meta"><span>{p.task.repositories.length} repositories</span><span class="dot-sep" aria-hidden="true">·</span><span class="nowrap">{ago(p.task.createdAt)}</span></span>
  </button>;
  const SessionRow=(p:{s:Listed;archived?:boolean})=><div class="session-row">
    <button class="session" classList={{active:!showProjects()&&current()?.id===p.s.id,loading:loadingId()===p.s.id}} aria-current={!showProjects()&&current()?.id===p.s.id?"page":undefined} onClick={()=>select(p.s.id)}>
      <span class="session-title">{sessionTitle(p.s)}</span>
      <span class="session-meta"><RunBadge status={p.s.status} quiet/><span class="dot-sep" aria-hidden="true">·</span><span class="truncate">{base(p.s.sourceCwd??p.s.cwd)}{p.s.sourceCwd&&p.s.sourceCwd!==p.s.cwd?" · code":""}</span><Show when={p.s.created_at}><span class="dot-sep" aria-hidden="true">·</span><span class="nowrap">{ago(p.s.created_at)}</span></Show><Show when={duplicate(p.s)}><span class="dot-sep" aria-hidden="true">·</span><span class="mono nowrap" title={p.s.id}>#{p.s.id.slice(0,4)}</span></Show></span>
      <Show when={isDemo(p.s.model)}><span class="session-demo">demo</span></Show>
    </button>
    <button class="icon-btn xs row-action session-action" disabled={!p.archived&&p.s.status==="running"} onClick={()=>void archive(p.s,!p.archived)} aria-label={`${p.archived?"Restore":"Archive"} session ${sessionTitle(p.s)}`} title={p.archived?"Restore":p.s.status==="running"?"Stop the session to archive it":"Archive"}><Icon name={p.archived?"restore":"archive"}/></button>
  </div>;
  const Sidebar=()=><aside id="nav" ref={navPanel} class="sidebar" aria-label="Workspace and sessions">
    <div class="side-head">
      <div class="brand"><Logo class="brand-mark"/><span class="brand-name">Sigma</span></div>
      <button class="icon-btn dock-nav dock-nav-hide" onClick={toggleNavCollapsed} aria-label="Hide sidebar" title="Hide sidebar" aria-controls="nav" aria-expanded="true"><Icon name="sidebar"/></button>
      <button class="icon-btn drawer-close only-nav" onClick={closeNav} aria-label="Close sessions panel"><Icon name="close"/></button>
    </div>
    <div class="side-actions">
      <button class="nav-item" classList={{active:composing()}} onClick={startNew}><Icon name="compose"/>New session</button>
      <button class="nav-item" classList={{active:showProjects()}} onClick={()=>{setEditRequest(0);manageProjects();}}><Icon name="folder"/>Projects</button>
      <button class="nav-item" classList={{active:showRoles()}} onClick={()=>{setShowProviders(false);setShowProjects(false);setShowRoles(true);setDetailsOpen(false);setNavOpen(false);}}><Icon name="bot"/>Agents</button>
      <button class="nav-item" classList={{active:showProviders()}} onClick={()=>{setShowProjects(false);setShowRoles(false);setShowProviders(true);setDetailsOpen(false);setNavOpen(false);queueMicrotask(()=>document.getElementById("providers-title")?.focus());}}><Icon name="cpu"/>Providers</button>
    </div>
    <nav class="session-list" aria-label="Projects and sessions" onKeyDown={listKeys}>
    <Show when={workspaceRecovery().length}><section class="setup-recovery" aria-label="Workspace setup recovery"><h2>Workspace setup recovery</h2><For each={workspaceRecovery()}>{item=><article class="setup-recovery-item"><div><strong>{item.kind}</strong><span class="mono">{item.id.slice(0,28)}</span></div><Show when={item.setup}><details><summary>Inspect workspace identity</summary><dl class="setup-identity"><dt>Phase</dt><dd>{item.setup!.phase} · {item.setup!.sessionId}</dd><dt>Source</dt><dd>{item.setup!.sourceCwd??item.setup!.cwd}</dd><dt>Workspace</dt><dd>{item.setup!.cwd} · {item.cwdExists?"present":"absent"} · {item.worktreeRegistered?"Git registered":"no worktree registration"} · {item.registered?"session row present":"session row absent"}</dd><dt>Git owner</dt><dd>{item.workspaceGitDir??"unavailable"} · expected {item.setup!.workspaceGitDir??item.setup!.gitDir??"read only"}</dd><dt>HEAD</dt><dd>{item.head??"unavailable"} · expected {item.setup!.baseCommit??"read only"}</dd><dt>Pi history</dt><dd>{item.managerFile??"absent; reserved ID"} · {item.setup!.managerId}</dd></dl></details></Show><Show when={!item.setup&&(item.cwd||item.managerFile)}><p class="mono">{item.cwd??item.managerFile}</p></Show><p>{item.reason??(item.canContinue?"Verified workspace is ready for explicit continuation.":"Inspect saved workspace and Pi history before continuing.")}</p><p>Continuing setup does not rerun the original input.</p><div><span class="tag">{item.status}</span><Show when={recoveryBusy()===item.id&&item.setup}><button class="btn danger-ghost sm" onClick={()=>void stopSetup(item)}>Stop setup</button></Show><Show when={item.canContinue&&["create","delegate","review_spawn"].includes(item.kind)}><button class="btn ghost sm" disabled={recoveryBusy()===item.id||offline()} onClick={()=>void continueWorkspaceSetup(item)}>{recoveryBusy()===item.id?"Continuing…":"Continue setup"}</button></Show></div></article>}</For></section></Show>
      <div class="side-section"><h2 ref={navTitle} class="section-label" tabindex="-1">Projects</h2><button class="icon-btn xs" onClick={()=>editProject()} aria-label="New project" title="New project"><Icon name="plus"/></button></div>
      <Show when={booted()&&!projects().length}><p class="side-empty">Group folders into a project to keep its sessions together.</p></Show>
      <For each={activeProjects()}>{project=><ProjectGroup project={project}/>}</For>
      <div class="side-section"><h2 class="section-label">Chats</h2><button class="icon-btn xs" onClick={newChat} aria-label="New chat" title="New chat"><Icon name="plus"/></button></div>
      <Show when={booted()&&!looseSessions().length&&!looseTasks().length}><p class="side-empty">Start a chat without a project; it gets its own scratch folder.</p></Show>
      <For each={looseTasks()}>{task=><TaskRow task={task}/>}</For>
      <For each={looseSessions()}>{s=><SessionRow s={s}/>}</For>
      <Show when={booted()&&!sessions().length&&!projectTasks().length}><p class="side-empty">No sessions yet. Start one with New session; history stays on this machine.</p></Show>
      <Show when={archivedProjects().length}>
        <button class="side-section side-toggle" aria-expanded={showArchivedProjects()} onClick={()=>setShowArchivedProjects(x=>!x)}><span class="chevron" classList={{open:showArchivedProjects()}}><Icon name="chevron"/></span><span class="section-label">Archived projects</span><span class="project-count">{archivedProjects().length}</span></button>
        <Show when={showArchivedProjects()}><For each={archivedProjects()}>{project=><ProjectGroup project={project}/>}</For></Show>
      </Show>
      <Show when={archivedSessions().length}>
        <button class="side-section side-toggle" aria-expanded={showArchived()} onClick={()=>setShowArchived(x=>!x)}><span class="chevron" classList={{open:showArchived()}}><Icon name="chevron"/></span><span class="section-label">Archived</span><span class="project-count">{archivedSessions().length}</span></button>
        <Show when={showArchived()}><For each={archivedSessions()}>{s=><SessionRow s={s} archived/>}</For><Cleanup/></Show>
      </Show>
    <Show when={menu()}>{m=><div class="project-menu" role="menu" aria-label={`Actions for project ${m().project.name}`} style={{top:`${m().top}px`,left:`${m().left}px`}} onKeyDown={e=>{if(e.key!=="ArrowDown"&&e.key!=="ArrowUp")return;e.preventDefault();const items=[...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")],i=items.indexOf(document.activeElement as HTMLElement);items[(i+(e.key==="ArrowDown"?1:-1)+items.length)%items.length]?.focus();}}>
        <button role="menuitem" onClick={()=>{const pr=m().project;setMenu(null);editProject(pr);}}>Settings</button>
        <button role="menuitem" onClick={()=>{const pr=m().project;setMenu(null);void archiveProject(pr,!pr.archivedAt);}}>{m().project.archivedAt?"Restore":"Archive"}</button>
        <button role="menuitem" class="danger" onClick={()=>{const pr=m().project;setMenu(null);void deleteProject(pr);}}>Delete</button>
      </div>}</Show>
    </nav>
    <div class="side-foot">
      <UpdateButton/>
      <div class="side-status" role="status" aria-live="polite">
      <span class={`conn conn-${conn()}`} aria-hidden="true"/>
      <span><strong>{CONN[conn()].label}{conn()==="reconnecting"&&attempt()>1?` (attempt ${attempt()})`:""}</strong><small>{CONN[conn()].detail}</small></span>
      </div>
    </div>
  </aside>;

  // ---------- run details ----------
  const AgentRow=(p:{agent:AgentView;child?:boolean})=><li classList={{agent:true,child:!!p.child,[`agent-${p.agent.status}`]:true}}>
    <div class="agent-main"><span class="agent-role">{p.child?cap(p.agent.role):"Root · planner"}</span><RunBadge status={p.agent.status}/></div>
    <div class="agent-meta mono"><span title={p.agent.id}>{short(p.agent.id)}</span><span aria-hidden="true">·</span><span>host</span><Show when={p.child}><span aria-hidden="true">·</span><span>{p.agent.model}</span><Show when={p.agent.parentId!==current()?.id}><span aria-hidden="true">·</span><span>parent {short(p.agent.parentId!)}</span></Show></Show></div>
    <Show when={p.child}><button type="button" class="btn ghost sm" aria-expanded={selectedChildId()===p.agent.id} onClick={()=>selectChild(p.agent)}>{selectedChildId()===p.agent.id?"Hide history":profile().maxDepth>0?"View result and message":"View reviewer history"}</button></Show>
    <Show when={p.child&&selectedChildId()===p.agent.id}><div class="child-detail">
      <Show when={childView()?.id===p.agent.id} fallback={<p class="hint">Loading child history…</p>}>
        <p class="hint">This is {cap(p.agent.role)} {short(p.agent.id)}’s own Pi history. Interrupted output may be partial; settled does not verify the result.</p>
        <div class="child-messages" aria-label={`${p.agent.role} history`}><For each={childView()!.messages}>{m=><div class="child-message"><strong>{m.role==="user"?"Task / you":"Child reply"}</strong>{m.role==="user"?<p>{m.text}</p>:<Markdown class="md child-md" text={m.text}/>}</div>}</For></div>
        <Show when={childView()!.recoveryInputs.length}><div class="callout error-callout"><strong>Uncertain child input.</strong> Inspect history before sending a new command.<For each={childView()!.recoveryInputs}>{input=><pre class="recovery-text">{input.text}</pre>}</For></div></Show>
        <Show when={!p.agent.revisionReviewer&&profile().maxDepth>0&&(p.agent.status==="running"||p.agent.status==="settled")} fallback={<Show when={profile().maxDepth===0}><p class="hint">Use Code changes to stop this revision-bound reviewer.</p></Show>}><form class="child-form" onSubmit={e=>{e.preventDefault();void sendChild(p.agent);}}>
          <label for={`child-text-${p.agent.id}`} class="field-label">Message to this child</label>
          <textarea id={`child-text-${p.agent.id}`} class="input" rows="3" value={childText()} onInput={e=>setChildText(e.currentTarget.value)} disabled={taskUnresolved()} placeholder="Clarify the task or change its direction…"/>
          <Show when={p.agent.status==="running"}><select class="input" aria-label="Delivery while child is running" value={childBehavior()} onChange={e=>setChildBehavior(e.currentTarget.value as "steer"|"followUp")}><option value="followUp">Follow up after current turn</option><option value="steer">Steer current turn</option></select></Show>
          <button class="btn primary sm" type="submit" disabled={offline()||taskUnresolved()||childBusy()||!childText().trim()}>{childBusy()?"Sending…":p.agent.status==="running"?"Send to running child":"Ask this child again"}</button>
        </form></Show>
      </Show>
    </div></Show>
    <Show when={p.child&&!p.agent.revisionReviewer&&profile().maxDepth>0&&(p.agent.status==="idle"||p.agent.status==="running")}><button type="button" class="btn danger-ghost sm" disabled={offline()||stoppingChildren().includes(p.agent.id)} onClick={()=>stopChild(p.agent)} aria-label={`Stop ${p.agent.role} ${short(p.agent.id)}`}><Icon name="stop"/>{stoppingChildren().includes(p.agent.id)?"Stopping…":"Stop child"}</button></Show>
  </li>;
  const AgentBranch=(p:{agent:AgentView})=><><AgentRow agent={p.agent} child/><Show when={children().some(agent=>agent.parentId===p.agent.id)}><li class="tree-children"><ul><For each={children().filter(agent=>agent.parentId===p.agent.id)}>{agent=><AgentBranch agent={agent}/>}</For></ul></li></Show></>;
  const DETAIL_TABS:{id:DetailTab;label:string}[]=[{id:"overview",label:"Overview"},{id:"changes",label:"Changes"},{id:"repository",label:"Repository"},{id:"activity",label:"Activity"},{id:"graph",label:"Graph"}];
  const tabCount=(id:DetailTab)=>!current()?0:id==="overview"?current()!.recoveryInputs.length+current()!.recoveryActions.length+childTrouble().filter(a=>a.status==="error").length:id==="changes"?pending().length+mergePending()+directNeeds():0;
  function tabKeys(e:KeyboardEvent){
    if(!["ArrowLeft","ArrowRight","Home","End"].includes(e.key))return;e.preventDefault();
    const i=DETAIL_TABS.findIndex(t=>t.id===detailTab()),n=DETAIL_TABS.length;
    const next=e.key==="Home"?0:e.key==="End"?n-1:(i+(e.key==="ArrowRight"?1:n-1))%n;
    setDetailTab(DETAIL_TABS[next].id);document.getElementById(`tab-${DETAIL_TABS[next].id}`)?.focus();
  }
  const Details=()=><aside id="details" ref={detailsPanel} class="details" aria-label="Session details">
    <div class="details-resize" classList={{dragging:resizing()}} role="separator" aria-orientation="vertical" aria-label="Resize details panel" tabindex="0" aria-valuenow={detailsNow()} aria-valuemin={DETAILS_MIN} aria-valuemax={detailsMax()} onPointerDown={resizeDown} onPointerMove={resizeMove} onPointerUp={resizeUp} onPointerCancel={resizeUp} onLostPointerCapture={resizeUp} onKeyDown={resizeKey} onDblClick={()=>saveDetailsW(null)}/>
    <div class="col-head details-head">
      <h2 ref={detailsTitle} class="sr-only" tabindex="-1">Session details</h2>
      <div class="tabs" role="tablist" aria-label="Session details" onKeyDown={tabKeys}>
        <For each={DETAIL_TABS}>{t=><button id={`tab-${t.id}`} role="tab" class="tab" aria-selected={detailTab()===t.id} aria-controls={`panel-${t.id}`} tabindex={detailTab()===t.id?0:-1} disabled={!current()} onClick={()=>setDetailTab(t.id)}>
          {t.label}<Show when={tabCount(t.id)}><span class="pip">{tabCount(t.id)}</span></Show>
        </button>}</For>
      </div>
      <button class="icon-btn dock-details dock-details-hide" onClick={toggleDetailsCollapsed} aria-label="Hide details" title="Hide details" aria-controls="details" aria-expanded="true"><Icon name="panel"/></button>
      <button class="icon-btn drawer-close only-details" onClick={()=>closeDetails()} aria-label="Close session details"><Icon name="close"/></button>
    </div>
    <div class="details-body">
      <Show when={current()} fallback={<p class="muted pad">Start or open a session to see its changes, repository, agents and tool activity.</p>}>
        <div id="panel-overview" role="tabpanel" aria-labelledby="tab-overview" class="tab-panel" hidden={detailTab()!=="overview"}>
          <section class="panel" aria-labelledby="h-summary">
            <h3 id="h-summary" class="panel-title">Summary</h3>
            <dl class="summary">
              <div class="stack"><dt>Model</dt><dd class="mono dd-wrap">{current()!.model}<Show when={isDemo(current()!.model)}> <DemoTag/></Show></dd></div>
              <div class="stack"><dt>Workspace</dt><dd class="mono dd-wrap" title={current()!.cwd}>{current()!.cwd}</dd></div>
              <div><dt>Root run</dt><dd><RunBadge status={current()!.status}/></dd></div>
              <div><dt>Children</dt><dd>{children().length?`${children().length} · ${children().filter(a=>a.status==="running").length} running`:"None"}</dd></div>
              <div><dt>Waiting on you</dt><dd classList={{hot:pending().length>0}}>{pending().length?`${pending().length} approval${pending().length===1?"":"s"}`:"Nothing"}</dd></div>
            </dl>
            <Show when={childTrouble().length}><p class="callout error-callout">{childTrouble().length} child agent{childTrouble().length===1?"":"s"} ended in {[...new Set(childTrouble().map(a=>RUN[a.status].label.toLowerCase()))].join(" / ")}. The root result does not replace these outcomes.</p></Show>
          </section>
          <BrowserUsePanel id={current()!.id} revision={evidenceVersion()}/>
          <section class="panel" ref={treeSection} tabindex="-1" aria-labelledby="h-tree">
            <h3 id="h-tree" class="panel-title">Agent tree <span class="count">{agents().length}</span></h3>
            <ul class="tree">
              <Show when={root()}><AgentRow agent={root()!}/></Show>
              <Show when={children().length}><li class="tree-children"><ul><For each={children().filter(agent=>agent.parentId===current()!.id)}>{a=><AgentBranch agent={a}/>}</For></ul></li></Show>
            </ul>
            <Show when={!children().length}><p class="hint">{current()!.policy?.requested.mode==="multi"?"Repository sessions are shown in the task cards above.":delegates()?`No child agents yet. The root can delegate to as many child agents as the task needs; a lone worker edits the working copy directly, and parallel workers are merged automatically under Full access (otherwise you approve each merge).`:profile().maxDepth>0?"No children yet. The root may delegate to researcher, worker, reviewer or QA agents.":"This session has one writer. Start a separate read-only review from Code changes."}</p></Show>
          </section>
          <Show when={current()!.recoveryInputs.length||current()!.recoveryActions.length}>
            <section class="panel recovery" ref={recoverySection} tabindex="-1" aria-labelledby="h-recovery">
              <h3 id="h-recovery" class="panel-title">Unresolved activity <span class="count warn">{current()!.recoveryInputs.length+current()!.recoveryActions.length}</span></h3>
              <p class="hint">Outcome unknown. Nothing is replayed automatically. Inspect the relevant agent history and file state before starting new work.</p>
              <ul class="recovery-list"><For each={current()!.recoveryActions}>{action=><li class="recovery-item">
                <div class="recovery-head"><span class="badge st-unknown"><span class="glyph" aria-hidden="true"/>Unknown</span><span class="tag">{action.kind}{action.role?` · ${action.role}`:""}</span><span class="muted small">{clock(action.createdAt)}</span></div>
                <Show when={action.text}><pre class="recovery-text">{action.text}</pre></Show>
                <Show when={action.agentId&&children().some(a=>a.id===action.agentId)}><button class="btn ghost sm" onClick={()=>{const agent=children().find(a=>a.id===action.agentId);if(agent&&selectedChildId()!==agent.id)selectChild(agent);treeSection?.scrollIntoView({block:"nearest"});}} aria-label={`Inspect child ${short(action.agentId!)}`}>Inspect child</button></Show>
                <Show when={action.kind!=="delegate"}><p class="hint">Inspect write approvals and {workspaceKind(current())==="direct"?"the selected folder":"the isolated workspace"} before another change.</p></Show>
              </li>}</For><For each={current()!.recoveryInputs}>{input=><li class="recovery-item">
                <div class="recovery-head"><span class="badge st-unknown"><span class="glyph" aria-hidden="true"/>Unknown</span><Show when={input.behavior}><span class="tag">{input.behavior==="followUp"?"follow-up":input.behavior}</span></Show><span class="muted small">{clock(input.createdAt)}</span></div>
                <pre class="recovery-text">{input.text}</pre>
                <button class="btn ghost sm" onClick={()=>copyRecovery(input)} aria-label={`Copy to composer without sending: ${firstLine(input.text,40)}`}><Icon name="copy"/>Copy to composer</button>
              </li>}</For></ul>
              <Show when={current()!.recoveryInputs.length===100||current()!.recoveryActions.length===100}><p class="hint">Showing the most recent 100 of each activity type.</p></Show>
            </section>
          </Show>
          <section class="panel boundary" aria-labelledby="h-limits">
            <h3 id="h-limits" class="panel-title">Session policy</h3>
            <Show when={current()!.policy} fallback={<p class="hint">Legacy session: the original policy snapshot is unknown. Current read-only limits are shown below.</p>}>
              <p class="hint">Workspace and editing mode are fixed when the session is created; model and reasoning can be changed in the chat.</p>
              <dl class="summary">
                <div class="stack"><dt>Requested model</dt><dd class="mono dd-wrap">{current()!.policy!.requested.model}</dd></div>
                <Show when={current()!.policy!.role?.requestedReasoning}><div class="stack"><dt>Requested reasoning</dt><dd class="mono dd-wrap">{current()!.policy!.role!.requestedReasoning}</dd></div></Show>
                <div class="stack"><dt>Effective model</dt><dd class="mono dd-wrap">{current()!.policy!.effective.model}</dd></div>
                <div class="stack"><dt>Requested workspace</dt><dd class="mono dd-wrap">{current()!.policy!.requested.cwd}</dd></div>
                <div class="stack"><dt>Effective workspace</dt><dd class="mono dd-wrap">{current()!.policy!.effective.cwd}</dd></div>
                <Show when={current()!.policy!.workspace}><div><dt>Editing location</dt><dd>{workspaceKind(current())==="direct"?"Selected folder":workspaceKind(current())==="worktree"?"Git worktree":"Legacy Git copy"}</dd></div></Show>
              </dl>
            </Show>
            <ul class="facts">
              <li><strong>Settled</strong> means the Pi run ended. It does not certify the engineering task; child results are not independent review.</li>
              <Show when={current()!.policy?.unsupervised}><li class="unsupervised-note"><strong>Unsupervised Antigravity.</strong> {AGY_WARNING} Its tools are not Pi approvals; open Activity to see what AGY reported.</li></Show>
              <Show when={!current()!.policy?.unsupervised}><li>{current()!.policy?.requested.mode==="multi"?<>Coordinator controls: <code>delegate_repo, repo_status</code>. File tools: none. Each repository has its own session and approval flow.</>:<>File tools: <code>{[...profile().tools,...(profile().tools.includes("write" as never)?["bash"]:[]),...(canCommit()?["git_commit"]:[])].join(", ")||"none"}</code>{profile().tools.length?(askMode()?", each call needs your approval.":", run without asking (Full access)."):"."} {editing()?<>{delegates()?`The agent can delegate to up to ${profile().rootTotalChildren} child agents. Workers write in separate Git ${workspaceKind(current())==="clone"?"workspaces":"worktrees"}; merges into ${rootWs()} need your approval. `:""}{workspaceKind(current())==="direct"?"Edits change the selected folder.":"Edits change only this isolated workspace; Source Apply is a separate step."} {canCommit()?"Commits use git_commit; ":"No commit; "}no push. <strong>bash runs shell commands on this computer</strong> in the agent's folder with network access; Sigma's own credential and data folders are blocked, but commands can change anything else your account can.</>:current()!.policy?.workspace?"":"No edit or write. Delegated agents can still run bash commands."}</>}</li></Show>
              <li>Depth {profile().maxDepth} · no limit on the number of agents<Show when={"verification" in profile()}> · revision reviews: one at a time</Show> · {profile().childTimeoutMs/1000}s per child · {profile().execution} execution.</li>
              <li class="muted">Pi SDK 0.87.1</li>
            </ul>
          </section>
        </div>
        <div id="panel-changes" role="tabpanel" aria-labelledby="tab-changes" class="tab-panel" hidden={detailTab()!=="changes"}>
          <Show when={current()!.policy?.requested.mode==="parallel"&&!taskUnresolved()}><WorkerMerges id={current()!.id} workers={children().filter(a=>a.role==="worker"&&a.parentId===current()!.id)} revision={evidenceVersion().toString()} offline={offline()} rootSettled={current()!.status==="settled"} rootKind={workspaceKind(current())} onPending={setMergePending}/></Show>
          <Show when={current()!.policy?.workspace}><Changes id={current()!.id} revision={`${current()!.approvals.filter(a=>a.change&&a.outcome).map(a=>`${a.id}:${a.outcome}`).join(",")}:${evidenceVersion()}`} canVerify={!taskUnresolved()&&"verification" in current()!.policy!.effective.profile} canTypecheck={!taskUnresolved()&&"typecheck" in current()!.policy!.effective.profile} canApply={!taskUnresolved()&&workspaceKind(current())!=="direct"&&"sourceApply" in current()!.policy!.effective.profile} workspaceKind={workspaceKind(current())}/></Show>
          <Show when={current()!.policy?.workspace&&!taskUnresolved()&&"verification" in current()!.policy!.effective.profile}><Qa id={current()!.id} revision={evidenceVersion().toString()} askMode={askMode()}/></Show>
          <section class="panel" tabindex="-1" aria-labelledby="h-approvals">
            <h3 id="h-approvals" class="panel-title">Approvals <span class="count">{current()!.approvals.length}</span></h3>
            <Show when={current()!.approvals.length} fallback={<p class="hint">No tool requests in this session yet. Each file operation waits for an explicit decision.</p>}>
              <ul class="log"><For each={current()!.approvals.slice(0,20)}>{a=><li>
                <span class={`badge ap-${a.status}`}><span class="glyph" aria-hidden="true"/>{APPROVAL[a.status]||a.status}</span>
                <span class="mono truncate" title={a.preview}>{a.preview}</span><span class="muted small nowrap">{a.change?`${a.outcome??"not applied"}${a.needsReconciliation?" · reconcile":""}`:roleOf(a.agentId)}</span>
                <Show when={a.git}><details class="approval-history"><summary>View approved message and exact diff</summary><pre class="recovery-text">{a.git!.message}</pre><p class="mono small">Parent {a.git!.parent} · Tree {a.git!.tree}</p><pre class="change-diff" tabindex="0">{a.git!.diff}</pre></details></Show>
                <Show when={a.change}><details class="approval-history"><summary>View proposed diff</summary><pre class="change-diff" tabindex="0">{a.change!.diff}</pre></details></Show>
              </li>}</For></ul>
              <Show when={pending().length}><div class="hint-row"><p class="hint">Pending requests are decided above the composer.</p><button class="btn ghost sm" onClick={goToDecision}>Go to decision</button></div></Show>
            </Show>
            <Show when={workspaceKind(current())==="direct"}><For each={current()!.approvals.filter(a=>a.needsReconciliation&&a.change)}>{a=><WriteRecovery sessionId={current()!.id} approval={a} offline={offline()} onDone={refreshWriteRecovery}/>}</For></Show>
          </section>
        </div>
        <div id="panel-repository" role="tabpanel" aria-labelledby="tab-repository" class="tab-panel" hidden={detailTab()!=="repository"}>
          <Repository id={current()!.id} revision={`${current()!.status}:${evidenceVersion()}`} kind={current()!.policy?.workspace?workspaceKind(current()):null} running={running()||pending().length>0} offline={offline()} onCommit={requestCommit}/>
        </div>
        <div id="panel-graph" role="tabpanel" aria-labelledby="tab-graph" class="tab-panel" hidden={detailTab()!=="graph"}>
          <Graph id={current()!.id} active={detailTab()==="graph"} selected={graphNode()?.id??current()!.id} waiting={Object.fromEntries(pending().map(a=>[a.agentId,a.tool]))} unsupervised={current()!.policy?.unsupervised?{[current()!.id]:agyActivity().length}:undefined} onNode={node=>void readGraphNode(node)}/>
        </div>
        <div id="panel-activity" role="tabpanel" aria-labelledby="tab-activity" class="tab-panel" hidden={detailTab()!=="activity"}>
          <Show when={current()!.policy?.unsupervised||agyActivity().length}>
            <section class="panel" aria-labelledby="h-agy">
              <h3 id="h-agy" class="panel-title">Executed by AGY (unsupervised) <span class="count warn">{agyActivity().length}</span></h3>
              <p class="hint warn-text">{AGY_WARNING} These are read-only reports, not Pi approvals; nothing here was approved or can be denied.</p>
              <Show when={agyActivity().length} fallback={<p class="hint">No AGY tool activity reported yet.</p>}>
                <ul class="log"><For each={agyActivity()}>{t=><li><span class={`tool-st ts-${t.status}`}>{t.status}</span><span class="mono">{t.tool}</span><span class="muted small truncate" title={t.params}>{t.params}</span></li>}</For></ul>
              </Show>
            </section>
          </Show>
          <section class="panel" aria-labelledby="h-tools">
            <h3 id="h-tools" class="panel-title">Tool activity</h3>
            <Show when={tools().length} fallback={<p class="hint">Tool calls from this view appear here as they run.</p>}>
              <ul class="log"><For each={tools()}>{t=><li><span class={`tool-st ts-${t.status}`}>{t.status}</span><span class="mono">{t.tool}</span><Show when={t.detail}><span class="mono muted small truncate" title={t.detail}>{t.detail}</span></Show><span class="muted small nowrap">{roleOf(t.agentId)}</span></li>}</For></ul>
            </Show>
          </section>
        </div>
      </Show>
    </div>
  </aside>;

  // ---------- conversation ----------
  const DEMO_PROMPTS=["hello","read:package.json","delegate2: inspect A | inspect B","slow task","fail-provider"];
  const STARTER_PROMPTS=[
    {label:"Explain this project",text:"Read README.md and explain this project's purpose and how to run it. Ask for approval before reading files."},
    {label:"Review a file",text:"Help me review a source file for bugs. First ask me which file to inspect, then read only that file and report concrete findings."},
    {label:"Plan a change",text:"Help me plan a small code change. First ask what I want to change, then inspect the relevant files with my approval and suggest the smallest implementation and validation plan."},
  ];
  const workLive=()=>current()?.status==="running"&&(!graphNode()||graphNode()!.id===current()?.id);
  const [openWork,setOpenWork]=createSignal<Record<string,boolean>>({});
  const lastUserId=createMemo(()=>[...(conversation()?.messages??[])].reverse().find(m=>m.role==="user")?.id);
  const WorkBlock=(p:{id:string;work?:WorkView;at?:number;live?:boolean})=>{
    const mountedAt=Date.now(),[now,setNow]=createSignal(Date.now());
    createEffect(()=>{if(!p.live)return;setNow(Date.now());const t=setInterval(()=>setNow(Date.now()),1000);onCleanup(()=>clearInterval(t));});
    const start=()=>p.work?.startedAt||p.at||mountedAt,steps=()=>p.work?.steps??[],open=()=>openWork()[p.id]??!!p.live;
    const ms=()=>p.live?now()-start():Math.max(0,(p.work?.endedAt??0)-(p.work?.startedAt??0)),items=createMemo(()=>groupWork(steps()));
    const activity=()=>{
      if(pending().length)return "Waiting for your approval";
      const running=children().filter(a=>a.status==="running").length;if(running)return `Waiting on ${running} child agent${running>1?"s":""}`;
      const root=current()!.id,t=[...tools()].reverse().find(x=>x.agentId===root);
      if(t&&t.status==="requested")return liveActivity(t);
      if(draft())return "Writing";
      return thinking().includes(root)?"Thinking":"Working";
    };
    return <div class="work" classList={{live:p.live}}>
      <button class="work-head" aria-expanded={open()} onClick={()=>setOpenWork(x=>({...x,[p.id]:!open()}))}><span class="chevron" classList={{open:open()}}><Icon name="chevron"/></span>{p.live?"Working":"Worked"} for {elapsed(ms())}</button>
      <Show when={open()}><div class="work-steps">
        <For each={items()}>{item=>item.kind==="note"?<div class="work-note">{item.text}</div>
          :item.kind==="thinking"?<details class="work-row"><summary>Thought</summary><div class="work-thought">{item.text}</div></details>
          :<details class="work-row"><summary title={toolSummary(item.calls)}><span class="truncate">{toolSummary(item.calls)}</span><Show when={item.calls.some(c=>c.status==="error")}><span class="work-err" title="A call failed">failed</span></Show></summary>
            <ul class="work-calls"><For each={item.calls}>{c=><li><span class="mono">{c.tool}</span><Show when={c.detail}><span class="mono truncate" title={c.detail}>{c.detail}</span></Show><Show when={c.status==="error"}><span class="work-err">error</span></Show><Show when={c.status==="running"}><span class="muted">running</span></Show></li>}</For></ul></details>}</For>
      </div></Show>
      <Show when={p.live}><div class="work-live" role="status"><span class="spinner" aria-hidden="true"/><span class="truncate">{activity()}</span></div></Show>
    </div>;
  };
  const Outcome=()=>{
    const s=()=>current()!.status;
    return <>
      <Show when={s()==="running"&&!draft()&&!(workLive()&&lastUserId())}><div class="outcome running" role="status"><span class="spinner" aria-hidden="true"/><span>{pending().length?"Paused — waiting for your approval below":children().some(a=>a.status==="running")?`Root is waiting on ${children().filter(a=>a.status==="running").length} child agent(s)`:thinking().length?"Thinking…":"Agent is working…"}</span></div></Show>
      <Show when={s()==="settled"}><div class="outcome settled"><span class="badge st-settled"><span class="glyph" aria-hidden="true"/>Settled</span><span>The Pi run ended. Review the result yourself; this is not verification.</span></div></Show>
      <Show when={activeRepositoryWork()&&s()!=="running"}><div class="outcome running" role="status"><span class="spinner" aria-hidden="true"/><span>Repository work is still running. Open its task card for current status and approvals.</span></div></Show>
      <Show when={s()==="interrupted"}><div class="outcome interrupted"><span class="badge st-interrupted"><span class="glyph" aria-hidden="true"/>Interrupted</span><span>Stopped by you or by a service restart. History up to this point is saved; send a message to continue.</span></div></Show>
      <Show when={s()==="error"}><div class="outcome error"><span class="badge st-error"><span class="glyph" aria-hidden="true"/>Error</span><span>The run ended with an error. Inspect the history before retrying.</span></div></Show>
      <Show when={!RUN[s()]}><div class="outcome unknown"><span class="badge st-unknown"><span class="glyph" aria-hidden="true"/>Unknown</span><span>Unrecognized run status “{s()}”. Reload to resync.</span></div></Show>
      <Show when={childTrouble().some(a=>a.status==="error")&&s()!=="running"}><div class="outcome error"><span>{childTrouble().filter(a=>a.status==="error").length===1?"1 child agent ended with an error.":`${childTrouble().filter(a=>a.status==="error").length} child agents ended with an error.`} The root result does not replace it.</span><button class="link-btn" onClick={()=>openDetails("tree")}>View agent tree</button></div></Show>
    </>;
  };
  const Conversation=()=><main class="main" aria-label="Conversation">
    <header class="col-head main-head">
      <NavShow/>
      <button class="icon-btn only-nav" onClick={openNav} aria-label="Open sessions panel" aria-controls="nav" aria-expanded={navOpen()}><Icon name="menu"/></button>
      <div class="head-title">
        <h1 class="title truncate">{graphNode()?graphNode()!.title:current()?currentTitle():focusedTask()?focusedTask()!.projectName:selectedProject()?.name||workspace().split("/").filter(Boolean).pop()||"New chat"}</h1>
        <Show when={current()}><div class="head-meta">
          <span class="mono truncate head-cwd" title={conversation()!.cwd}>{graphHistory()?graphHistory()!.cwd:current()!.policy?.requested.mode==="multi"&&focusedTask()?`${focusedTask()!.projectName} · ${focusedTask()!.repositories.length} repositories`:conversation()!.cwd}</span>
          <span class="dot-sep hide-xs" aria-hidden="true">·</span><span class="mono truncate head-model">{conversation()!.model}</span>
          <Show when={isDemo(conversation()!.model)}><DemoTag/></Show>
        </div></Show>
        <Show when={!current()&&!graphNode()&&!focusedTask()&&workspace().trim()}><div class="head-meta"><span class="mono truncate head-cwd" title={workspace()}>{workspace()}</span></div></Show>
      </div>
      <Show when={current()}><RunBadge status={graphHistory()?.status??current()!.status}/></Show>
      <Show when={current()?.policy?.unsupervised}><span class="badge unsupervised" role="note" title={AGY_WARNING}>Unsupervised AGY</span></Show>
      <Show when={detailsCollapsed()}><button class="icon-btn dock-details dock-details-show" onClick={toggleDetailsCollapsed} aria-label="Show details" title="Show details" aria-controls="details" aria-expanded="false"><Icon name="panel"/></button></Show>
      <button class="btn ghost sm only-details details-toggle" onClick={()=>openDetails()} aria-label="Session details" aria-describedby={attention()?"details-attention":undefined} aria-controls="details" aria-expanded={detailsOpen()}>
        <Icon name="panel"/><span class="hide-xs">Details</span><Show when={attention()}><span id="details-attention" class="pip" aria-label={`Attention: ${attention()} item${attention()===1?"":"s"}`}>{attention()}</span></Show>
      </button>
    </header>
    <Show when={conn()==="reconnecting"||conn()==="unreachable"}>
      <div class={`banner ${conn()==="unreachable"?"error":"warning"}`} role="status">{conn()==="unreachable"?"Local service unreachable. Start it and reload this page.":"Connection lost — the state shown may be stale. Reconnecting; saved events replay from the last cursor and nothing is resent."}</div>
    </Show>
    <Show when={notice()}>
      <div class={`banner ${notice()!.kind}`} role={notice()!.kind==="error"?"alert":"status"}><span>{notice()!.text}</span><button class="icon-btn sm" onClick={()=>setNotice(null)} aria-label="Dismiss message"><Icon name="close"/></button></div>
    </Show>
    <Show when={graphNode()&&graphNode()!.id!==current()?.id}><div class="banner info"><span>Reading {graphNode()!.repositoryId&&!graphNode()!.parentId?"repository":graphNode()!.role} chat · {graphNode()!.id.slice(0,8)}. Controls remain with the owning root.</span><button class="btn ghost sm" onClick={returnGraphRoot}>Return to root</button></div></Show>
    <Show when={graphHistoryError()}><div class="banner error" role="alert">Selected graph history unavailable: {graphHistoryError()}</div></Show>
    <Show when={!graphNode()||graphNode()!.id===current()?.id}><TaskOverview/></Show>
    <Show when={taskUnresolved()}><div class="banner warning" role="status">{sessionArchived()?"Archived. Restore the session or task to resume work.":"Task creation is unresolved. Existing sessions are available for inspection; prompts, approvals, checks and source application are paused."}</div></Show>

    <Show when={!opening()&&!openFailed()&&current()} fallback={<>
      <Show when={!(!opening()&&!openFailed()&&booted()&&!focusedTask())}><div class="stage">
        <Show when={opening()}><div class="placeholder" role="status"><span class="spinner" aria-hidden="true"/>Opening session…</div></Show>
        <Show when={!opening()&&openFailed()}><div class="placeholder error"><strong>Could not open this session.</strong><span>{openFailed()!.text}</span><button class="btn ghost sm" onClick={()=>select(openFailed()!.id)}>Try again</button></div></Show>
        <Show when={!opening()&&!openFailed()&&!booted()}><div class="placeholder" role="status"><span class="spinner" aria-hidden="true"/>Connecting to the local service…</div></Show>
        <Show when={!opening()&&!openFailed()&&booted()&&focusedTask()}><div class="placeholder"><strong>Coordinator session is not open.</strong><span>Review the saved repository sessions above. Refresh the task to read their current state.</span></div></Show>
      </div></Show>
      <Show when={!opening()&&!openFailed()&&booted()&&!focusedTask()}>
        <div class="scroller"><div class="thread"><div class="thread-empty"><h2>What should we work on?</h2></div></div></div>
        <div class="dock">
          <form class="composer" classList={{dragging:dragging()}} onSubmit={e=>{e.preventDefault();void create();}} {...dropTarget}>
            <AttachmentStrip/>
            <label for="prompt" class="sr-only">Message to the root agent</label>
            <textarea id="prompt" ref={composer} value={prompt()} rows="2" onInput={e=>{setPrompt(e.currentTarget.value);resize();welcomeMention.sync();}} onPaste={onPasteImages} {...welcomeMention.props}
              onKeyDown={e=>{if(welcomeMention.keydown(e))return;if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();void create();}}}
              placeholder="Describe the task for the root agent… Type @ to mention files, skills or tools"/>{welcomeMention.view()}
            <div class="composer-foot">
              <div class="composer-tools"><AttachTool id="attach-welcome"/><ModelPicker welcome/></div>
              <div class="composer-actions"><button type="submit" class="send-btn" disabled={busy()||!models().length||!prompt().trim()&&!attachments().length||!!attachments().length&&!imagesAllowed()} aria-label={busy()?"Starting":"Send"}><Icon name="up"/></button></div>
            </div>
          </form>
        </div>
      </Show>
    </>}>
      <div class="scroller" ref={scroller} onScroll={()=>{if(scroller)stick=scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<80;}}>
        <div class="thread" aria-live="off">
          <Show when={current()!.messages.length>shown()}><button class="btn ghost sm older" onClick={()=>{stick=false;setShown(x=>x+200);}}>Load 200 older messages</button></Show>
          <Show when={!current()!.messages.length&&!draft()&&current()!.status!=="running"}>
            <div class="thread-empty">
              <h2>What should the agents work on?</h2>
              <p>{current()?.policy?.requested.mode==="multi"?"Describe the goal across the saved repositories. The coordinator can delegate repository work; inspect each repository’s own result and evidence above.":delegates()?`Describe the task. The agent can edit files and delegate to up to ${profile().rootTotalChildren} child agents; a lone worker edits ${rootWs()} directly; parallel workers are merged into it automatically under Full access, otherwise you approve each merge.`:current()?.policy?.workspace?workspaceKind(current())==="direct"?`Describe the code change. Edits will change the selected folder${askMode()?" after your approval":" immediately"}.`:`The agent can read and edit files in this isolated workspace${askMode()?" with your approval":""}. Describe the code change.`:"Describe the goal for the root agent. It can read files you approve and delegate bounded sub-tasks."}</p>
              <Show when={!isDemo(current()!.model)&&current()!.policy?.requested.mode!=="multi"}>
                <div class="examples"><span class="muted small">Start here — choose a prompt, edit it, then send:</span>
                  <div class="chips"><For each={STARTER_PROMPTS}>{p=><button class="chip" onClick={()=>insertExample(p.text)}>{p.label}</button>}</For></div></div>
              </Show>
              <Show when={current()!.policy?.requested.mode==="parallel"}><p class="hint">Editing · the agent can edit files and delegate to child agents; a lone worker edits {rootWs()} directly; workers running in parallel get their own Git {workspaceKind(current())==="clone"?"workspaces":"worktrees"} and are merged automatically under Full access. When a merge is pending (Ask mode or a conflict), open the Changes tab → Worker changes and merges to review it, then verify the result in Code changes.</p></Show>
              <Show when={current()!.policy?.requested.mode==="multi"}><p class="hint">Multi-repository task · {focusedTask()&&taskWorkspaceKind(focusedTask()!)==="direct"?"approved edits change the selected folders immediately":"repository work stays in separate Git workspaces until Source Apply"}. Use each card above for approvals, checks and review.</p></Show>
              <Show when={current()!.policy?.workspace&&current()!.policy?.requested.mode!=="parallel"&&current()!.policy?.requested.mode!=="multi"}><p class="hint">Editing · {workspaceKind(current())==="direct"?"edits affect the selected folder":"edits affect this isolated workspace"}{askMode()?" after you approve each diff":" immediately (Full access)"}. Open the Changes tab to inspect the working-tree diff.</p></Show>
              <Show when={isDemo(current()!.model)&&current()!.policy?.requested.mode!=="multi"}>
                <div class="examples"><span class="muted small">Offline demo prompts — inserted into the composer, not sent:</span>
                  <div class="chips"><For each={DEMO_PROMPTS}>{p=><button class="chip mono" onClick={()=>insertExample(p)}>{p}</button>}</For></div></div>
              </Show>
            </div>
          </Show>
          <For each={graphNode()&&graphNode()!.id!==current()?.id&&!graphHistory()?[]:conversation()!.messages.slice(-shown())}>{m=><Show when={!m.interim}><article class={`msg ${m.role==="user"?"user":"assistant"}`}>
            <div class="msg-author" classList={{"sr-only":m.role==="user"}}>{m.role==="user"?"You":<><Logo class="avatar"/>Sigma<span class="muted">{graphNode()?.role??"root"} agent</span></>}</div>
            <Show when={m.text||!m.images}>{m.role==="user"?<div class="msg-body">{renderMentions(m.text)}</div>:<Markdown class="msg-body md" text={m.text}/>}</Show>
            <Show when={m.images}><SentImages session={conversation()!.id} message={m.id} count={m.images!}/></Show>
          </article><Show when={m.role==="user"&&(m.work||workLive()&&m.id===lastUserId())}><WorkBlock id={m.id} work={m.work} at={m.at} live={workLive()&&m.id===lastUserId()}/></Show></Show>}</For>
          <Show when={draft()&&(!graphNode()||graphNode()!.id===current()?.id)}><article class="msg assistant streaming" aria-busy="true"><div class="msg-author"><Logo class="avatar"/>Sigma<span class="muted">root agent</span><span class="live-tag">streaming</span></div><div class="msg-body md"><Markdown text={draft()}/><span class="caret" aria-hidden="true"/></div></article></Show>
          <Show when={!graphNode()||graphNode()!.id===current()?.id}><Outcome/></Show>
        </div>
      </div>

      <Show when={!graphNode()||graphNode()!.id===current()?.id}><div class="dock">
        <Show when={mergePending()}><section class="approvals" aria-label="Worker merges awaiting a decision"><div class="dock-title"><span class="badge ap-pending"><span class="glyph" aria-hidden="true"/>{mergePending()} waiting</span>Worker merge {mergePending()===1?"needs":"merges need"} your decision</div><button class="btn ghost sm" onClick={()=>openDetails("merges")}>Review merge</button></section></Show>
        <Show when={pending().length}>
          <section class="approvals" aria-labelledby="h-pending" role="region">
            <h2 id="h-pending" class="dock-title"><span class="badge ap-pending"><span class="glyph" aria-hidden="true"/>{pending().length} waiting</span>{pending().length===1?"Tool request needs":"Tool requests need"} your decision</h2>
            <Show when={offline()}><p class="small dock-note">Decisions are paused until the connection is back. If the service restarted, these requests expire and are not executed.</p></Show>
            <ul class="approval-list"><For each={pending()}>{a=><li class="approval">
              <div class="approval-text">
                <div><strong>{roleOf(a.agentId)}</strong> wants to run <code>{a.tool}</code></div>
                <Show when={a.tool==="bash"} fallback={<div class="mono approval-path" title={a.preview}>{a.preview.replace(/^\S+\s/,"")}</div>}><pre class="change-diff" tabindex="0" aria-label="Command to run">{a.preview.replace(/^\S+\s/,"")}</pre></Show><Show when={a.git}><pre class="recovery-text">{a.git!.message}</pre><p class="mono small">Parent {a.git!.parent} · Tree {a.git!.tree}</p><pre class="change-diff" tabindex="0">{a.git!.diff}</pre></Show>
                <div class="muted small">{a.tool==="bash"?"Runs a shell command on this computer in the agent's folder; Sigma's credential and data folders are blocked":a.tool==="git_commit"?"Creates a Git commit in the selected folder":a.tool==="browser_action"?"Controls the selected tab in the active browser mode; screenshots may be saved in Pi and Sigma history":a.change?workspaceKind(current())==="direct"?"Write to selected folder":"Write to isolated workspace":"Read-only"} · applies to this call only · requested {clock(a.createdAt)}</div>
                <Show when={a.change}><pre class="change-diff" tabindex="0" aria-label={`Proposed change to ${a.change!.path}`}>{a.change!.diff}</pre></Show>
              </div>
              <div class="approval-actions">
                <button class="btn danger-ghost sm" disabled={deciding().includes(a.id)||offline()||taskUnresolved()} onClick={()=>decide(a,false)} aria-label={`Deny ${a.preview}`}>Deny</button>
                <button class="btn primary sm" disabled={deciding().includes(a.id)||offline()||taskUnresolved()} onClick={()=>decide(a,true)} aria-label={`Allow once: ${a.preview}`}>{a.tool==="git_commit"?"Commit":a.change?"Apply this change":"Allow once"}</button>
              </div>
            </li>}</For></ul>
          </section>
        </Show>
        <Show when={current()!.recoveryInputs.length||current()!.recoveryActions.length}>
          <div class="recovery-strip" role="status"><span class="badge st-unknown"><span class="glyph" aria-hidden="true"/>Unknown</span><span>{current()!.recoveryInputs.length+current()!.recoveryActions.length} action{current()!.recoveryInputs.length+current()!.recoveryActions.length===1?" has an":"s have an"} unknown outcome. Nothing was replayed.</span><button class="link-btn" onClick={()=>openDetails("recovery")}>Review</button></div>
        </Show>
        <Show when={directNeeds()}><div class="recovery-strip" role="status"><span class="badge st-unknown"><span class="glyph" aria-hidden="true"/>Unknown</span><span>{directNeeds()} direct write{directNeeds()===1?" needs":"s need"} observed-state reconciliation.</span><button class="link-btn" onClick={()=>openDetails("writes")}>Review observed state</button></div></Show>
        <form class="composer" classList={{running:running(),dragging:dragging()}} onSubmit={e=>{e.preventDefault();void send();}} {...dropTarget}>
          <AttachmentStrip/>
          <label for="prompt" class="sr-only">{running()?"Queue a follow-up message":"Message to the root agent"}</label>
          <textarea id="prompt" ref={composer} value={prompt()} rows="2" disabled={taskUnresolved()} onInput={e=>{setPrompt(e.currentTarget.value);resize();sessionMention.sync();}} onPaste={onPasteImages} {...sessionMention.props}
            onKeyDown={e=>{if(sessionMention.keydown(e))return;if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();void send();}}}
            placeholder={running()?"Queue a follow-up — delivered after the current turn… Type @ to mention":"Describe the task for the root agent… Type @ to mention files, skills or tools"}/>{sessionMention.view()}
          <div class="composer-foot">
            <div class="composer-tools">
              <AttachTool id="attach-session" disabled={taskUnresolved()}/>
              <ModelPicker/>
              <span class="pill hide-xs">{MODE_LABEL[current()!.policy?.requested.mode??"read"]??"Read only"}</span>
              <Show when={queued()?.id===current()!.id&&running()}>
                <span class="composer-hint"><span class="queued">{queued()!.count} follow-up{queued()!.count===1?"":"s"} queued this run</span></span>
              </Show>
            </div>
            <div class="composer-actions">
              <Show when={running()||children().some(a=>a.status==="running"||a.status==="idle")||activeRepositoryWork()}><button type="button" class="btn danger-ghost sm" onClick={stop} aria-label={current()!.policy?.requested.mode==="multi"?"Stop the coordinator and active repository work":"Stop the run and its child agents"}><Icon name="stop"/>Stop</button></Show>
              <button type="submit" class="send-btn" classList={{wide:running()||busy()}} disabled={!prompt().trim()&&!attachments().length||busy()||taskUnresolved()||!!attachments().length&&!imagesAllowed()} aria-label={busy()?"Sending":running()?"Queue follow-up":"Send"}><Show when={running()||busy()}><span>{busy()?"Sending…":"Queue"}</span></Show><Icon name="up"/></button>
            </div>
          </div>
        </form>
      </div></Show>
    </Show>
  </main>;

  return <div class="shell" classList={{"nav-open":navOpen(),"nav-collapsed":navCollapsed(),"details-collapsed":detailsCollapsed(),"details-open":detailsOpen(),"projects-view":showProjects()||showRoles()||showProviders(),composing:composing(),"graph-wide":!showProviders()&&!showRoles()&&!!current()&&detailTab()==="graph"}} style={detailsW()==null?undefined:{"--details-user-w":`${clampDetailsW(detailsW()!)}px`}}>
    <a class="skip" href={showProviders()?"#providers-title":showRoles()?"#roles-title":showProjects()?"#projects-title":"#prompt"}>{showProviders()?"Skip to providers":showRoles()?"Skip to agents":showProjects()?"Skip to projects":"Skip to composer"}</a>
    <Sidebar/>
    <Show when={showProviders()} fallback={<>
    <Show when={showRoles()} fallback={<>
    <Show when={showProjects()} fallback={<><Conversation/><Details/></>}>
      <Projects project={selectedProject()} editRequest={editRequest()} onSaved={projectSaved} onFolder={useProjectFolder} onCreateTask={(project,kind)=>void createProjectTask(project,kind)} taskBusy={taskBusy()} model={selectedModel()} onClose={()=>{setShowProjects(false);queueMicrotask(()=>composer?.focus());}} pending={pending().length}
        menu={<><NavShow/><button class="icon-btn only-nav" onClick={openNav} aria-label="Open sessions panel" aria-controls="nav" aria-expanded={navOpen()}><Icon name="menu"/></button></>}/>
    </Show>
    </>}><Roles models={models()} pending={pending().length} onClose={()=>{setShowRoles(false);setShowProviders(false);queueMicrotask(()=>composer?.focus());}} menu={<><NavShow/><button class="icon-btn only-nav" onClick={openNav} aria-label="Open sessions panel" aria-controls="nav" aria-expanded={navOpen()}><Icon name="menu"/></button></>}/></Show>
    </>}><Providers pending={pending().length} onClose={()=>{setShowProviders(false);void refreshAccess();queueMicrotask(()=>composer?.focus());}} onModelsChanged={async(signal,isCurrent)=>{await readModels("/models","GET",signal,isCurrent);}} menu={<><NavShow/><button class="icon-btn only-nav" onClick={openNav} aria-label="Open sessions panel" aria-controls="nav" aria-expanded={navOpen()}><Icon name="menu"/></button></>}/></Show>
    <div class="scrim" aria-hidden="true" onClick={()=>{if(detailsOpen())closeDetails();if(navOpen())closeNav();}}/>
  </div>;
}
for(const t of["pointerdown","mousedown"])document.addEventListener(t,()=>{document.documentElement.dataset.input="pointer";},true);
document.addEventListener("keydown",e=>{const t=e.target as HTMLElement;if((e.key==="Tab"||!t.closest?.("input,textarea,[contenteditable]"))&&/^(Tab|Arrow\w+|Enter| |Escape|Home|End|PageUp|PageDown)$/.test(e.key))document.documentElement.dataset.input="keyboard";},true);
render(()=><App/>,document.getElementById("root")!);
