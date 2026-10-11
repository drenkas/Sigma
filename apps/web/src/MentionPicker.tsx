import { createEffect, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { api } from "./api.js";

type Found = { files:{path:string;kind:"file"|"dir"}[]; skills:{name:string;description:string}[]; tools:{name:string;description:string}[]; order?:("files"|"skills"|"tools")[] };
type Hit = { group:"Files"|"Skills"|"Tools"; label:string; detail:string; token:string };
type Active = { start:number; end:number; query:string };
const TOKEN=/(?<!\S)@(?:"([^"\n]+)"|(\S+))/g;

/** The `@query` under the caret: `@` at the start or after whitespace, no whitespace up to the caret (or an open quote). */
function activeToken(text:string,caret:number):Active|null{
  const head=text.slice(0,caret),quoted=/(?<!\S)@"([^"\n]*)$/.exec(head),match=quoted??/(?<!\S)@([^\s"]*)$/.exec(head);
  if(!match)return null;
  return {start:match.index,end:caret+(quoted?(text[caret]==='"'?1:0):/^[^\s"]*/.exec(text.slice(caret))![0].length),query:match[1]};
}
const hitsOf=(found:Found):Hit[]=>{const by={files:found.files.map((f):Hit=>{const slash=f.path.lastIndexOf("/"),shown=f.kind==="dir"?`${f.path}/`:f.path;return {group:"Files",label:`${f.path.slice(slash+1)}${f.kind==="dir"?"/":""}`,detail:slash>0?f.path.slice(0,slash):"",token:/\s/.test(f.path)?`@"${shown}"`:`@${shown}`};}),
  skills:found.skills.map((s):Hit=>({group:"Skills",label:s.name,detail:s.description,token:`@skill:${s.name}`})),
  tools:found.tools.map((t):Hit=>({group:"Tools",label:t.name,detail:t.description,token:`@tool:${t.name}`}))};
  return (found.order??["files","skills","tools"]).flatMap(key=>by[key]);};

/** Composer @-mention picker: call `keydown` first from the textarea's onKeyDown, `sync` after input, spread `props` on the textarea and render `view` inside the composer. */
export function createMention(opts:{id:string;scope:()=>Record<string,string>|null;el:()=>HTMLTextAreaElement|undefined;set:(value:string)=>void;resize:()=>void}){
  const [range,setRange]=createSignal<Active|null>(null),[hits,setHits]=createSignal<Hit[]>([]),[index,setIndex]=createSignal(0),[loaded,setLoaded]=createSignal(false),[pending,setPending]=createSignal(false),[slow,setSlow]=createSignal(false);
  let timer:ReturnType<typeof setTimeout>|undefined,slowTimer:ReturnType<typeof setTimeout>|undefined,abort:AbortController|undefined,flush:(()=>void)|undefined,last="",dismissed=-1,want=false;
  const shown=()=>range()!==null&&loaded(),searching=()=>range()!==null&&!loaded()&&pending()&&slow(),listId=`${opts.id}-list`,optionId=(i:number)=>`${opts.id}-opt-${i}`;
  function close(){clearTimeout(timer);clearTimeout(slowTimer);abort?.abort();abort=undefined;flush=undefined;want=false;last="";setRange(null);setHits([]);setLoaded(false);setPending(false);setSlow(false);}
  function load(scope:Record<string,string>,query:string,delay:number){
    clearTimeout(timer);clearTimeout(slowTimer);abort?.abort();const ctl=abort=new AbortController();setPending(true);setSlow(false);slowTimer=setTimeout(()=>setSlow(true),150);
    const run=flush=async()=>{
      flush=undefined;
      try{const found=await api<Found>(`/mentions?${new URLSearchParams({...scope,q:query})}`,"GET",undefined,undefined,ctl.signal);if(ctl.signal.aborted)return;setHits(hitsOf(found));setIndex(0);setLoaded(true);if(want){want=false;if(hits().length)insert(hits()[0]);}}
      catch{if(!ctl.signal.aborted){want=false;setHits([]);setLoaded(true);}}
      finally{if(abort===ctl){setPending(false);clearTimeout(slowTimer);}}
    };
    timer=setTimeout(run,delay);
  }
  function sync(){
    const el=opts.el(),scope=opts.scope(),next=el&&scope?activeToken(el.value,el.selectionStart):null;
    if(!next||!scope||next.start===dismissed){if(!next)dismissed=-1;close();return;}
    dismissed=-1;
    const key=`${new URLSearchParams(scope)}\0${next.query}`,fresh=!range();
    setRange(next);
    if(key!==last){last=key;want=false;load(scope,next.query,fresh?0:120);}
  }
  function insert(hit:Hit){
    const el=opts.el(),at=range();if(!el||!at)return;
    const tail=el.value.slice(at.end),next=`${el.value.slice(0,at.start)}${hit.token}${/^\s/.test(tail)?"":" "}${tail}`,caret=at.start+hit.token.length+1;
    el.value=next;opts.set(next);close();
    queueMicrotask(()=>{el.focus();el.setSelectionRange(caret,caret);opts.resize();});
  }
  /** True when the key was consumed; Enter is only held back while the picker has something to pick. */
  function keydown(e:KeyboardEvent){
    if(e.key==="Enter"&&!e.shiftKey)dismissed=-1;
    if(!range()||e.isComposing||e.ctrlKey||e.metaKey||e.altKey)return false;
    const stop=()=>{e.preventDefault();e.stopImmediatePropagation();};
    if(e.key==="Escape"){stop();dismissed=range()!.start;close();return true;}
    const pick=(e.key==="Enter"||e.key==="Tab")&&!e.shiftKey;
    if(pick){sync();if(!range())return false;}
    if(pick&&pending()){stop();want=true;setSlow(true);if(flush){clearTimeout(timer);flush();}return true;}
    if(!shown()||!hits().length)return false;
    if(e.key==="ArrowDown"||e.key==="ArrowUp"){stop();setIndex(i=>(i+(e.key==="ArrowDown"?1:hits().length-1))%hits().length);return true;}
    if(pick){stop();insert(hits()[index()]);return true;}
    return false;
  }
  createEffect(()=>{if(shown())document.getElementById(optionId(index()))?.scrollIntoView({block:"nearest"});});
  onCleanup(close);
  const props={
    role:"combobox" as const,"aria-autocomplete":"list" as const,
    get "aria-expanded"(){return shown();},
    get "aria-controls"(){return shown()?listId:undefined;},
    get "aria-activedescendant"(){return shown()&&hits().length?optionId(index()):undefined;},
    onKeyUp:(e:KeyboardEvent)=>{if(e.key!=="Escape"&&e.key!=="Enter"&&e.key!=="Tab")sync();},
    onClick:sync,onBlur:()=>{dismissed=-1;close();},
  };
  const groups=()=>[...new Set(hits().map(h=>h.group))];
  const view=()=><Show when={shown()||searching()}><div class="mention-pop" onMouseDown={e=>e.preventDefault()}>
    <Show when={shown()} fallback={<div class="mention-empty" role="status">Searching…</div>}><div id={listId} class="mention-list" role="listbox" aria-label="Files, skills and tools">
      <Show when={hits().length} fallback={<div class="mention-empty" role="status">No matches</div>}>
        <For each={groups()}>{group=><Show when={hits().some(h=>h.group===group)}><div role="group" aria-label={group}>
          <div class="mention-group" aria-hidden="true">{group}</div>
          <For each={hits()}>{(hit,i)=><Show when={hit.group===group}><div id={optionId(i())} class="mention-opt" role="option" aria-selected={i()===index()} classList={{active:i()===index()}} onMouseMove={()=>{if(index()!==i())setIndex(i());}} onClick={()=>insert(hit)}>
            <span class="mention-name">{hit.label}</span><Show when={hit.detail}><span class="mention-detail">{hit.detail}</span></Show>
          </div></Show>}</For>
        </div></Show>}</For>
      </Show>
    </div></Show>
  </div></Show>;
  return {props,keydown,sync,view};
}

/** User message text with likely @-mention tokens (paths, quoted paths, skill: and tool:) set as inline chips. */
export function renderMentions(text:string):JSX.Element[]{
  const out:JSX.Element[]=[];let at=0;
  for(const match of text.matchAll(TOKEN)){
    const quoted=match[1]!==undefined,chip=quoted?match[0]:match[0].replace(/[.,;:!?)\]}]+$/,""),value=match[1]??match[2];
    if(!quoted&&!/^(skill|tool):./.test(value)&&!/[/.]/.test(chip.slice(1)))continue;
    out.push(text.slice(at,match.index),<span class="mention">{chip}</span>);at=match.index!+chip.length;
  }
  out.push(text.slice(at));
  return out;
}
