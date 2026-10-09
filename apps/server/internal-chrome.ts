import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, chmodSync, constants, mkdirSync, realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";
import { chromiumPath } from "./qa-browser.js";

type Exit={groupEmpty:boolean;stopping:string;exitCode:number|null;signal:string|null};
type Entry={
  owner:string;id:string;runDir:string;cancelled:boolean;ready:boolean;child?:ChildProcess;exit?:Exit;
  input?:Writable;output?:Readable;closed:Promise<Exit>;resolveClosed:(value:Exit)=>void;stop?:Promise<void>;
};
export type InternalChromeLease={id:string;input:Writable;output:Readable;closed:Promise<void>;stop:()=>Promise<void>};

const watchdog=fileURLToPath(new URL("./qa-browser-watchdog.mjs",import.meta.url));
const failedExit=(stopping:string):Exit=>({groupEmpty:false,stopping,exitCode:null,signal:null});
class InternalChromeUnavailable extends Error{}

/**
 * Starts only Sigma's own visible Chrome for Testing process. The watchdog owns
 * the process group, so a server crash or parent-pipe close drains that group.
 */
export class InternalChrome{
  private active?:Entry;
  private closing=false;
  constructor(private dataDir:string){}

  private reserve(owner:string):Entry{
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner))throw new Error("Internal Chrome requires a valid session owner");
    if(this.closing)throw new Error("Internal Chrome is shutting down");
    if(this.active)throw new Error("An internal Chrome process is starting or still draining");
    let resolveClosed!:(value:Exit)=>void;
    const closed=new Promise<Exit>(resolve=>{resolveClosed=resolve;});
    const id=randomUUID(),runDir=join(this.dataDir,"browser-use","internal",owner,id);
    const entry:Entry={owner,id,runDir,cancelled:false,ready:false,closed,resolveClosed};
    // Reserve synchronously before directory creation or any process wait.
    this.active=entry;
    return entry;
  }

  private finish(entry:Entry,exit:Exit){
    if(entry.exit)return;
    entry.exit=exit;entry.resolveClosed(exit);
    if(exit.groupEmpty&&this.active===entry)this.active=undefined;
  }

  private requestStop(entry:Entry){
    entry.cancelled=true;
    try{entry.child?.stdin?.end();}catch{}
    if(!entry.child&&entry.ready===false&&this.active===entry){
      // The launch path checks cancellation after each preparation wait.
      // It owns finalization while still preparing.
    }
  }

  async launch(owner:string,check:()=>void=()=>{}):Promise<InternalChromeLease>{
    const entry=this.reserve(owner);
    try{return await this.start(entry,check);}
    catch(error){
      this.requestStop(entry);
      if(!entry.child)this.finish(entry,{...failedExit("cancelled before browser start"),groupEmpty:true});
      const exit=await entry.closed;
      if(!exit.groupEmpty)throw new Error("Internal Chrome process cleanup could not be confirmed; new launches are blocked");
      if(error instanceof InternalChromeUnavailable)throw error;
      throw new Error("Internal Chrome could not start; its owned process was stopped and nothing was replayed");
    }
  }

  private async start(entry:Entry,check:()=>void):Promise<InternalChromeLease>{
    const active=()=>{if(entry.cancelled||this.closing||this.active!==entry)throw new Error("Internal Chrome launch was stopped");check();};
    const profile=join(entry.runDir,"profile"),home=join(entry.runDir,"home"),tmp=join(entry.runDir,"tmp");
    const base=join(this.dataDir,"browser-use","internal"),ownerDir=join(base,entry.owner);
    mkdirSync(entry.runDir,{recursive:true,mode:0o700});
    for(const dir of [base,ownerDir,entry.runDir,profile,home,tmp]){mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);}
    active();

    let chromium:string;
    try{chromium=realpathSync(chromiumPath());accessSync(chromium,constants.X_OK);if(!statSync(chromium).isFile())throw new Error();}
    catch{throw new InternalChromeUnavailable("Chrome for Testing is unavailable. Install or configure the existing Sigma Chrome for Testing runtime, then retry.");}
    const args=[
      `--user-data-dir=${profile}`,
      "--remote-debugging-pipe",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-breakpad",
      "--disable-crash-reporter",
      "--disable-quic",
      "--metrics-recording-only",
      "--window-size=1280,800",
      "about:blank",
    ];
    const env={
      PATH:process.env.PATH||"/usr/bin:/bin:/usr/sbin:/sbin",
      // macOS Keychain needs the account home; the browser profile stays private.
      HOME:process.platform==="darwin"?userInfo().homedir:home,
      TMPDIR:tmp,
      XDG_CONFIG_HOME:join(home,".config"),
      XDG_CACHE_HOME:join(home,".cache"),
      LANG:process.env.LANG||"en_US.UTF-8",
    };
    active();
    const child=spawn(process.execPath,[watchdog,JSON.stringify({chromium,args,env,termGraceMs:400})],{
      cwd:entry.runDir,
      env:{PATH:env.PATH,HOME:home,TMPDIR:tmp},
      stdio:["pipe","ignore","ignore","pipe","pipe","ipc"],
    });
    entry.child=child;entry.input=child.stdio[3] as Writable;entry.output=child.stdio[4] as Readable;
    let sawExit=false;
    let signalStarted!:()=>void;const started=new Promise<void>(resolve=>{signalStarted=resolve;});
    child.on("message",message=>{
      const event=message as any;
      if(!event||typeof event!=="object")return;
      if(event.type==="started"){signalStarted();return;}
      if(event.type==="exit"){
        sawExit=true;
        this.finish(entry,{
          groupEmpty:event.groupEmpty===true,
          stopping:typeof event.stopping==="string"?event.stopping:"unknown",
          exitCode:Number.isInteger(event.exitCode)?event.exitCode:null,
          signal:typeof event.signal==="string"?event.signal:null,
        });
      }
    });
    child.on("error",()=>this.finish(entry,{...failedExit("watchdog failed"),groupEmpty:child.pid===undefined}));
    child.on("close",(code,signal)=>{if(!sawExit)this.finish(entry,{...failedExit("watchdog exited without a drain receipt"),exitCode:code,signal});});
    child.on("spawn",()=>{if(entry.cancelled)try{child.stdin?.end();}catch{}});

    const startup=entry.closed.then(()=>{throw new Error("Internal Chrome exited before startup completed");});
    await Promise.race([started,startup]);
    active();if(!entry.input||!entry.output)throw new Error("Internal Chrome pipe transport was unavailable");
    entry.ready=true;
    const closed=entry.closed.then(()=>undefined);
    return {id:entry.id,input:entry.input,output:entry.output,closed,stop:()=>this.stop(entry.owner,entry.id)};
  }

  stop(owner?:string,id?:string):Promise<void>{
    const entry=this.active;
    if(!entry||owner&&entry.owner!==owner||id&&entry.id!==id)return Promise.resolve();
    this.requestStop(entry);
    return entry.stop??=(entry.closed.then(exit=>{
      if(!exit.groupEmpty)throw new Error("Internal Chrome process group drain was not confirmed");
    }));
  }

  beginClose(){if(this.closing)return;this.closing=true;void this.stop().catch(()=>{});}
  close(){this.beginClose();return this.stop();}
}
