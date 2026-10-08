import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { QaActionView, QaGateView, QaRunView, QaView } from "../../../packages/contracts/index.js";
import { api } from "./api.js";

const live=(run:QaRunView)=>run.status==="starting"||run.status==="running";
export function Qa(p:{id:string;revision:string;askMode?:boolean}){
  const [view,setView]=createSignal<QaView|null>(null),[gate,setGate]=createSignal<QaGateView|null>(null),[error,setError]=createSignal(""),[busy,setBusy]=createSignal(false),[entry,setEntry]=createSignal("index.html");let generation=0;
  async function refresh(){
    const id=p.id,version=++generation;
    try{const [next,state]=await Promise.all([api<QaView>(`/sessions/${id}/qa`),api<QaGateView>(`/sessions/${id}/qa/gate`).catch(()=>null)]);if(version===generation){setView(next);setGate(state);setError("");}}
    catch(e){if(version===generation){setView(null);setError(e instanceof Error?e.message:"Cannot load QA runs");}}
  }
  async function action(run:()=>Promise<unknown>){setBusy(true);setError("");try{await run();await refresh();}catch(e){setError(e instanceof Error?e.message:"QA action failed");}finally{setBusy(false);}}
  const start=()=>void action(()=>api(`/sessions/${p.id}/qa/runs`,"POST",{entry:entry().trim()},crypto.randomUUID()));
  const cancel=(run:QaRunView)=>void action(()=>api(`/sessions/${p.id}/qa/runs/${run.id}/cancel`,"POST",{}));
  createEffect(()=>{p.id;p.revision;void refresh();});onCleanup(()=>{generation++;});
  const actionsOf=(run:QaRunView):QaActionView[]=>view()?.actions.filter(a=>a.runId===run.id)??[];
  const shots=(run:QaRunView)=>view()?.artifacts.filter(a=>a.runId===run.id)??[];
  return <section class="panel" aria-labelledby="h-qa">
    <h3 id="h-qa" class="panel-title">Browser QA</h3>
    <p class="hint">Starting a run approves this exact Code revision for QA: its files are copied into a read-only static preview opened in an isolated browser that can reach nothing else. {p.askMode?"A QA agent still needs your approval for every navigation, click and typed entry.":"With Full access the QA agent navigates, clicks and types without asking; set Agent access to ask in Providers to approve each step."}</p>
    <label class="field"><span class="field-label">Static site entry file</span><input class="input mono" value={entry()} onInput={e=>setEntry(e.currentTarget.value)} placeholder="index.html"/></label>
    <button class="btn ghost sm" disabled={busy()||!entry().trim()||!!view()?.runs.some(live)} onClick={start}>Start QA run</button>
    <Show when={error()}><p class="field-help warn" role="alert">{error()}</p></Show>
    <Show when={gate()&&gate()!.state!=="none"||gate()?.steps.some(step=>step.status!=="pending")}><div class="panel" aria-label="QA gate timeline">
      <div class="field-row"><strong>QA gate</strong><span class="muted small">{gate()!.state==="none"?"not started":gate()!.state}</span></div>
      <Show when={gate()!.blocked}><p class="field-help warn" role="status">Blocked: {gate()!.blocked}. Nothing is replayed; resolve it explicitly.</p></Show>
      <ol class="log"><For each={gate()!.steps}>{step=><li><span class="badge"><span class="glyph" aria-hidden="true"/>{step.status}</span><span class="mono truncate" title={step.detail}>{step.step}</span><span class="muted small">{step.detail}</span></li>}</For></ol>
    </div></Show>
    <For each={view()?.runs??[]}>{run=><div class="panel">
      <div class="field-row"><strong>QA run {run.id.slice(0,8)}</strong><span class="muted small">{run.status}{live(run)?run.current?" · current revision":" · stale revision":""}</span></div>
      <p class="hint mono small">Revision {run.revision.slice(0,12)} · manifest {run.manifestHash.slice(0,12)} · {run.manifest.length} files · entry {run.entry} · {run.viewport.width}×{run.viewport.height} · outer sandbox</p>
      <Show when={run.error}><p class="field-help warn">{run.error}</p></Show>
      <Show when={run.status==="unknown"}><p class="field-help warn">An action or the server stopped with an unknown outcome. This run is blocked and nothing is replayed; start a new run.</p></Show>
      <Show when={live(run)}><button class="btn danger-ghost sm" disabled={busy()} onClick={()=>cancel(run)}>Cancel run</button></Show>
      <Show when={actionsOf(run).length}><ul class="log"><For each={actionsOf(run)}>{a=><li><span class="badge"><span class="glyph" aria-hidden="true"/>{a.status}</span><span class="mono truncate" title={`${a.kind} ${a.target}`}>{a.kind} {a.target}{a.text!==undefined?` ← ${JSON.stringify(a.text.slice(0,60))}`:""}</span><span class="muted small nowrap">{a.outcome??a.detail.slice(0,60)}</span></li>}</For></ul></Show>
      <Show when={shots(run).length}><div class="field-row"><For each={shots(run)}>{shot=><a href={`/api/sessions/${p.id}/qa/artifacts/${shot.id}`} target="_blank" rel="noopener"><img src={`/api/sessions/${p.id}/qa/artifacts/${shot.id}`} alt={`Screenshot ${shot.width}×${shot.height} at revision ${shot.revision.slice(0,12)}`} width="160" loading="lazy" style="border:1px solid var(--border,#8884);border-radius:4px"/></a>}</For></div></Show>
    </div>}</For>
  </section>;
}
