import { createEffect, createMemo, createSignal, For, Show, onCleanup, type JSX } from "solid-js";
import type { ProjectStatus, ProjectView } from "../../../packages/contracts/index.js";
import { api } from "./api.js";

export function Projects(p:{project:ProjectView|undefined;onSaved:(project:ProjectView)=>void;onFolder:(path:string)=>void;onCreateTask:(project:ProjectView,workspaceMode:"direct"|"worktree")=>void;taskBusy:boolean;model:string;onClose:()=>void;menu:JSX.Element;pending:number;editRequest:number}){
  const [draft,setDraft]=createSignal<{id:string;name:string;folders:string[]}|null>(null);
  const [taskWorkspaceMode,setTaskWorkspaceMode]=createSignal<"direct"|"worktree">("direct");
  const [choosing,setChoosing]=createSignal(false);
  const [status,setStatus]=createSignal<ProjectStatus|null>(null),[loading,setLoading]=createSignal(false),[saving,setSaving]=createSignal(false),[error,setError]=createSignal("");
  const taskRoots=createMemo(()=>new Set(status()?.folders.filter(folder=>folder.state==="git"&&folder.oid&&folder.repository).map(folder=>folder.repository)).size);
  const taskEligible=createMemo(()=>{const folders=status()?.folders;if(!folders||folders.length<2||folders.length>4||!folders.every(folder=>folder.state==="git"&&folder.oid&&folder.repository)||taskRoots()!==folders.length)return false;const roots=folders.map(folder=>folder.repository!);return !roots.some((root,i)=>roots.some((other,j)=>i!==j&&root.startsWith(`${other}/`)));});
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
  function edit(project?:ProjectView){setError("");setDraft({id:project?.id??crypto.randomUUID(),name:project?.name??"",folders:project?.folders??[]});}
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
      const {project}=await api<{project:ProjectView}>(`/projects/${value.id}`,"PUT",{name:value.name,folders:value.folders});
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
        <div class="project-actions">
          <button class="btn primary" onClick={()=>edit()} disabled={saving()||choosing()}>New project</button>
          <Show when={p.project}><button class="btn ghost" onClick={()=>edit(p.project)} disabled={saving()||choosing()}>Edit project</button><button class="btn ghost" onClick={()=>void refresh()} disabled={loading()||saving()}>{loading()?"Checking…":"Refresh Git"}</button><button class="btn primary" onClick={()=>p.onCreateTask(p.project!,taskWorkspaceMode())} disabled={!taskEligible()||!p.model||p.taskBusy||loading()||saving()}>{p.taskBusy?"Creating task…":"New multi-repository task"}</button></Show>
        </div>
        <Show when={p.project}><label class="field"><span class="field-label">Repository workspace for new task</span><select class="input" value={taskWorkspaceMode()} disabled={p.taskBusy} onChange={e=>setTaskWorkspaceMode(e.currentTarget.value as "direct"|"worktree")}><option value="direct">Selected folders · default</option><option value="worktree">Separate Git worktrees</option></select></label><p class="field-help">{taskWorkspaceMode()==="direct"?"Approved edits change the selected folders immediately; current diffs may include pre-existing changes.":"Each repository gets a worktree at its current commit. Existing uncommitted changes stay in the source folders; applying results there requires a separate approval."}</p></Show>
        <Show when={p.project}><p class="field-help">A multi-repository task captures all folders in this project. Choose 2–4 distinct Git repositories with commits; ordinary folders, duplicates, nested repositories and projects with 5+ folders are not eligible. Currently {taskRoots()} distinct committed Git root{taskRoots()===1?"":"s"} ready. Model: {p.model||"choose one under New session"}.</p></Show>
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
          <div class="project-actions"><button class="btn primary" type="submit" disabled={saving()||choosing()||!value().folders.length}>{saving()?"Saving…":"Save project"}</button><button class="btn ghost" type="button" disabled={saving()} onClick={()=>{picker?.abort();setDraft(null);}}>Cancel</button></div>
        </form>}</Show>
        <Show when={!p.project&&!draft()}><div class="project-empty"><h2>Group the folders you work on</h2><p>Create a named project for your frontend, backend and any other folders. Each repository keeps its own Git state.</p><p class="muted">Use one folder for a session, or select a project with two Git repositories to start a multi-repository task.</p></div></Show>
        <Show when={p.project}>
          <p class="field-help">Ahead (push) and behind (pull) use the locally known upstream. Refresh reads local Git data; it does not fetch, pull or push. A separately configured push target may differ.</p>
          <Show when={loading()}><p role="status" class="muted">Reading repository status…</p></Show>
          <Show when={status()}>{snapshot=><>
            <p class="muted small" role="status">Checked {new Date(snapshot().checkedAt).toLocaleTimeString()} · {snapshot().folders.length} folders</p>
            <ul class="repo-list"><For each={snapshot().folders}>{folder=><li class="repo-card">
              <div class="repo-heading"><h2 class="repo-name">{folder.path.split("/").filter(Boolean).pop()||folder.path}</h2><button class="btn ghost sm" disabled={folder.state==="missing"} onClick={()=>p.onFolder(folder.path)} aria-label={`Use folder ${folder.path} for a new chat`}>Use for chat</button></div>
              <p class="mono repo-path">{folder.path}</p>
              <Show when={folder.state==="git"}>
                <div class="project-actions"><span class="tag mono">{folder.branch??`Detached HEAD · ${folder.oid?.slice(0,8)??"unknown"}`}</span><Show when={!folder.oid}><span class="tag">No commits yet</span></Show>
                  <span class={`badge ${(folder.staged||folder.unstaged||folder.untracked||folder.conflicts)?"st-interrupted":"ap-approved"}`}>{(folder.staged||folder.unstaged||folder.untracked||folder.conflicts)?"Uncommitted changes":"Clean"}</span>
                </div>
                <Show when={folder.repository!==folder.path}><p class="field-help repo-path">Git root: {folder.repository} · status covers the whole repository</p></Show>
                <dl class="git-counts"><div><dt>Staged</dt><dd>{folder.staged}</dd></div><div><dt>Unstaged</dt><dd>{folder.unstaged}</dd></div><div><dt title="Files or directories not tracked by Git">Untracked entries</dt><dd>{folder.untracked}</dd></div><div><dt>Conflicts</dt><dd>{folder.conflicts}</dd></div></dl>
                <Show when={folder.upstream} fallback={<p class="field-help">No upstream configured · pull/push counts unavailable</p>}>
                  <p class="field-help repo-path">Upstream: <span class="mono">{folder.upstream}</span></p>
                  <Show when={folder.ahead!==null&&folder.behind!==null} fallback={<p class="field-help warn">Upstream commit unavailable locally · pull/push counts unknown</p>}>
                    <div class="project-actions"><span class="tag">↑ Ahead (push): {folder.ahead}</span><span class="tag">↓ Behind (pull): {folder.behind}</span><Show when={folder.ahead!>0&&folder.behind!>0}><span class="badge st-interrupted">Diverged</span></Show></div>
                  </Show>
                </Show>
              </Show>
              <Show when={folder.state==="folder"}><p class="muted">Ordinary folder · no Git working tree</p></Show>
              <Show when={folder.state==="missing"}><p class="field-help warn">Folder unavailable or no longer a directory</p></Show>
              <Show when={folder.state==="error"}><p class="field-help warn">{folder.error}</p></Show>
            </li>}</For></ul>
          </>}</Show>
        </Show>
      </div>
    </div>
  </main>;
}
