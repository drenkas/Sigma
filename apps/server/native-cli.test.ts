import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

// Import the SDK only after separating every credential/config owner from the user's home.
const scratch=resolve(import.meta.dirname,'../../.scratch',`native-cli-${Date.now()}-${process.pid}`);
for(const key of Object.keys(process.env))if(!['PATH','TMPDIR','USER','SIGMA_APPROVAL_MODE'].includes(key))delete process.env[key];
process.env.HOME=scratch;process.env.PI_CODING_AGENT_DIR=join(scratch,'agent');
const {ModelRuntime}=await import('@earendil-works/pi-coding-agent');
const {Type}=await import('@earendil-works/pi-ai');
const {NativeCli,CLAUDE_PROVIDER_ID,nativeEnvironment}=await import('./native-cli.js');
const {registerClaudeProvider}=await import('./claude-provider.js');
const {PiHost}=await import('./pi-host.js');
const {Storage}=await import('./storage.js');
await mkdir(join(scratch,'.local/bin'),{recursive:true,mode:0o700});
const fixture=(await readFile(join(import.meta.dirname,'claude-cli.fixture.mjs'),'utf8')).replace('#!/usr/bin/env node',`#!${process.execPath}`);
await writeFile(join(scratch,'.local/bin/claude'),fixture,{mode:0o700});
const mode=async(value:string)=>writeFile(join(scratch,'scenario.json'),JSON.stringify({mode:value,ownerUser:process.env.USER}),{mode:0o600});
const observed=async()=>{try{return (await readFile(join(scratch,'observed.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));}catch{return [];}};
async function waitFor<T>(check:()=>Promise<T|undefined>,timeout=8000){const until=Date.now()+timeout;while(Date.now()<until){const result=await check();if(result!==undefined)return result;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Fixture timed out');}
// macOS can briefly retain a killed orphan PID after its process group is gone.
// Zombies cannot execute; running or SIGSTOP descendants must still fail drain.
const alive=(pid:number)=>{try{process.kill(pid,0);const state=execFileSync('/bin/ps',['-p',String(pid),'-o','stat='],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();return !!state&&!state.startsWith('Z');}catch{return false;}};
async function setup(name:string){const dir=join(scratch,name);await mkdir(dir,{recursive:true,mode:0o700});const owner=new NativeCli(dir);await owner.init();await owner.connect(CLAUDE_PROVIDER_ID);assert.equal(owner.list()[0].message,'Official CLI account · local route connected');const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:null,allowModelNetwork:false});const registration=registerClaudeProvider(runtime,owner);await runtime.refresh({allowNetwork:false});return {dir,owner,runtime,registration,model:runtime.getModel(CLAUDE_PROVIDER_ID,'claude-sonnet-4-6')!};}
const tool={name:'read',description:'Read a file',parameters:Type.Object({path:Type.String()})};

test('owned CLI stream validates every proposal before Pi tool events and preserves Unicode deltas',async()=>{
  await mode('normal');const {owner,runtime,model}=await setup('stream');
  try{
    const stream=runtime.streamSimple(model,{systemPrompt:'Actual Pi system',messages:[{role:'user',content:'hello',timestamp:Date.now()}],tools:[tool]},{reasoning:'high',env:{HOME:'/invalid',PATH:'/invalid',TMPDIR:'/invalid',USER:'other-owner',ANTHROPIC_API_KEY:'fixture-key',CLAUDE_CODE_OAUTH_TOKEN:'fixture-token',CLAUDE_CODE_DISABLE_CLAUDE_MDS:'0'}});
    const events=[];for await(const event of stream)events.push(event);const result=await stream.result();
    assert.equal(result.stopReason,'stop');assert.equal(result.usage.totalTokens,37);assert.equal(result.content[0].type,'text');assert.equal((result.content[0] as any).text,'Hello 🐱');
    assert.equal(events.filter(event=>event.type==='done'||event.type==='error').length,1);
    assert.equal(events.filter(event=>event.type==='text_delta').map(event=>(event as any).delta).join(''),'Hello 🐱');
    assert.ok(events.filter(event=>event.type==='text_delta').every(event=>!/[\uD800-\uDBFF]$/.test((event as any).delta)));
    const record=(await observed()).filter(row=>row.kind==='completion').at(-1)!;assert.equal(record.home,scratch);assert.equal(record.disableMds,'1');assert.equal(record.userOwnerMatches,true,'Per-call USER cannot switch official CLI ownership');assert.ok(!record.envKeys.some((key:string)=>/API_KEY|OAUTH_TOKEN|AWS_|NODE_OPTIONS/.test(key)));
    assert.equal((await stat(record.cwd).catch(()=>undefined)),undefined,'Private request cwd is retired only after drain');
    const protocol=[...(await observed())].reverse().find(row=>row.args);assert.equal(protocol.systemMode,0o600);assert.deepEqual(protocol.args.slice(protocol.args.indexOf('--tools'),protocol.args.indexOf('--tools')+2),['--tools','']);
    for(const level of ['off','minimal','xhigh'])assert.equal(model.thinkingLevelMap?.[level as keyof typeof model.thinkingLevelMap],null);assert.equal(model.thinkingLevelMap?.max,'max');
    await mode('batch-invalid');const rejected=runtime.streamSimple(model,{messages:[{role:'user',content:'read:note.txt',timestamp:Date.now()}],tools:[tool]});const invalid=[];for await(const event of rejected)invalid.push(event);assert.equal((await rejected.result()).stopReason,'error');assert.equal(invalid.filter(event=>event.type.startsWith('toolcall')).length,0,'No first valid proposal escapes an invalid batch');
    for(const scenario of ['hooks','wrong-id','permission','permission-later','permission-malformed','native-tool','native-action','unknown-system','status-unknown','status-compacting','status-session','status-uuid','status-extra']){await mode(scenario);const dispatchedBefore=(await observed()).filter(row=>row.transcript).length;const rejected=runtime.streamSimple(model,{messages:[{role:'user',content:'hello',timestamp:Date.now()}],tools:[tool]});const rejectedEvents=[];for await(const event of rejected)rejectedEvents.push(event);const failed=await rejected.result();assert.equal(failed.stopReason,'error',scenario);assert.equal(rejectedEvents.filter(event=>event.type.startsWith('toolcall')).length,0,`${scenario} cannot publish Pi proposals`);assert.ok(!JSON.stringify(failed).includes('fixture-token'));if(['hooks','wrong-id','permission','permission-later','permission-malformed'].includes(scenario))assert.equal((await observed()).filter(row=>row.transcript).length,dispatchedBefore,`${scenario} must fail before any user dispatch`);}
    await mode('normal');const before=(await observed()).length;await assert.rejects(runtime.getAuth(model,{apiKey:'fixture-explicit-key'}));assert.equal((await observed()).length,before,'Explicit API key cannot dispatch a CLI or a fallback');
    await owner.disconnect(CLAUDE_PROVIDER_ID);assert.equal((await runtime.getAvailable(CLAUDE_PROVIDER_ID)).length,0);assert.equal(nativeEnvironment({HOME:'/other',PATH:'/other'}).HOME,scratch);
  }finally{await owner.close();}
});

test('all current Claude CLI models are registered and each runs with its own identity and effort contract',async()=>{
  await mode('normal');const {owner,runtime}=await setup('lineup');
  try{
    const ids=['claude-fable-5-1','claude-opus-5-5','claude-sonnet-5-5','claude-haiku-4-5-20251001','claude-sonnet-4-6'];
    assert.deepEqual(runtime.getModels(CLAUDE_PROVIDER_ID).map(entry=>entry.id).sort(),[...ids].sort());
    for(const id of ids){
      const selected=runtime.getModel(CLAUDE_PROVIDER_ID,id)!,haiku=id.includes('haiku');assert.equal(selected.reasoning,!haiku);
      const stream=runtime.streamSimple(selected,{messages:[{role:'user',content:'hello',timestamp:Date.now()}],tools:[tool]},haiku?{}:{reasoning:id==='claude-sonnet-4-6'?'high':'xhigh'});
      for await(const event of stream)void event;assert.equal((await stream.result()).stopReason,'stop',id);
      const protocol=[...(await observed())].reverse().find(row=>row.args)!;assert.equal(protocol.args[protocol.args.indexOf('--model')+1],id);assert.equal(protocol.args.includes('--effort'),!haiku,id);
    }
    const legacy=runtime.getModel(CLAUDE_PROVIDER_ID,'claude-sonnet-4-6')!;const rejected=runtime.streamSimple(legacy,{messages:[{role:'user',content:'hello',timestamp:Date.now()}],tools:[tool]},{reasoning:'xhigh'});for await(const event of rejected)void event;assert.equal((await rejected.result()).stopReason,'error','xhigh is not offered for claude-sonnet-4-6');
  }finally{await owner.close();}
});

test('real Pi approval Allow and Deny return actual tool results to the next CLI request',async()=>{
  await mode('normal');const dir=join(scratch,'pi'),workspace=join(scratch,'workspace');await mkdir(dir,{recursive:true});await mkdir(workspace);await writeFile(join(workspace,'note.txt'),'owned Pi read result\n');
  const storage=new Storage(join(dir,'state.sqlite')),host=new PiHost(storage,dir,async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);});await host.init();await host.nativeProviders.connect(CLAUDE_PROVIDER_ID);
  try{
    for(const allow of [true,false]){
      const sid=await host.create(workspace,`${CLAUDE_PROVIDER_ID}/claude-sonnet-4-6`);await host.prompt(sid,'read:note.txt');
      const approval=await waitFor(async()=>(await host.snapshot(sid)).approvals.find(item=>item.status==='pending'));assert.equal(approval.tool,'read');
      await host.decide(sid,approval.id,allow);await waitFor(async()=>(await host.snapshot(sid)).status==='settled'?true:undefined);
      const snapshot=await host.snapshot(sid);assert.ok(snapshot.messages.some(message=>message.role==='assistant'&&message.text.includes(allow?'owned Pi read result':'Denied by Pi')));
      const followup=[...(await observed())].reverse().find(row=>row.transcript?.some((message:any)=>message.role==='toolResult'))!;
      const call=[...followup.transcript].reverse().find((message:any)=>message.role==='assistant').content.find((part:any)=>part.type==='toolCall'),result=[...followup.transcript].reverse().find((message:any)=>message.role==='toolResult');
      assert.equal(result.toolCallId,call.id);assert.equal(result.toolName,'read');assert.equal(!!result.isError,!allow);assert.ok(followup.currentTools.some((item:any)=>item.name==='read'));
      assert.equal(snapshot.approvals.find(item=>item.id===approval.id)?.status,allow?'approved':'denied');
      const events=await storage.call<any[]>("events",{sessionId:sid});assert.ok(events.some(event=>event.type==="graph_message"&&event.payload.entryId),"Pi turn_end persisted a native history entry ID");
    }
  }finally{await host.close();await storage.close();}
});

test('connect cancellation, offline mode and catalog overlays cannot restore or reroute native auth',async()=>{
  await mode('normal');const {owner,runtime,dir,registration,model}=await setup('lifecycle');
  try{
    await mode('held-status');const connect=owner.connect(CLAUDE_PROVIDER_ID);await waitFor(async()=>{try{return await readFile(join(scratch,'status-ready'),'utf8');}catch{return undefined;}});
    await owner.disconnect(CLAUDE_PROVIDER_ID);await connect;assert.equal(owner.isConnected(),false);assert.equal(JSON.parse(await readFile(join(dir,'native-providers.json'),'utf8')).claude,false);
    await mode('normal');await owner.connect(CLAUDE_PROVIDER_ID);const overlay=join(dir,'overlay.json');await writeFile(overlay,JSON.stringify({providers:{[CLAUDE_PROVIDER_ID]:{baseUrl:'https://example.invalid',models:[{id:model.id,name:'Overlay',api:'openai-completions',contextWindow:1000,maxTokens:100,input:['text'],reasoning:false,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
    const composed=await ModelRuntime.create({authPath:join(dir,'auth-overlay.json'),modelsPath:overlay,allowModelNetwork:false});registerClaudeProvider(composed,owner);await composed.refresh({allowNetwork:false});assert.notEqual(composed.getProvider(CLAUDE_PROVIDER_ID),composed.getRegisteredNativeProvider(CLAUDE_PROVIDER_ID));assert.equal((await composed.getAvailable(CLAUDE_PROVIDER_ID)).length,0);assert.equal(owner.list()[0].state,'blocked');let http=0;const blocked=await composed.completeSimple(composed.getModel(CLAUDE_PROVIDER_ID,model.id)!,{messages:[{role:'user',content:'hello',timestamp:Date.now()}]},{fetch:async()=>{http++;throw new Error('Network must not be used');}});assert.equal(blocked.stopReason,'error');assert.equal(http,0);
    registration.identity();process.env.PI_OFFLINE='1';const before=(await observed()).length;await owner.refresh(CLAUDE_PROVIDER_ID);assert.equal(owner.list()[0].state,'blocked');assert.equal((await observed()).length,before);delete process.env.PI_OFFLINE;
  }finally{delete process.env.PI_OFFLINE;await owner.close();}
});

test('Cancel status drains only the current probe and preserves a concurrent Pi completion',async()=>{
  await mode('normal');const {owner,runtime,model}=await setup('cancel-status');
  try{
    await mode('held-status-completion');const before=(await observed()).length;
    const stream=runtime.streamSimple(model,{messages:[{role:'user',content:'hello',timestamp:Date.now()}]});const resultWork=stream.result();
    const completion=await waitFor(async()=>(await observed()).slice(before).find(row=>row.completionReady));
    const refresh=owner.refresh(CLAUDE_PROVIDER_ID);await waitFor(async()=>(await observed()).slice(before).find(row=>row.statusReady));
    await owner.cancel(CLAUDE_PROVIDER_ID);await refresh;
    assert.equal(owner.isConnected(),true,'Cancel status retains the previously verified local route');assert.equal(alive(completion.pid),true,'Status cancellation does not stop the independent completion');
    await writeFile(join(scratch,`release-completion-${completion.pid}`),'release');const result=await resultWork;assert.equal(result.stopReason,'stop');assert.equal((result.content[0] as any).text,'Hello 🐱');
  }finally{await owner.close();}
});

test('abort, timeout, helper crash and parent SIGKILL drain the owned process group including descendants',async()=>{
  await mode('normal');const {owner}=await setup('drain');
  try{
    for(const stop of ['abort','timeout'] as const){await mode('descendant');const controller=new AbortController(),before=(await observed()).length;const request=owner.run({signal:controller.signal,timeoutMs:stop==='timeout'?300:5000,prepare:async()=>['-p'],onLine:()=>{}});const rejected=assert.rejects(request);const rows=await waitFor(async()=>{const rows=(await observed()).slice(before);return rows.some(row=>row.descendant)?rows:undefined;});if(stop==='abort')controller.abort();await rejected;for(const row of rows)for(const pid of [row.pid,row.descendant].filter(Boolean))assert.equal(alive(pid),false,`Owned ${stop} descendant must be gone before return`);}
    await mode('descendant');const helperBefore=(await observed()).length;
    const helperRequest=owner.run({timeoutMs:5000,prepare:async()=>['-p'],onLine:()=>{}}),helperRejected=assert.rejects(helperRequest);
    const helperRows=await waitFor(async()=>{const rows=(await observed()).slice(helperBefore);return rows.some(row=>row.descendant)?rows:undefined;});
    const helperPid=helperRows.find(row=>row.ppid)?.ppid;assert.ok(helperPid);process.kill(helperPid,'SIGKILL');await helperRejected;
    for(const row of helperRows)for(const pid of [row.pid,row.descendant].filter(Boolean))assert.equal(alive(pid),false,'Helper crash cannot release a live CLI or descendant');
    for(const cancellation of ['abort','timeout'] as const){
      await mode('descendant');const stoppedBefore=(await observed()).length,controller=new AbortController();
      const stoppedRequest=owner.run({signal:controller.signal,timeoutMs:cancellation==='timeout'?650:5000,prepare:async()=>['-p'],onLine:()=>{}}),stoppedRejected=assert.rejects(stoppedRequest);
      const stoppedRows=await waitFor(async()=>{const rows=(await observed()).slice(stoppedBefore);return rows.some(row=>row.descendant)?rows:undefined;});const stoppedHelper=stoppedRows.find(row=>row.ppid)?.ppid;assert.ok(stoppedHelper);process.kill(stoppedHelper,'SIGSTOP');if(cancellation==='abort')controller.abort();await stoppedRejected;
      for(const row of stoppedRows)for(const pid of [row.pid,row.descendant,stoppedHelper].filter(Boolean))assert.equal(alive(pid),false,`Root ${cancellation} must kill a suspended helper without IPC cooperation`);
    }
    await mode('descendant');const before=(await observed()).length,driver=join(scratch,'driver.ts');await writeFile(driver,`import {NativeCli} from ${JSON.stringify(join(import.meta.dirname,'native-cli.ts'))};const owner=new NativeCli(${JSON.stringify(join(scratch,'parent-crash'))});await owner.run({prepare:async()=>['-p'],onLine:()=>{}});`);
    await mkdir(join(scratch,'parent-crash'),{recursive:true});const parent=spawn(process.execPath,['--import','tsx',driver],{env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,HOME:scratch,PI_CODING_AGENT_DIR:join(scratch,'agent')},stdio:['ignore','ignore','ignore']});const rows=await waitFor(async()=>{const rows=(await observed()).slice(before);return rows.some(row=>row.descendant)?rows:undefined;});const exited=new Promise(resolve=>parent.once('exit',resolve));parent.kill('SIGKILL');await exited;
    await waitFor(async()=>rows.every(row=>[row.pid,row.descendant].filter(Boolean).every(pid=>!alive(pid)))?true:undefined);assert.ok(rows.some(row=>row.descendant));
  }finally{await owner.close();}
});
