import { createEffect, createMemo, createSignal, For, Show, onCleanup, type JSX } from "solid-js";
import { AGENT_ROLES, type AgentRole, type FolderStatus, type ProjectRoleOverride, type ProjectStatus, type ProjectView, type RoleCatalog, type RoleReasoning } from "../../../packages/contracts/index.js";
import { api } from "./api.js";
import { LABELS } from "./Roles.js";

type Model={provider:string;id:string;name:string;reasoningLevels?:string[];legacy?:boolean};
const ALL_LEVELS=["off","minimal","low","medium","high","xhigh","max"],GLOBAL="global";
const name=(path:string)=>path.split("/").filter(Boolean).pop()||path;
const dirty=(f:FolderStatus)=>!!(f.staged||f.unstaged||f.untracked||f.conflicts);
function summary(f:FolderStatus){
  if(f.state!=="git")return f.state==="folder"?"Ordinary folder · no Git":f.state==="missing"?"Folder unavailable":f.error??"Git status unavailable";
  const changed=(f.staged??0)+(f.unstaged??0);
  const parts=[changed?`${changed} changed`:"",f.untracked?`${f.untracked} untracked`:"",f.conflicts?`${f.conflicts} conflict${f.conflicts===1?"":"s"}`:""].filter(Boolean);
  return parts.length?parts.join(" · "):"Clean";
}
const has=(item:ProjectRoleOverride|undefined,key:"model"|"reasoning")=>!!item&&Object.prototype.hasOwnProperty.call(item,key);

