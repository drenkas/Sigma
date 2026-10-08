import { createSignal, onCleanup, onMount, Show } from "solid-js";

type Info = { version:string; current:string; notes?:string|null };
type Phase = "idle"|"installing"|"error";

const inTauri=()=>typeof window!=="undefined"&&"__TAURI_INTERNALS__" in window;

// Shown only inside the Tauri desktop shell. The API is imported lazily so the plain web build never loads it.
export function UpdateBanner(){
  const [info,setInfo]=createSignal<Info|null>(null),[phase,setPhase]=createSignal<Phase>("idle"),[error,setError]=createSignal(""),[progress,setProgress]=createSignal<{downloaded:number;total:number|null}|null>(null),[hidden,setHidden]=createSignal(false);
  const unlisten:Array<()=>void>=[];
  let disposed=false;
  onMount(async()=>{
    if(!inTauri())return;
    try{
      const [{invoke},{listen}]=await Promise.all([import("@tauri-apps/api/core"),import("@tauri-apps/api/event")]);
      const keep=(off:()=>void)=>{if(disposed)off();else unlisten.push(off);};
      keep(await listen<Info>("sigma-update-available",e=>{setInfo(e.payload);setHidden(false);}));
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
  return <Show when={info()&&!hidden()}>
    <section class="update-banner" role="status" aria-label="Update available">
      <div class="update-text"><strong>Sigma {info()!.version} is available</strong><span>You have {info()!.current}.</span></div>
      <Show when={phase()==="error"}><p class="update-error" role="alert">Update failed: {error()}</p></Show>
      <div class="update-actions">
        <button class="btn accent sm" disabled={phase()==="installing"} onClick={()=>void install()}>
          {phase()==="installing"?(percent()!==null?`Installing… ${percent()}%`:"Installing…"):phase()==="error"?"Retry":`Update to v${info()!.version}`}
        </button>
        <Show when={phase()!=="installing"}><button class="btn ghost sm" onClick={()=>setHidden(true)}>Later</button></Show>
      </div>
    </section>
  </Show>;
}
