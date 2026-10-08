import { createSignal, For, Show } from "solid-js";
import { api } from "./api.js";

type Candidate={kind:string;path:string;ignored?:{count:number;bytes:number;sample:string[]}};type Blocker={kind:string;path:string;reason:string};type Preview={candidates:Candidate[];blockers:Blocker[];digest:string};
const label=(item:{kind:string;path:string})=>`${item.kind==="worktree"?"Worktree":item.kind==="check"?"Check copy":"Review copy"} · ${item.path.split("/").slice(-2).join("/")}`;
export function Cleanup(){
  const [preview,setPreview]=createSignal<Preview|null>(null),[busy,setBusy]=createSignal(false),[error,setError]=createSignal(""),[note,setNote]=createSignal("");
  async function load(){setBusy(true);setError("");try{setPreview(await api<Preview>("/cleanup/preview"));}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  async function confirm(){const p=preview();if(!p)return;setBusy(true);setError("");setNote("");try{const result=await api<{removed:string[]}>("/cleanup","POST",{digest:p.digest,approve:true},crypto.randomUUID());setNote(`Removed ${result.removed.length} folder${result.removed.length===1?"":"s"}.`);setPreview(await api<Preview>("/cleanup/preview"));}catch(e){setError(`${e instanceof Error?e.message:String(e)}. Review the list again before removing.`);try{setPreview(await api<Preview>("/cleanup/preview"));}catch{}}finally{setBusy(false);}}
  return <div class="cleanup">
    <Show when={!preview()} fallback={<>
      <p class="field-help">Removes only clean Git worktrees and check/review scratch copies of archived sessions. Sessions, history, branches and results stay.</p>
      <Show when={error()}><p class="banner error" role="alert">{error()}</p></Show>
      <Show when={note()}><p class="banner info" role="status">{note()}</p></Show>
      <Show when={preview()!.candidates.length} fallback={<p class="side-empty">Nothing can be removed safely right now.</p>}>
        <ul class="cleanup-list" aria-label="Folders to remove"><For each={preview()!.candidates}>{item=><li title={item.path}>{label(item)}<Show when={item.ignored?.count}><span class="muted small"> — also removes {item.ignored!.count} ignored file{item.ignored!.count===1?"":"s"} ({Math.ceil(item.ignored!.bytes/1024)} KB), e.g. {item.ignored!.sample.join(", ")}</span></Show></li>}</For></ul>
      </Show>
      <Show when={preview()!.blockers.length}><details class="cleanup-blocked"><summary>Kept ({preview()!.blockers.length})</summary><ul class="cleanup-list"><For each={preview()!.blockers}>{item=><li title={item.path}>{label(item)}<span class="muted small"> — {item.reason}</span></li>}</For></ul></details></Show>
      <div class="project-actions"><button class="btn danger-ghost sm" disabled={busy()||!preview()!.candidates.length} onClick={()=>void confirm()}>{busy()?"Working…":`Remove ${preview()!.candidates.length} folder${preview()!.candidates.length===1?"":"s"}`}</button><button class="btn ghost sm" disabled={busy()} onClick={()=>{setPreview(null);setNote("");setError("");}}>Close</button></div>
    </>}>
      <button class="btn ghost sm" disabled={busy()} onClick={()=>void load()}>{busy()?"Checking…":"Clean up archived sessions…"}</button>
      <Show when={error()}><p class="banner error" role="alert">{error()}</p></Show>
    </Show>
  </div>;
}
