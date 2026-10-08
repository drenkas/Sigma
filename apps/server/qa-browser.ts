import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here=dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CHROMIUM=join(homedir(),"Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
export const chromiumPath=()=>process.env.SIGMA_QA_CHROMIUM||DEFAULT_CHROMIUM;
export type Viewport={width:number;height:number};
export type Shot={bytes:Buffer;mime:"image/png";width:number;height:number;sha256:string};
export type LaunchOptions={chromium?:string;runDir:string;previewPort:number;viewport?:Viewport;
  /** "outer": sandbox-exec SBPL + Chromium --no-sandbox (default; see spike notes). "nested": SBPL + Chromium's own sandbox. "none": no SBPL, Chromium own sandbox on (spike/tests only). */
  isolation?:"outer"|"nested"|"none";
  /** CDP Fetch.requestPaused denial of non-preview origins. Off in tests that need to prove the proxy/SBPL layers by themselves. */
  cdpFilter?:boolean};
type Pending={resolve:(value:any)=>void;reject:(error:Error)=>void;method:string};
type Exit={exitCode:number|null;signal:string|null;stopping:string;groupEmpty:boolean;stderr:string;infrastructureError:string};

/** Chromium flags. Deny-by-default network: everything (loopback included, via <-loopback>) goes to a closed proxy except the preview origin. */
export function chromiumArgs(o:{runDir:string;previewPort:number;viewport:Viewport;noSandbox:boolean}){
  return [
    `--user-data-dir=${join(o.runDir,"profile")}`,"--remote-debugging-pipe","--headless=new",
    "--no-first-run","--no-default-browser-check","--disable-extensions","--disable-sync","--disable-background-networking",
    "--disable-component-update","--disable-default-apps","--disable-breakpad","--disable-crash-reporter",`--crash-dumps-dir=${join(o.runDir,"crash")}`,"--disable-quic","--metrics-recording-only",
    "--password-store=basic","--use-mock-keychain",
    "--proxy-server=http://127.0.0.1:1",`--proxy-bypass-list=<-loopback>;127.0.0.1:${o.previewPort}`,
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    `--window-size=${o.viewport.width},${o.viewport.height}`,
    ...(o.noSandbox?["--no-sandbox"]:[]),"about:blank",
  ];
}
export function sbplProfile(o:{chromiumPath:string;runDir:string;previewPort:number}){
  const app=o.chromiumPath.replace(/\/Contents\/MacOS\/[^/]+$/,"").replace(/\/[^/]+\.app$/,"");
  return readFileSync(join(here,"qa-browser.sb"),"utf8").replace("@PORT@",String(o.previewPort)).replace("@APP@",JSON.stringify(app)).replace(/@RUN@/g,JSON.stringify(o.runDir));
}
export function pngInfo(bytes:Buffer){
  if(bytes.length<33||bytes.readUInt32BE(0)!==0x89504e47||bytes.readUInt32BE(4)!==0x0d0a1a0a||bytes.toString("latin1",12,16)!=="IHDR")throw new Error("Not a PNG");
  return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
}

export class QaBrowser {
  readonly events:Array<{method:string;params:any}>=[];
  readonly blocked:string[]=[];
  pid=0;pgid=0;
  private nextId=1;private pending=new Map<number,Pending>();private buffer=Buffer.alloc(0);
  private sessionId="";private waiters:Array<{method:string;resolve:(p:any)=>void}>=[];
  private exitInfo?:Exit;private exited:Promise<Exit>;private closing?:Promise<Exit>;
  private constructor(private watchdog:ChildProcess,private origin:string,private cdpFilter:boolean,readonly viewport:Viewport){
    this.exited=new Promise(resolve=>{
      let done=false;const finish=(info:Exit)=>{if(done)return;done=true;this.exitInfo=info;for(const p of this.pending.values())p.reject(new Error("Browser exited"));this.pending.clear();resolve(info);};
      watchdog.on("message",(message:any)=>{if(message?.type==="started"){this.pid=message.pid;this.pgid=message.pgid;}else if(message?.type==="exit")finish(message);});
      watchdog.on("close",(code,signal)=>finish({exitCode:code,signal,stopping:"watchdog-closed",groupEmpty:false,stderr:"",infrastructureError:"watchdog exited without report"}));
    });
  }
  static async launch(o:LaunchOptions):Promise<QaBrowser>{
    const chromium=o.chromium??chromiumPath();
    if(!existsSync(chromium))throw new Error(`Chromium not found at ${chromium}`);
    const viewport=o.viewport??{width:800,height:600},isolation=o.isolation??"outer";
    for(const dir of ["profile","home","tmp","crash"])mkdirSync(join(o.runDir,dir),{recursive:true,mode:0o700});
    const spec={chromium,args:chromiumArgs({runDir:o.runDir,previewPort:o.previewPort,viewport,noSandbox:isolation==="outer"}),
      profile:isolation==="none"?undefined:sbplProfile({chromiumPath:chromium,runDir:o.runDir,previewPort:o.previewPort}),
      env:{PATH:"/usr/bin:/bin",HOME:join(o.runDir,"home"),TMPDIR:join(o.runDir,"tmp")+"/",LC_ALL:"C"}};
    const watchdog=spawn(process.execPath,[join(here,"qa-browser-watchdog.mjs"),JSON.stringify(spec)],{stdio:["pipe","ignore","ignore","pipe","pipe","ipc"],env:{PATH:"/usr/bin:/bin"}});
    const browser=new QaBrowser(watchdog,`http://127.0.0.1:${o.previewPort}`,o.cdpFilter??true,viewport);
    watchdog.stdin!.on("error",()=>{});
    (watchdog.stdio[4] as NodeJS.ReadableStream).on("data",(chunk:Buffer)=>browser.onData(chunk));
    (watchdog.stdio[3] as NodeJS.WritableStream).on("error",()=>{});
    try{await browser.attach();}catch(error){await browser.close().catch(()=>{});throw error;}
    return browser;
  }
  private onData(chunk:Buffer){
    this.buffer=Buffer.concat([this.buffer,chunk]);
    for(let end=this.buffer.indexOf(0);end>=0;end=this.buffer.indexOf(0)){
      const text=this.buffer.subarray(0,end).toString("utf8");this.buffer=this.buffer.subarray(end+1);
      if(!text)continue;let message:any;try{message=JSON.parse(text);}catch{continue;}
      if(message.id!==undefined){const p=this.pending.get(message.id);if(p){this.pending.delete(message.id);message.error?p.reject(new Error(`${p.method}: ${message.error.message}`)):p.resolve(message.result);}}
      else{this.events.push(message);this.onEvent(message);}
    }
  }
  private onEvent(message:{method:string;params:any}){
    if(message.method==="Fetch.requestPaused"){
      const url:string=message.params.request.url,ok=url.startsWith(this.origin+"/")||url==="about:blank"||url.startsWith("data:")&&false;
      if(!ok)this.blocked.push(url);
      void this.send(ok?"Fetch.continueRequest":"Fetch.failRequest",ok?{requestId:message.params.requestId}:{requestId:message.params.requestId,errorReason:"BlockedByClient"},true).catch(()=>{});
    }
    this.waiters=this.waiters.filter(w=>{if(w.method===message.method){w.resolve(message.params);return false;}return true;});
  }
  private send(method:string,params:object={},session=false):Promise<any>{
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      if(this.exitInfo)return reject(new Error("Browser exited"));
      this.pending.set(id,{resolve,reject,method});
      const body:any={id,method,params};if(session&&this.sessionId)body.sessionId=this.sessionId;
      (this.watchdog.stdio[3] as NodeJS.WritableStream).write(JSON.stringify(body)+"\0");
    });
  }
  private waitFor(method:string,ms=15_000){return new Promise<any>((resolve,reject)=>{const t=setTimeout(()=>reject(new Error(`Timed out waiting for ${method}`)),ms);this.waiters.push({method,resolve:p=>{clearTimeout(t);resolve(p);}});});}
  private async attach(){
    const {targetInfos}=await this.send("Target.getTargets");
    let target=targetInfos.find((t:any)=>t.type==="page");
    const targetId=target?.targetId??(await this.send("Target.createTarget",{url:"about:blank"})).targetId;
    this.sessionId=(await this.send("Target.attachToTarget",{targetId,flatten:true})).sessionId;
    await this.send("Page.enable",{},true);
    await this.send("Emulation.setDeviceMetricsOverride",{width:this.viewport.width,height:this.viewport.height,deviceScaleFactor:1,mobile:false},true);
    if(this.cdpFilter)await this.send("Fetch.enable",{patterns:[{urlPattern:"*"}]},true);
  }
  async navigate(url:string){
    const loaded=this.waitFor("Page.loadEventFired");
    const result=await this.send("Page.navigate",{url},true);
    if(result.errorText){loaded.catch(()=>{});throw new Error(`Navigation failed: ${result.errorText}`);}
    await loaded;
  }
  /** Page-session CDP command (Input.*, Page.*). */
  pageCommand(method:string,params:object={}){return this.send(method,params,true);}
  /** Settles when the browser group is gone (self-exit, crash or close()). */
  get closed():Promise<Exit>{return this.exited;}
  get dead(){return !!this.exitInfo;}
  /** Browser-level (non-page) CDP command, e.g. Browser.setDownloadBehavior. */
  browserCommand(method:string,params:object={}){return this.send(method,params);}
  async evaluate<T=unknown>(expression:string):Promise<T>{
    const result=await this.send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true},true);
    if(result.exceptionDetails)throw new Error(`Evaluate failed: ${result.exceptionDetails.exception?.description??result.exceptionDetails.text}`);
    return result.result.value as T;
  }
  async screenshot():Promise<Shot>{
    const {data}=await this.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false},true);
    const bytes=Buffer.from(data,"base64"),{width,height}=pngInfo(bytes);
    return {bytes,mime:"image/png",width,height,sha256:createHash("sha256").update(bytes).digest("hex")};
  }
  /** Browser.close, then watchdog SIGTERM->SIGKILL on the group; resolves only once the group is empty. */
  close():Promise<Exit>{
    return this.closing??=(async()=>{
      if(!this.exitInfo){
        void this.send("Browser.close").catch(()=>{});
        const graceful=await Promise.race([this.exited,new Promise<undefined>(r=>setTimeout(r,3000))]);
        if(!graceful)this.watchdog.stdin?.end();
      }
      const info=await this.exited;
      this.watchdog.stdin?.destroy();
      return info;
    })();
  }
}
