import { createEffect, createSignal, For, Show, onCleanup } from "solid-js";
import type { FolderStatus, SessionRepositoryView } from "../../../packages/contracts/index.js";
import { api } from "./api.js";

const name=(path:string)=>path.split("/").filter(Boolean).pop()||path;
const changed=(f:FolderStatus)=>(f.staged??0)+(f.unstaged??0);
const dirty=(f:FolderStatus)=>!!(changed(f)||f.untracked||f.conflicts);
function summary(f:FolderStatus){
  if(f.state!=="git")return f.state==="folder"?"Not a Git repository":f.state==="missing"?"Folder unavailable":f.error??"Git status unavailable";
  const parts=[changed(f)?`${changed(f)} changed`:"",f.untracked?`${f.untracked} untracked`:"",f.conflicts?`${f.conflicts} conflict${f.conflicts===1?"":"s"}`:""].filter(Boolean);
  return parts.length?parts.join(" · "):"Clean";
}

export function Repository(p:{id:string;revision:string;kind:"direct"|"worktree"|"clone"|null;running:boolean;offline:boolean;onCommit:()=>void;active:boolean}){
  const [value,setValue]=createSignal<SessionRepositoryView|null>(null),[error,setError]=createSignal(""),[loading,setLoading]=createSignal(false);
  const [recoveries,setRecoveries]=createSignal<Array<{id:string;kind:string;head:string|null;tree:string|null;expectedHead:string|null;expectedTree:string|null;state:string;reason?:string;digest:string;canReconcile:boolean}>>([]);
  const [busy,setBusy]=createSignal<string|null>(null),[result,setResult]=createSignal("");
  let generation=0;
  async function refresh(){
    const version=++generation;setLoading(true);setError("");
    // Git recovery is refused where Git actions are unavailable (the reason comes with the status), so its failure must not hide the folder status.
    try{const sessionId=p.id;const [data,recovery]=await Promise.all([api<SessionRepositoryView>(`/sessions/${sessionId}/repository`),api<ReturnType<typeof recoveries>>(`/sessions/${sessionId}/git-recovery`).catch(()=>[])]);if(version===generation&&p.id===sessionId){setValue(data);setRecoveries(recovery);}}
    catch(e){if(version===generation){setValue(null);setError(e instanceof Error?e.message:"Cannot read Git status");}}
    finally{if(version===generation)setLoading(false);}
  }
  let seen=p.id;createEffect(()=>{const id=p.id;p.revision;if(p.active){seen=id;setResult("");void refresh();}else{generation++;setLoading(false);if(id!==seen){seen=id;setValue(null);setRecoveries([]);setError("");setResult("");}}});onCleanup(()=>{generation++;});
  async function act(action:"switch"|"pull"|"push",body:object={}){
    setBusy(action);setError("");setResult("");
    try{const data=await api<{output:string}>(`/sessions/${p.id}/git/${action}`,"POST",body,crypto.randomUUID());setResult(action==="switch"?"Branch switched.":data.output?data.output.split("\n").slice(-2).join(" "):action==="pull"?"Already up to date.":"Pushed.");}
    catch(e){setError(e instanceof Error?e.message:"Git action failed");}
    finally{setBusy(null);void refresh();}
  }
  async function reconcile(item:ReturnType<typeof recoveries>[number]){setBusy(item.id);setError("");try{await api(`/sessions/${p.id}/git-reconcile`,"POST",{commandId:item.id,acknowledge:true,digest:item.digest});setResult("Observed Git state acknowledged; no action was replayed.");}catch(e){setError(e instanceof Error?e.message:"Git reconciliation failed");}finally{setBusy(null);void refresh();}}
  const git=()=>value()?.git;
  const source=()=>value()?.source;
  const locked=()=>recoveries().length>0||!!busy()||p.offline||!git()?.enabled||source()?.state!=="git";
  function switchTo(select:HTMLSelectElement){
    const branch=select.value,current=source()?.branch??"";
    if(branch===current)return;
    if(!confirm(`Switch ${name(source()!.path)} to branch “${branch}”? Uncommitted changes are carried over when Git allows it.`)){select.value=current;return;}
    void act("switch",{branch});
  }
  function push(){
    const f=source()!;
    if(confirm(`Push ${f.branch} to ${f.upstream??"origin"}? This publishes your commits to the remote.`))void act("push");
  }
  return <section class="panel repo-panel" aria-labelledby="h-repository">
    <div class="repo-bar">
      <h3 id="h-repository" class="panel-title truncate">{source()?name(source()!.path):"Repository"}</h3>
      <Show when={source()?.state==="git"}><span class={`badge ${dirty(source()!)?"st-interrupted":"ap-approved"}`}><span class="glyph" aria-hidden="true"/>{summary(source()!)}</span></Show>
      <button class="icon-btn sm" disabled={loading()} onClick={()=>void refresh()} aria-label="Refresh Git status" title="Refresh Git status"><svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M16 10a6 6 0 1 1-2-4.5M16 3v4h-4"/></svg></button>
    </div>
    <Show when={source()}>{f=><>
      <Show when={f().state==="git"} fallback={<p class="hint">{summary(f())}</p>}>
        <div class="repo-row">
          <Show when={git()?.enabled&&f().branch&&git()!.branches.length>1} fallback={<span class="tag mono branch-tag">{f().branch??"detached HEAD"}</span>}>
            <label class="sr-only" for="branch-select">Branch</label>
            <select id="branch-select" class="input sm mono branch-select" disabled={locked()||p.running} onChange={e=>switchTo(e.currentTarget)}>
              <For each={git()!.branches}>{b=><option value={b} selected={b===f().branch}>{b}</option>}</For>
            </select>
          </Show>
          <span class="mono muted small" title={f().oid??undefined}>{f().oid?.slice(0,7)??"no commits"}</span>
        </div>
        <p class="repo-sync small">
          <Show when={f().upstream} fallback={<span class="muted">No upstream</span>}>
            <span class="mono muted truncate">{f().upstream}</span>
            <Show when={f().ahead!==null&&f().behind!==null}><span classList={{"sync-count":true,hot:!!f().ahead}} title="Commits to push">↑{f().ahead}</span><span classList={{"sync-count":true,hot:!!f().behind}} title="Commits to pull">↓{f().behind}</span></Show>
          </Show>
        </p>
        <div class="repo-actions">
          <button class="btn ghost sm" disabled={locked()||p.running||!f().upstream} onClick={()=>void act("pull")}>{busy()==="pull"?"Pulling…":"Pull"}</button>
          <button class="btn ghost sm" disabled={locked()||!f().branch} onClick={push}>{busy()==="push"?"Pushing…":"Push"}</button>
          <button class="btn accent sm" disabled={locked()||p.running||!git()?.commit||!dirty(f())} onClick={()=>p.onCommit()} title={git()?.commit?"Ask the agent to write a commit message; you approve it before the commit runs":"Commit is available in sessions that edit the selected folder directly"}>Commit</button>
        </div>
      </Show>
    </>}</Show>
    <Show when={git()&&!git()!.enabled}><p class="hint">{git()!.reason}</p></Show>
    <Show when={git()?.enabled&&!git()!.commit}><p class="hint">Commit needs a session that edits the selected folder directly; branch, pull and push work here.</p></Show>
    <For each={value()?.workspace?[value()!.workspace!]:[]}>{w=><p class="hint">{p.kind==="worktree"?"Worktree":"Isolated copy"} · <span class="mono">{w.branch??w.oid?.slice(0,7)??"detached"}</span> · {summary(w)}</p>}</For>
    <For each={recoveries()}>{item=><article class="callout error-callout"><strong>Unknown Git {item.kind}</strong><p>No Git action was replayed. Inspect the observed state before acknowledgement.</p><dl class="setup-identity"><dt>Command</dt><dd class="mono">{item.id}</dd><dt>Observed HEAD</dt><dd class="mono">{item.head??"unavailable"}</dd><dt>Expected HEAD</dt><dd class="mono">{item.expectedHead??"unavailable"}</dd><dt>Observed tree</dt><dd class="mono">{item.tree??"unavailable"}</dd><dt>Expected tree</dt><dd class="mono">{item.expectedTree??"unavailable"}</dd></dl><p>{item.reason??item.state}</p><button class="btn ghost sm" disabled={!!busy()||p.offline} onClick={()=>void refresh()}>Inspect fresh Git state</button><button class="btn accent sm" disabled={!item.canReconcile||!!busy()||p.offline} onClick={()=>void reconcile(item)}>Acknowledge observed state</button></article>}</For>
    <Show when={result()}><p class="hint repo-result" role="status">{result()}</p></Show>
    <Show when={error()}><p class="field-help warn" role="alert">{error()}</p></Show>
  </section>;
}
