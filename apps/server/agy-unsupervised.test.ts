import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';

// Import the SDK only after separating every credential/config owner from the user's home.
const scratch=resolve(import.meta.dirname,'../../.scratch',`agy-unsupervised-${Date.now()}-${process.pid}`);
for(const key of Object.keys(process.env))if(!['PATH','TMPDIR','USER'].includes(key))delete process.env[key];
process.env.HOME=scratch;process.env.PI_CODING_AGENT_DIR=join(scratch,'agent');
const {AGY_UNSUPERVISED_PROVIDER_ID,NativeCli}=await import('./native-cli.js');
const {AGY_ARGV,agyInputLine,agyTurnTimeout,agyTimeoutMessage}=await import('./agy-provider.js');
const {PiHost}=await import('./pi-host.js');
const {Storage}=await import('./storage.js');
const {agyProfileIsReady}=await import('./agy-profile.js');
const KEY=`${AGY_UNSUPERVISED_PROVIDER_ID}/antigravity-default`;
await mkdir(join(scratch,'.local/bin'),{recursive:true,mode:0o700});
const scenarioPath=join(scratch,'scenario.json'),observedPath=join(scratch,'observed.jsonl'),readyPath=join(scratch,'ready');
const fixture=(await readFile(join(import.meta.dirname,'agy.fixture.mjs'),'utf8')).replace('#!/usr/bin/env node',`#!${process.execPath}`).replace('__SCENARIO__',scenarioPath).replace('__OBSERVED__',observedPath);
await writeFile(join(scratch,'.local/bin/agy'),fixture,{mode:0o700});await chmod(join(scratch,'.local/bin/agy'),0o700);
const livePath=join(import.meta.dirname,'agy-live-events.fixture.jsonl');
const mode=async(value:string)=>{await rm(readyPath,{force:true});await rm(observedPath,{force:true});await writeFile(scenarioPath,JSON.stringify({mode:value,ready:readyPath,replay:livePath}),{mode:0o600});};
const observed=async()=>{try{return (await readFile(observedPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));}catch{return [];}};
async function waitFor<T>(check:()=>Promise<T|undefined>,timeout=10000){const until=Date.now()+timeout;while(Date.now()<until){const result=await check();if(result!==undefined)return result;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Fixture timed out');}
const alive=(pid:number)=>{try{process.kill(pid,0);const state=execFileSync('/bin/ps',['-p',String(pid),'-o','stat='],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();return !!state&&!state.startsWith('Z');}catch{return false;}};
function git(cwd:string,...args:string[]){return execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false',...args],{cwd,env:{PATH:process.env.PATH,HOME:scratch,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'},encoding:'utf8'});}
async function setup(name:string){
  const data=join(scratch,name,'data'),source=join(scratch,name,'source');await mkdir(data,{recursive:true,mode:0o700});await mkdir(source,{recursive:true});
  git(source,'init','-q','-b','main');await writeFile(join(source,'seed.txt'),'base\n');git(source,'add','.');git(source,'commit','-qm','fixture');
  const storage=new Storage(join(data,'state.sqlite')),sent:Array<{type:string;payload:any}>=[],host=new PiHost(storage,data,async(id,type,payload,durable)=>{sent.push({type,payload});if(durable)await storage.event(id,type,payload);});await host.init();
  return {data,source,storage,host,sent,close:async()=>{await host.close();await storage.close();}};
}
const modelsOf=async(host:InstanceType<typeof PiHost>)=>(await host.models()).filter(model=>model.provider===AGY_UNSUPERVISED_PROVIDER_ID);

