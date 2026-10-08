import { QA_GATE_STEPS, type GraphFact, type QaActionView, type QaArtifactView, type QaGateStep, type QaGateStepStatus, type QaGateStepView, type QaGateView } from "../../packages/contracts/index.js";

/** A graph fact as persisted: only its latest state per fact id, with when that state was stored. */
export interface GateFact {seq:number;sessionId:string;at:number;payload:GraphFact&{receiptEntryId?:string}}
export interface GateRun {id:string;revision:string;status:string;createdAt:number}
export interface GateFinding {id:string;runId:string;agentId:string;revision:string;artifactIds:string[];actionIds:string[];createdAt:number}
export interface GateReview {id:string;agentId:string;revision:string;status:string;endedAt:number|null}
export interface GateView {reviewId:string;artifactId:string}
export interface GateFix {id:string;kind:"write"|"merge";outcome:string|null;createdAt:number}
type Stored={anchor?:{runId:string;findingId:string;revision:string;agentId:string;at:number};receipt?:{factId:string;entryId:string;targetId:string;at:number};fix?:{id:string;kind:string;at:number};[key:string]:unknown};
/** Everything the gate reads. Each method is a read of a durable fact (SQLite rows, persisted graph events, the native session transcript); nothing is held in memory. */
export interface GateIo{
  sessionId:string;revision:string|null;stored:Stored;
  runs():Promise<GateRun[]>;actions(runId:string):Promise<QaActionView[]>;artifacts():Promise<QaArtifactView[]>;findings():Promise<GateFinding[]>;
  session(id:string):Promise<{id:string;parentId:string|null;status:string}|undefined>;
  facts(field:"source"|"reviewId",value:string):Promise<GateFact[]>;
  entryExists(sessionId:string,entryId:string):Promise<boolean>;
  fixes(after:number):Promise<GateFix[]>;reviews():Promise<GateReview[]>;views():Promise<GateView[]>;
}
const short=(value:string)=>value.slice(0,8);
const done=(a:QaActionView)=>a.status==="done";
export async function evaluateGate(io:GateIo):Promise<{view:QaGateView;patch:Record<string,unknown>}>{
  const steps:QaGateStepView[]=[],patch:Record<string,unknown>={};
  const put=(step:QaGateStep,status:QaGateStepStatus,detail:string,at:number|null=null,refs:Record<string,string>={})=>{steps.push({step,status,detail,at,refs});return status==="done";};
  const runs=await io.runs(),artifacts=await io.artifacts(),findings=await io.findings(),stored=io.stored;
  const actionsOf=new Map<string,QaActionView[]>();for(const run of runs)actionsOf.set(run.id,await io.actions(run.id));
  const failing=(runId:string)=>(actionsOf.get(runId)??[]).filter(a=>a.kind==="assert"&&done(a)&&a.outcome==="fail");
  const shots=(runId:string)=>artifacts.filter(a=>a.runId===runId);
  const qualifying=(runId:string)=>failing(runId).length>0&&shots(runId).length>0;

  // 1. R1_failed: a real failed assertion plus a screenshot in the same run.
  const anchorRun=stored.anchor?runs.find(run=>run.id===stored.anchor!.runId):runs.find(run=>qualifying(run.id));
  if(!anchorRun){put("r1_failed","pending","No QA run has a failed assertion and a screenshot yet");return finish();}
  put("r1_failed","done",`Run ${short(anchorRun.id)} failed ${failing(anchorRun.id).length} assertion(s) at revision ${short(anchorRun.revision)}`,anchorRun.createdAt,{runId:anchorRun.id,revision:anchorRun.revision});

  // 2. finding_recorded: a stored finding that cites a failed assertion and a screenshot of that run.
  let anchor=stored.anchor;
  if(!anchor){
    const found=findings.find(f=>f.runId===anchorRun.id&&f.actionIds.some(id=>failing(anchorRun.id).some(a=>a.id===id))&&f.artifactIds.some(id=>shots(anchorRun.id).some(a=>a.id===id)));
    if(found){anchor={runId:found.runId,findingId:found.id,revision:found.revision,agentId:found.agentId,at:found.createdAt};patch.anchor=anchor;}
  }
  if(!anchor){put("finding_recorded","pending","The QA agent has not recorded a finding citing the failed assertion and a screenshot");return finish();}
  put("finding_recorded","done",`Finding ${short(anchor.findingId)} by agent ${short(anchor.agentId)}`,anchor.at,{findingId:anchor.findingId,agentId:anchor.agentId});

  // 3. caller_receipt: the qa child's delegate result reached its caller, proven only by a persisted native turn_end receipt entry ID.
  const child=await io.session(anchor.agentId),parentId=child?.parentId??null;
  let receipt=stored.receipt;
  if(!receipt){
    if(!child||!parentId){put("caller_receipt","unknown","The QA agent session is unavailable, so delivery to its caller cannot be proven");return finish();}
    const facts=(await io.facts("source",anchor.agentId)).filter(f=>f.payload.kind==="result"&&f.payload.cause==="delegate_result"&&f.payload.target===parentId);
    const received=facts.find(f=>f.payload.outcome==="received"&&!!f.payload.receiptEntryId);
    if(received){
      if(await io.entryExists(parentId,received.payload.receiptEntryId!)){receipt={factId:received.payload.id,entryId:received.payload.receiptEntryId!,targetId:parentId,at:received.at};patch.receipt=receipt;}
      else{put("caller_receipt","unknown","The recorded receipt entry is not in the caller transcript");return finish();}
    }else{
      const caller=await io.session(parentId);
      if(facts.length)put("caller_receipt",caller?.status==="running"?"pending":"unknown",caller?.status==="running"?"Result dispatched; waiting for the caller turn_end entry":"Result was dispatched but no native turn_end entry ID was recorded; it is not replayed");
      else put("caller_receipt",child.status==="interrupted"||child.status==="error"?"unknown":"pending",child.status==="interrupted"||child.status==="error"?`QA agent ended as ${child.status} without delivering a result`:"The QA agent result has not reached its caller yet");
      return finish();
    }
  }
  put("caller_receipt","done",`Delivered to ${short(receipt.targetId)} as native entry ${receipt.entryId}`,receipt.at,{factId:receipt.factId,entryId:receipt.entryId,targetId:receipt.targetId});

  // 4. fix_approved: an approved write path applied after the receipt AND the Code revision moved off R1.
  const revision=io.revision;
  let fix=stored.fix;
  if(!fix){
    const fixes=await io.fixes(receipt.at),uncertain=fixes.find(f=>f.outcome==="applying"||f.outcome==="unknown"),applied=fixes.find(f=>f.outcome==="applied");
    if(uncertain){put("fix_approved","unknown",`${uncertain.kind} ${short(uncertain.id)} has an unknown outcome; resolve it first (never replayed)`,uncertain.createdAt,{id:uncertain.id});return finish();}
    if(applied&&revision&&revision!==anchor.revision){fix={id:applied.id,kind:applied.kind,at:applied.createdAt};patch.fix=fix;}
    else{put("fix_approved","pending",!revision?"Code revision is unavailable":applied?"A write was applied but the Code revision did not change":"Waiting for an approved fix that changes the Code revision");return finish();}
  }
  put("fix_approved","done",`Approved ${fix.kind} ${short(fix.id)} applied`,fix.at,{id:fix.id,kind:fix.kind});

  // 5. r1_stale: automatic once the revision differs from R1's.
  if(!revision){put("r1_stale","unknown","Code revision is unavailable");return finish();}
  if(revision===anchor.revision){put("r1_stale","pending","The Code revision is back at R1; R1 evidence is current again");return finish();}
  put("r1_stale","done",`R1 evidence (revision ${short(anchor.revision)}) is stale; current revision ${short(revision)}`,null,{revision});

  // 6. r2_passed: a fresh run at the current revision with passing assertions only and a screenshot.
  const keyed=(name:string)=>stored[`${name}:${revision}`] as any;
  let r2=keyed("r2");
  if(!r2){
    const candidates=runs.filter(run=>run.revision===revision&&run.id!==anchorRun.id);
    const verdict=(run:GateRun)=>{const acts=actionsOf.get(run.id)??[];
      if(acts.some(a=>a.status==="unknown"))return "unknown";
      const asserts=acts.filter(a=>a.kind==="assert"&&done(a));
      if(asserts.some(a=>a.outcome==="fail"))return "failed";
      return asserts.length&&shots(run.id).length&&run.status!=="unknown"&&run.status!=="failed"?"passed":"incomplete";};
    const passed=[...candidates].reverse().find(run=>verdict(run)==="passed");
    if(passed){const acts=actionsOf.get(passed.id)!;r2={runId:passed.id,revision,screenshotIds:shots(passed.id).map(a=>a.id),assertIds:acts.filter(a=>a.kind==="assert"&&done(a)).map(a=>a.id),at:passed.createdAt};patch[`r2:${revision}`]=r2;}
    else{
      const other=Object.keys(stored).some(key=>key.startsWith("r2:"));
      const state=candidates.some(run=>verdict(run)==="unknown")?"unknown":other?"stale":"pending";
      put("r2_passed",state,state==="unknown"?"An R2 run has an unknown action; start a fresh run (never replayed)":candidates.some(run=>verdict(run)==="failed")?"An R2 assertion failed":other?`Earlier R2 evidence is for another revision; run QA at ${short(revision)}`:`Waiting for a fresh QA run at revision ${short(revision)} with passing assertions and a screenshot`);
      return finish();
    }
  }
  put("r2_passed","done",`Run ${short(r2.runId)}: ${r2.assertIds.length} passing assertion(s), ${r2.screenshotIds.length} screenshot(s)`,r2.at,{runId:r2.runId,revision});

  // 7. reviewed: an independent reviewer (never the QA agent) completed at this revision after viewing an R2 artifact through qa_view_artifact.
  const views=await io.views(),reviews=(await io.reviews()).filter(r=>r.revision===revision&&r.agentId!==anchor!.agentId);
  let reviewed=keyed("reviewed");
  if(!reviewed){
    const viewed=(review:GateReview)=>views.filter(v=>v.reviewId===review.id&&r2.screenshotIds.includes(v.artifactId)).map(v=>v.artifactId);
    const good=[...reviews].reverse().find(review=>review.status==="completed"&&viewed(review).length);
    if(good){reviewed={reviewId:good.id,viewed:[...new Set(viewed(good))],at:good.endedAt??0};patch[`reviewed:${revision}`]=reviewed;}
    else{
      const unknown=reviews.find(r=>r.status==="unknown"),running=reviews.find(r=>r.status==="running"),noView=reviews.find(r=>r.status==="completed");
      put("reviewed",unknown&&!running?"unknown":"pending",unknown&&!running?`Review ${short(unknown.id)} has an unknown outcome`:running?"Reviewer is running":noView?"The completed review did not view an R2 artifact through qa_view_artifact":"Waiting for an independent revision review");
      return finish();
    }
  }
  put("reviewed","done",`Review ${short(reviewed.reviewId)} viewed ${reviewed.viewed.length} R2 artifact(s)`,reviewed.at,{reviewId:reviewed.reviewId});

  // 8. final_receipt: the review reached the caller chat, proven only by a persisted native turn_end entry ID.
  let final=keyed("final");
  if(!final){
    const facts=(await io.facts("reviewId",reviewed.reviewId)).filter(f=>f.payload.kind==="result"&&f.payload.cause==="user_review_transfer"&&f.payload.target===io.sessionId);
    const received=facts.find(f=>f.payload.outcome==="received"&&!!f.payload.receiptEntryId);
    if(received){
      if(await io.entryExists(io.sessionId,received.payload.receiptEntryId!)){final={factId:received.payload.id,entryId:received.payload.receiptEntryId!,at:received.at};patch[`final:${revision}`]=final;}
      else{put("final_receipt","unknown","The recorded receipt entry is not in the session transcript");return finish();}
    }else{
      const live=facts.filter(f=>f.payload.outcome!=="rejected");
      const caller=await io.session(io.sessionId);
      put("final_receipt",live.length&&caller?.status!=="running"?"unknown":"pending",live.length?(caller?.status==="running"?"Delivery dispatched; waiting for the native turn_end entry":"Delivery was dispatched but no native turn_end entry ID was recorded; it is not replayed"):"Deliver the review to the chat; prose or a settled run does not count");
      return finish();
    }
  }
  put("final_receipt","done",`Review delivered as native entry ${final.entryId}`,final.at,{factId:final.factId,entryId:final.entryId});
  return finish();

  function finish(){
    for(const step of QA_GATE_STEPS.slice(steps.length))put(step,"pending",`Waiting for ${QA_GATE_STEPS[QA_GATE_STEPS.indexOf(step)-1]}`);
    let state:QaGateStep|"none"="none";for(const step of steps){if(step.status!=="done")break;state=step.step;}
    const blocker=steps.find(step=>step.status==="unknown"||step.status==="stale");
    return {view:{sessionId:io.sessionId,revision:io.revision,state,blocked:blocker?`${blocker.step}: ${blocker.detail}`:null,steps},patch};
  }
}
