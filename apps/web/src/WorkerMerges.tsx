import { createEffect, createSignal, For, Show, onCleanup } from "solid-js";
import type { AgentView, ChangesView, WorkerMergeView } from "../../../packages/contracts/index.js";
import { api } from "./api.js";

const short=(id:string)=>id.slice(0,12);
const message=(error:unknown)=>error instanceof Error?error.message:String(error);

export function WorkerMerges(p:{id:string;workers:AgentView[];revision:string;offline:boolean;rootSettled:boolean;rootKind:"direct"|"worktree"|"clone";onPending:(count:number)=>void}){
  const [changes,setChanges]=createSignal<Record<string,ChangesView>>({});
  const [changeErrors,setChangeErrors]=createSignal<Record<string,string>>({});
  const [merges,setMerges]=createSignal<WorkerMergeView[]>([]);
  const [error,setError]=createSignal(""),[loading,setLoading]=createSignal(false),[busy,setBusy]=createSignal(false);
  let generation=0;

  async function refresh(){
    const id=p.id,workers=p.workers,version=++generation;setLoading(true);setError("");
    const [mergeResult,...workerResults]=await Promise.allSettled([
      api<{merges:WorkerMergeView[]}>(`/sessions/${id}/worker-merges`),
      ...workers.map(worker=>api<ChangesView>(`/sessions/${worker.id}/changes`)),
    ]);
    if(version!==generation)return;
    if(mergeResult.status==="fulfilled"){
      setMerges([...mergeResult.value.merges].sort((a,b)=>b.createdAt-a.createdAt));
      p.onPending(mergeResult.value.merges.filter(merge=>merge.status==="pending").length);
    }else{setMerges([]);setError(message(mergeResult.reason));p.onPending(0);}
    const next:Record<string,ChangesView>={},errors:Record<string,string>={};
    workerResults.forEach((result,index)=>{
      const worker=workers[index];
      if(result.status==="fulfilled")next[worker.id]=result.value;
      else errors[worker.id]=message(result.reason);
    });
    setChanges(next);setChangeErrors(errors);setLoading(false);
  }

  async function action(run:()=>Promise<unknown>){
    setBusy(true);let failure="";
    try{await run();}catch(error){failure=message(error);}
    await refresh();if(failure)setError(failure);setBusy(false);
  }
  function prepare(worker:AgentView){
    const key=`pi-worker-merge-${p.id}-${worker.id}`;
    const id=sessionStorage.getItem(key)||crypto.randomUUID();
    sessionStorage.setItem(key,id);
    void action(async()=>{
      const result=await api<WorkerMergeView>(`/sessions/${p.id}/worker-merges`,"POST",{workerId:worker.id},id);
      if(result.status==="unknown")throw new Error("Merge preparation outcome is unknown. Inspect the worker and merge state before another attempt.");
      sessionStorage.removeItem(key);
    });
  }
  function decide(merge:WorkerMergeView,allow:boolean){
    void action(()=>api(`/sessions/${p.id}/worker-merges/${merge.id}/decision`,"POST",{allow}));
  }
  function reconcile(merge:WorkerMergeView){
    void action(()=>api(`/sessions/${p.id}/worker-merges/${merge.id}/reconcile`,"POST",{acknowledge:true}));
  }
  const workerMerges=(workerId:string)=>merges().filter(merge=>merge.workerId===workerId);
  const rootLabel=()=>p.rootKind==="direct"?"selected folder":p.rootKind==="worktree"?"root worktree":"root copy";
  createEffect(()=>{p.id;p.revision;p.rootSettled;p.workers.map(worker=>`${worker.id}:${worker.status}`);void refresh();});
  onCleanup(()=>{generation++;p.onPending(0);});

  return <section class="panel" tabindex="-1" aria-labelledby="h-worker-merges">
    <div class="field-row"><h3 id="h-worker-merges" class="panel-title">Worker changes and merges</h3><button class="btn ghost sm" disabled={loading()} onClick={()=>void refresh()}>{loading()?"Checking…":"Refresh"}</button></div>
    <p class="hint">A lone worker edits the {rootLabel()} directly and needs no merge. Workers that ran in parallel edited a separate {p.rootKind==="clone"?"Git workspace":"Git worktree"}: under Full access they are merged automatically, otherwise (or after a conflict) prepare a merge here to inspect its exact patch and conflicts and approve it.</p>
    <Show when={error()}><p class="field-help warn" role="alert">{error()}</p></Show>
    <Show when={!p.workers.length}><p class="hint">No workers yet. Ask the root agent to delegate bounded code tasks.</p></Show>
    <For each={p.workers}>{worker=>{
      const snapshot=()=>changes()[worker.id];
      const canPrepare=()=>p.rootSettled&&worker.status==="settled"&&!!snapshot()?.files.length&&!snapshot()?.omitted&&!workerMerges(worker.id).some(merge=>["pending","running","partial","unknown"].includes(merge.status)||merge.status==="applied"&&merge.workerRevision===snapshot()?.revision);
      return <div class="panel worker-merge-card">
        <div class="field-row"><strong>Worker {short(worker.id)}</strong><span class="tag">{worker.status}</span></div>
        <p class="hint mono dd-wrap" title={worker.cwd}>{worker.cwd}</p>
        <Show when={changeErrors()[worker.id]}><p class="field-help warn" role="alert">{changeErrors()[worker.id]}</p></Show>
        <Show when={snapshot()}>{change=><>
          <p class="hint">{change().files.length} changed file(s) · revision <span class="mono">{short(change().revision)}</span><Show when={change().omitted}> · {change().omitted} omitted file(s)</Show></p>
          <Show when={change().diff}><details><summary class="worker-diff-summary">View worker diff</summary><pre class="change-diff" tabindex="0" aria-label={`Worker ${short(worker.id)} changes`}>{change().diff}</pre></details></Show>
        </>}</Show>
        <button class="btn ghost sm" disabled={p.offline||busy()||loading()||!canPrepare()} onClick={()=>prepare(worker)}>Prepare merge</button>
        <Show when={!p.rootSettled||worker.status!=="settled"}><p class="hint">Wait for the root and worker to settle before preparing a merge.</p></Show>
        <For each={workerMerges(worker.id)}>{item=><div class="worker-merge-proposal">
          <div class="field-row"><strong>Merge {short(item.id)}</strong><span class={`badge ${item.status==="applied"?"ap-approved":item.status==="pending"?"ap-pending":"st-unknown"}`}><span class="glyph" aria-hidden="true"/>{item.status}</span></div>
          <p class="hint">Root revision <span class="mono">{short(item.rootRevision)}</span> · worker revision <span class="mono">{short(item.workerRevision)}</span> · {item.status==="pending"?item.current?"current":"stale":"saved preview"}</p>
          <For each={item.files}>{file=><div class="worker-merge-file">
            <div class="field-row"><span class="mono dd-wrap">{file.path}</span><span class="tag">{file.status}</span></div>
            <Show when={file.observedHash}><p class="hint">Root now: <span class="mono">{file.observedHash}</span> · {file.observation}</p></Show>
            <Show when={file.error}><p class="field-help warn" role="status">{file.error}</p></Show>
            <Show when={file.preview}><details open={file.status==="conflict"}><summary class="worker-diff-summary">{file.status==="conflict"?"Inspect conflict":"View file preview"}</summary><pre class="change-diff" tabindex="0">{file.preview}</pre></details></Show>
          </div>}</For>
          <Show when={item.diff}><pre class="change-diff" tabindex="0" aria-label={`Prepared merge ${short(item.id)} diff`}>{item.diff}</pre></Show>
          <Show when={item.error}><p class="field-help warn" role="status">{item.error}</p></Show>
          <Show when={item.status==="conflict"}><p class="field-help warn">Resolve conflicts in the worker or {rootLabel()}, then refresh and prepare a new merge.</p></Show>
          <Show when={item.status==="partial"||item.status==="unknown"}><p class="field-help warn">Outcome uncertain. Compare each root hash above with the approved preview and inspect the {rootLabel()}. Acknowledgement records the observed state without retrying writes; fresh checks and review are required{p.rootKind==="direct"?"":" before Source Apply"}.</p><button class="btn ghost sm" disabled={p.offline||busy()||loading()} onClick={()=>reconcile(item)}>Acknowledge observed root state</button></Show>
          <Show when={item.status==="reconciled"}><p class="hint">Observed root hashes recorded. Review the root diff and run fresh checks{p.rootKind==="direct"?"":" before Source Apply"}.</p></Show>
          <Show when={item.status==="pending"}><div class="worker-merge-actions"><button class="btn danger-ghost sm" disabled={p.offline||busy()} onClick={()=>decide(item,false)}>Deny merge</button><button class="btn primary sm" disabled={p.offline||busy()||loading()||!p.rootSettled||!item.current} onClick={()=>decide(item,true)}>Apply to {rootLabel()}</button></div></Show>
        </div>}</For>
      </div>;
    }}</For>
  </section>;
}