test('unsupervised Antigravity is off by default, needs explicit confirmation and registers or unregisters its models',async()=>{
  await mode('normal');const f=await setup('toggle');
  try{
    const view=()=>f.host.nativeProviders.list().find(item=>item.id===AGY_UNSUPERVISED_PROVIDER_ID)!;
    assert.equal(view().enabled,false);assert.equal(view().unsupervised,true);assert.match(view().warning!,/without Sigma approvals/);assert.deepEqual(await modelsOf(f.host),[]);
    await assert.rejects(f.host.nativeProviders.enableAgyUnsupervised(undefined),/confirmation/);await assert.rejects(f.host.nativeProviders.enableAgyUnsupervised('yes'),/confirmation/);assert.deepEqual(await modelsOf(f.host),[]);
    await f.host.nativeProviders.enableAgyUnsupervised(true);assert.equal(view().enabled,true);assert.equal((await modelsOf(f.host)).length,1);assert.match((await modelsOf(f.host))[0].name,/unsupervised/i);
    assert.equal(JSON.parse(await readFile(join(f.data,'native-providers.json'),'utf8')).agyUnsupervised,true);
    await f.host.nativeProviders.disableAgyUnsupervised();assert.equal(view().enabled,false);assert.deepEqual(await modelsOf(f.host),[]);
    assert.equal(JSON.parse(await readFile(join(f.data,'native-providers.json'),'utf8')).agyUnsupervised,false);
    // The supervised route stays blocked and never gains models.
    await assert.rejects(f.host.nativeProviders.connect('sigma-antigravity-cli'),/blocked/);assert.equal((await f.host.models()).filter(model=>model.provider==='sigma-antigravity-cli').length,0);
    // Persisted opt-in is restored on the next start.
    await f.host.nativeProviders.enableAgyUnsupervised(true);
  }finally{await f.close();}
  const restored=await setup('toggle-restored');
  try{await writeFile(join(restored.data,'native-providers.json'),JSON.stringify({claude:false,agyUnsupervised:true}));const fresh=new PiHost(restored.storage,restored.data,async()=>{});await fresh.init();try{assert.equal((await modelsOf(fresh)).length,1,'Saved opt-in re-registers the model');}finally{await fresh.close();}}
  finally{await restored.close();}
});

test('only isolated worktree code sessions and safe workspaces are allowed; no Pi delegation',async()=>{
  await mode('normal');const f=await setup('constraints');
  try{
    await f.host.nativeProviders.enableAgyUnsupervised(true);
    await assert.rejects(f.host.create(f.source,KEY,undefined,'read'),/unsupervised|available|worktree/i);
    await assert.rejects(f.host.create(f.source,KEY,undefined,'code',{workspaceMode:'direct'}),/worktree/i);
    await assert.rejects(f.host.create(f.source,KEY,undefined,'parallel',{workspaceMode:'direct'}),/worktree/i);
    assert.equal((await observed()).filter(row=>row.stdin).length,0,'Refused sessions never reach AGY');
    const guard=(path:string)=>(f.host as any).assertUnsupervisedWorkspace(path);
    await mkdir(join(f.data,'workspaces','ok'),{recursive:true});await mkdir(join(f.data,'cliproxyapi','x'),{recursive:true});await mkdir(join(f.data,'antigravity-profile','x'),{recursive:true});await mkdir(join(f.data,'agent','x'),{recursive:true});
    guard(join(f.data,'workspaces','ok'));
    for(const unsafe of [scratch,f.data,resolve(f.data,'..'),join(f.data,'cliproxyapi','x'),join(f.data,'antigravity-profile'),join(f.data,'antigravity-profile','x'),join(f.data,'agent'),join(f.data,'agent','x'),process.env.PI_CODING_AGENT_DIR!])assert.throws(()=>guard(unsafe),/Sigma data|credential|unavailable/,unsafe);
    const id=await f.host.create(f.source,KEY,undefined,'code',{workspaceMode:'worktree'});
    const view=await f.host.snapshot(id);assert.equal(view.policy?.unsupervised,true);assert.equal(view.policy?.workspace?.kind,'worktree');assert.equal((view.policy!.effective.profile as any).rootTotalChildren,0);assert.equal((view.policy!.effective.profile as any).maxDepth,0);
    assert.equal((view.policy!.setup!.profile as any).rootTotalChildren,0);
    const par=await f.host.snapshot(await f.host.create(f.source,KEY,undefined,'parallel',{workspaceMode:'worktree'}));assert.equal(par.policy?.unsupervised,true,'parallel is accepted as a plain code session');assert.equal(par.policy?.requested.mode,'code');assert.equal((par.policy!.effective.profile as any).maxDepth,0,'AGY never gets delegate');assert.equal((par.policy!.effective.profile as any).sourceApply,true);
    await mode('normal');await f.host.prompt(id,'delegate: anything');await waitFor(async()=>(await f.host.snapshot(id)).status==='settled'?true:undefined);
    assert.equal((await f.host.snapshot(id)).agents.length,1,'No Pi child agents exist for an unsupervised root');
  }finally{await f.close();}
});

