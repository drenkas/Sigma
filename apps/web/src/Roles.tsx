import { createSignal, For, Show, onMount, type JSX } from "solid-js";
import { AGENT_ROLES, type AgentRole, type RoleCatalog, type RoleReasoning } from "../../../packages/contracts/index.js";
import { api } from "./api.js";

type Model={provider:string;id:string;name:string;reasoningLevels?:string[];legacy?:boolean};
const LABELS:Record<AgentRole,string>={planner:"Planner",researcher:"Researcher",worker:"Implementation",reviewer:"Reviewer",qa:"QA"};
export function Roles(p:{models:Model[];menu:JSX.Element;onClose:()=>void;pending:number}) {
  const [catalog,setCatalog]=createSignal<RoleCatalog|null>(null),[busy,setBusy]=createSignal(false),[error,setError]=createSignal(""),[saved,setSaved]=createSignal(false);
  async function load(){setBusy(true);setError("");try{setCatalog((await api<{catalog:RoleCatalog}>("/roles")).catalog);}catch(e){setError(String(e));}finally{setBusy(false);}}
  onMount(()=>{void load();document.getElementById("roles-title")?.focus();});
  const modelOf=(role:AgentRole)=>catalog()?.roles.find(item=>item.role===role)?.model??null;
  const reasoningOf=(role:AgentRole)=>catalog()?.roles.find(item=>item.role===role)?.reasoning??null;
  const levels=(role:AgentRole)=>p.models.find(m=>`${m.provider}/${m.id}`===modelOf(role))?.reasoningLevels??["off","minimal","low","medium","high","xhigh","max"];
  const noReasoning=(role:AgentRole)=>levels(role).length===1&&levels(role)[0]==="off";
  function change(role:AgentRole,patch:{model?:string|null;reasoning?:RoleReasoning|null}){setCatalog(value=>value&&{...value,roles:value.roles.map(item=>item.role===role?{...item,...patch}:item)});setSaved(false);}
  function setModel(role:AgentRole,model:string|null){change(role,{model});if(reasoningOf(role)&&!levels(role).includes(reasoningOf(role)!))change(role,{reasoning:null});}
  async function save(){const value=catalog();if(!value)return;setBusy(true);setError("");setSaved(false);try{setCatalog((await api<{catalog:RoleCatalog}>("/roles","PUT",value)).catalog);setSaved(true);}catch(e){setError(`${e instanceof Error?e.message:String(e)}. Reload before another save.`);}finally{setBusy(false);}}
  return <main class="main" aria-label="Agents">
    <header class="col-head main-head">{p.menu}<div class="head-title"><h1 id="roles-title" class="title" tabindex="-1">Agents</h1><span class="muted small">Model and reasoning for each agent</span></div><button class="btn ghost sm" onClick={p.onClose}>Chat<Show when={p.pending}><span class="pip">{p.pending}</span></Show></button></header>
    <Show when={p.pending}><div class="banner warning" role="status">A chat is waiting for approval.<button class="link-btn" onClick={p.onClose}>Review in chat</button></div></Show>
    <div class="scroller"><div class="project-content">
      <p class="field-help">The chat model is the orchestrator and decides which agents to call. Pick a model and reasoning for each agent; it applies to new chats.</p>
      <Show when={error()}><p class="banner error" role="alert">{error()}</p></Show>
      <Show when={saved()}><p class="banner info" role="status">Saved for new chats.</p></Show>
      <Show when={catalog()}><section class="repo-card" aria-label="Agent models"><For each={AGENT_ROLES}>{role=>
        <div class="role-row"><span class="role-name">{LABELS[role]}</span><select class="input" id={`agent-${role}-model`} aria-label={`${LABELS[role]} model`} value={modelOf(role)??""} onChange={e=>setModel(role,e.currentTarget.value||null)} disabled={busy()}>
          <option value="">Same as chat model</option>
          <Show when={modelOf(role)&&!p.models.some(m=>`${m.provider}/${m.id}`===modelOf(role))}><option value={modelOf(role)!}>{modelOf(role)} · unavailable</option></Show>
          <For each={p.models.filter(m=>!m.legacy||`${m.provider}/${m.id}`===modelOf(role))}>{m=><option value={`${m.provider}/${m.id}`}>{m.provider} · {m.name||m.id}</option>}</For>
        </select>
        <Show when={!noReasoning(role)||reasoningOf(role)}><select class="input" id={`agent-${role}-reasoning`} aria-label={`${LABELS[role]} reasoning`} value={reasoningOf(role)??""} onChange={e=>change(role,{reasoning:(e.currentTarget.value||null) as RoleReasoning|null})} disabled={busy()}>
          <option value="">Model default</option>
          <Show when={reasoningOf(role)&&!levels(role).includes(reasoningOf(role)!)}><option value={reasoningOf(role)!}>{reasoningOf(role)} · unavailable</option></Show>
          <Show when={!noReasoning(role)}><For each={levels(role)}>{level=><option value={level}>{level}</option>}</For></Show>
        </select></Show></div>
      }</For></section></Show>
      <div class="project-actions"><button class="btn primary" disabled={busy()||!catalog()} onClick={()=>void save()}>{busy()?"Working…":"Save"}</button><button class="btn ghost" disabled={busy()} onClick={()=>void load()}>Reload</button></div>
    </div></div>
  </main>;
}
