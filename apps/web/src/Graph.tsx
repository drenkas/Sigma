import { createEffect, createMemo, createSignal, For, Show, onCleanup, untrack } from "solid-js";
import type { GraphEvent, GraphFact, GraphNode, GraphSnapshot } from "../../../packages/contracts/index.js";
import { api } from "./api.js";

// Layout: an indented tree (fits the narrow details panel). Down edges run on the left trunk,
// returns and cross-chat transfers on lanes to the right of the cards.
const PAD=14,INDENT=34,NODE_W=264,NODE_H=82,GAP=18,TOP=52,LANE=10;
const labels:Record<GraphFact["kind"],string>={creation:"Created",delegation:"Delegated",result:"Result",prompt:"Prompt",steer:"Steer",followUp:"Follow-up",review_evidence:"Review evidence"};
const label=(fact:GraphFact)=>fact.kind==="result"&&fact.cause==="user_review_transfer"?"Review handoff":labels[fact.kind];
const family=(kind:GraphFact["kind"])=>kind==="creation"||kind==="delegation"?"down":kind==="result"?"result":kind==="review_evidence"?"review":"message";
const inFlight=(outcome:string)=>outcome==="pending"||outcome==="unknown";
const reasoning=(node:GraphNode)=>node.metadata.reasoningAvailability==="available"?node.metadata.reasoning??"—":node.metadata.reasoningAvailability;
const glyph:Record<string,string>={running:"",settled:"✓",error:"✕",interrupted:"‖",idle:"○"};
type Edge={key:string;event:GraphEvent;fact:GraphFact;tree:boolean;lane:number};