test('AGY runs with the exact argv, minimal env and private profile; activity is a persisted read-only record and Unicode streams intact',async()=>{
  process.env.OPENAI_API_KEY='must-not-leak';process.env.SIGMA_SESSION_TOKEN='must-not-leak';process.env.AGY_ACCESS_TOKEN='must-not-leak';
  await mode('normal');const f=await setup('stream');
  try{
    await f.host.nativeProviders.enableAgyUnsupervised(true);
    const id=await f.host.create(f.source,KEY,undefined,'code',{workspaceMode:'worktree'});
    await f.host.prompt(id,'write a file 🐱');await waitFor(async()=>(await f.host.snapshot(id)).status==='settled'?true:undefined);
    const rows=await observed(),start=rows.find(row=>row.argv)!,stdin=rows.find(row=>row.stdin)!;
    assert.deepEqual(start.argv,AGY_ARGV);assert.deepEqual(AGY_ARGV,['-p=','--input-format','stream-json','--output-format','stream-json','--sandbox','--dangerously-skip-permissions']);
    const workspace=(await f.host.snapshot(id)).policy!.effective.cwd;assert.equal(start.cwd,await realpath(workspace));assert.equal(start.home,join(await realpath(f.data),'antigravity-profile'));
    assert.deepEqual(Object.keys(start.env).filter((key:string)=>!['HOME','PATH','TMPDIR','USER','LANG','LC_ALL','AGY_CLI_DISABLE_AUTO_UPDATE','__CF_USER_TEXT_ENCODING'].includes(key)),[],'Only allowlisted variables reach AGY');
    assert.ok(!JSON.stringify(start.env).includes('must-not-leak')&&!('PI_CODING_AGENT_DIR' in start.env));
    const input=JSON.parse(stdin.stdin);assert.equal(input.event,'user');assert.deepEqual(Object.keys(input.message).sort(),['content','prompt','text']);assert.match(input.message.text,/write a file/);assert.equal(input.message.text,input.message.content);assert.equal(input.message.text,input.message.prompt);assert.equal(stdin.stdin,JSON.stringify(agyInputLine(input.message.text)),'Exactly one NDJSON line in the real shape');
    assert.equal(await readFile(join(workspace,'agy-wrote.txt'),'utf8'),'written by the synthetic AGY\n','AGY tool effects land in the isolated worktree');
    const snapshot=await f.host.snapshot(id);assert.equal(snapshot.approvals.length,0,'AGY tools never create Pi approvals');
    assert.equal(snapshot.messages.filter(message=>message.role==='assistant').at(-1)!.text,'Hello 🐱 ünï – done');
    assert.equal(f.sent.filter(event=>event.type==='delta').map(event=>event.payload.text).join(''),'Hello 🐱 ünï – done');
    const events=(await f.storage.call<any[]>('events',{sessionId:id})).filter(event=>event.type==='agy_activity').map(event=>event.payload);
    assert.ok(events.length>=3);assert.ok(events.every(event=>event.agentId===id&&typeof event.step==='string'&&typeof event.tool==='string'&&['running','done','error'].includes(event.status)));
    const write=events.filter(event=>event.step==='1');assert.deepEqual(write.map(event=>event.status),['running','done']);assert.equal(write[0].tool,'write_to_file');assert.ok(write[0].params.length<=200&&write[0].params.endsWith('…'),'Params are summarised and truncated');
    assert.ok(write[1].output.length<=500&&write[1].output.endsWith('…'),'Tool output is truncated');assert.equal(write[0].output,undefined);
    assert.deepEqual(events.filter(event=>event.step==='2').map(event=>[event.status,event.output]),[['running',undefined],['error','exit 1']]);
    assert.ok(!events.some(event=>event.step==='0'),'user_input steps are ignored');
    assert.ok(!(await f.storage.call<any[]>('events',{sessionId:id})).some(event=>event.type==='approval'));
    const turn=(await f.storage.call<any[]>('events',{sessionId:id})).filter(event=>event.type==='graph_message');assert.ok(turn.length>=1,'Native turn end is persisted like other providers');
    assert.equal((await observed()).filter(row=>row.stdin).length,1,'One input line per turn');
    // A reported AGY error ends the Pi turn as an error without leaking detail.
    await mode('error');await f.host.prompt(id,'fail');await waitFor(async()=>(await observed()).some(row=>row.stdin)?true:undefined);await waitFor(async()=>(await f.host.snapshot(id)).status==='error'?true:undefined);
    const failed=(await f.host.snapshot(id)).messages.filter(message=>message.role==='assistant').at(-1);assert.ok(!failed||!/must-not-leak/.test(failed.text));
    assert.equal((await f.host.snapshot(id)).status,'error','AGY ERROR result ends the Pi turn as an error');
    await waitFor(async()=>f.sent.some(event=>event.type==='error'&&event.payload.message==='Antigravity unsupervised request failed (agy_error): model quota exhausted')?true:undefined);
  }finally{await f.close();for(const key of ['OPENAI_API_KEY','SIGMA_SESSION_TOKEN','AGY_ACCESS_TOKEN'])delete process.env[key];}
});

