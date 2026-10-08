import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { readDeployment, proxyEnvironment } from "./cliproxy-config.mjs";
import { authEntryCount, findFreeProxyPort, provisionProviderData, repointProxyPort } from "./cliproxy-provision.js";

export type ProxyState="not_installed"|"needs_login"|"starting"|"ready"|"degraded"|"stopped"|"borrowed";
export type ProxyStatus={state:ProxyState;reason:string;restarts:number};
export type ProxyOptions={binarySource?:string;port?:number;sha256?:string;maxRestarts?:number;windowMs?:number;backoffMs?:number;healthMs?:number;healthFailures?:number};

function portOpen(port:number){return new Promise<boolean>(resolve=>{
  const socket=connect({host:"127.0.0.1",port});let done=false;
  const finish=(open:boolean)=>{if(done)return;done=true;socket.destroy();resolve(open);};
  socket.once("connect",()=>finish(true));socket.once("error",()=>finish(false));socket.setTimeout(500,()=>finish(true));
});}

/** Own only processes started by this server; a verified existing proxy is borrowed and never stopped or restarted. */
export class CliproxyProcess {
  private child?:ChildProcess;
  private exited?:Promise<void>;
  private starting?:Promise<boolean>;
  private closing=false;
  private cancelled=new AbortController();
  private closeWork?:Promise<void>;
  private spec?:ReturnType<typeof readDeployment>;
  private status_:ProxyStatus={state:"stopped",reason:"Local proxy has not been started.",restarts:0};
  private supervised=false;
  private restarting?:Promise<void>;
  private crashes:number[]=[];
  private health?:ReturnType<typeof setInterval>;
  private probing=false;
  private failures=0;
  constructor(private dataDir:string,private options:ProxyOptions={}){}
  status():ProxyStatus{return {...this.status_};}
  private set(state:ProxyState,reason:string){if(this.closing&&state!=="stopped")return;this.status_={state,reason,restarts:this.status_.restarts};}
  private stopping?:Promise<void>;
  /** Provision the private deployment (binary, config) without launching anything; reports install state and that the proxy is off. */
  prepare(reason="Local proxy is off. Connect the local proxy in Providers to start it."){
    if(this.closing||this.child||this.starting||this.stopping)return;
    if(process.env.PI_OFFLINE==="1"||(process.env.SIGMA_DEMO??process.env.PI_ORCH_DEMO)==="1"){this.set("stopped","Local proxy is disabled in offline or demo mode.");return;}
    try{
      const provisioned=provisionProviderData(this.dataDir,{binarySource:this.options.binarySource??process.env.SIGMA_CLIPROXY_BINARY,port:this.options.port,sha256:this.options.sha256});
      if(provisioned.state==="not_installed")this.set("not_installed",provisioned.reason);else this.set("stopped",reason);
    }catch{this.set("degraded","Provisioning the private proxy deployment failed.");}
  }
  start():Promise<boolean>{
    if(this.stopping)return this.stopping.then(()=>this.start());
    const run=this.starting??=this.launch().finally(()=>{if(!this.child&&this.starting===run)this.starting=undefined;});return run;}
  /** Restartable stop: ends supervision and stops an owned process; a borrowed listener is never touched. Unlike close(), start() works again afterwards. */
  stop(reason="Local proxy is off. Connect the local proxy in Providers to start it."){
    if(this.closing)return this.close();
    return this.stopping??=(async()=>{
      this.supervised=false;this.stopHealth();
      await this.starting?.catch(()=>{});await this.restarting?.catch(()=>{});
      this.supervised=false;this.stopHealth();
      await this.stopOwned();
      this.starting=undefined;this.crashes=[];this.failures=0;this.status_.restarts=0;
      this.set("stopped",reason);
    })().finally(()=>{this.stopping=undefined;});
  }
  cancelStartup(){this.closing=true;this.cancelled.abort();}
  private async probe(spec:{baseUrl:string;apiKey:string}){
    try{
      const response=await fetch(`${spec.baseUrl}/models`,{headers:{authorization:`Bearer ${spec.apiKey}`},redirect:"error",signal:AbortSignal.any([this.cancelled.signal,AbortSignal.timeout(800)])});
      if(!response.ok)return false;
      const reader=response.body?.getReader();let bytes=0,body="";const decoder=new TextDecoder();
      if(!reader)return false;
      try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>1_000_000)return false;body+=decoder.decode(part.value,{stream:true});}}finally{await reader.cancel().catch(()=>{});}
      const catalog=JSON.parse(body);return catalog&&Array.isArray(catalog.data)&&catalog.data.length<=100;
    }catch{return false;}
  }
  private async launch(){
    if(this.closing)return false;
    if(process.env.PI_OFFLINE==="1"||(process.env.SIGMA_DEMO??process.env.PI_ORCH_DEMO)==="1"){this.set("stopped","Local proxy is disabled in offline or demo mode.");return false;}
    let provisioned:ReturnType<typeof provisionProviderData>;
    try{provisioned=provisionProviderData(this.dataDir,{binarySource:this.options.binarySource??process.env.SIGMA_CLIPROXY_BINARY,port:this.options.port,sha256:this.options.sha256});}
    catch{this.set("degraded","Provisioning the private proxy deployment failed.");throw new Error("Private local proxy deployment is invalid.");}
    if(provisioned.state==="not_installed"){this.set("not_installed",provisioned.reason);return false;}
    let spec:ReturnType<typeof readDeployment>;
    try{spec=readDeployment(this.dataDir,this.options.sha256?{sha256:this.options.sha256}:undefined);}
    catch{this.set("degraded","Private local proxy deployment failed its safety checks.");throw new Error("Private local proxy deployment is invalid.");}
    this.spec=spec;
    const occupied=await portOpen(Number(new URL(spec.baseUrl).port));
    if(this.closing)return false;
    if(occupied){
      if(await this.probe(spec)){this.set("borrowed","Using an existing verified local proxy; Sigma does not manage its lifecycle.");return true;}
      // Another deployment (e.g. dev vs installed app) owns this port. Move this Sigma-owned deployment to a free loopback port.
      try{
        const port=await findFreeProxyPort(Number(new URL(spec.baseUrl).port)+1);
        if(this.closing)return false;
        repointProxyPort(this.dataDir,port);
        spec=readDeployment(this.dataDir,this.options.sha256?{sha256:this.options.sha256}:undefined);this.spec=spec;
      }catch{this.set("degraded","Local proxy port is occupied by an unverified service.");throw new Error("Local proxy port is occupied by an unverified service.");}
    }
    this.set("starting","Starting local proxy…");
    this.spawnOwned();
    const child=this.child!;
    if(!await this.waitReady(child)||this.closing){await this.stopOwned();this.set("degraded","Local proxy did not become ready.");throw new Error("Local proxy startup failed.");}
    this.supervised=true;this.applyReady();this.startHealth();
    return true;
  }
  private spawnOwned(){
    const child=spawn(process.execPath,[fileURLToPath(new URL("./cliproxy-watchdog.mjs",import.meta.url)),this.dataDir,...(this.options.sha256?[this.options.sha256]:[])],{env:proxyEnvironment(),detached:true,stdio:["pipe","ignore","ignore","ipc"]});
    this.child=child;
    this.exited=new Promise<void>(resolve=>{child.once("error",()=>resolve());child.once("close",()=>resolve());});
    child.once("close",()=>this.onExit(child));
  }
  private async waitReady(child:ChildProcess){
    const until=Date.now()+8_000;
    while(Date.now()<until&&!this.closing){
      if(child.exitCode!==null||child.signalCode!==null)return false;
      if(await this.probe(this.spec!))return child.exitCode===null&&child.signalCode===null&&!this.closing;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    return false;
  }
  private applyReady(){
    if(!this.spec)return;
    if(authEntryCount(this.spec.auth)>0)this.set("ready","Local proxy is running and authenticated.");
    else this.set("needs_login","Local proxy is running; sign in to Antigravity to load models.");
  }
  private startHealth(){
    this.stopHealth();this.failures=0;
    const every=this.options.healthMs??30_000,limit=this.options.healthFailures??2;
    this.health=setInterval(()=>void (async()=>{
      if(this.probing||this.restarting||!this.supervised||this.closing||!this.spec)return;
      this.probing=true;
      try{
        const ok=await this.probe(this.spec);
        if(!this.supervised||this.restarting||this.closing)return;
        if(ok){this.failures=0;this.applyReady();}
        else if(++this.failures>=limit)this.set("degraded","Authenticated /models health check failed.");
      }finally{this.probing=false;}
    })(),every);
    this.health.unref();
  }
  private stopHealth(){if(this.health)clearInterval(this.health);this.health=undefined;}
  private sleep(ms:number){return new Promise<void>(resolve=>{const timer=setTimeout(resolve,ms);this.cancelled.signal.addEventListener("abort",()=>{clearTimeout(timer);resolve();},{once:true});});}
  /** An owned process died unexpectedly: bounded restarts with exponential backoff, then degraded. */
  private onExit(child:ChildProcess){
    if(this.closing||!this.supervised||this.restarting||child!==this.child)return;
    this.restarting=(async()=>{
      this.stopHealth();
      const {maxRestarts=3,windowMs=300_000,backoffMs=500}=this.options;
      while(!this.closing&&this.supervised){
        const now=Date.now();this.crashes=this.crashes.filter(at=>now-at<windowMs);
        if(this.crashes.length>=maxRestarts){this.supervised=false;await this.stopOwned();this.set("degraded",`Local proxy stopped repeatedly (${maxRestarts} restarts in ${Math.round(windowMs/60_000)} min).`);return;}
        this.crashes.push(now);this.status_.restarts++;
        this.set("starting",`Local proxy exited; restarting (attempt ${this.crashes.length}/${maxRestarts}).`);
        await this.stopOwned();
        await this.sleep(backoffMs*2**(this.crashes.length-1));
        if(this.closing)return;
        this.spawnOwned();
        if(await this.waitReady(this.child!)){if(!this.supervised||this.closing)return;this.applyReady();this.startHealth();return;}
      }
    })().finally(()=>{this.restarting=undefined;});
  }
  private async stopOwned(){
    const child=this.child;if(!child)return;
    if(child.exitCode===null&&child.signalCode===null){
      try{if(child.connected)child.send({type:"stop"},()=>{});}catch{}
      child.stdin?.end();
      await Promise.race([this.exited,new Promise(resolve=>setTimeout(resolve,1_000))]);
      if(child.pid&&child.exitCode===null&&child.signalCode===null)try{process.kill(-child.pid,"SIGKILL");}catch{}
    }
    await this.exited;if(this.child===child)this.child=undefined;
  }
  close(){this.cancelStartup();this.supervised=false;this.stopHealth();return this.closeWork??=(async()=>{await this.starting?.catch(()=>{});await this.restarting?.catch(()=>{});await this.stopOwned();this.set("stopped","Local proxy is stopped.");})();}
}