// waiting: chats paused on a pending approval (agent ID → tool), from the session snapshot.
export function Graph(p:{id:string;active:boolean;selected:string|null;waiting?:Record<string,string>;unsupervised?:Record<string,number>;onNode:(node:GraphNode)=>void}){
  const [graph,setGraph]=createSignal<GraphSnapshot|null>(null),[error,setError]=createSignal("");
  const [zoom,setZoom]=createSignal(1),[offset,setOffset]=createSignal({x:0,y:0}),[hover,setHover]=createSignal<string|null>(null);
  let viewport:HTMLDivElement|undefined,generation=0,moved=false,drag:{x:number;y:number;ox:number;oy:number}|undefined;
  const facts=createMemo(()=>{
    const latest=new Map<string,GraphEvent>();
    for(const event of graph()?.events??[])if(event.type==="graph_fact")latest.set((event.payload as GraphFact).id,event);
    return [...latest.values()].sort((a,b)=>a.seq-b.seq);
  });
  const fact=(event:GraphEvent)=>event.payload as GraphFact;
  const nodes=()=>graph()?.nodes??[];
  const byId=createMemo(()=>new Map(nodes().map(node=>[node.id,node])));
  // Tree parent: stored parent, else the chat that recorded creating/delegating it (multi-repo coordinator).
  const treeParent=createMemo(()=>{
    const ids=byId(),parent=new Map<string,string>();
    for(const node of nodes())if(node.parentId&&ids.has(node.parentId))parent.set(node.id,node.parentId);
    for(const event of facts()){const f=fact(event);if(family(f.kind)==="down"&&ids.has(f.source)&&ids.has(f.target)&&f.source!==f.target&&!parent.has(f.target))parent.set(f.target,f.source);}
    return parent;
  });
  const layout=createMemo(()=>{
    const parent=treeParent(),rootId=graph()?.rootId,order:{id:string;depth:number}[]=[],seen=new Set<string>();
    const kids=(id:string)=>nodes().filter(node=>parent.get(node.id)===id);
    const visit=(id:string,depth:number)=>{if(seen.has(id))return;seen.add(id);order.push({id,depth});for(const child of kids(id))visit(child.id,depth+1);};
    const tops=nodes().filter(node=>!parent.has(node.id)).sort((a,b)=>(a.id===rootId?-1:0)-(b.id===rootId?-1:0));
    for(const node of tops)visit(node.id,0);
    for(const node of nodes())visit(node.id,0);
    const positions=new Map(order.map((item,index)=>[item.id,{x:PAD+item.depth*INDENT,y:TOP+index*(NODE_H+GAP),depth:item.depth}]));
    const maxDepth=Math.max(0,...order.map(item=>item.depth));
    return {order,positions,right:PAD+maxDepth*INDENT+NODE_W};
  });
  const point=(id:string)=>layout().positions.get(id);
  const edges=createMemo(()=>{
    const parent=treeParent(),latest=new Map<string,GraphEvent>();
    for(const event of facts()){
      const f=fact(event);
      if(!point(f.source)||!point(f.target)||f.source===f.target)continue;
      const tree=family(f.kind)==="down"&&parent.get(f.target)===f.source;
      // Creation and delegation of the same child share one trunk; the latest fact labels it.
      latest.set(tree?`down:${f.target}`:`${f.source}:${f.target}:${family(f.kind)}`,event);
    }
    let lane=0;
    return [...latest.entries()].map(([key,event]):Edge=>{const tree=key.startsWith("down:");return {key,event,fact:fact(event),tree,lane:tree?0:lane++};});
  });
  const lanes=()=>edges().filter(edge=>!edge.tree).length;
  const width=()=>layout().right+PAD+Math.max(1,lanes())*LANE+8;
  const height=()=>Math.max(160,TOP+layout().order.length*(NODE_H+GAP)+8);
  const name=(id:string)=>{if(id==="user")return "You";const node=byId().get(id);if(!node)return `Unavailable ${id.slice(0,8)}`;return id===graph()?.rootId?"Root":`${cap(roleOf(node))} ${node.id.slice(0,4)}`;};
  const roleOf=(node:GraphNode)=>node.repositoryId&&!node.parentId?"repository":node.role;
  const selected=()=>p.selected??graph()?.rootId;
  const live=(f:GraphFact)=>inFlight(f.outcome)&&[f.source,f.target].some(id=>byId().get(id)?.status==="running");
  const userFacts=createMemo(()=>facts().filter(event=>fact(event).source==="user"));
  const rootUser=createMemo(()=>userFacts().filter(event=>fact(event).target===graph()?.rootId));
  const prompts=()=>rootUser().filter(event=>fact(event).kind!=="creation").length;
  const incoming=(id:string)=>{
    const all=facts().filter(event=>fact(event).target===id&&(family(fact(event).kind)==="down"||fact(event).source==="user"));
    return last(all,event=>fact(event).kind==="delegation")??all.at(-1);
  };
  const returned=(id:string)=>last(facts(),event=>fact(event).source===id&&(fact(event).kind==="result"||fact(event).kind==="review_evidence")&&fact(event).target!==id);
  const messages=(id:string)=>facts().filter(event=>fact(event).target===id&&family(fact(event).kind)==="message").length;
  const counts=createMemo(()=>{const c:Record<string,number>={};for(const node of nodes())c[node.status]=(c[node.status]??0)+1;return c;});
  const running=()=>counts().running??0;
  const related=(edge:Edge)=>!hover()||edge.fact.source===hover()||edge.fact.target===hover();

  function fit(){
    if(!viewport)return;
    const next=Math.max(.3,Math.min(1,(viewport.clientWidth-16)/width()));
    setZoom(next);setOffset({x:Math.max(8,(viewport.clientWidth-width()*next)/2),y:8});moved=false;
  }
  function changeZoom(value:number){moved=true;const next=Math.max(.3,Math.min(2,value)),previous=zoom(),x=(viewport?.clientWidth??360)/2,y=(viewport?.clientHeight??420)/2;setOffset(old=>({x:x-(x-old.x)*next/previous,y:y-(y-old.y)*next/previous}));setZoom(next);}
  // Keep the whole tree in view while it grows, until the user pans or zooms.
  createEffect(()=>{width();layout().order.length;if(!moved)queueMicrotask(fit);});
  const scopeId=createMemo(()=>p.id),enabled=createMemo(()=>p.active);
  createEffect(()=>{
    const id=scopeId(),active=enabled(),version=++generation;let closed=false,busy=false;
    setGraph(null);setError("");setZoom(1);setOffset({x:0,y:0});moved=false;
    async function refresh(){
      if(closed||busy||!active)return;busy=true;
      try{
        const existing=graph(),data=await api<GraphSnapshot>(`/sessions/${id}/graph${existing?`/events?after=${existing.cursor}`:""}`);
        if(closed||version!==generation)return;
        const events=existing?[...existing.events,...data.events.filter(event=>event.seq>existing.cursor)]:data.events;
        // Same bounded window as the snapshot; truncation is visible, not silently called complete.
        setGraph({...data,events:events.slice(-2000),truncated:data.truncated||!!existing?.truncated||events.length>2000});setError("");
        if(data.hasMore)queueMicrotask(()=>void refresh());
      }catch(e){if(!closed&&version===generation)setError(e instanceof Error?e.message:"Graph unavailable");}
      finally{busy=false;}
    }
    untrack(()=>void refresh());const timer=setInterval(()=>void refresh(),1000);
    onCleanup(()=>{closed=true;clearInterval(timer);});
  });

  function downPath(edge:Edge){
    const a=point(edge.fact.source)!,b=point(edge.fact.target)!,x=a.x+16,y=b.y+NODE_H/2,r=8;
    return `M${x} ${a.y+NODE_H} V${y-r} Q${x} ${y} ${x+r} ${y} H${b.x-2}`;
  }
  function lanePath(edge:Edge){
    const a=point(edge.fact.source)!,b=point(edge.fact.target)!,lane=layout().right+PAD+edge.lane*LANE;
    const sy=a.y+NODE_H/2+8,ty=b.y+NODE_H/2-8,r=Math.min(8,Math.abs(sy-ty)/2),dir=ty<sy?-1:1;
    return `M${a.x+NODE_W} ${sy} H${lane-r} Q${lane} ${sy} ${lane} ${sy+dir*r} V${ty-dir*r} Q${lane} ${ty} ${lane-r} ${ty} H${b.x+NODE_W+2}`;
  }
  function nodeKeys(e:KeyboardEvent,id:string){
    if(e.key!=="ArrowDown"&&e.key!=="ArrowUp")return;
    e.preventDefault();e.stopPropagation();
    const order=layout().order,index=order.findIndex(item=>item.id===id),next=order[index+(e.key==="ArrowDown"?1:-1)];
    if(next)viewport?.querySelector<HTMLButtonElement>(`[data-node="${next.id}"]`)?.focus();
  }
  return <section class="graph-panel" aria-label="Task orchestration graph">
    <Show when={error()}><p class="field-help warn" role="status">{error()} · Saved graph may be stale; reconnecting.</p></Show>
    <Show when={graph()} fallback={<p class="hint">Loading graph…</p>}>
      <header class="graph-head">
        <div class="graph-live" classList={{on:running()>0}} role="status" aria-live="polite">
          <span class="graph-pulse" aria-hidden="true"/>
          <strong>{running()?"Live":"Idle"}</strong>
          <span>{nodes().length} {nodes().length===1?"chat":"chats"}{running()?` · ${running()} running`:""}{counts().error?` · ${counts().error} failed`:""}</span>
          <Show when={Object.keys(p.waiting??{}).length}><span class="graph-wait">{Object.keys(p.waiting??{}).length} waiting for you</span></Show>
        </div>
        <div class="graph-tools" role="toolbar" aria-label="Graph view">
          <button class="icon-btn" onClick={()=>changeZoom(zoom()/1.25)} aria-label="Zoom out">−</button>
          <output aria-label="Graph zoom">{Math.round(zoom()*100)}%</output>
          <button class="icon-btn" onClick={()=>changeZoom(zoom()*1.25)} aria-label="Zoom in">+</button>
          <button class="btn ghost sm" onClick={fit}>Fit</button>
        </div>
      </header>
      <div class="graph-meter" aria-hidden="true">
        <For each={["settled","running","idle","interrupted","error"]}>{status=><Show when={counts()[status]}><span class={`seg seg-${status}`} style={{flex:counts()[status]}}/></Show>}</For>
      </div>
      <div ref={viewport} class="graph-viewport" tabindex="0" role="region" aria-label="Graph canvas. Arrow keys pan; Tab or arrow keys on a chat move between chats."
        style={{height:`min(62vh, ${Math.round(height()*zoom()+16)}px)`}}
        onKeyDown={e=>{if(e.target!==e.currentTarget)return;const delta=40;if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)){e.preventDefault();moved=true;setOffset(old=>({x:old.x+(e.key==="ArrowLeft"?delta:e.key==="ArrowRight"?-delta:0),y:old.y+(e.key==="ArrowUp"?delta:e.key==="ArrowDown"?-delta:0)}));}}}
        onPointerDown={e=>{if((e.target as Element).closest("button"))return;drag={x:e.clientX,y:e.clientY,ox:offset().x,oy:offset().y};e.currentTarget.setPointerCapture(e.pointerId);}}
        onPointerMove={e=>{if(drag){moved=true;setOffset({x:drag.ox+e.clientX-drag.x,y:drag.oy+e.clientY-drag.y});}}} onPointerUp={()=>{drag=undefined;}} onPointerCancel={()=>{drag=undefined;}}
        onWheel={e=>{if(e.ctrlKey||e.metaKey){e.preventDefault();changeZoom(zoom()*(e.deltaY>0?.9:1.1));return;}
          const view=e.currentTarget;if(height()*zoom()+16<=view.clientHeight&&width()*zoom()<=view.clientWidth)return;
          e.preventDefault();moved=true;setOffset(old=>({x:old.x-e.deltaX,y:Math.min(8,Math.max(view.clientHeight-height()*zoom()-8,old.y-e.deltaY))}));}}>
        <div class="graph-surface" style={{width:`${width()}px`,height:`${height()}px`,transform:`translate(${offset().x}px, ${offset().y}px) scale(${zoom()})`}}>
          <svg class="graph-links" width={width()} height={height()} aria-hidden="true">
            <defs>
              <For each={["down","result","review","message"]}>{kind=><marker id={`graph-arrow-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class={`arrow-${kind}`} d="M0 1 L10 5 L0 9 z"/></marker>}</For>
            </defs>
            <Show when={rootUser().length>0&&!!point(graph()!.rootId)}>
              <g class="graph-edge edge-message" classList={{live:live(fact(rootUser().at(-1)!)),dim:!!hover()&&hover()!==graph()!.rootId}}>
                <path d={`M${point(graph()!.rootId)!.x+16} 34 V${point(graph()!.rootId)!.y-2}`} marker-end="url(#graph-arrow-message)"/>
              </g>
            </Show>
            <For each={edges()}>{edge=><g class={`graph-edge edge-${family(edge.fact.kind)}`} classList={{live:live(edge.fact),dim:!related(edge)}} data-seq={edge.event.seq}>
              <path d={edge.tree?downPath(edge):lanePath(edge)} marker-end={`url(#graph-arrow-${family(edge.fact.kind)})`}><title>{`${label(edge.fact)} #${edge.event.seq} · ${edge.fact.outcome}: ${name(edge.fact.source)} → ${name(edge.fact.target)}`}</title></path>
            </g>}</For>
          </svg>
          <Show when={rootUser().length>0&&!!point(graph()!.rootId)}>
            <div class="graph-user" style={{left:`${PAD}px`,top:"8px"}}>
              <span class="graph-user-pill">You</span>
              <span class="graph-user-note">{label(fact(rootUser().at(-1)!))}{prompts()>1?` ×${prompts()}`:""} · #{rootUser().at(-1)!.seq} {fact(rootUser().at(-1)!).outcome}</span>
            </div>
          </Show>
          <For each={layout().order.map(item=>item.id)}>{id=>{
            const node=()=>byId().get(id)!,pos=()=>point(id)!,inbound=()=>incoming(id),outbound=()=>returned(id);
            return <Show when={byId().get(id)&&point(id)}><button class={`graph-node gs-${node().status}`} data-node={id} classList={{waiting:!!p.waiting?.[id],selected:selected()===id,root:id===graph()!.rootId,dim:!!hover()&&hover()!==id&&!edges().some(edge=>[edge.fact.source,edge.fact.target].includes(hover()!)&&[edge.fact.source,edge.fact.target].includes(id))}}
              style={{left:`${pos().x}px`,top:`${pos().y}px`,width:`${NODE_W}px`,height:`${NODE_H}px`}}
              onClick={()=>p.onNode(node())} onKeyDown={e=>nodeKeys(e,id)} onPointerEnter={()=>setHover(id)} onPointerLeave={()=>setHover(null)} onFocus={()=>setHover(id)} onBlur={()=>setHover(null)} aria-pressed={selected()===id}
              aria-label={`${node().title}. ${roleOf(node())}. ${node().status}${p.waiting?.[id]?`, waiting for your approval of ${p.waiting[id]}`:""}.${p.unsupervised?.[id]!==undefined?" Unsupervised: AGY runs its own tools without Sigma approvals.":""} Model ${node().model}. Reasoning ${reasoning(node())}.${inbound()?` ${label(fact(inbound()!))} by ${name(fact(inbound()!).source)}, ${fact(inbound()!).outcome}.`:""}${outbound()?` ${label(fact(outbound()!))} to ${name(fact(outbound()!).target)}, ${fact(outbound()!).outcome}.`:""} Open chat history.`}>
              <span class="gn-top"><span class={`gn-status st-${node().status}`} aria-hidden="true">{glyph[node().status]??"?"}</span><strong>{node().title}</strong><span class="gn-role">{roleOf(node())}</span></span>
              <span class="gn-meta"><span class="mono" title={node().model}>{node().model.split("/").at(-1)}</span><span class="gn-think" classList={{off:node().metadata.reasoningAvailability!=="available"}}>reasoning {reasoning(node())}</span></span><Show when={p.unsupervised?.[id]!==undefined}><span class="badge unsupervised" title="AGY runs its own tools without Sigma approvals">Unsupervised · {p.unsupervised![id]} AGY steps</span></Show>
              <span class="gn-flow">
                <Show when={inbound()}>{item=>{const f=()=>fact(item());return <span class={`gn-in edge-${family(f().kind)}`} title={`${label(f())} #${item().seq} · ${f().outcome}`}>↓ {label(f())} #{item().seq} · {f().outcome}</span>;}}</Show>
                <Show when={!p.waiting?.[id]} fallback={<span class="gn-out needs">⏸ approve {p.waiting![id]}</span>}><Show when={outbound()} fallback={<Show when={node().status==="running"}><span class="gn-out working">working…</span></Show>}>{item=>{const f=()=>fact(item());return <span class={`gn-out edge-${family(f().kind)}`} title={`${label(f())} #${item().seq} · ${f().outcome}`}>↑ {label(f())} #{item().seq} · {f().outcome}</span>;}}</Show></Show>
                <Show when={messages(id)}><span class="gn-msg">✉ {messages(id)}</span></Show>
              </span>
            </button></Show>;
          }}</For>
        </div>
      </div>
      <ul class="graph-legend" aria-label="Arrow types">
        <li><i class="lg lg-down"/>Delegated / created</li><li><i class="lg lg-result"/>Result returned</li><li><i class="lg lg-message"/>Prompt / message</li><li><i class="lg lg-review"/>Review</li><li><i class="lg lg-live"/>In flight</li>
      </ul>
      <Show when={nodes().some(node=>!node.creationAvailable)}><p class="field-help warn">Legacy metadata: creation actor and historical deliveries unavailable for chats without recorded facts. Reopening does not reconstruct them.</p></Show>
      <Show when={graph()!.truncated}><p class="field-help warn">Showing the latest 2,000 graph events of {graph()!.totalEvents}; earlier history is omitted.</p></Show>
      <details class="graph-log" open>
        <summary>Timeline <span class="count">{facts().length}</span><span class="muted small">{graph()!.hasMore?" · catching up":""} · settled does not prove delivery</span></summary>
        <ol aria-label="Ordered interactions and direction">
          <For each={facts()}>{event=>{const f=()=>fact(event);return <li class={`edge-${family(f().kind)}`} classList={{live:live(f())}} onPointerEnter={()=>setHover(f().target)} onPointerLeave={()=>setHover(null)}>
            <span class="gl-seq mono">#{event.seq}</span>
            <span class="gl-body"><strong>{label(f())}</strong> <span class="gl-path">{name(f().source)} → {name(f().target)}</span>
              <span class="gl-sub muted small">{new Date(event.at).toLocaleTimeString()} · {f().outcome}{f().actor!==f().source?` · actor ${name(f().actor)}`:""} · {f().cause}<Show when={f().run}> · run {f().run!.runId?.slice(0,8)}</Show><Show when={f().revision}> · rev {f().revision?.slice(0,10)}</Show></span>
            </span>
          </li>;}}</For>
        </ol>
      </details>
    </Show>
  </section>;
}
const last=<T,>(items:T[],test:(item:T)=>boolean)=>{for(let index=items.length-1;index>=0;index--)if(test(items[index]))return items[index];return undefined;};
const cap=(s:string)=>s.charAt(0).toUpperCase()+s.slice(1);
