import { createSignal, onCleanup, onMount, Show } from "solid-js";

type Info = { version:string; current:string; notes?:string|null };
type Phase = "idle"|"installing"|"error";

const inTauri=()=>typeof window!=="undefined"&&"__TAURI_INTERNALS__" in window;

// Shown only inside the Tauri desktop shell. The API is imported lazily so the plain web build never loads it.
export function UpdateButton(){
  const [info,setInfo]=createSignal<Info|null>(null),[phase,setPhase]=createSignal<Phase>("idle"),[error,setError]=createSignal(""),[progress,setProgress]=createSignal<{downloaded:number;total:number|null}|null>(null);
  const unlisten:Array<()=>void>=[];
  let disposed=false;
  onMount(async()=>{
    if(!inTauri())return;
    try{
      const [{invoke},{listen}]=await Promise.all([import("@tauri-apps/api/core"),import("@tauri-apps/api/event")]);
      const keep=(off:()=>void)=>{if(disposed)off();else unlisten.push(off);};
      keep(await listen<Info>("sigma-update-available",e=>{setInfo(e.payload);}));
      keep(await listen<{downloaded:number;total:number|null}>("sigma-update-progress",e=>setProgress(e.payload)));
      keep(await listen<string>("sigma-update-error",e=>{setError(String(e.payload));setPhase("error");}));
      const current=await invoke<Info|null>("update_status");
      if(current)setInfo(current);
    }catch{/* IPC unavailable: stay hidden */}
  });
  onCleanup(()=>{disposed=true;unlisten.splice(0).forEach(off=>off());});
  async function install(){
    setPhase("installing");setError("");setProgress(null);
    try{
      const {invoke}=await import("@tauri-apps/api/core");
      await invoke("install_update");
    }catch(e){setError(String(e));setPhase("error");}
  }
  const percent=()=>{const p=progress();return p&&p.total?Math.min(100,Math.round(p.downloaded/p.total*100)):null;};
  const label=()=>phase()==="error"?`Update failed: ${error()}. Click to retry`:phase()==="installing"?(percent()!==null?`Installing update… ${percent()}%`:"Installing update…"):`Update to v${info()!.version} and restart (you have ${info()!.current})`;
  const R=12,C=2*Math.PI*R;
  return <Show when={info()}>
    <button type="button" class="update-btn" classList={{installing:phase()==="installing",failed:phase()==="error"}} disabled={phase()==="installing"} title={label()} aria-label={label()} onClick={()=>void install()}>
      <Show when={phase()==="installing"} fallback={<svg class="update-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v9M6 8.5l4 4 4-4M4 16h12"/></svg>}>
        <svg class="update-ring" viewBox="0 0 28 28" aria-hidden="true"><circle class="ring-track" cx="14" cy="14" r={R}/><circle classList={{"ring-bar":true,spin:percent()===null}} cx="14" cy="14" r={R} stroke-dasharray={`${percent()===null?C*0.25:C*percent()!/100} ${C}`}/></svg>
        <Show when={percent()!==null}><span class="update-pct" aria-hidden="true">{percent()}</span></Show>
      </Show>
    </button>
  </Show>;
}