export function Projects(p:{project:ProjectView|undefined;models:Model[];onSaved:(project:ProjectView)=>void;onFolder:(path:string)=>void;onCreateTask:(project:ProjectView,workspaceMode:"direct"|"worktree")=>void;taskBusy:boolean;model:string;onClose:()=>void;menu:JSX.Element;pending:number;editRequest:number}){
  const [draft,setDraft]=createSignal<{id:string;name:string;folders:string[];agents:ProjectRoleOverride[]}|null>(null);
  const [globalRoles,setGlobalRoles]=createSignal<RoleCatalog|null>(null);
  const [taskWorkspaceMode,setTaskWorkspaceMode]=createSignal<"direct"|"worktree">("direct");
  const [choosing,setChoosing]=createSignal(false);
  const [status,setStatus]=createSignal<ProjectStatus|null>(null),[loading,setLoading]=createSignal(false),[saving,setSaving]=createSignal(false),[error,setError]=createSignal("");
  const taskRoots=createMemo(()=>new Set(status()?.folders.filter(folder=>folder.state==="git"&&folder.oid&&folder.repository).map(folder=>folder.repository)).size);
  const taskEligible=createMemo(()=>{const folders=status()?.folders;if(!folders||folders.length<2||folders.length>4||!folders.every(folder=>folder.state==="git"&&folder.oid&&folder.repository)||taskRoots()!==folders.length)return false;const roots=folders.map(folder=>folder.repository!);return !roots.some((root,i)=>roots.some((other,j)=>i!==j&&root.startsWith(`${other}/`)));});
  const taskBlocker=()=>{const folders=status()?.folders??[];return folders.length>4?`Works with 2–4 folders; this project has ${folders.length}.`:!folders.every(folder=>folder.state==="git"&&folder.oid)?"Every folder must be a Git repository with at least one commit.":"Each folder must be its own repository, not a duplicate or nested one.";};
  let generation=0;
  async function refresh(project=p.project){
    const version=++generation;setStatus(null);setError("");
    if(!project){setLoading(false);return;}
    setLoading(true);
    try{const result=await api<ProjectStatus>(`/projects/${project.id}/status`);if(version===generation)setStatus(result);}
    catch{if(version===generation)setError("Cannot refresh Git status. Check the local service and try again.");}
    finally{if(version===generation)setLoading(false);}
  }
  let picker:AbortController|undefined;
  // editRequest is a fresh token when the sidebar asks to edit (or create) a project, 0 otherwise; each token opens the editor once.
  let handledEdit=0;
  createEffect(()=>{const project=p.project,request=p.editRequest;picker?.abort();setDraft(null);void refresh(project);if(request&&request!==handledEdit){handledEdit=request;edit(project);}});
  onCleanup(()=>{generation++;picker?.abort();});
  function edit(project?:ProjectView){
    setError("");setDraft({id:project?.id??crypto.randomUUID(),name:project?.name??"",folders:project?.folders??[],agents:structuredClone(project?.agents??[])});
    api<{catalog:RoleCatalog}>("/roles").then(({catalog})=>setGlobalRoles(catalog),()=>setGlobalRoles(null));
  }
  const modelLabel=(key:string|null)=>{if(!key)return "Same as chat model";const model=p.models.find(m=>`${m.provider}/${m.id}`===key);return model?`${model.provider} · ${model.name||model.id}`:`${key} · unavailable`;};
  const globalOf=(role:AgentRole)=>globalRoles()?.roles.find(item=>item.role===role);
  const overrideOf=(role:AgentRole)=>draft()?.agents.find(item=>item.role===role);
  const effectiveModel=(role:AgentRole)=>{const own=overrideOf(role);return has(own,"model")?own!.model??null:globalOf(role)?.model??null;};
  const levels=(role:AgentRole)=>{const key=effectiveModel(role);return (key&&p.models.find(m=>`${m.provider}/${m.id}`===key)?.reasoningLevels)||ALL_LEVELS;};
  /** Sets or clears ("global") one field of a role's project override; a row with no fields left is removed. */
  function changeAgent(role:AgentRole,field:"model"|"reasoning",value:string){
    setDraft(d=>{
      if(!d)return d;
      const next:ProjectRoleOverride={...(d.agents.find(item=>item.role===role)??{role})};
      if(value===GLOBAL)delete next[field];else if(field==="model")next.model=value||null;else next.reasoning=(value||null) as RoleReasoning|null;
      const agents=d.agents.filter(item=>item.role!==role);
      if(has(next,"model")||has(next,"reasoning"))agents.push(next);
      return {...d,agents};
    });
    const own=overrideOf(role);
    if(field==="model"&&own?.reasoning&&!levels(role).includes(own.reasoning))changeAgent(role,"reasoning",GLOBAL);
  }
  async function pick(){
    const id=draft()?.id;if(!id||choosing())return;
    setChoosing(true);setError("");const request=new AbortController();picker=request;
    try{
      const result=await api<{folders:string[]}>("/folders/choose","POST",undefined,undefined,request.signal);
      if(draft()?.id!==id)return;
      const folders=[...new Set<string>([...draft()!.folders,...result.folders])];
      if(folders.length>20)throw new Error("Choose up to 20 folders per project");
      setDraft(d=>d?{...d,folders}:d);
    }catch(e){if(!request.signal.aborted&&draft()?.id===id)setError(e instanceof Error?e.message:"Cannot open folder picker");}
    finally{setChoosing(false);}
  }
  async function save(){
    const value=draft();if(!value||saving())return;setSaving(true);setError("");
    try{
      const {project}=await api<{project:ProjectView}>(`/projects/${value.id}`,"PUT",{name:value.name,folders:value.folders,agents:value.agents});
      setDraft(null);p.onSaved(project);
    }catch(e){setError(e instanceof Error?e.message:"Cannot save project");}
    finally{setSaving(false);}
  }
  return <main class="main" aria-label="Projects">
    <header class="col-head main-head">
      {p.menu}
      <div class="head-title"><h1 id="projects-title" class="title truncate" tabindex="-1">{p.project?.name??"Projects"}</h1><span class="muted small">Folders and Git status</span></div>
      <button class="btn ghost sm" onClick={p.onClose}>Chat<Show when={p.pending}><span class="pip">{p.pending}</span></Show></button>
    </header>
    <Show when={p.pending}><div class="banner warning" role="status">A chat is waiting for {p.pending} tool approval(s).<button class="link-btn" onClick={p.onClose}>Review in chat</button></div></Show>
    <div class="scroller">
      <div class="project-content">
        <Show when={!draft()}><div class="project-actions">
          <button class="btn primary" onClick={()=>edit()} disabled={saving()||choosing()}>New project</button>
          <Show when={p.project}><button class="btn ghost" onClick={()=>edit(p.project)} disabled={saving()||choosing()}>Edit project</button><button class="btn ghost" onClick={()=>void refresh()} disabled={loading()||saving()} title="Reads local Git data; does not fetch, pull or push">{loading()?"Checking…":"Refresh Git"}</button>
            <Show when={status()}>{snapshot=><span class="muted small" role="status">Checked {new Date(snapshot().checkedAt).toLocaleTimeString()}</span>}</Show></Show>
        </div></Show>
        <Show when={error()}><div class="banner error" role="alert">{error()}</div></Show>
        <Show when={draft()}>{value=><form class="project-editor" onSubmit={e=>{e.preventDefault();void save();}}>
          <h2 class="panel-title">{p.project?.id===value().id?"Edit project":"New project"}</h2>
          <label class="field"><span class="field-label">Project name</span><input class="input" required maxlength="80" value={value().name} disabled={saving()} onInput={e=>setDraft(d=>d?{...d,name:e.currentTarget.value}:d)} placeholder="My product"/></label>
          <div class="field">
            <div class="field-row"><span class="field-label">Folders · {value().folders.length}/20</span><button class="btn ghost sm" type="button" disabled={saving()||choosing()||value().folders.length===20} onClick={()=>void pick()}>{choosing()?"Choosing…":"Choose folders…"}</button></div>
            <Show when={choosing()}><p class="field-help" role="status">Choose folders in the macOS window, then click Add folders.</p></Show>
            <Show when={value().folders.length} fallback={<p class="field-help">No folders selected yet.</p>}>
              <ul class="chosen-folders"><For each={value().folders}>{path=><li><span class="mono repo-path">{path}</span><button class="btn ghost sm" type="button" disabled={saving()||choosing()} aria-label={`Remove folder ${path}`} onClick={()=>setDraft(d=>d?{...d,folders:d.folders.filter(f=>f!==path)}:d)}>Remove</button></li>}</For></ul>
            </Show>
          </div>
          <p class="field-help">Up to 20 existing folders. Git repositories and ordinary directories can be grouped together. Editing this list only changes the group.</p>
          <fieldset class="field project-agents" aria-describedby="project-agents-help">
            <legend class="field-label">Agents in this project</legend>
            <p id="project-agents-help" class="field-help">New chats in this project use these models and reasoning levels. Global keeps the value from the Agents page, which also applies to chats outside projects.</p>
            <For each={AGENT_ROLES}>{role=><div class="role-row">
              <span class="role-name">{LABELS[role]}</span>
              <select class="input" id={`project-agent-${role}-model`} aria-label={`${LABELS[role]} model in this project`} value={has(overrideOf(role),"model")?overrideOf(role)!.model??"":GLOBAL} disabled={saving()} onChange={e=>changeAgent(role,"model",e.currentTarget.value)}>
                <option value={GLOBAL}>Global · {globalRoles()?modelLabel(globalOf(role)?.model??null):"Agents page"}</option>
                <option value="">Same as chat model</option>
                <Show when={overrideOf(role)?.model&&!p.models.some(m=>`${m.provider}/${m.id}`===overrideOf(role)!.model)}><option value={overrideOf(role)!.model!}>{overrideOf(role)!.model} · unavailable</option></Show>
                <For each={p.models.filter(m=>!m.legacy||`${m.provider}/${m.id}`===overrideOf(role)?.model)}>{m=><option value={`${m.provider}/${m.id}`}>{m.provider} · {m.name||m.id}</option>}</For>
              </select>
              <select class="input" id={`project-agent-${role}-reasoning`} aria-label={`${LABELS[role]} reasoning in this project`} value={has(overrideOf(role),"reasoning")?overrideOf(role)!.reasoning??"":GLOBAL} disabled={saving()} onChange={e=>changeAgent(role,"reasoning",e.currentTarget.value)}>
                <option value={GLOBAL}>Global · {globalRoles()?globalOf(role)?.reasoning??"Model default":"Agents page"}</option>
                <option value="">Model default</option>
                <Show when={overrideOf(role)?.reasoning&&!levels(role).includes(overrideOf(role)!.reasoning!)}><option value={overrideOf(role)!.reasoning!}>{overrideOf(role)!.reasoning} · unavailable</option></Show>
                <For each={levels(role).filter(level=>level!=="off"||levels(role).length>1)}>{level=><option value={level}>{level}</option>}</For>
              </select>
            </div>}</For>
          </fieldset>
          <div class="project-actions"><button class="btn primary" type="submit" disabled={saving()||choosing()||!value().folders.length}>{saving()?"Saving…":"Save project"}</button><button class="btn ghost" type="button" disabled={saving()} onClick={()=>{picker?.abort();setDraft(null);}}>Cancel</button></div>
        </form>}</Show>
        <Show when={!p.project&&!draft()}><div class="project-empty"><h2>Group the folders you work on</h2><p>Create a named project for your frontend, backend and any other folders. Each repository keeps its own Git state.</p><p class="muted">Use one folder for a session, or select a project with two Git repositories to start a multi-repository task.</p></div></Show>
        <Show when={p.project&&!draft()}>
          <Show when={p.project!.agents?.length}><p class="field-help">Agents: {AGENT_ROLES.filter(role=>p.project!.agents!.some(item=>item.role===role)).map(role=>LABELS[role]).join(", ")} use this project's settings; the rest follow the Agents page.</p></Show>
          <Show when={loading()&&!status()}><p role="status" class="muted">Reading repository status…</p></Show>
          <Show when={status()}>{snapshot=><ul class="repo-list"><For each={snapshot().folders}>{folder=><li class="project-folder">
            <span class="repo-name">{name(folder.path)}</span>
            <span class="mono repo-path truncate" title={folder.repository&&folder.repository!==folder.path?`${folder.path} · Git root ${folder.repository}`:folder.path}>{folder.path}</span>
            <Show when={folder.state==="git"} fallback={<span class={folder.state==="folder"?"muted small":"field-help warn"}>{summary(folder)}</span>}>
              <span class="tag mono">{folder.branch??(folder.oid?`detached ${folder.oid.slice(0,7)}`:"no commits")}</span>
              <span class={`badge ${dirty(folder)?"st-interrupted":"ap-approved"}`} title={folder.repository!==folder.path?`Covers the whole repository at ${folder.repository}`:undefined}>{summary(folder)}</span>
              <Show when={folder.upstream} fallback={<span class="muted small">No upstream</span>}>
                <Show when={folder.ahead!==null&&folder.behind!==null} fallback={<span class="muted small" title={`${folder.upstream} is not available locally`}>↑? ↓?</span>}>
                  <span classList={{"sync-count":true,hot:!!folder.ahead}} title={`Commits to push to ${folder.upstream} (locally known upstream)`}>↑{folder.ahead}</span><span classList={{"sync-count":true,hot:!!folder.behind}} title={`Commits to pull from ${folder.upstream} (locally known upstream)`}>↓{folder.behind}</span>
                  <Show when={folder.ahead!>0&&folder.behind!>0}><span class="badge st-interrupted">Diverged</span></Show>
                </Show>
              </Show>
            </Show>
            <button class="btn ghost sm" disabled={folder.state==="missing"} onClick={()=>p.onFolder(folder.path)} aria-label={`Use folder ${folder.path} for a new chat`}>Use for chat</button>
          </li>}</For></ul>}</Show>
          <Show when={taskRoots()>=2}><section class="repo-card" aria-labelledby="project-task-title">
            <h2 id="project-task-title" class="repo-name">Multi-repository task</h2>
            <Show when={taskEligible()} fallback={<p class="field-help warn">{taskBlocker()}</p>}>
              <p class="field-help">One task across all {taskRoots()} repositories: a coordinator hands each repository to its own session.</p>
              <div class="project-actions">
                <label class="sr-only" for="project-task-workspace">Repository workspace</label>
                <select id="project-task-workspace" class="input task-workspace" value={taskWorkspaceMode()} disabled={p.taskBusy} onChange={e=>setTaskWorkspaceMode(e.currentTarget.value as "direct"|"worktree")}><option value="direct">Edit the folders directly</option><option value="worktree">Separate Git worktrees</option></select>
                <button class="btn primary" onClick={()=>p.onCreateTask(p.project!,taskWorkspaceMode())} disabled={!p.model||p.taskBusy||loading()||saving()}>{p.taskBusy?"Creating task…":"New multi-repository task"}</button>
              </div>
              <p class="field-help">{!p.model?"Choose a model under New session first.":taskWorkspaceMode()==="direct"?"Approved edits land in these folders; diffs may include changes that were already there.":"Each repository works in its own worktree; applying results back needs a separate approval."}</p>
            </Show>
          </section></Show>
        </Show>
      </div>
    </div>
  </main>;
}