test('images are handed to AGY as temporary files via --add-dir for that turn only and removed afterwards; text-only turns keep the exact argv',async()=>{
  await mode('normal');const f=await setup('images');
  try{
    await f.host.nativeProviders.enableAgyUnsupervised(true);
    assert.equal((await modelsOf(f.host))[0].images,true);
    const id=await f.host.create(f.source,KEY,undefined,'code',{workspaceMode:'worktree'}),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64'),gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
    await f.host.prompt(id,'what is in these?',undefined,undefined,undefined,undefined,undefined,[{type:'image',data:png.toString('base64'),mimeType:'image/png'},{type:'image',data:gif.toString('base64'),mimeType:'image/gif'}]);
    await waitFor(async()=>(await f.host.snapshot(id)).status==='settled'?true:undefined);
    const rows=await observed(),start=rows.find(row=>row.argv)!,stdin=rows.find(row=>row.stdin)!,seen=rows.find(row=>row.addDir)!;
    const at=start.argv.indexOf('--add-dir');assert.ok(at>0);assert.deepEqual(start.argv,[...AGY_ARGV,'--add-dir',start.argv[at+1]]);
    const dir=start.argv[at+1];assert.ok(isAbsolute(dir));assert.equal(seen.addDir,dir);assert.equal(seen.error,undefined);assert.equal(seen.dirMode,0o700);
    assert.ok(!dir.startsWith(await realpath(f.source))&&!dir.startsWith(await realpath((await f.host.snapshot(id)).policy!.effective.cwd)),'Images live outside the git workspace');
    assert.deepEqual(seen.files.map((file:any)=>[file.name,file.mode,file.base64]),[['image-1.png',0o600,png.toString('base64')],['image-2.gif',0o600,gif.toString('base64')]],'Files existed with the right bytes while AGY ran');
    const text=JSON.parse(stdin.stdin).message.text;
    assert.ok(text.includes(`[image 1: ${join(dir,'image-1.png')} — open it with view_file to see it]`)&&text.includes(`[image 2: ${join(dir,'image-2.gif')} — open it with view_file to see it]`));assert.match(text,/\[user\] what is in these\?\n\[image 1:/);
    await waitFor(async()=>{try{await stat(dir);return undefined;}catch{return true;}});
    // A session without any image keeps the exact argv and gets no --add-dir. (Images stay in the Pi history, so later turns of the same session re-attach them.)
    const other=await f.host.create(f.source,KEY,undefined,'code',{workspaceMode:'worktree'});await mode('normal');await f.host.prompt(other,'thanks');await waitFor(async()=>(await observed()).some(row=>row.stdin)?true:undefined);await waitFor(async()=>(await f.host.snapshot(other)).status==='settled'?true:undefined);
    const plain=await observed();assert.deepEqual(plain.find(row=>row.argv)!.argv,AGY_ARGV);assert.ok(!plain.some(row=>row.addDir));assert.ok(!JSON.parse(plain.find(row=>row.stdin)!.stdin).message.text.includes('[image'));
  }finally{await f.close();}
});

test('an image-only message is kept in the transcript and the image directory is removed when the turn fails',async()=>{
  await mode('error');const f=await setup('images-error');
  try{
    await f.host.nativeProviders.enableAgyUnsupervised(true);
    const id=await f.host.create(f.source,KEY,undefined,'code',{workspaceMode:'worktree'});
    await f.host.prompt(id,'',undefined,undefined,undefined,undefined,undefined,[{type:'image',data:Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64').toString('base64'),mimeType:'image/gif'}]);
    await waitFor(async()=>(await f.host.snapshot(id)).status==='error'?true:undefined);
    const rows=await observed(),start=rows.find(row=>row.argv)!,dir=start.argv[start.argv.indexOf('--add-dir')+1],text=JSON.parse(rows.find(row=>row.stdin)!.stdin).message.text;
    assert.match(text,/\[user\] \[image 1: .*image-1\.gif — open it with view_file to see it\]/);
    await waitFor(async()=>{try{await stat(dir);return undefined;}catch{return true;}});
  }finally{await f.close();}
});

test('replaying a verbatim live agy 1.2.17 capture yields its final text and the manage_task activity',async()=>{
  await mode('replay');const f=await setup('replay');
  try{
    await f.host.nativeProviders.enableAgyUnsupervised(true);
    const id=await f.host.create(f.source,KEY,undefined,'code',{workspaceMode:'worktree'});
    await f.host.prompt(id,'Create a file hello.txt containing the word hi, then reply with the single word done.');await waitFor(async()=>(await f.host.snapshot(id)).status==='settled'?true:undefined);
    const lines=(await readFile(livePath,'utf8')).trim().split('\n').map(line=>JSON.parse(line)),expected=lines.find(line=>line.event==='result').result.response;
    assert.ok(expected.length>0);
    const snapshot=await f.host.snapshot(id);assert.equal(snapshot.messages.filter(message=>message.role==='assistant').at(-1)!.text,expected);
    assert.equal(f.sent.filter(event=>event.type==='delta').map(event=>event.payload.text).join(''),expected);
    const events=(await f.storage.call<any[]>('events',{sessionId:id})).filter(event=>event.type==='agy_activity').map(event=>event.payload);
    assert.deepEqual(events.map(event=>[event.step,event.tool,event.status,event.params,event.output]),[['2','manage_task','running','{"Action":"list"}',undefined],['2','manage_task','done','{"Action":"list"}','No background tasks are currently running.']]);
  }finally{await f.close();}
});

test('Stop mid-turn drains the whole AGY process group',async()=>{
  await mode('hang');const f=await setup('stop');
  try{
    await f.host.nativeProviders.enableAgyUnsupervised(true);
    const id=await f.host.create(f.source,KEY,undefined,'code',{workspaceMode:'worktree'});
    const before=(await observed()).length;await f.host.prompt(id,'run forever');
    await waitFor(async()=>{try{await readFile(readyPath);return true;}catch{return undefined;}});
    const rows=(await observed()).slice(before);assert.ok(rows.some(row=>row.descendant));
    await waitFor(async()=>(await f.storage.call<any[]>('events',{sessionId:id})).some(event=>event.type==='agy_activity'&&event.payload.tool==='run_command'&&event.payload.status==='running')?true:undefined);
    await f.host.abort(id);await waitFor(async()=>(await f.host.snapshot(id)).status!=='running'?true:undefined);
    for(const row of rows)for(const pid of [row.pid,row.descendant].filter(Boolean))assert.equal(alive(pid),false,'Stop drains the AGY process and its descendant');
  }finally{await f.close();}
});

test('disabling the route aborts an active AGY run and server SIGKILL reaps the AGY process group',async()=>{
  await mode('hang');const f=await setup('disable');
  try{
    await f.host.nativeProviders.enableAgyUnsupervised(true);
    const id=await f.host.create(f.source,KEY,undefined,'code',{workspaceMode:'worktree'});
    const before=(await observed()).length;await f.host.prompt(id,'run forever');await waitFor(async()=>{try{await readFile(readyPath);return true;}catch{return undefined;}});
    const rows=(await observed()).slice(before);await f.host.nativeProviders.disableAgyUnsupervised();
    await waitFor(async()=>rows.every(row=>[row.pid,row.descendant].filter(Boolean).every((pid:number)=>!alive(pid)))?true:undefined);
  }finally{await f.close();}
  // Parent SIGKILL: a driver owns an AGY run in an isolated workspace; killing it must leave nothing alive.
  await mode('hang-start');const root=join(scratch,'sigkill'),data=join(root,'data'),workspace=join(root,'ws');await mkdir(data,{recursive:true,mode:0o700});await mkdir(workspace,{recursive:true});
  const driver=join(scratch,'agy-driver.ts');await writeFile(driver,`import {NativeCli} from ${JSON.stringify(join(import.meta.dirname,'native-cli.ts'))};const owner=new NativeCli(${JSON.stringify(data)});await owner.run({agy:{cwd:${JSON.stringify(workspace)}},prepare:async()=>['-p'],onLine:()=>{}});`);
  const before=(await observed()).length,parent=spawn(process.execPath,['--import','tsx',driver],{env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,HOME:scratch,PI_CODING_AGENT_DIR:join(scratch,'agent')},stdio:['ignore','ignore','ignore']});
  const rows=await waitFor(async()=>{const rows=(await observed()).slice(before);return rows.some(row=>row.descendant)?rows:undefined;});
  const exited=new Promise(resolve=>parent.once('exit',resolve));parent.kill('SIGKILL');await exited;
  await waitFor(async()=>rows.every(row=>[row.pid,row.descendant].filter(Boolean).every((pid:number)=>!alive(pid)))?true:undefined);assert.ok(rows.some(row=>row.descendant));
});

test('enabling rewrites the profile settings to the unsupervised variant, disabling restores strict, and the auth file is never touched',async()=>{
  await mode('normal');const f=await setup('settings-variant');
  try{
    const home=join(f.data,'antigravity-profile'),cli=join(home,'.gemini','antigravity-cli'),settings=join(cli,'settings.json'),auth=join(cli,'auth_tokens.json');
    const read=async()=>JSON.parse(await readFile(settings,'utf8'));
    await f.host.nativeProviders.refresh('sigma-antigravity-cli');assert.deepEqual((await read()).permissions.deny,['command(*)','read_file(*)','write_file(*)','read_url(*)','execute_url(*)','mcp(*)']);
    await writeFile(auth,'auth-sentinel',{mode:0o600});const hash=createHash('sha256').update(await readFile(auth)).digest('hex');await chmod(auth,0o000);
    try{
      await f.host.nativeProviders.enableAgyUnsupervised(true);
      assert.deepEqual(await read(),{permissions:{deny:['mcp(*)']},hooks:{},useG1Credits:false});assert.equal((await stat(settings)).mode&0o777,0o600);
      assert.equal(agyProfileIsReady(f.data,home,true),true);assert.equal(agyProfileIsReady(f.data,home,false),false,'Strict readers reject the unsupervised variant');
      await f.host.nativeProviders.disableAgyUnsupervised();
      assert.deepEqual(await read(),{permissions:{deny:['command(*)','read_file(*)','write_file(*)','read_url(*)','execute_url(*)','mcp(*)']},hooks:{},useG1Credits:false});
      assert.equal(agyProfileIsReady(f.data,home,false),true);assert.equal(agyProfileIsReady(f.data,home,true),false);
    }finally{await chmod(auth,0o600);}
    assert.equal(createHash('sha256').update(await readFile(auth)).digest('hex'),hash,'Auth file untouched');
  }finally{await f.close();}
});

test('Pi HTTP idle timeout cannot cut an AGY turn; it can only raise the 30 minute deadline up to 60',()=>{
  assert.equal(agyTurnTimeout(undefined),1_800_000);assert.equal(agyTurnTimeout(300_000),1_800_000);assert.equal(agyTurnTimeout(2_400_000),2_400_000);assert.equal(agyTurnTimeout(7_200_000),3_600_000);
  assert.match(agyTimeoutMessage(1_800_000),/30 minutes/);
});
