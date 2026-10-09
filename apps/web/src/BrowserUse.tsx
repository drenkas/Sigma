import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { BrowserUseView } from "../../../packages/contracts/index.js";
import { api } from "./api.js";

export function BrowserUsePanel(p:{id:string;revision:number}){
  const [view,setView]=createSignal<BrowserUseView|null>(null),[error,setError]=createSignal(""),[busy,setBusy]=createSignal(false),[target,setTarget]=createSignal(""),[address,setAddress]=createSignal("");let generation=0,actionGeneration=0,timer:ReturnType<typeof setInterval>|undefined;
  async function refresh(preserveError=false){const id=p.id,version=++generation;try{const next=await api<BrowserUseView>(`/sessions/${id}/browser-use`);if(id===p.id&&version===generation){setView(next);if(!next.targets.some(item=>item.id===target()))setTarget(next.targets[0]?.id??"");if(!preserveError)setError("");}}catch(e){if(id===p.id&&version===generation){setError(e instanceof Error?e.message:"Chrome status is unavailable");setView(null);}}}
  async function action(run:(id:string)=>Promise<BrowserUseView>){const id=p.id,version=++generation,actionVersion=++actionGeneration;setBusy(true);setError("");try{const next=await run(id);if(id===p.id&&version===generation){setView(next);if(!next.targets.some(item=>item.id===target()))setTarget(next.targets[0]?.id??"");}}catch(e){if(id===p.id&&version===generation){const message=e instanceof Error?e.message:"Chrome action failed";await refresh(true);if(id===p.id)setError(message);}}finally{if(id===p.id&&actionVersion===actionGeneration)setBusy(false);}}
  const connect=()=>void action(id=>api(`/sessions/${id}/browser-use/connect`,"POST",address().trim()?{address:address().trim()}:{}));
  const refreshTabs=()=>void action(id=>api(`/sessions/${id}/browser-use/refresh`,"POST",{}));
  const select=()=>void action(id=>api(`/sessions/${id}/browser-use/select`,"POST",{targetId:target()}));
  const disconnect=()=>void action(id=>api(`/sessions/${id}/browser-use/disconnect`,"POST",{}));
  let activeSession=p.id;
  createEffect(()=>{const id=p.id;p.revision;if(id!==activeSession){activeSession=id;generation++;actionGeneration++;setBusy(false);setError("");setView(null);setTarget("");setAddress("");}void refresh();});
  createEffect(()=>{const active=view()?.status==="connected"||view()?.status==="selected";if(timer){clearInterval(timer);timer=undefined;}if(active)timer=setInterval(()=>void refresh(),2000);});
  onCleanup(()=>{generation++;if(timer)clearInterval(timer);});
  return <section class="panel" aria-labelledby="h-browser-use">
    <h3 id="h-browser-use" class="panel-title">Browser control</h3>
    <p class="hint">Current Chrome: use Chrome 144+, open <span class="mono">chrome://inspect/#remote-debugging</span>, enable remote debugging, then connect and allow Chrome’s browser-wide prompt. Sigma controls only the tab you select. If needed, enter the loopback address shown there.</p>
    <p class="hint">Internal Chrome: enter <span class="mono">/browser internal</span> for a separate visible browser with a fresh profile; sign in manually. Enter <span class="mono">/browser chrome</span> to return. Nothing is copied between profiles. Disconnect leaves your Chrome and its tabs open.</p>
    <p class="hint">Browser actions follow Sigma’s access mode: Ask prompts before dispatch. Use an image-capable Pi model. Screenshots may contain page data and remain in Sigma artifacts and Pi history. Type non-secret text only.</p>
    <Show when={view()?.status==="unknown"}><p class="field-help warn" role="status">A dispatched browser action has an unknown outcome. Nothing was replayed. Inspect the Chrome tab before connecting again.</p></Show>
    <div class="field-row wrap">
      <Show when={(view()?.status==="disconnected"||view()?.status==="unknown")&&view()?.mode!=="internal"}>
        <label class="field"><span class="field-label">Optional Chrome loopback address</span><input class="input mono" value={address()} onInput={e=>setAddress(e.currentTarget.value)} placeholder="127.0.0.1:9222"/></label>
        <button class="btn ghost sm" disabled={busy()} onClick={connect}>{busy()?"Connecting…":"Connect current Chrome"}</button>
      </Show>
      <Show when={(view()?.status==="disconnected"||view()?.status==="unknown")&&view()?.mode==="internal"}><span class="field-help">Internal mode is selected. Enter <span class="mono">/browser chrome</span> to connect your current Chrome.</span></Show>
      <Show when={busy()&&!view()?.selected}><button class="btn danger-ghost sm" onClick={disconnect}>Cancel connection</button></Show>
      <Show when={view()?.status==="connected"||view()?.status==="selected"}>
        <button class="btn ghost sm" disabled={busy()} onClick={refreshTabs}>{busy()?"Refreshing…":"Refresh tabs"}</button>
        <button class="btn danger-ghost sm" onClick={disconnect}>Disconnect</button>
      </Show>
      <Show when={view()?.targets.length}>
        <select class="input mono" aria-label="Existing Chrome tab" value={target()} onChange={e=>setTarget(e.currentTarget.value)}>
          <For each={view()?.targets??[]}>{item=><option value={item.id}>{item.label} · {item.origin}</option>}</For>
        </select>
        <button class="btn primary sm" disabled={busy()||!target()} onClick={select}>Select tab</button>
      </Show>
    </div>
    <Show when={view()?.selected}><p class="hint" role="status">Selected {view()!.mode==="internal"?"internal Chrome tab":"current Chrome tab"}: {view()!.selected!.label} · <span class="mono">{view()!.selected!.host}</span>. To switch tabs, choose another explicitly.</p></Show>
    <Show when={error()}><p class="field-help warn" role="alert">{error()}</p></Show>
    <Show when={view()?.modeCommands.length}><ul class="log" aria-label="Browser mode command history"><For each={view()?.modeCommands??[]}>{item=><li><span class="badge"><span class="glyph" aria-hidden="true"/>{item.status}</span><span class="mono truncate">/browser {item.mode}</span><span class="muted small">{item.status==="unknown"?"Outcome unknown; nothing was replayed. Inspect the browser state before starting another process.":"Mode command recorded."}</span></li>}</For></ul></Show>
    <Show when={view()?.actions.length}><ul class="log" aria-label="Browser action history"><For each={view()?.actions??[]}>{item=><li><span class="badge"><span class="glyph" aria-hidden="true"/>{item.status}</span><span class="mono truncate">{item.mode==="internal"?"Internal Chrome":"Your Chrome"} · {item.kind} · {item.target}</span><span class="muted small">{item.detail}</span></li>}</For></ul></Show>
    <Show when={view()?.artifacts.length}><div class="field-row wrap browser-artifacts" aria-label="Chrome screenshots"><For each={[...(view()?.artifacts??[])].reverse()}>{item=><a href={`/api/sessions/${p.id}/browser-use/artifacts/${item.id}`} target="_blank" rel="noopener"><img class="browser-thumbnail" src={`/api/sessions/${p.id}/browser-use/artifacts/${item.id}`} alt={`Chrome screenshot ${item.width} by ${item.height}`} width="160" loading="lazy"/></a>}</For></div></Show>
  </section>;
}
