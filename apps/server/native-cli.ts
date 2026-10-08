import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NativeProviderView } from '../../packages/contracts/index.js';
import { AGY_AGENT_NAME, agyProfileIsReady, prepareAgyProfile } from './agy-profile.js';

export const CLAUDE_PROVIDER_ID='sigma-claude-cli';
export const AGY_PROVIDER_ID='sigma-antigravity-cli';
export const AGY_UNSUPERVISED_PROVIDER_ID='sigma-antigravity-unsupervised';
export const AGY_UNSUPERVISED_WARNING='AGY runs its own file, shell, browser and other tools without Sigma approvals; Sigma only sees what AGY reports.';
// The supervised AGY route stays blocked; the unsupervised id is a separate opt-in route and is deliberately not in this set.
export const NATIVE_PROVIDER_IDS=new Set([CLAUDE_PROVIDER_ID,AGY_PROVIDER_ID]);
const offline=()=>process.env.PI_OFFLINE==='1'||(process.env.SIGMA_DEMO??process.env.PI_ORCH_DEMO)==='1';
export function nativeEnvironment(overlay:Record<string,string|undefined>={}){
  // Merge first, then allowlist. Caller API/cloud/token settings cannot choose another auth route.
  const merged:NodeJS.ProcessEnv={...process.env,...overlay,HOME:process.env.HOME,PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,USER:process.env.USER},env:NodeJS.ProcessEnv={};
  for(const key of ['HOME','PATH','TMPDIR','USER','LANG','LC_ALL'])if(merged[key])env[key]=merged[key];
  if(!env.HOME)throw new Error('Official CLI home is unavailable');
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS='1';return env;
}
const AGY_ENV_KEYS=['HOME','PATH','TMPDIR','USER','LANG','LC_ALL','AGY_CLI_DISABLE_AUTO_UPDATE'];
/** Minimal AGY environment: private profile HOME and nothing else from Sigma or the caller. */
export function agyEnvironment(home:string){const env:NodeJS.ProcessEnv={};for(const [key,value] of Object.entries({HOME:home,PATH:process.env.PATH,USER:process.env.USER,LANG:process.env.LANG,LC_ALL:process.env.LC_ALL,TMPDIR:home,AGY_CLI_DISABLE_AUTO_UPDATE:'1'}))if(value&&AGY_ENV_KEYS.includes(key))env[key]=value;return env;}
function agyBinary(){const path=process.env.HOME?join(process.env.HOME,'.local','bin','agy'):undefined;try{if(!path)return;accessSync(path,constants.X_OK);return path;}catch{return;}}
function binary(env:NodeJS.ProcessEnv){
  const candidates=[join(env.HOME!,'.local/bin/claude'),...(env.PATH??'').split(':').filter(Boolean).map(path=>join(path,'claude'))];
  return candidates.find(path=>{try{accessSync(path,constants.X_OK);return true;}catch{return false;}});
}
const groupAlive=(pid:number)=>{try{process.kill(-pid,0);return true;}catch{return false;}};
async function drainGroup(pid:number){
  if(!groupAlive(pid))return;
  try{process.kill(-pid,'SIGTERM');}catch{}
  const grace=Date.now()+250;
  while(groupAlive(pid)&&Date.now()<grace)await new Promise(resolve=>setTimeout(resolve,15));
  if(groupAlive(pid))try{process.kill(-pid,'SIGKILL');}catch{}
  const deadline=Date.now()+2500;
  while(groupAlive(pid)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,15));
  if(groupAlive(pid))throw new Error('Owned native group could not drain');
}
type Result={exitCode:number|null;drained:boolean};
type Send=((value:unknown)=>void)&{end:()=>void};
type Request={agy?:{cwd:string};signal?:AbortSignal;env?:Record<string,string|undefined>;timeoutMs?:number;prepare:(cwd:string)=>Promise<string[]>;onStart?:(send:Send)=>void;onLine:(line:string,send:Send)=>void};
type Operation={abort:()=>void;done:Promise<void>;agy:boolean};
/** Owns all temporary resources and child leases before the first asynchronous boundary. */
export class NativeCli {
  private operations=new Set<Operation>();
  private controls=new Set<Promise<unknown>>();
  private saveWork:Promise<void>=Promise.resolve();
  private closing=false;
  private enabled=false;
  private generation=0;
  private controller?:AbortController;
  private probeWork?:Promise<Result>;
  private agyProfileReady=false;
  private agyHome?:string;
  private agyProfileError=false;
  private agyProfileWork:Promise<string>=Promise.resolve('');
  private view:NativeProviderView={id:CLAUDE_PROVIDER_ID,name:'Claude Code',owner:'native_cli',state:'disconnected',enabled:false,expiresAt:null,message:'Connect the official CLI account to this local route.'};
  private collision=false;
  private agyUnsupervised=false;
  private agyHook?:(enabled:boolean)=>void;
  constructor(private dataDir:string){}
  async init(){try{const saved=JSON.parse(await readFile(join(this.dataDir,'native-providers.json'),'utf8'));this.enabled=saved.claude===true;this.view.enabled=this.enabled;this.agyUnsupervised=saved.agyUnsupervised===true&&!offline();}catch{}if(offline()){this.view.state='blocked';this.view.message='Native providers are disabled in offline or demo mode.';}}
  list():NativeProviderView[]{
    const agyPath=process.env.HOME?join(process.env.HOME,'.local','bin','agy'):undefined;
    const installed=!!agyPath&&(()=>{try{accessSync(agyPath,constants.X_OK);return true;}catch{return false;}})();
    const home=this.agyHome,env:Record<string,string|undefined>={HOME:home,PATH:process.env.PATH,USER:process.env.USER,LANG:process.env.LANG,LC_ALL:process.env.LC_ALL,TMPDIR:home,AGY_CLI_DISABLE_AUTO_UPDATE:'1'};
    const offlineMode=offline(),profileValid=!!home&&agyProfileIsReady(this.dataDir,home),variantValid=!!home&&agyProfileIsReady(this.dataDir,home,this.agyUnsupervised),command=home&&profileValid&&agyPath&&installed&&!offlineMode?`cd ${shellQuote(home)} && env -i ${Object.entries(env).filter((entry):entry is [string,string]=>typeof entry[1]==='string'&&entry[1].length>0).map(([key,value])=>`${key}=${shellQuote(value)}`).join(' ')} ${shellQuote(agyPath)} --agent ${AGY_AGENT_NAME}`:undefined;
    const profileError=this.agyProfileError||this.agyProfileReady&&!variantValid, status=offlineMode?'blocked':profileError?'error':!installed?'missing':'blocked',message=offlineMode?'Native CLI profiles are disabled in offline or demo mode.':profileError?'Private profile could not be prepared safely or its guard files changed. Inspect owned profile files before retrying.':!installed?'Install the official Antigravity CLI at ~/.local/bin/agy.':profileValid?'Private profile prepared. Sign in with the command below; model access stays blocked until authenticated safety metadata is verified.':'Prepare the isolated account profile, then sign in with the command below. Model access stays blocked until authenticated safety metadata is verified.';
    const antigravity:NativeProviderView={id:AGY_PROVIDER_ID,name:'Antigravity',owner:'native_cli',state:status,enabled:false,expiresAt:null,message,...(profileValid&&command?{loginCommand:command}:{}),profileReady:profileValid};
    const unsupervised:NativeProviderView={id:AGY_UNSUPERVISED_PROVIDER_ID,name:'Antigravity (unsupervised)',owner:'native_cli',state:offlineMode?'blocked':!installed?'missing':this.agyUnsupervised?'connected':'disconnected',enabled:this.agyUnsupervised,expiresAt:null,unsupervised:true,warning:AGY_UNSUPERVISED_WARNING,message:offlineMode?'Native CLI profiles are disabled in offline or demo mode.':!installed?'Install the official Antigravity CLI at ~/.local/bin/agy.':this.agyUnsupervised?'Enabled. Only isolated Git worktree code sessions may use it; AGY tools bypass Pi approvals.':'Off. Sign in to the Antigravity profile first (see the Antigravity row), then enable explicitly.',profileReady:variantValid};
    return [structuredClone(this.collision?{...this.view,state:'blocked' as const,message:'Reserved native provider configuration conflicts with the Pi catalog.'}:this.view),antigravity,unsupervised];
  }
  setAgyHook(hook:(enabled:boolean)=>void){this.agyHook=hook;if(this.agyUnsupervised&&!this.closing)hook(true);}
  isAgyUnsupervisedEnabled(){return !this.closing&&!offline()&&this.agyUnsupervised;}
  enableAgyUnsupervised(confirmed:unknown){return this.control(async()=>{
    if(confirmed!==true)throw new Error('Explicit confirmation is required');if(offline())throw new Error('Native providers are disabled');if(!agyBinary())throw new Error('Antigravity CLI is missing');
    this.agyProfileWork=this.agyProfileWork.catch(()=> '').then(()=>prepareAgyProfile(this.dataDir,true));this.agyHome=await this.agyProfileWork;this.agyProfileReady=true;this.agyProfileError=false;
    if(this.closing)throw new Error('Native provider is shutting down');this.agyUnsupervised=true;this.agyHook?.(true);await this.save();return this.list();});}
  disableAgyUnsupervised(){return this.control(async()=>{this.agyUnsupervised=false;this.agyHook?.(false);for(const operation of this.operations)if(operation.agy)operation.abort();await Promise.allSettled([...this.operations].filter(op=>op.agy).map(op=>op.done));await this.save();
    // Restore the strict settings variant; if that fails the flag is already off, so a leftover unsupervised file reads as not ready (fail closed).
    this.agyProfileWork=this.agyProfileWork.catch(()=> '').then(()=>prepareAgyProfile(this.dataDir,false));try{this.agyHome=await this.agyProfileWork;this.agyProfileError=false;}catch{this.agyProfileError=true;throw new Error('Antigravity settings could not be restored to the strict policy');}return this.list();});}
  setCollision(value:boolean){this.collision=value;}
  isConnected(){return !this.closing&&!offline()&&!this.collision&&this.enabled&&this.view.state==='connected';}
  private async probe(id:string){
    if(id!==CLAUDE_PROVIDER_ID){if(id===AGY_PROVIDER_ID)return this.generation;throw new Error('Unknown native provider');}
    if(this.closing)throw new Error('Native provider is shutting down');
    const generation=++this.generation;this.controller?.abort();const controller=new AbortController();this.controller=controller;
    if(offline()){this.view.state='blocked';return generation;}
    if(!binary(nativeEnvironment())){this.view.state='missing';this.view.message='Install the official Claude Code CLI, then reload status.';return generation;}
    let metadata:any,raw='';
    try{
      const work=this.run({signal:controller.signal,timeoutMs:8000,prepare:async()=>['auth','status','--json'],onLine:line=>{raw+=line+'\n';if(raw.length>64000)throw new Error('Status limit');}});this.probeWork=work;const result=await work;
      if(generation!==this.generation||this.closing)return generation;
      metadata=JSON.parse(raw);
      const authenticated=metadata?.loggedIn===true&&metadata?.authMethod==='claude.ai'&&result.exitCode===0;
      this.view.state=authenticated?(this.enabled?'connected':'disconnected'):'login_required';
      this.view.message=authenticated?'Official CLI account · local route '+(this.enabled?'connected':'disconnected'):'Complete claude auth login in the official CLI, then refresh status.';
      this.view.account=authenticated?'claude.ai':undefined;
      this.view.subscription=authenticated&&['pro','max','team','enterprise'].includes(metadata?.subscriptionType)?metadata.subscriptionType:undefined;
    }catch{if(generation===this.generation){this.view.state='error';this.view.message='Official CLI status could not be verified.';}}
    finally{if(this.controller===controller){this.controller=undefined;this.probeWork=undefined;}}
    return generation;
  }
  private control<T>(work:()=>Promise<T>):Promise<T>{if(this.closing)return Promise.reject(new Error("Native provider is shutting down"));const pending=Promise.resolve().then(()=>{if(this.closing)throw new Error("Native provider is shutting down");return work();});this.controls.add(pending);void pending.then(()=>this.controls.delete(pending),()=>this.controls.delete(pending));return pending;}
  refresh(id:string){return this.control(async()=>{if(id===AGY_PROVIDER_ID){if(offline())return this.list();const binary=process.env.HOME?join(process.env.HOME,'.local','bin','agy'):undefined;try{if(!binary)throw new Error();accessSync(binary,constants.X_OK);}catch{return this.list();}try{this.agyProfileWork=this.agyProfileWork.catch(()=> '').then(()=>prepareAgyProfile(this.dataDir,this.agyUnsupervised));this.agyHome=await this.agyProfileWork;this.agyProfileReady=true;this.agyProfileError=false;}catch{this.agyHome=undefined;this.agyProfileReady=false;this.agyProfileError=true;}return this.list();}await this.probe(id);return this.list();});}
  connect(id:string){return this.control(async()=>{if(id!==CLAUDE_PROVIDER_ID)throw new Error('Native transport is blocked');const generation=await this.probe(id);if(this.closing||generation!==this.generation||!['disconnected','connected'].includes(this.view.state))return this.list();this.enabled=true;this.view.enabled=true;this.view.state='connected';this.view.message='Official CLI account · local route connected';await this.save();return this.list();});}
  disconnect(id:string){return this.control(async()=>{if(id!==CLAUDE_PROVIDER_ID)throw new Error('Unknown native provider');++this.generation;this.controller?.abort();this.enabled=false;this.view.enabled=false;this.view.state='disconnected';this.view.message='Local route disconnected. The official CLI account remains signed in.';for(const operation of this.operations)if(!operation.agy)operation.abort();await Promise.allSettled([...this.operations].filter(op=>!op.agy).map(op=>op.done));await this.save();return this.list();});}
  cancel(id:string){return this.control(async()=>{if(id!==CLAUDE_PROVIDER_ID)throw new Error('Unknown native provider');const pending=this.probeWork;++this.generation;this.controller?.abort();if(pending)await Promise.allSettled([pending]);return this.list();});}
  private save(){const enabled=this.enabled,agyUnsupervised=this.agyUnsupervised;return this.saveWork=this.saveWork.catch(()=>{}).then(async()=>{const path=join(this.dataDir,`.native-provider-${randomUUID()}.json`);try{await writeFile(path,JSON.stringify({claude:enabled,agyUnsupervised}),{mode:0o600,flag:'wx'});await rename(path,join(this.dataDir,'native-providers.json'));}finally{await rm(path,{force:true});}});}
  run(request:Request):Promise<Result>{
    let finish!:()=>void;const controller=new AbortController(),operation:Operation={abort:()=>controller.abort(),done:new Promise(resolve=>{finish=resolve;}),agy:!!request.agy};
    this.operations.add(operation);const abort=()=>controller.abort();request.signal?.addEventListener('abort',abort,{once:true});if(request.signal?.aborted||this.closing)controller.abort();
    return (async()=>{
      let cwd:string|undefined;
      try{
        if(offline())throw new Error('Native providers are disabled');controller.signal.throwIfAborted();
        let env:NodeJS.ProcessEnv,executable:string|undefined;
        if(request.agy){
          // AGY runs inside the caller's isolated workspace with only its private profile HOME. Caller env overlays are ignored.
          executable=agyBinary();if(!executable)throw new Error('Official CLI is missing');
          this.agyProfileWork=this.agyProfileWork.catch(()=> '').then(()=>prepareAgyProfile(this.dataDir,this.agyUnsupervised));const home=await this.agyProfileWork;if(!agyProfileIsReady(this.dataDir,home,this.agyUnsupervised))throw new Error('Antigravity profile is not ready');
          env=agyEnvironment(home);cwd=request.agy.cwd;
        }else{
          env=nativeEnvironment(request.env);executable=binary(env);if(!executable)throw new Error('Official CLI is missing');
          const root=join(this.dataDir,'native-tmp');await mkdir(root,{recursive:true,mode:0o700});await chmod(root,0o700);cwd=await mkdtemp(join(root,'claude-'));await chmod(cwd,0o700);
        }
        const args=await request.prepare(cwd);controller.signal.throwIfAborted();
        return await new Promise<Result>((resolve,reject)=>{
          const child=fork(fileURLToPath(new URL('./native-cli-watchdog.mjs',import.meta.url)),[JSON.stringify({binary:executable,args,cwd,env,timeoutMs:request.timeoutMs??120000})],{execArgv:[],detached:true,stdio:['pipe','ignore','ignore','ipc'],env});
          let terminal:any,failed=false,callbackError=false,mainExited=false,stopping=false,expired=false,groupId=child.pid,killTimer:ReturnType<typeof setTimeout>|undefined;
          const terminate=()=>{try{if(groupId)process.kill(-groupId,'SIGTERM');}catch{}if(!killTimer)killTimer=setTimeout(()=>{try{if(groupId)process.kill(-groupId,'SIGKILL');}catch{}},250);};
          const stop=()=>{stopping=true;terminate();child.send?.({type:'stop'},()=>{});};
          const deadline=setTimeout(()=>{expired=true;stop();},request.timeoutMs??120000);
          child.on('spawn',()=>{groupId=child.pid;if(stopping)terminate();});controller.signal.addEventListener('abort',stop,{once:true});
          const send:Send=Object.assign((value:unknown)=>{if(!child.connected||controller.signal.aborted)throw new Error('Native child is unavailable');child.send({type:'write',line:JSON.stringify(value)},error=>{if(error){callbackError=true;stop();}});},{end:()=>{child.send({type:'eof'},()=>{});}});
          child.on('message',(raw:any)=>{
            try{if(raw.type==='ready')request.onStart?.(send);if(raw.type==='line')request.onLine(raw.line,send);if(raw.type==='closed')terminal=raw;if(raw.type==='main_exit'){mainExited=true;terminate();}}
            catch{callbackError=true;stop();}
          });
          child.on('error',()=>{failed=true;});
          child.on('close',()=>{controller.signal.removeEventListener('abort',stop);child.stdin?.destroy();clearTimeout(deadline);void (async()=>{try{if(groupId)await drainGroup(groupId);if(failed||callbackError||!terminal?.mainClosed||terminal.reason||controller.signal.aborted||expired||!mainExited)throw new Error('Native operation failed or was cancelled');resolve({exitCode:terminal.exitCode,drained:true});}catch{reject(new Error('Native operation failed or its owned group did not drain'));}finally{if(killTimer)clearTimeout(killTimer);}})();});
          if(controller.signal.aborted)stop();
        });
      }finally{try{if(cwd&&!request.agy)await rm(cwd,{recursive:true,force:true});}finally{request.signal?.removeEventListener('abort',abort);this.operations.delete(operation);finish();}}
    })();
  }
  beginShutdown(){this.closing=true;for(const operation of this.operations)operation.abort();}
  async close(){this.beginShutdown();await Promise.allSettled([...this.controls,...[...this.operations].map(op=>op.done)]);await this.saveWork;}
}
function shellQuote(value:string){return `'${value.replaceAll("'",`'\\''`)}'`;}
