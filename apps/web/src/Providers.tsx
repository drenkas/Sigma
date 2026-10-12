import { createSignal, For, Show, onCleanup, onMount, type JSX } from "solid-js";
import type { ApprovalMode, CliproxyView, NativeProviderView, ProviderLoginView, ProviderView } from "../../../packages/contracts/index.js";
import { api } from "./api.js";

const active=(operation?:ProviderLoginView)=>operation?.state==="starting"||operation?.state==="waiting"||operation?.state==="finishing"||operation?.state==="cancelling";
const states={starting:"Starting sign-in",waiting:"Waiting for sign-in",finishing:"Finishing sign-in",cancelling:"Cancelling sign-in…",succeeded:"Sign-in completed",cancelled:"Sign-in cancelled",failed:"Sign-in failed",sync_pending:"Credentials saved · synchronization pending"};
export function Providers(p:{menu:JSX.Element;pending:number;onClose:()=>void;onModelsChanged:(signal:AbortSignal,isCurrent:()=>boolean)=>Promise<void>}){
  const [native,setNative]=createSignal<NativeProviderView[]>([]),[nativeBusy,setNativeBusy]=createSignal<string[]>([]);
  const [cliproxy,setCliproxy]=createSignal<CliproxyView>(),[cliproxyBusy,setCliproxyBusy]=createSignal(false);
  const [providers,setProviders]=createSignal<ProviderView[]>([]),[error,setError]=createSignal(""),[busy,setBusy]=createSignal<string[]>([]),[loaded,setLoaded]=createSignal(false);
  const lifecycle=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,readGeneration=0,actionGeneration=0,polling:number|undefined,needsLoad=false;
  const endpoint=(provider:ProviderView)=>`/providers/${encodeURIComponent(provider.id)}`;
  function patch(id:string,operation:ProviderLoginView){if(!lifecycle.signal.aborted)setProviders(items=>items.map(item=>item.id===id?{...item,operation}:item));}
  const currentRead=(generation:number)=>!lifecycle.signal.aborted&&generation===readGeneration&&!busy().length&&!nativeBusy().length&&!cliproxyBusy();
  async function load(){
    if(lifecycle.signal.aborted||busy().length||nativeBusy().length||cliproxyBusy()){needsLoad=true;return;}
    const generation=++readGeneration,action=actionGeneration;polling=undefined;
    try{
      const [sdk,v2,proxy]=await Promise.allSettled([api<{providers:ProviderView[]}>("/providers","GET",undefined,undefined,lifecycle.signal),api<{providers:NativeProviderView[]}>("/v2/providers","GET",undefined,undefined,lifecycle.signal),api<{provider:CliproxyView}>("/cliproxy","GET",undefined,undefined,lifecycle.signal)]);
      if(!currentRead(generation))return;
      if(v2.status==="fulfilled")setNative(v2.value.providers);
      if(sdk.status==="fulfilled")setProviders(sdk.value.providers);
      if(proxy.status==="fulfilled")setCliproxy(proxy.value.provider);
      setLoaded(true);setError(sdk.status==="rejected"||v2.status==="rejected"||proxy.status==="rejected"?"Some provider status could not refresh.":"");
      // Status polling can continue while models load; a newer action invalidates
      // that model snapshot, and the parent orders concurrent model reads.
      await p.onModelsChanged(lifecycle.signal,()=>!lifecycle.signal.aborted&&action===actionGeneration);
    }catch{if(currentRead(generation))setError("Provider status unavailable. Reload status to reconnect.");}
  }
  function schedule(){if(timer)clearTimeout(timer);timer=undefined;if(!lifecycle.signal.aborted&&!busy().length&&!cliproxyBusy()&&polling===undefined&&providers().some(provider=>active(provider.operation)))timer=setTimeout(()=>void poll(),650);}
  async function poll(){
    if(polling!==undefined||lifecycle.signal.aborted||busy().length||cliproxyBusy())return;
    const generation=++readGeneration;polling=generation;
    try{
      let finished=false;
      for(const provider of providers().filter(provider=>active(provider.operation))){
        const {operation}=await api<{operation:ProviderLoginView}>(`${endpoint(provider)}/login/${provider.operation!.id}`,"GET",undefined,undefined,lifecycle.signal);
        if(!currentRead(generation)||providers().find(item=>item.id===provider.id)?.operation?.id!==provider.operation!.id)return;
        patch(provider.id,operation);finished||=!active(operation);
      }
      if(finished)await load();
    }catch{if(currentRead(generation))setError("Sign-in status could not refresh. Reload status before another sign-in.");}
    finally{if(polling===generation)polling=undefined;schedule();}
  }
  async function action(provider:ProviderView,work:()=>Promise<void>){
    if(lifecycle.signal.aborted||busy().includes(provider.id)||nativeBusy().length||cliproxyBusy())return;++readGeneration;++actionGeneration;polling=undefined;setBusy(ids=>[...ids,provider.id]);setError("");if(timer)clearTimeout(timer);
    try{await work();}catch{if(!lifecycle.signal.aborted)setError("Provider action could not complete. Reload status to inspect its outcome before trying again.");}
    finally{if(!lifecycle.signal.aborted){++readGeneration;++actionGeneration;setBusy(ids=>ids.filter(id=>id!==provider.id));if(!busy().length&&needsLoad){needsLoad=false;await load();}schedule();}}
  }
  async function nativeAction(provider:NativeProviderView,kind:"refresh"|"connect"|"disconnect"|"cancel"){
    if(kind!=="cancel"&&(nativeBusy().length||busy().length||cliproxyBusy())||lifecycle.signal.aborted)return;
    ++readGeneration;const generation=++actionGeneration;setNativeBusy(ids=>ids.includes(provider.id)?ids:[...ids,provider.id]);setError("");
    try{const result=await api<{providers:NativeProviderView[]}>(`/v2/providers/${encodeURIComponent(provider.id)}/${kind}`,"POST",{},undefined,lifecycle.signal);if(lifecycle.signal.aborted||generation!==actionGeneration)return;setNative(result.providers);await p.onModelsChanged(lifecycle.signal,()=>!lifecycle.signal.aborted&&generation===actionGeneration);}
    catch{if(!lifecycle.signal.aborted&&generation===actionGeneration)setError("Native provider action could not complete. Refresh status to inspect its outcome.");}
    finally{if(!lifecycle.signal.aborted&&generation===actionGeneration)setNativeBusy(ids=>ids.filter(id=>id!==provider.id));}
  }
  const [understood,setUnderstood]=createSignal(false);
  const [access,setAccess]=createSignal<ApprovalMode>("full"),[accessBusy,setAccessBusy]=createSignal(false);
  onMount(()=>{void api<{mode:ApprovalMode}>("/v2/access","GET",undefined,undefined,lifecycle.signal).then(r=>{if(!lifecycle.signal.aborted)setAccess(r.mode);},()=>{});});
  async function setMode(mode:ApprovalMode){
    if(accessBusy()||lifecycle.signal.aborted)return;setAccessBusy(true);setError("");
    try{const r=await api<{mode:ApprovalMode}>("/v2/access","POST",{mode},undefined,lifecycle.signal);if(!lifecycle.signal.aborted)setAccess(r.mode);}
    catch{if(!lifecycle.signal.aborted)setError("Access mode could not be changed. Try again.");}
    finally{if(!lifecycle.signal.aborted)setAccessBusy(false);}
  }
  async function unsupervisedAction(kind:"enable"|"disable"){
    if(nativeBusy().length||busy().length||cliproxyBusy()||lifecycle.signal.aborted||kind==="enable"&&!understood())return;
    ++readGeneration;const generation=++actionGeneration;setNativeBusy(ids=>[...ids,"sigma-antigravity-unsupervised"]);setError("");
    try{const result=await api<{providers:NativeProviderView[]}>(`/v2/antigravity-unsupervised/${kind}`,"POST",kind==="enable"?{confirm:true}:{},undefined,lifecycle.signal);if(lifecycle.signal.aborted||generation!==actionGeneration)return;setNative(result.providers);setUnderstood(false);await p.onModelsChanged(lifecycle.signal,()=>!lifecycle.signal.aborted&&generation===actionGeneration);}
    catch{if(!lifecycle.signal.aborted&&generation===actionGeneration)setError("Unsupervised Antigravity could not be changed. Refresh status to inspect its state.");}
    finally{if(!lifecycle.signal.aborted&&generation===actionGeneration)setNativeBusy(ids=>ids.filter(id=>id!=="sigma-antigravity-unsupervised"));}
  }
  async function cliproxyAction(kind:"connect"|"refresh"|"disconnect"|"cancel"){
    if((cliproxyBusy()&&kind!=="cancel")||busy().length||nativeBusy().length||lifecycle.signal.aborted)return;
    if(kind==="cancel"){
      const generation=actionGeneration;
      try{const result=await api<{provider:CliproxyView}>("/cliproxy/cancel","POST",{},undefined,lifecycle.signal);if(!lifecycle.signal.aborted&&generation===actionGeneration)setCliproxy(result.provider);}
      catch{if(!lifecycle.signal.aborted&&generation===actionGeneration)setError("Local proxy request could not be cancelled. Reload status to inspect the connection.");}
      return;
    }
    ++readGeneration;const generation=++actionGeneration;polling=undefined;setCliproxyBusy(true);setError("");if(timer)clearTimeout(timer);
    try{
      const result=await api<{provider:CliproxyView}>(`/cliproxy/${kind}`,"POST",{},undefined,lifecycle.signal);
      if(lifecycle.signal.aborted||generation!==actionGeneration)return;setCliproxy(result.provider);
      await p.onModelsChanged(lifecycle.signal,()=>!lifecycle.signal.aborted&&generation===actionGeneration);
    }catch{if(!lifecycle.signal.aborted&&generation===actionGeneration)setError("Local proxy action could not complete. Reload status to inspect the connection.");}
    finally{if(!lifecycle.signal.aborted&&generation===actionGeneration){setCliproxyBusy(false);if(needsLoad){needsLoad=false;await load();}schedule();}}
  }
  onMount(()=>void load().then(schedule));
  onCleanup(()=>{++readGeneration;lifecycle.abort();if(timer)clearTimeout(timer);});
  const Prompt=(q:{provider:ProviderView;operation:ProviderLoginView})=>{
    const [answer,setAnswer]=createSignal("");let input:HTMLInputElement|HTMLSelectElement|undefined;
    onCleanup(()=>{setAnswer("");if(input)input.value="";});
    const prompt=q.operation.prompt!;
    async function submit(event:Event){event.preventDefault();let value=answer();setAnswer("");if(input)input.value="";
      await action(q.provider,async()=>{try{const result=await api<{operation:ProviderLoginView}>(`${endpoint(q.provider)}/login/${q.operation.id}/answer`,"POST",{promptId:prompt.id,answer:value},undefined,lifecycle.signal);patch(q.provider.id,result.operation);if(!active(result.operation))await load();}finally{value="";}});
    }
    return <form class="provider-prompt" onSubmit={event=>void submit(event)} autocomplete="off">
      <label class="field"><span class="field-label">{prompt.message}</span>
      <Show when={prompt.type==="select"} fallback={<input ref={element=>{input=element;}} class="input" type={prompt.type==="secret"||prompt.type==="manual_code"?"password":"text"} autocomplete="off" autocapitalize="off" spellcheck={false} maxlength="16000" placeholder={prompt.placeholder} value={answer()} onInput={event=>setAnswer(event.currentTarget.value)} required/>}>
        <select ref={element=>{input=element;}} aria-label="Sign-in option" class="input" value={answer()} onChange={event=>setAnswer(event.currentTarget.value)} required><option value="">Choose an option</option><For each={prompt.options}>{option=><option value={option.id}>{option.label}{option.description?` · ${option.description}`:""}</option>}</For></select>
      </Show></label>
      <button class="btn primary sm" type="submit" disabled={!!nativeBusy().length||busy().includes(q.provider.id)||!answer().trim()}>Continue sign-in</button>
    </form>;
  };
  const [open,setOpen]=createSignal<Set<string>>(new Set());
  const toggle=(k:string)=>setOpen(set=>{const next=new Set(set);if(!next.delete(k))next.add(k);return next;});
  const attention=(provider:ProviderView)=>active(provider.operation)||provider.operation?.state==="sync_pending"||provider.operation?.state==="failed";
  const rank=(provider:ProviderView)=>provider.id==="openai"?0:provider.id==="openai-codex"?1:2;
  const sorted=()=>providers().map((provider,index)=>({provider,index})).sort((x,y)=>rank(x.provider)-rank(y.provider)||x.index-y.index).map(item=>item.provider);
  const initials=(name:string)=>{const w=name.split(/\s+/).filter(word=>/^[a-z0-9]/i.test(word));return (w.length>1?w[0][0]+w[1][0]:name.charAt(0)).toUpperCase();};
  type Tone="info"|"ok"|"warn"|"err"|"";
  const nativeTone=(state:string):Tone=>state==="connected"?"ok":state==="login_required"?"warn":state==="error"?"err":"";
  const piTone=(p:ProviderView):Tone=>p.operation?(active(p.operation)?"info":p.operation.state==="sync_pending"?"warn":p.operation.state==="failed"?"err":p.configured?"ok":""):p.configured?"ok":"";
  const proxyTone=(p:{connected:boolean;state:string}):Tone=>p.connected?"ok":p.state==="error"?"err":"";
  const cap=(text:string)=>text.charAt(0).toUpperCase()+text.slice(1);
  const shortState=(state:ProviderLoginView["state"])=>active({state} as ProviderLoginView)?"Signing in…":state==="succeeded"?"Signed in":state==="failed"?"Sign-in failed":state==="cancelled"?"Cancelled":"Sync pending";
  const Row=(q:{k:string;name:string;sub:string;pill:string;tone:Tone;forced?:boolean;badge?:JSX.Element;children:JSX.Element})=>{
    const expanded=()=>!!q.forced||open().has(q.k);
    return <section class="provider-row" classList={{open:expanded()}} aria-label={q.name}>
      <button type="button" class="provider-head" aria-expanded={expanded()} onClick={()=>toggle(q.k)}>
        <span class="provider-avatar" aria-hidden="true">{initials(q.name)}</span><span class="provider-main"><span class="provider-name">{q.name}</span><span class="provider-sub">{q.sub}</span></span>
        <span class="provider-side">{q.badge}<span class={"status-pill"+(q.tone?" "+q.tone:"")}><i class="status-pill-dot"/>{cap(q.pill)}</span><svg class="chev" aria-hidden="true" viewBox="0 0 16 16" width="14" height="14"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      </button>
      <Show when={expanded()}><div class="provider-details">{q.children}</div></Show>
    </section>;
  };
  return <main class="main" aria-label="Providers">
    <header class="col-head main-head">{p.menu}<div class="head-title"><h1 id="providers-title" class="title" tabindex="-1">Providers</h1><span class="muted small">Accounts and sign-in</span></div><button class="btn ghost sm" onClick={p.onClose}>Chat<Show when={p.pending}><span class="pip">{p.pending}</span></Show></button></header>
    <Show when={p.pending}><div class="banner warning" role="status">A chat is waiting for approval.<button class="link-btn" onClick={p.onClose}>Review in chat</button></div></Show>
    <div class="scroller"><div class="project-content provider-page">
      <section class="provider-section"><h2 class="repo-name">Agent access</h2>
      <label class="field check"><input type="checkbox" checked={access()==="full"} disabled={accessBusy()} onChange={event=>void setMode(event.currentTarget.checked?"full":"ask")}/> <span>Full access — agents run tools without asking</span></label>
      <p class="field-help">Uncheck to restore Allow/Deny prompts for every read, edit, write, commit and QA action.</p></section>
      <Show when={error()}><p class="banner error" role="alert">{error()}</p></Show>
      <section class="provider-section">
        <div class="provider-section-head"><h2 class="repo-name">Pi SDK accounts</h2><button class="btn ghost sm" disabled={!!busy().length||!!nativeBusy().length} onClick={()=>void load().then(schedule)}>Reload status</button></div>
        <p class="field-help">Pi's credential store. Sign-in never starts automatically.</p>
        <Show when={!loaded()}><p class="muted" role="status">Loading providers…</p></Show>
        <div class="provider-list"><For each={sorted().map(provider=>provider.id)}>{id=>{
          const provider=()=>providers().find(provider=>provider.id===id)!;
          return <Row k={"pi:"+id} name={provider().name} forced={attention(provider())} tone={piTone(provider())} pill={provider().operation?shortState(provider().operation!.state):provider().configured?(provider().credentialType==="oauth"?"Signed in":provider().credentialType==="api_key"?"API key set":"Configured"):"Not configured"} sub={provider().credentialType?(provider().credentialType==="oauth"?"OAuth account":"API key"):provider().source||"Sign in or add an API key"}>
            <Show when={provider().operation}>{operation=><>
              <p class="field-help" role="status">{states[operation().state]}{operation().credentialStored?" · OAuth credential stored":""}</p>
              <Show when={operation().message}><p class="field-help">{operation().message}</p></Show>
              <Show when={operation().metadataUnavailable}><p class="field-help warn">Saved credential status could not refresh.</p></Show>
              <Show when={active(operation())}>
                <Show when={operation().authUrl}><div class="project-actions"><button class="btn primary sm" disabled={!!nativeBusy().length||busy().includes(id)} onClick={()=>void action(provider(),async()=>{await api(`${endpoint(provider())}/login/${operation().id}/open`,"POST",{},undefined,lifecycle.signal);})}>Open browser</button><a class="btn ghost sm" href={operation().authUrl} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Open sign-in link</a></div></Show>
                <Show when={operation().deviceCode}><p class="field-help">Provider device code: <code>{operation().deviceCode}</code><Show when={operation().deviceExpiresAt}> · expires {new Date(operation().deviceExpiresAt!).toLocaleTimeString()}</Show></p></Show>
                <Show keyed when={operation().prompt?.id}>{_id=> <Prompt provider={provider()} operation={operation()}/>}</Show>
                <button class="btn danger-ghost sm" disabled={!!nativeBusy().length||busy().includes(id)} onClick={()=>void action(provider(),async()=>{const result=await api<{operation:ProviderLoginView}>(`${endpoint(provider())}/login/${operation().id}/cancel`,"POST",{},undefined,lifecycle.signal);patch(id,result.operation);await load();})}>Cancel sign-in</button>
              </Show>
            </>}</Show>
            <div class="project-actions"><Show when={provider().oauth}><button class="btn primary sm" disabled={!!nativeBusy().length||busy().includes(id)||active(provider().operation)||provider().operation?.state==="sync_pending"} onClick={()=>void action(provider(),async()=>{const {operation}=await api<{operation:ProviderLoginView}>(`${endpoint(provider())}/login`,"POST",{},crypto.randomUUID(),lifecycle.signal);patch(id,operation);})}>{provider().configured?"Sign in again":provider().loginLabel||"Sign in"}</button></Show><button class="btn ghost sm" disabled={!!nativeBusy().length||busy().includes(id)||active(provider().operation)} onClick={()=>void action(provider(),async()=>{await api(`${endpoint(provider())}/refresh`,"POST",{},undefined,lifecycle.signal);await load();})}>Refresh provider</button></div>
          </Row>;
        }}</For></div>
      </section>
      <section class="provider-section">
        <h2 class="repo-name">Official CLI accounts</h2>
        <p class="field-help">Uses accounts signed in through the official CLIs.</p>
        <div class="provider-list">
          <For each={native().filter(provider=>!provider.unsupervised)}>{provider=><Row k={"native:"+provider.id} name={provider.name} forced={nativeBusy().includes(provider.id)} tone={nativeTone(provider.state)} pill={provider.state==="connected"?"Connected":provider.state.replaceAll("_"," ")} sub={provider.account?provider.account+(provider.subscription?` · ${provider.subscription}`:""):provider.message}>
            <p class="field-help" role="status">{provider.state.replaceAll("_"," ")}{provider.account?` · ${provider.account}`:""}{provider.subscription?` · ${provider.subscription}`:""}</p>
            <p class="field-help">{provider.message}</p>
            <Show when={provider.id==="sigma-antigravity-cli"}><p class="field-help">Antigravity’s experimental official CLI route remains blocked pending native safety proof; its separate local CLIProxyAPI route is available below.</p></Show>
            <Show when={provider.id==="sigma-antigravity-cli"&&provider.loginCommand}>
              <p class="field-help">After preparing the profile, run this command in your local terminal to sign in with the official Antigravity CLI:</p>
              <textarea class="input" rows={3} readOnly value={provider.loginCommand} onFocus={event=>event.currentTarget.select()} aria-label="Antigravity sign-in command" />
            </Show>
            <div class="project-actions">
              <button class="btn ghost sm" disabled={!!nativeBusy().length||!!busy().length} onClick={()=>void nativeAction(provider,"refresh")}>{provider.id==="sigma-antigravity-cli"?"Prepare / recheck private profile":"Refresh status"}</button>
              <Show when={provider.state!=="blocked"&&provider.id!=="sigma-antigravity-cli"}><button class="btn primary sm" disabled={!!nativeBusy().length||!!busy().length||provider.state==="connected"} onClick={()=>void nativeAction(provider,"connect")}>Connect local route</button><button class="btn ghost sm" disabled={!provider.enabled||!!nativeBusy().length||!!busy().length} onClick={()=>void nativeAction(provider,"disconnect")}>Disconnect local route</button></Show>
              <Show when={nativeBusy().includes(provider.id)&&provider.id!=="sigma-antigravity-cli"}><button class="btn danger-ghost sm" onClick={()=>void nativeAction(provider,"cancel")}>Cancel operation</button></Show>
            </div>
          </Row>}</For>
          <For each={native().filter(provider=>provider.unsupervised)}>{provider=><Row k={"native:"+provider.id} name={provider.name} forced={nativeBusy().includes(provider.id)} tone={provider.enabled?"warn":""} pill={provider.enabled?"Enabled":"Off"} badge={<span class="badge unsupervised">Unsupervised</span>} sub={provider.account?provider.account+(provider.subscription?` · ${provider.subscription}`:""):provider.message}>
            <p class="banner warning" role="note"><strong>No Sigma approvals.</strong> {provider.warning}</p>
            <p class="field-help" role="status">{provider.enabled?"Enabled":"Off"} · {provider.message}</p>
            <p class="field-help">Only available for new code sessions in an isolated Git worktree, never direct-folder or read-only chats, and never for delegated child agents. Its file, shell and browser activity is shown read-only as “executed by AGY (unsupervised)”.</p>
            <Show when={!provider.enabled}>
              <label class="field check"><input type="checkbox" checked={understood()} onChange={event=>setUnderstood(event.currentTarget.checked)}/> <span>I understand AGY runs its own tools without Sigma approvals.</span></label>
            </Show>
            <div class="project-actions">
              <Show when={!provider.enabled}><button class="btn primary sm" disabled={!understood()||!!nativeBusy().length||!!busy().length||provider.state==="missing"||provider.state==="blocked"} onClick={()=>void unsupervisedAction("enable")}>Enable unsupervised Antigravity</button></Show>
              <Show when={provider.enabled}><button class="btn ghost sm" disabled={!!nativeBusy().length||!!busy().length} onClick={()=>void unsupervisedAction("disable")}>Disable</button></Show>
            </div>
          </Row>}</For>
        </div>
      </section>
      <section class="provider-section">
        <h2 class="repo-name">Local model gateways</h2>
        <Show when={cliproxy()} fallback={<p class="field-help">Loading local proxy status…</p>}>{provider=><div class="provider-list"><Row k="proxy" name={provider().name} forced={cliproxyBusy()} tone={proxyTone(provider())} pill={provider().connected?"Connected":provider().proxy?.state==="not_installed"?"Missing":provider().state.replaceAll("_"," ")} sub={provider().connected?`${provider().modelCount} catalog models`:provider().proxy?`${provider().proxy!.state.replaceAll("_"," ")} · ${provider().proxy!.reason}`:provider().message}>
          <p class="field-help" role="status">{provider().state.replaceAll("_"," ")}{provider().connected?` · ${provider().modelCount} catalog models`:""}</p>
          <Show when={provider().proxy}>{proxy=><p class="field-help" role="status" data-proxy-state={proxy().state}>Proxy process: {proxy().state.replaceAll("_"," ")} · {proxy().reason}</p>}</Show>
          <p class="field-help">{provider().message}</p>
          <p class="field-help">Sigma reads only its private local connection file. The API key never appears here. Model limits are conservative because the proxy list contains IDs only.</p>
          <div class="project-actions">
            <Show when={!provider().connected}><button class="btn primary sm" disabled={cliproxyBusy()||!!nativeBusy().length||!!busy().length} onClick={()=>void cliproxyAction("connect")}>Connect local proxy</button></Show>
            <Show when={provider().connected}><button class="btn ghost sm" disabled={cliproxyBusy()||!!nativeBusy().length||!!busy().length} onClick={()=>void cliproxyAction("refresh")}>Refresh models</button><button class="btn ghost sm" disabled={cliproxyBusy()||!!nativeBusy().length||!!busy().length} onClick={()=>void cliproxyAction("disconnect")}>Disconnect</button></Show>
            <Show when={cliproxyBusy()}><button class="btn danger-ghost sm" onClick={()=>void cliproxyAction("cancel")}>Cancel request</button></Show>
          </div>
        </Row></div>}</Show>
      </section>
    </div></div>
  </main>;
}
