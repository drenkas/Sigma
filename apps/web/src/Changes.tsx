import { createEffect, createSignal, For, Show, onCleanup } from "solid-js";
import type { ChangesView, CheckView, EvidenceView, SourceApplyView } from "../../../packages/contracts/index.js";
import { api } from "./api.js";

export function Changes(p:{id:string;revision:string;canVerify:boolean;canTypecheck:boolean;canApply:boolean;workspaceKind:"direct"|"worktree"|"clone"}){
  const [value,setValue]=createSignal<ChangesView|null>(null),[evidence,setEvidence]=createSignal<EvidenceView|null>(null),[applies,setApplies]=createSignal<SourceApplyView[]>([]);
  const [error,setError]=createSignal(""),[loading,setLoading]=createSignal(false),[busy,setBusy]=createSignal(false);
  const [testPath,setTestPath]=createSignal(""),[inputPaths,setInputPaths]=createSignal(""),[typeConfig,setTypeConfig]=createSignal("tsconfig.json"),[typeInputs,setTypeInputs]=createSignal("");let generation=0;
  async function refresh(){
    const id=p.id,version=++generation;setLoading(true);setError("");setEvidence(null);
    try{
      const [changes,proof,source]=await Promise.all([api<ChangesView>(`/sessions/${id}/changes`),p.canVerify?api<EvidenceView>(`/sessions/${id}/evidence`):Promise.resolve(null),p.canApply?api<{applies:SourceApplyView[]}>(`/sessions/${id}/source-applies`):Promise.resolve({applies:[]})]);
      if(version===generation){setValue(changes);setEvidence(proof);setApplies(source.applies);}
    }catch(e){if(version===generation){setValue(null);setEvidence(null);setApplies([]);setError(e instanceof Error?e.message:"Cannot load changes");}}
    finally{if(version===generation)setLoading(false);}
  }
  async function action(run:()=>Promise<unknown>){setBusy(true);setError("");try{await run();await refresh();}catch(e){setError(e instanceof Error?e.message:"Action failed");}finally{setBusy(false);}}
  function prepare(){
    const paths=inputPaths().split(",").map(x=>x.trim()).filter(Boolean);
    void action(()=>api(`/sessions/${p.id}/checks`,"POST",{testPath:testPath().trim(),inputPaths:paths},crypto.randomUUID()));
  }
  function prepareTypecheck(){
    const paths=typeInputs().split(",").map(x=>x.trim()).filter(Boolean);
    void action(()=>api(`/sessions/${p.id}/typechecks`,"POST",{configPath:typeConfig().trim(),inputPaths:paths},crypto.randomUUID()));
  }
  function decide(check:CheckView,allow:boolean){void action(()=>api(`/sessions/${p.id}/checks/${check.id}/decision`,"POST",{allow}));}
  function stop(check:CheckView){void action(()=>api(`/sessions/${p.id}/checks/${check.id}/abort`,"POST",{}));}
  function stopReview(id:string){void action(()=>api(`/sessions/${p.id}/reviews/${id}/abort`,"POST",{}));}
  function review(check:CheckView){void action(()=>api(`/sessions/${p.id}/reviews`,"POST",{checkId:check.id}));}
  function sendFindings(id:string){
    const key=`sigma-review-transfer-${p.id}-${id}`,command=sessionStorage.getItem(key)||crypto.randomUUID();sessionStorage.setItem(key,command);
    void action(async()=>{const result=await api<{status:string}>(`/sessions/${p.id}/prompt`,"POST",{text:"Consider these advisory review findings and propose the smallest next step. Ask before reading or editing files.",reviewId:id,behavior:"followUp"},command);if(!["dispatched","queued","completed"].includes(result.status))throw new Error("Review transfer outcome is uncertain; inspect chat history before another request.");sessionStorage.removeItem(key);});
  }
  function prepareApply(){void action(()=>api(`/sessions/${p.id}/source-applies`,"POST",{},crypto.randomUUID()));}
  function decideApply(item:SourceApplyView,allow:boolean){void action(()=>api(`/sessions/${p.id}/source-applies/${item.id}/decision`,"POST",{allow}));}
  function stopApply(item:SourceApplyView){void action(()=>api(`/sessions/${p.id}/source-applies/${item.id}/abort`,"POST",{}));}
  function reconcileApply(item:SourceApplyView){
    const files=item.files.map(file=>({path:file.path,observedHash:file.observedHash??"unavailable",observedMode:file.observedMode??null,observation:file.observation??"diverged" as const}));
    void action(()=>api(`/sessions/${p.id}/source-applies/${item.id}/reconcile`,"POST",{acknowledge:true,sourceCwd:item.sourceCwd,files}));
  }
  createEffect(()=>{p.id;p.revision;p.canVerify;p.canApply;void refresh();});onCleanup(()=>{generation++;});
  const coherent=()=>!!value()&&!!evidence()&&evidence()!.revision===value()!.revision;
  const currentCheck=(check:CheckView)=>coherent()&&check.current&&check.revision===value()!.revision;
  const currentReviewer=(review:EvidenceView["reviews"][number])=>coherent()&&review.current&&review.revision===value()!.revision;
  const currentReview=(check:CheckView)=>evidence()?.reviews.some(r=>r.checkId===check.id&&currentReviewer(r)&&r.status==="completed");
  const readyToApply=()=>evidence()?.checks.some(check=>currentCheck(check)&&check.status==="passed"&&currentReview(check))??false;
  const hasPassed=()=>evidence()?.checks.some(check=>currentCheck(check)&&check.status==="passed")??false,hasReview=()=>evidence()?.reviews.some(r=>currentReviewer(r)&&r.status==="completed")??false;
  const missingProof=()=>!hasPassed()&&!hasReview()?"Warning: this revision has no passed check and no completed review yet.":!hasPassed()?"Warning: this revision has no passed check yet.":"Warning: this revision has no completed review yet.";
  return <section class="panel" aria-labelledby="h-changes">
    <div class="field-row"><h3 id="h-changes" class="panel-title">Code changes</h3><button class="btn ghost sm" disabled={loading()} onClick={()=>void refresh()}>{loading()?"Checking…":"Refresh changes"}</button></div>
    <p class="hint">{p.workspaceKind==="direct"?"Approved edits change the selected folder immediately. The working-tree diff may include changes that were already there.":p.workspaceKind==="worktree"?"Edits stay in this Git worktree. Downloading a patch does not apply it to the source folder.":"Edits stay in this legacy Git copy. Downloading a patch does not apply it to the source folder."}</p>
    <Show when={error()}><p class="field-help warn" role="alert">{error()}</p></Show>
    <Show when={value()}>{snapshot=><>
      <dl class="summary"><div class="stack"><dt>{p.workspaceKind==="direct"?"Selected folder":"Source folder"}</dt><dd class="mono dd-wrap">{snapshot().sourceCwd}</dd></div><Show when={p.workspaceKind!=="direct"}><div class="stack"><dt>{p.workspaceKind==="worktree"?"Git worktree":"Legacy Git copy"}</dt><dd class="mono dd-wrap">{snapshot().cwd}</dd></div></Show><div><dt>Base commit</dt><dd class="mono">{snapshot().baseCommit.slice(0,12)}</dd></div><div><dt>Revision</dt><dd class="mono">{snapshot().revision.slice(0,12)}</dd></div></dl>
      <p class="hint">{snapshot().files.length} {p.workspaceKind==="direct"?"current working-tree":"changed"} file(s)<Show when={snapshot().omitted}> · {snapshot().omitted} unsupported or sensitive file(s) omitted</Show></p>
      <Show when={snapshot().files.length}><ul class="file-list" aria-label="Changed files"><For each={snapshot().files}>{file=><li class="mono" title={file}><span class="file-dir">{file.includes("/")?file.slice(0,file.lastIndexOf("/")+1):""}</span>{file.split("/").pop()}</li>}</For></ul></Show>
      <Show when={snapshot().diff}><pre class="change-diff" tabindex="0" aria-label={p.workspaceKind==="direct"?"Current changes in selected folder":"Current changes in isolated workspace"}>{snapshot().diff}</pre><Show when={!loading()&&!snapshot().omitted}><a class="btn ghost sm" href={`/api/sessions/${p.id}/changes.patch?revision=${snapshot().revision}`} download="">{p.workspaceKind==="direct"?"Download patch":"Download patch · manual transfer"}</a></Show></Show>
      <Show when={!p.canVerify}><p class="hint">This saved Code session keeps its original editing policy. Start a new Code session for controlled checks.</p></Show>
      <Show when={p.canVerify}>
        <h4 class="panel-title">Controlled Node check</h4>
        <Show when={!coherent()}><p class="field-help warn" role="status">Check evidence is loading or belongs to a different revision. Refresh changes before approval or review.</p></Show>
        <p class="hint">Choose a .test.mjs file and list every file it imports. Only these files enter the check snapshot; other imports fail. The next card shows the exact command before approval.</p>
        <label class="field"><span class="field-label">Test file</span><input class="input mono" value={testPath()} onInput={e=>setTestPath(e.currentTarget.value)} placeholder="sum.test.mjs"/></label>
        <label class="field"><span class="field-label">Other input files, comma-separated</span><input class="input mono" value={inputPaths()} onInput={e=>setInputPaths(e.currentTarget.value)} placeholder="sum.mjs"/></label>
        <button class="btn ghost sm" disabled={busy()||loading()||!coherent()||!testPath().trim()} onClick={prepare}>Prepare check</button>
        <Show when={p.canTypecheck}><h4 class="panel-title">Direct TypeScript check</h4>
        <p class="hint">Use a JSON config with an explicit files list. Add any imported files. The approved snapshot contains only those inputs and a copied installed TypeScript package; shell and child processes stay disabled.</p>
        <label class="field"><span class="field-label">TypeScript config</span><input class="input mono" value={typeConfig()} onInput={e=>setTypeConfig(e.currentTarget.value)}/></label>
        <label class="field"><span class="field-label">Other input files, comma-separated</span><input class="input mono" value={typeInputs()} onInput={e=>setTypeInputs(e.currentTarget.value)} placeholder="src/helper.ts"/></label>
        <button class="btn ghost sm" disabled={busy()||loading()||!coherent()||!typeConfig().trim()} onClick={prepareTypecheck}>Prepare TypeScript check</button></Show>
        <Show when={evidence()?.error}><p class="field-help warn">{evidence()!.error}</p></Show>
        <For each={evidence()?.checks||[]}>{check=><div class="panel">
          <div class="field-row"><strong>{check.kind==="typescript"?"TypeScript":"Node test"} {check.id.slice(0,8)}</strong><span class="muted small">{currentCheck(check)?"Current revision":"Stale revision"} · {check.status}</span></div>
          <Show when={check.status==="pending"}><>
            <p class="hint">Approve this exact command and snapshot:</p>
            <pre class="change-diff" tabindex="0">{JSON.stringify({argv:check.argv,cwd:check.cwd,revision:check.revision,inputs:check.inputs,dependencyDigest:check.dependencyDigest,timeoutMs:check.timeoutMs,outputLimit:check.outputLimit},null,2)}</pre>
            <div class="field-row"><button class="btn danger-ghost sm" disabled={busy()} onClick={()=>decide(check,false)}>Deny check</button><button class="btn primary sm" disabled={busy()||loading()||!currentCheck(check)} onClick={()=>decide(check,true)}>Approve and run</button></div>
          </></Show>
          <Show when={check.status==="approved"||check.status==="running"}><button class="btn danger-ghost sm" disabled={busy()} onClick={()=>stop(check)}>Stop check</button></Show>
          <Show when={check.endedAt}><p class="hint">Exit: {check.exitCode===null?"unknown":check.exitCode} · Revision {check.revision.slice(0,12)}<Show when={check.inputChanged}> · Snapshot inputs changed during check</Show><Show when={check.truncated}> · Output truncated</Show></p></Show>
          <Show when={check.output}><pre class="change-diff" tabindex="0" aria-label={`Check ${check.id.slice(0,8)} output`}>{check.output}</pre></Show>
          <Show when={currentCheck(check)&&(check.status==="passed"||check.status==="failed")&&!currentReview(check)}><button class="btn ghost sm" disabled={busy()||loading()} onClick={()=>review(check)}>Start independent review</button></Show>
        </div>}</For>
        <For each={evidence()?.reviews||[]}>{review=><div class="panel">
          <div class="field-row"><strong>Reviewer {review.agentId.slice(0,8)}</strong><span class="muted small">{currentReviewer(review)?"Current revision":"Stale revision"} · {review.status}</span></div>
          <p class="hint">Read-only Pi review of {review.revision.slice(0,12)} · advisory findings</p>
          <Show when={review.status==="running"}><button class="btn danger-ghost sm" disabled={busy()} onClick={()=>stopReview(review.id)}>Stop reviewer</button></Show>
          <Show when={review.status==="completed"}><button class="btn ghost sm" disabled={busy()} onClick={()=>sendFindings(review.id)}>Send findings to root chat</button></Show>
          <Show when={review.findings}><pre class="change-diff" tabindex="0" aria-label="Reviewer findings">{review.findings}</pre></Show>
        </div>}</For>
        <Show when={evidence()?.qaRuns.length||evidence()?.qaFindings.length}><h4 class="panel-title">QA evidence</h4>
        <For each={evidence()?.qaRuns||[]}>{run=><div class="panel">
          <div class="field-row"><strong>QA run {run.id.slice(0,8)}</strong><span class="muted small">{coherent()&&run.current?"Current revision":"Stale revision"} · {run.status}</span></div>
          <p class="hint mono small">Revision {run.revision.slice(0,12)} · manifest {run.manifestHash.slice(0,12)} · entry {run.entry}</p>
        </div>}</For>
        <For each={evidence()?.qaFindings||[]}>{finding=><div class="panel">
          <div class="field-row"><strong>QA finding · {finding.severity}</strong><span class="muted small">{coherent()&&finding.current?"Current revision":"Stale revision"}</span></div>
          <p class="hint">{finding.summary}</p>
          <p class="hint mono small">Revision {finding.revision.slice(0,12)} · run {finding.runId.slice(0,8)} · {finding.artifactIds.length} screenshot(s) · {finding.actionIds.length} assertion(s)</p>
        </div>}</For></Show>
        <Show when={p.canApply}><h4 class="panel-title">Apply to source repository</h4>
        <p class="hint">Copies these changes into your original folder after you approve the exact diff. Running a check and a review first is recommended. Touched dirty or staged paths and a changed HEAD/branch block it; the app does not stage or commit.</p>
        <Show when={coherent()&&!readyToApply()}><p class="field-help warn" role="status">{missingProof()}</p></Show>
        <button class="btn danger-ghost sm" disabled={busy()||loading()||!!snapshot().omitted} onClick={prepareApply}>Prepare source Apply</button>
        <For each={applies()}>{item=><div class="panel">
          <div class="field-row"><strong>Source Apply {item.id.slice(0,8)}</strong><span class="muted small">{item.status==="reconciled"?item.current?"Reconciled observations still match":"Reconciled observations or revision are stale":coherent()&&item.current&&item.revision===snapshot().revision?"Current revision":"Stale or changed source"} · {item.status}</span></div>
          <Show when={item.status==="pending"}><>
            <p class="hint">Review this exact source mutation before allowing it:</p>
            <pre class="change-diff" tabindex="0">{JSON.stringify({source:item.sourceCwd,head:item.head,branch:item.branch,revision:item.revision,files:item.files},null,2)}</pre>
            <pre class="change-diff" tabindex="0">{item.diff}</pre>
            <Show when={item.verified}>{v=><p class="hint">Verification at this revision: {v().check?"check passed":"no passed check"} · {v().review?"review completed":"no completed review"}.</p>}</Show>
            <div class="field-row"><button class="btn danger-ghost sm" disabled={busy()} onClick={()=>decideApply(item,false)}>Deny Apply</button><button class="btn primary sm" disabled={busy()||loading()||!coherent()||!item.current||item.revision!==snapshot().revision} onClick={()=>decideApply(item,true)}>Apply to original source</button></div>
          </></Show>
          <Show when={item.status==="approved"||item.status==="running"}><button class="btn danger-ghost sm" disabled={busy()} onClick={()=>stopApply(item)}>Stop Apply</button></Show>
          <Show when={item.status==="unknown"||item.status==="partial"}><>
            <p class="hint">Inspect the exact source state below. Confirming records observations only; it does not write or replay files.</p>
            <pre class="change-diff" tabindex="0">{JSON.stringify({session:item.sessionId,source:item.sourceCwd,files:item.files.map(file=>({path:file.path,observation:file.observation??"unavailable",observedHash:file.observedHash??"unavailable",observedMode:file.observedMode??null}))},null,2)}</pre>
            <button class="btn primary sm" disabled={busy()||loading()||item.files.some(file=>!file.observedHash||file.observedHash==="unavailable")} onClick={()=>reconcileApply(item)}>Acknowledge these source observations</button>
          </></Show>
          <For each={item.files}>{file=><p class="hint mono">{file.path}: {file.status}<Show when={file.observation}> · observed {file.observation} ({file.observedHash}, mode {file.observedMode??"missing"})</Show><Show when={file.error}> · {file.error}</Show><Show when={file.recoveryPath}> · preimage {file.recoveryPath}</Show></p>}</For>
          <Show when={item.error}><p class="field-help warn">{item.error}</p></Show>
        </div>}</For></Show>
      </Show>
    </>}</Show>
  </section>;
}
