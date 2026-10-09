import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, openSync, closeSync, fstatSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { BrowserModeCommandView, BrowserUseActionKind, BrowserUseActionStatus, BrowserUseActionView, BrowserUseArtifactView, BrowserUseMode, BrowserUseTargetView, BrowserUseView } from "../../packages/contracts/index.js";
import { chromeUserDataDir } from "./chrome-path.js";
import type { InternalChrome, InternalChromeLease } from "./internal-chrome.js";
import { pngInfo } from "./qa-browser.js";
import { Storage } from "./storage.js";

const MAX_PNG_BYTES=8*1024*1024,MAX_PIXELS=24_000_000;
const sha=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
export const BROWSER_TOOLS=["browser_screenshot","browser_click","browser_type","browser_scroll","browser_key","browser_navigate"] as const;
export const isBrowserTool=(name:string)=>(BROWSER_TOOLS as readonly string[]).includes(name);
const CDP_METHODS=new Set([
  "Browser.getVersion","Target.getTargets","Target.attachToTarget","Target.detachFromTarget",
  "Browser.setDownloadBehavior",
  "Page.enable","Page.bringToFront","Page.getLayoutMetrics","Page.getFrameTree","Page.captureScreenshot","Page.navigate",
  "Input.dispatchMouseEvent","Input.synthesizeScrollGesture","Input.dispatchKeyEvent","Input.insertText","Runtime.evaluate","Runtime.callFunctionOn","Runtime.releaseObjectGroup",
]);
type CdpEvent={method:string;params:any;sessionId?:string};
type CdpEventWait={promise:Promise<void>;cancel:()=>void};

/** A deliberately narrow CDP client. CDP method names never come from a caller. */
export class NativeChromeCdp{
  private socket?:WebSocket;
  private pipeInput?:Writable;
  private pipeOutput?:Readable;
  private pipeBuffer=Buffer.alloc(0);
  private nextId=0;
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private listeners=new Set<(event:CdpEvent)=>void>();
  private closeListeners=new Set<()=>void>();
  private closed=false;
  constructor(connection:string|{input:Writable;output:Readable}){
    if(typeof connection==="string")this.socket=new WebSocket(connection);
    else{this.pipeInput=connection.input;this.pipeOutput=connection.output;}
  }
  static async connect(url:string,timeoutMs=7_000){
    const cdp=new NativeChromeCdp(url);
    try{await cdp.start(timeoutMs);return cdp;}catch(error){cdp.close();throw error;}
  }
  static connectPipe(input:Writable,output:Readable){
    const cdp=new NativeChromeCdp({input,output});
    input.on("error",()=>cdp.disconnect());
    output.on("data",chunk=>cdp.pipeMessage(chunk));
    output.on("end",()=>cdp.disconnect());output.on("close",()=>cdp.disconnect());output.on("error",()=>cdp.disconnect());
    return cdp;
  }
  start(timeoutMs:number){return new Promise<void>((resolve,reject)=>{
    if(!this.socket){if(this.closed)reject(new Error("Chrome connection closed"));else resolve();return;}
    let settled=false;const timer=setTimeout(()=>finish(new Error("Chrome connection timed out")),timeoutMs);
    const socket=this.socket;
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);socket.removeEventListener("open",onOpen);socket.removeEventListener("error",onError);socket.removeEventListener("close",onClose);if(error)reject(error);else resolve();};
    const onOpen=()=>finish();const onError=()=>finish(new Error("Chrome connection failed"));
    const onClose=()=>finish(new Error("Chrome connection closed"));
    socket.addEventListener("open",onOpen);socket.addEventListener("error",onError);
    socket.addEventListener("close",onClose);
    socket.addEventListener("message",event=>{void this.message(event.data);});
    socket.addEventListener("close",()=>this.disconnect());
  });}
  onEvent(listener:(event:CdpEvent)=>void){this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
  onClosed(listener:()=>void){this.closeListeners.add(listener);return ()=>this.closeListeners.delete(listener);}
  waitForEvent(method:string,sessionId:string,timeoutMs:number,predicate:(event:CdpEvent)=>boolean=()=>true):CdpEventWait{
    let resolve!:()=>void,reject!:(error:Error)=>void,settled=false,remove=()=>{},removeClosed=()=>{},timer:ReturnType<typeof setTimeout>;
    const promise=new Promise<void>((ok,no)=>{resolve=ok;reject=no;});
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);remove();removeClosed();error?reject(error):resolve();};
    remove=this.onEvent(event=>{if(event.method===method&&event.sessionId===sessionId&&predicate(event))finish();});
    removeClosed=this.onClosed(()=>finish(new Error("Chrome connection closed")));
    timer=setTimeout(()=>finish(new Error("Chrome page did not finish loading")),timeoutMs);
    return {promise,cancel:()=>finish()};
  }
  private async message(data:unknown){
    let raw:string;try{raw=typeof data==="string"?data:await (data as Blob).text();}catch{return;}
    let message:any;try{message=JSON.parse(raw);}catch{return;}
    if(Number.isSafeInteger(message.id)){const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);clearTimeout(pending.timer);message.error?pending.reject(new Error("Chrome rejected a browser command")):pending.resolve(message.result);return;}
    this.dispatch(message);
  }
  private pipeMessage(chunk:Buffer|string){
    if(this.closed)return;
    this.pipeBuffer=Buffer.concat([this.pipeBuffer,Buffer.from(chunk)]);
    if(this.pipeBuffer.length>12*1024*1024){this.disconnect();return;}
    let end:number;
    while((end=this.pipeBuffer.indexOf(0))>=0){const frame=this.pipeBuffer.subarray(0,end);this.pipeBuffer=this.pipeBuffer.subarray(end+1);let message:any;try{message=JSON.parse(frame.toString("utf8"));}catch{this.disconnect();return;}this.dispatch(message);}
  }
  private dispatch(message:any){
    if(Number.isSafeInteger(message.id)){const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);clearTimeout(pending.timer);message.error?pending.reject(new Error("Chrome rejected a browser command")):pending.resolve(message.result);return;}
    if(typeof message.method==="string")for(const listener of this.listeners)listener({method:message.method,params:message.params??{},sessionId:message.sessionId});
  }
  private disconnect(){
    if(this.closed)return;this.failPending();for(const listener of this.closeListeners)listener();
  }
  private failPending(){this.closed=true;for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(new Error("Chrome connection closed"));}this.pending.clear();}
  command(method:string,params:Record<string,unknown>={},sessionId?:string,timeoutMs=8_000){
    if(!CDP_METHODS.has(method))return Promise.reject(new Error("Unsupported browser operation"));
    if(this.closed||this.socket&&this.socket.readyState!==WebSocket.OPEN||!this.socket&&!this.pipeInput)return Promise.reject(new Error("Chrome connection is closed"));
    const id=++this.nextId;
    return new Promise<any>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error("Chrome browser command timed out"));},timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try{const frame=JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})});if(this.socket)this.socket.send(frame);else this.pipeInput!.write(`${frame}\0`);}
      catch{this.pending.delete(id);clearTimeout(timer);reject(new Error("Chrome browser command could not be sent"));}
    });
  }
  close(){this.disconnect();try{this.socket?.close();}catch{}try{this.pipeInput?.end();}catch{} }
}

/** Reads exactly Chrome's small, process-owned DevTools endpoint descriptor; never queries /json/version. */
export function readChromeEndpoint(home=homedir()):string{
  const path=join(chromeUserDataDir(home),"DevToolsActivePort");
  let fd:number|undefined;
  try{
    const before=lstatSync(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size<1||before.size>512||before.uid!==process.getuid?.())throw new Error();
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);const info=fstatSync(fd);
    if(!info.isFile()||info.nlink!==1||info.dev!==before.dev||info.ino!==before.ino||info.size!==before.size||info.uid!==process.getuid?.())throw new Error();
    const bytes=readFileSync(fd);if(bytes.length>512)throw new Error();
    const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes),match=/^(\d{1,5})\n(\/devtools\/browser(?:\/[A-Za-z0-9._-]{1,128})?)\n?$/.exec(text);
    if(!match)throw new Error();const port=Number(match[1]);if(port<1024||port>65535)throw new Error();
    return `ws://127.0.0.1:${port}${match[2]}`;
  }catch{throw new Error("Chrome remote debugging is unavailable. In Chrome, open chrome://inspect/#remote-debugging and enable it, then try again.");}
  finally{if(fd!==undefined)try{closeSync(fd);}catch{}}
}

type BrowserMode=BrowserUseMode;
type Attempt={owner:string;epoch:string;mode:BrowserMode;cdp?:NativeChromeCdp;internalLease?:InternalChromeLease;cancelled:boolean};
type PipeTransport={input:Writable;output:Readable};
type CdpTransport={endpoint?:string;pipe?:PipeTransport};
type Target={alias:string;targetId:string;label:string;origin:string;host:string};
type FocusReference={group:string;objectId:string};
type Observation={id:string;epoch:string;targetId:string;sessionId:string;generation:number;width:number;height:number;cssWidth:number;cssHeight:number;sha256:string;focus:FocusReference;at:number};
type Selected={targetId:string;sessionId:string;alias:string;label:string;origin:string;host:string;generation:number;rootFrameId?:string;topUrlHash?:string;blockedControlPage?:boolean;observation?:Observation};
type Live={owner:string;epoch:string;mode:BrowserMode;cdp:NativeChromeCdp;targets:Target[];internalBlankTargetId?:string;internalLease?:InternalChromeLease;selected?:Selected;busy:boolean;revoked:boolean;removeEvents:()=>void};
type PageSafety={credential:boolean;activeSensitive:boolean;frame:boolean;editable:boolean;uninspectableFrame:boolean};
type ActionInput={observationId?:unknown;x?:unknown;y?:unknown;text?:unknown;key?:unknown;deltaX?:unknown;deltaY?:unknown;url?:unknown};
type Send=(sessionId:string,type:string,payload:unknown,durable?:boolean)=>Promise<void>;
type Approve=(preview:string)=>Promise<boolean>;
class CredentialScreenshotBlocked extends Error{}
class ControlPageBlocked extends Error{constructor(){super("The selected tab reached Sigma's local control page and was detached; no image was retained or returned");}}
class ControlPageDestinationBlocked extends Error{constructor(){super("Sigma control pages cannot be opened through browser tools; nothing was sent");}}
class UnsupportedPageBlocked extends Error{constructor(){super("The selected tab left HTTP(S) and was detached; choose an HTTP(S) page");}}
const SAFE_ACTION_ERRORS=new Set([
  "Observation is missing or stale; take a fresh browser screenshot first",
  "Focus changed since the screenshot; take a fresh browser screenshot before typing or pressing a key",
  "Focus changed while approval was pending; action cancelled",
  "The Chrome page changed after it was observed; take a new screenshot before acting",
  "The Chrome page changed while approval was pending; action cancelled",
  "Chrome viewport changed; take a fresh screenshot",
  "Coordinates are outside the current Chrome viewport",
  "Typing is disabled while focus is inside a frame",
  "Typing is disabled because a visible frame could not be inspected",
  "Typing and Enter are blocked while a visible credential or verification field is present",
  "Typing requires a verifiable text field or editable page area",
  "Focus changed since the screenshot; take a fresh browser screenshot before typing or pressing a key",
  "Focus changed while approval was pending; action cancelled",
  "Focus changed while the screenshot was captured; take a fresh browser screenshot",
  "Typing was cancelled because the focused field could not be verified as a non-secret text field",
  "Key press was cancelled because a credential field or frame could receive it",
  "Screenshots are blocked while a visible credential or verification field is present; sign in manually in Chrome",
  "Screenshots are blocked because a visible frame could not be inspected",
  "Chrome page safety could not be verified; typing is disabled",
  "Scroll distance must be between -1000 and 1000 pixels",
  "Key is outside the supported browser key list",
  "Enter 1-500 non-secret characters",
  "Use a full HTTP or HTTPS URL",
  "Use a full HTTP or HTTPS URL without embedded credentials",
  "Use a loopback address shown by chrome://inspect",
  "Use a loopback address such as 127.0.0.1:9222 or [::1]:9222",
  "Chrome tab is no longer available; refresh and choose it again",
  "The browser action was already attempted and was not replayed",
  "This browser action has an unknown outcome and was not replayed",
  "This browser action was already attempted and was not replayed",
  "Chrome access was stopped; nothing was replayed",
  "This browser action ID was already used for different arguments; nothing was sent",
  "This browser action ID cannot be verified against its original request; nothing was replayed",
  "Screenshots are blocked because a visible frame could not be inspected",
  "Coordinates must be visible screenshot coordinates",
  "A fresh browser observation is required",
  "Chrome viewport could not be verified",
  "Chrome screenshot exceeded the safe size limit",
  "Chrome screenshot exceeded the safe image bounds",
  "The selected tab reached Sigma's local control page and was detached; no image was retained or returned",
  "Sigma control pages cannot be opened through browser tools; nothing was sent",
  "The selected tab left HTTP(S) and was detached; choose an HTTP(S) page",
  "Chrome could not verify the selected tab's address; choose it again",
]);

function ipv6Words(host:string):number[]|undefined{
  let value=host.toLowerCase();
  if(value.includes(".")){
    const last=value.slice(value.lastIndexOf(":")+1);if(isIP(last)!==4)return;
    const octets=last.split(".").map(Number),high=((octets[0]<<8)|octets[1]).toString(16),low=((octets[2]<<8)|octets[3]).toString(16);
    value=`${value.slice(0,value.lastIndexOf(":"))}:${high}:${low}`;
  }
  const halves=value.split("::");if(halves.length>2)return;
  const left=halves[0]?halves[0].split(":"):[],right=halves.length===2&&halves[1]?halves[1].split(":"):[];
  const zeros=8-left.length-right.length;if(halves.length===1&&zeros!==0||halves.length===2&&zeros<1)return;
  const groups=[...left,...Array(zeros).fill("0"),...right];if(groups.length!==8||groups.some(group=>!/^[0-9a-f]{1,4}$/.test(group)))return;
  return groups.map(group=>parseInt(group,16));
}
function isLoopbackHost(hostname:string){
  const host=hostname.toLowerCase().replace(/^\[|\]$/g,"").replace(/\.$/,"");
  if(host==="localhost"||host.endsWith(".localhost")||host==="localhost.localdomain")return true;
  if(isIP(host)===4){const octets=host.split(".").map(Number);return octets[0]===127||octets.every(octet=>octet===0);}
  if(isIP(host)!==6)return false;
  const words=ipv6Words(host);if(!words)return false;
  if(words.slice(0,7).every(word=>word===0)&&(words[7]===1||words[7]===0))return true;
  return words.slice(0,5).every(word=>word===0)&&words[5]===0xffff&&((words[6]>>>8)===127||(words[6]===0&&words[7]===0));
}
function isControlPlaneUrl(url:URL,ports:readonly number[]){
  const port=url.port?Number(url.port):url.protocol==="https:"?443:80;
  return ports.includes(port)&&isLoopbackHost(url.hostname);
}
function targetUrl(raw:any):URL|undefined{if(typeof raw?.url!=="string"||raw.url.length>4096)return;try{return new URL(raw.url);}catch{return;}}
function safeTarget(raw:any,alias:string,allowBlank=false,controlPlanePorts:readonly number[]=[]):Target|undefined{
  if(raw?.type!=="page"||typeof raw.url!=="string")return;
  if(allowBlank&&raw.url==="about:blank"&&typeof raw.targetId==="string")return {alias,targetId:raw.targetId,label:"Internal start page",origin:"about:blank",host:"Internal start page"};
  try{const url=new URL(raw.url);if(!["http:","https:"].includes(url.protocol)||!url.hostname||isControlPlaneUrl(url,controlPlanePorts))return;const title=typeof raw.title==="string"?raw.title.replace(/[\u0000-\u001f\u007f]+/g," ").replace(/\s+/g," ").trim().slice(0,80):"";return {alias,targetId:String(raw.targetId),label:title||"Untitled tab",origin:url.origin,host:url.host};}catch{return;}
}
const safeTargetView=(target:Target):BrowserUseTargetView=>({id:target.alias,label:target.label,host:target.host,origin:target.origin});
function disambiguateTargets(targets:Target[]){
  const groups=new Map<string,Target[]>();
  for(const target of targets){const key=`${target.origin}\n${target.label}`,group=groups.get(key)??[];group.push(target);groups.set(key,group);}
  for(const group of groups.values())if(group.length>1)group.forEach((target,index)=>{target.label=`${target.label} (tab ${index+1})`;});
}
function asPixels(value:unknown,_name:string){if(typeof value!=="number"||!Number.isFinite(value)||value<0||value>20_000)throw new Error("Coordinates must be visible screenshot coordinates");return value;}
function safeUrl(value:unknown){if(typeof value!=="string"||value.length>4096)throw new Error("Use a full HTTP or HTTPS URL");try{const url=new URL(value);if(!["http:","https:"].includes(url.protocol)||!url.hostname||url.username||url.password)throw new Error();return url.toString();}catch{throw new Error("Use a full HTTP or HTTPS URL without embedded credentials");}}
function normalizedAction(kind:BrowserUseActionKind,input:ActionInput):Record<string,unknown>{
  if(kind==="screenshot")return {};
  if(typeof input.observationId!=="string"||!input.observationId||input.observationId.length>100)throw new Error("Observation is missing or stale; take a fresh browser screenshot first");
  if(kind==="navigate")return {url:safeUrl(input.url),observationId:input.observationId};
  if(kind==="click")return {x:asPixels(input.x,"x"),y:asPixels(input.y,"y"),observationId:input.observationId};
  if(kind==="scroll"){
    const x=asPixels(input.x,"x"),y=asPixels(input.y,"y"),deltaX=input.deltaX??0,deltaY=input.deltaY??0;
    if(typeof deltaX!=="number"||!Number.isFinite(deltaX)||Math.abs(deltaX)>1000||typeof deltaY!=="number"||!Number.isFinite(deltaY)||Math.abs(deltaY)>1000)throw new Error("Scroll distance must be between -1000 and 1000 pixels");
    return {x,y,deltaX,deltaY,observationId:input.observationId};
  }
  if(kind==="type"){
    if(typeof input.text!=="string"||!input.text.length||input.text.length>500||/[\0]/.test(input.text))throw new Error("Enter 1-500 non-secret characters");
    return {text:input.text,observationId:input.observationId};
  }
  const keys=new Set(["Enter","Tab","Escape","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End","PageUp","PageDown","Backspace","Delete","Space"]);
  if(typeof input.key!=="string"||!keys.has(input.key))throw new Error("Key is outside the supported browser key list");
  return {key:input.key,observationId:input.observationId};
}
function manualEndpoint(value:unknown){
  if(typeof value!=="string"||value.length>64)throw new Error("Use the loopback address shown by chrome://inspect");
  const match=/^(127\.0\.0\.1|\[::1\]):(\d{1,5})$/.exec(value.trim());if(!match)throw new Error("Use a loopback address such as 127.0.0.1:9222 or [::1]:9222");
  const port=Number(match[2]);if(port<1024||port>65535)throw new Error("Chrome debugging port is outside the safe range");return `ws://${match[1]}:${port}/devtools/browser`;
}

/** User-granted connection to one currently open, normal Chrome target. No browser process/profile control. */
export class BrowserUse{
  private live?:Live;
  private attempt?:Attempt;
  private modeOwner?:string;
  private lastMode?:BrowserMode;
  private closing=false;
  constructor(private storage:Storage,private dataDir:string,private send:Send,private home=homedir(),private internalChrome?:InternalChrome,private controlPlanePorts:readonly number[]=[]){
    if(controlPlanePorts.some(port=>!Number.isInteger(port)||port<1||port>65535))throw new Error("Invalid protected control-plane port");
  }
  private async assertOwner(sessionId:string){
    const row=await this.storage.call<any>("session",{id:sessionId});
    if(!row||row.parentId||row.role!=="root"||row.policy?.unsupervised||row.archivedAt||!row.policy?.effective?.profile?.tools?.length||this.closing)throw new Error("Chrome access is limited to an active supervised root session");
    return row;
  }
  private async bump(sessionId:string){await this.send(sessionId,"browser_use_changed",{sessionId},true).catch(()=>{});}
  private reserveAttempt(owner:string,mode:BrowserMode):Attempt{
    if(this.closing)throw new Error("Chrome connection is stopped");
    if(this.live||this.attempt)throw new Error("A Chrome connection is already owned by another session; disconnect it first");
    const attempt:Attempt={owner,epoch:randomUUID(),mode,cancelled:false};this.attempt=attempt;return attempt;
  }
  private checkAttempt(attempt:Attempt,admissionCheck:()=>void=()=>{}){
    if(this.closing||attempt.cancelled||this.attempt!==attempt)throw new Error("Chrome connection was stopped");
    admissionCheck();
  }
  private cancelAttempt(attempt:Attempt){attempt.cancelled=true;if(this.attempt===attempt)this.attempt=undefined;attempt.cdp?.close();if(attempt.internalLease)void attempt.internalLease.stop();else if(attempt.mode==="internal")void this.internalChrome?.stop(attempt.owner);}
  async connect(sessionId:string,address?:unknown,admit:(check:()=>void)=>Promise<void>=async()=>{}):Promise<BrowserUseView>{
    if(this.modeOwner===sessionId&&this.lastMode==="internal")throw new Error("Use /browser chrome to switch from Internal Chrome to your current Chrome");
    if(this.live?.owner===sessionId){await this.assertOwner(sessionId);if(this.live.mode==="internal")throw new Error("Use /browser chrome to switch from Internal Chrome to your current Chrome");return this.view(sessionId);}
    const attempt=this.reserveAttempt(sessionId,"chrome");
    try{
      await this.assertOwner(sessionId);this.checkAttempt(attempt);
      await admit(()=>this.checkAttempt(attempt));this.checkAttempt(attempt);
      const endpoint=address===undefined?readChromeEndpoint(this.home):manualEndpoint(address);this.checkAttempt(attempt);
      this.modeOwner=sessionId;this.lastMode="chrome";
      return await this.connectEndpoint(attempt,{endpoint});
    }catch(error){if(this.attempt===attempt)this.cancelAttempt(attempt);throw error;}
  }
  async setMode(sessionId:string,mode:BrowserMode,check:()=>void=()=>{}):Promise<BrowserUseView>{
    await this.assertOwner(sessionId);check();
    if(this.live&&this.live.owner!==sessionId||this.attempt&&this.attempt.owner!==sessionId)throw new Error("A browser connection is already owned by another session; disconnect it first");
    if(mode==="internal"){
      if(this.live?.owner===sessionId&&this.live.mode==="internal")return this.view(sessionId);
      if(this.live?.owner===sessionId)await this.disconnect(sessionId);
      if(this.attempt?.owner===sessionId)this.revoke(sessionId);
      this.modeOwner=sessionId;this.lastMode="internal";check();
      try{return await this.connectInternal(sessionId,check);}
      catch(error){await this.bump(sessionId);throw error;}
    }
    this.modeOwner=sessionId;this.lastMode="chrome";
    if(this.live?.owner===sessionId&&this.live.mode==="internal")await this.disconnect(sessionId);
    else if(this.attempt?.owner===sessionId&&this.attempt.mode==="internal"){
      this.revoke(sessionId);await this.internalChrome?.stop(sessionId);
    }
    check();await this.bump(sessionId);return this.view(sessionId);
  }
  private async connectInternal(sessionId:string,check:()=>void):Promise<BrowserUseView>{
    if(!this.internalChrome)throw new Error("Internal Chrome is unavailable in this installation");
    if(this.live||this.attempt)throw new Error("A browser connection is already active; switch modes explicitly first");
    const attempt=this.reserveAttempt(sessionId,"internal");let lease:InternalChromeLease|undefined;
    try{
      const fenced=()=>this.checkAttempt(attempt,check);
      lease=await this.internalChrome.launch(sessionId,fenced);fenced();attempt.internalLease=lease;
      return await this.connectEndpoint(attempt,{pipe:{input:lease.input,output:lease.output}},lease,check);
    }catch(error){if(this.attempt===attempt)this.cancelAttempt(attempt);await lease?.stop();throw error;}
  }
  private async connectEndpoint(attempt:Attempt,transport:CdpTransport,internalLease?:InternalChromeLease,admissionCheck:()=>void=()=>{}):Promise<BrowserUseView>{
    const {owner:sessionId,epoch,mode}=attempt,cdp=transport.pipe?NativeChromeCdp.connectPipe(transport.pipe.input,transport.pipe.output):new NativeChromeCdp(transport.endpoint!);
    attempt.cdp=cdp;if(internalLease)attempt.internalLease=internalLease;
    try{
      const assertAttempt=()=>this.checkAttempt(attempt,admissionCheck);
      await cdp.start(mode==="internal"?20_000:60_000);
      assertAttempt();
      const version=await cdp.command("Browser.getVersion",{},undefined,mode==="internal"?45_000:8_000);assertAttempt();
      const major=/^Chrome\/(\d+)\./.exec(String(version.product||""));if(!major||Number(major[1])<144)throw new Error("Chrome 144 or newer is required");
      const {targetInfos=[]}=await cdp.command("Target.getTargets",{},undefined,mode==="internal"?45_000:8_000);assertAttempt();
      const blanks=mode==="internal"?targetInfos.filter((info:any)=>info?.type==="page"&&info.url==="about:blank"):[];
      if(mode==="internal"&&blanks.length!==1)throw new Error("Internal Chrome did not expose exactly one owned start page");
      const live:Live={owner:sessionId,epoch,mode,cdp,targets:[],...(internalLease&&blanks.length===1?{internalBlankTargetId:String(blanks[0].targetId),internalLease}:{}),busy:false,revoked:false,removeEvents:()=>{}};
      for(const info of targetInfos){const target=safeTarget(info,randomUUID(),mode==="internal"&&String(info?.targetId)===live.internalBlankTargetId,this.controlPlanePorts);if(target)live.targets.push(target);}
      disambiguateTargets(live.targets);
      if(mode==="internal")await cdp.command("Browser.setDownloadBehavior",{behavior:"deny"});assertAttempt();
      live.removeEvents=cdp.onEvent(event=>this.onEvent(live,event));this.live=live;this.attempt=undefined;
      cdp.onClosed(()=>{if(this.live===live&&!live.revoked)this.revoke(sessionId);});
      if(mode==="internal"){
        const start=live.targets.find(target=>target.targetId===live.internalBlankTargetId);
        if(!start)throw new Error("Internal Chrome start page was unavailable");
        const assertLive=()=>{if(live.revoked||this.live!==live)throw new Error("Chrome connection was stopped");};
        await this.select(sessionId,start.alias);assertLive();
        void internalLease!.closed.then(()=>{if(this.live===live&&!live.revoked)this.revoke(sessionId);});
      }
      await this.bump(sessionId);return this.view(sessionId);
    }catch(error){
      cdp.close();if(this.live?.epoch===epoch)this.revoke(sessionId);if(this.attempt===attempt)this.cancelAttempt(attempt);
      if(internalLease)await internalLease.stop().catch(()=>{});
      const message=error instanceof Error?error.message:"";
      if(message==="Chrome 144 or newer is required")throw new Error(message);
      if(message==="Internal Chrome launch was stopped"||message==="Chrome connection was stopped")throw new Error("Internal Chrome was stopped; its owned process was drained and nothing was replayed");
      throw new Error(mode==="internal"?"Internal Chrome could not connect to its owned browser. Its process was stopped; nothing was replayed.":"Chrome could not connect. Check the Chrome remote-debugging permission prompt and retry.");
    }
  }
  private invalidateSelection(live:Live,selected:Selected,controlPage=false){
    if(controlPage)selected.blockedControlPage=true;
    if(live.selected===selected)live.selected=undefined;
    const prior=selected.observation;selected.observation=undefined;
    if(prior)void live.cdp.command("Runtime.releaseObjectGroup",{objectGroup:prior.focus.group},selected.sessionId).catch(()=>{});
    void live.cdp.command("Target.detachFromTarget",{sessionId:selected.sessionId}).catch(()=>{});
    void this.bump(live.owner);
  }
  private acceptTopUrl(live:Live,selected:Selected,url:URL,frameId?:string){
    const ownedBlank=live.mode==="internal"&&selected.targetId===live.internalBlankTargetId&&url.href==="about:blank";
    if(isControlPlaneUrl(url,this.controlPlanePorts)){this.invalidateSelection(live,selected,true);throw new ControlPageBlocked();}
    if(!ownedBlank&&(!["http:","https:"].includes(url.protocol)||!url.hostname)){this.invalidateSelection(live,selected);throw new UnsupportedPageBlocked();}
    const hash=sha(url.href);
    if(selected.topUrlHash&&selected.topUrlHash!==hash){selected.generation++;const prior=selected.observation;selected.observation=undefined;if(prior)void live.cdp.command("Runtime.releaseObjectGroup",{objectGroup:prior.focus.group},selected.sessionId).catch(()=>{});}
    selected.topUrlHash=hash;if(frameId)selected.rootFrameId=frameId;
    selected.origin=ownedBlank?"about:blank":url.origin;selected.host=ownedBlank?"Internal start page":url.host;
    const target=live.targets.find(item=>item.targetId===selected.targetId);if(target){target.origin=selected.origin;target.host=selected.host;}
  }
  private async assertSelectedPageSafe(live:Live,selected:Selected){
    if(selected.blockedControlPage)throw new ControlPageBlocked();
    if(live.revoked||this.live!==live||live.selected!==selected)throw new Error("Chrome access was stopped; nothing was replayed");
    let frame:any;
    try{const result=await live.cdp.command("Page.getFrameTree",{},selected.sessionId);frame=result?.frameTree?.frame;}
    catch{if(live.selected===selected)this.invalidateSelection(live,selected);throw new Error("Chrome could not verify the selected tab's address; choose it again");}
    if(selected.blockedControlPage)throw new ControlPageBlocked();
    if(live.revoked||this.live!==live||live.selected!==selected)throw new Error("Chrome access was stopped; nothing was replayed");
    const url=targetUrl({url:frame?.url});if(!url){this.invalidateSelection(live,selected);throw new UnsupportedPageBlocked();}
    this.acceptTopUrl(live,selected,url,typeof frame.id==="string"?frame.id:undefined);
    if(selected.blockedControlPage)throw new ControlPageBlocked();
    if(live.revoked||this.live!==live||live.selected!==selected)throw new Error("Chrome access was stopped; nothing was replayed");
    return url;
  }
  private onEvent(live:Live,event:CdpEvent){
    if(this.live!==live)return;const selected=live.selected;
    if(event.method==="Target.detachedFromTarget"&&event.params.sessionId===selected?.sessionId){live.selected=undefined;void this.bump(live.owner);}
    if(event.method==="Target.targetDestroyed"&&event.params.targetId===selected?.targetId){live.selected=undefined;void this.bump(live.owner);}
    if(selected&&event.sessionId===selected.sessionId&&["Page.frameNavigated","Page.frameStartedLoading","Page.navigatedWithinDocument","DOM.documentUpdated"].includes(event.method)){
      selected.generation++;const prior=selected.observation;selected.observation=undefined;if(prior)void live.cdp.command("Runtime.releaseObjectGroup",{objectGroup:prior.focus.group},selected.sessionId).catch(()=>{});
    }
    if(selected&&event.sessionId===selected.sessionId&&event.method==="Page.frameNavigated"&&!event.params.frame?.parentId){
      let location:URL|undefined;try{location=new URL(String(event.params.frame?.url||""));}catch{}
      if(!location){this.invalidateSelection(live,selected);return;}
      try{this.acceptTopUrl(live,selected,location,typeof event.params.frame?.id==="string"?event.params.frame.id:undefined);}catch{}
    }
    if(selected&&event.sessionId===selected.sessionId&&event.method==="Page.navigatedWithinDocument"&&event.params.frameId===selected.rootFrameId){
      let location:URL|undefined;try{location=new URL(String(event.params.url||""));}catch{}
      if(!location){this.invalidateSelection(live,selected);return;}
      try{this.acceptTopUrl(live,selected,location,selected.rootFrameId);}catch{}
    }
  }
  private current(sessionId:string){const live=this.live;if(!live||live.owner!==sessionId||live.revoked)throw new Error("Connect Chrome from this session before using browser tools");return live;}
  private async refreshTargetsFor(live:Live){
    const {targetInfos=[]}=await live.cdp.command("Target.getTargets");
    const prior=new Map(live.targets.map(target=>[target.targetId,target.alias]));
    const targets:Target[]=[];
    for(const info of targetInfos){const targetId=String(info?.targetId),alias=prior.get(targetId)??randomUUID(),target=safeTarget(info,alias,live.mode==="internal"&&targetId===live.internalBlankTargetId,this.controlPlanePorts);if(target)targets.push(target);}
    disambiguateTargets(targets);
    live.targets=targets;
    if(live.selected){
      const selected=live.selected,raw=targetInfos.find((info:any)=>String(info?.targetId)===selected.targetId),rawUrl=targetUrl(raw);
      if(rawUrl&&isControlPlaneUrl(rawUrl,this.controlPlanePorts)){this.invalidateSelection(live,selected,true);return targets;}
      const current=targets.find(target=>target.targetId===selected.targetId);
      if(!current){const selected=live.selected;live.selected=undefined;void live.cdp.command("Target.detachFromTarget",{sessionId:selected.sessionId}).catch(()=>{});}
      else{live.selected.origin=current.origin;live.selected.host=current.host;live.selected.label=current.label;}
    }
    return targets;
  }
  hasSelectedTarget(sessionId:string){const live=this.live;return !!live&&live.owner===sessionId&&!live.revoked&&!!live.selected;}
  async refresh(sessionId:string){await this.assertOwner(sessionId);const live=this.current(sessionId);await this.refreshTargetsFor(live);await this.bump(sessionId);return this.view(sessionId);}
  async select(sessionId:string,alias:string){
    await this.assertOwner(sessionId);
    const live=this.current(sessionId);if(live.busy)throw new Error("Wait for the current browser action to finish");
    if(typeof alias!=="string"||alias.length>100)throw new Error("Choose a current Chrome tab");
    const targets=await this.refreshTargetsFor(live);if(live.revoked||this.live!==live)throw new Error("Chrome access was stopped; nothing was replayed");const target=targets.find(item=>item.alias===alias);if(!target)throw new Error("Chrome tab is no longer available; refresh and choose it again");
    if(live.selected?.targetId===target.targetId){await this.bump(sessionId);return this.view(sessionId);}
    if(live.selected)await live.cdp.command("Target.detachFromTarget",{sessionId:live.selected.sessionId}).catch(()=>{});
    live.selected=undefined;
    const attached=await live.cdp.command("Target.attachToTarget",{targetId:target.targetId,flatten:true});
    if(typeof attached.sessionId!=="string"||!attached.sessionId)throw new Error("Chrome did not attach the selected tab");
    const selected:Selected={targetId:target.targetId,sessionId:attached.sessionId,alias,label:target.label,origin:target.origin,host:target.host,generation:0};live.selected=selected;
    try{await live.cdp.command("Page.bringToFront",{},selected.sessionId);if(live.revoked||this.live!==live)throw new Error();await live.cdp.command("Page.enable",{},selected.sessionId);if(live.revoked||this.live!==live)throw new Error();await this.assertSelectedPageSafe(live,selected);}
    catch(error){if(live.selected===selected)this.invalidateSelection(live,selected,error instanceof ControlPageBlocked);if(error instanceof ControlPageBlocked||error instanceof UnsupportedPageBlocked)throw error;throw new Error("Chrome could not attach the selected tab");}
    await this.bump(sessionId);return this.view(sessionId);
  }
  private async screenshot(live:Live,selected:Selected){
    const [shot,metrics]=await Promise.all([
      live.cdp.command("Page.captureScreenshot",{format:"png",captureBeyondViewport:false},selected.sessionId),
      live.cdp.command("Page.getLayoutMetrics",{},selected.sessionId),
    ]);
    if(typeof shot.data!=="string"||shot.data.length>Math.ceil(MAX_PNG_BYTES*4/3)+32)throw new Error("Chrome screenshot exceeded the safe size limit");
    const bytes=Buffer.from(shot.data,"base64"),info=pngInfo(bytes);if(bytes.length>MAX_PNG_BYTES||info.width<1||info.height<1||info.width*info.height>MAX_PIXELS)throw new Error("Chrome screenshot exceeded the safe image bounds");
    const viewport=metrics.cssVisualViewport;if(!viewport||!Number.isFinite(viewport.clientWidth)||!Number.isFinite(viewport.clientHeight)||viewport.clientWidth<=0||viewport.clientHeight<=0)throw new Error("Chrome viewport could not be verified");
    return {bytes,width:info.width,height:info.height,cssWidth:viewport.clientWidth,cssHeight:viewport.clientHeight,sha256:sha(bytes)};
  }
  private async pageSafety(live:Live,selected:Selected):Promise<PageSafety>{
    // This fixed expression returns booleans only. It never transfers page text, field attributes or values to Sigma.
    const expression=`(()=>{
      const sensitive='input[type="password"],input[autocomplete*="password" i],input[autocomplete*="one-time-code" i],input[autocomplete*="cc-number" i],input[autocomplete*="cc-csc" i],input[name*="password" i],input[id*="password" i],input[name*="passwd" i],input[name*="otp" i],input[name*="token" i],input[name*="verification" i],input[name*="security-code" i],input[name*="cvv" i],input[name*="cvc" i]';
      let credential=false,uninspectableFrame=false;const seen=new Set();
      const visible=(e,doc)=>{try{const r=e.getBoundingClientRect(),s=doc.defaultView.getComputedStyle(e);return r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<doc.defaultView.innerWidth&&r.top<doc.defaultView.innerHeight&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0;}catch{return false;}};
      const scanDoc=(doc,depth)=>{if(!doc||depth>8||seen.has(doc)){uninspectableFrame=true;return;}seen.add(doc);scanRoot(doc,doc,depth);};
      const scanRoot=(root,doc,depth)=>{for(const e of root.querySelectorAll('*')){if(e.matches?.(sensitive)&&visible(e,doc))credential=true;if(e.shadowRoot)scanRoot(e.shadowRoot,doc,depth);if((e.tagName==='IFRAME'||e.tagName==='FRAME')&&visible(e,doc)){try{const child=e.contentDocument;if(!child||!child.documentElement)uninspectableFrame=true;else scanDoc(child,depth+1);}catch{uninspectableFrame=true;}}}};
      scanDoc(document,0);
      let active=document.activeElement;for(let i=0;active?.shadowRoot?.activeElement&&i<16;i++)active=active.shadowRoot.activeElement;
      const frame=active?.tagName==='IFRAME'||active?.tagName==='FRAME';
      const activeSensitive=!!active&&active.matches?.(sensitive)===true;
      const editable=!!active&&(active.tagName==='TEXTAREA'||active.isContentEditable||active.tagName==='INPUT'&&['text','search','email','tel','url'].includes((active.type||'text').toLowerCase()));
      return {credential,activeSensitive,editable,frame,uninspectableFrame};
    })()`;
    try{
      const result=await live.cdp.command("Runtime.evaluate",{expression,returnByValue:true},selected.sessionId),value=result.result?.value;
      if(!value||typeof value.credential!=="boolean"||typeof value.activeSensitive!=="boolean"||typeof value.editable!=="boolean"||typeof value.frame!=="boolean"||typeof value.uninspectableFrame!=="boolean")throw new Error();
      return value as PageSafety;
    }catch{throw new Error("Chrome page safety could not be verified; typing is disabled");}
  }
  private async captureFocus(live:Live,selected:Selected):Promise<FocusReference>{
    const group=`sigma-browser-focus-${randomUUID()}`;
    try{
      const result=await live.cdp.command("Runtime.evaluate",{expression:"(()=>{let a=document.activeElement;for(let i=0;a?.shadowRoot?.activeElement&&i<16;i++)a=a.shadowRoot.activeElement;return a})()",objectGroup:group,returnByValue:false},selected.sessionId),objectId=result.result?.objectId;
      if(typeof objectId!=="string")throw new Error();return {group,objectId};
    }catch{await live.cdp.command("Runtime.releaseObjectGroup",{objectGroup:group},selected.sessionId).catch(()=>{});throw new Error("Chrome focus could not be verified");}
  }
  private async focusMatches(live:Live,selected:Selected,focus:FocusReference){
    try{
      const result=await live.cdp.command("Runtime.callFunctionOn",{objectId:focus.objectId,functionDeclaration:"function(){let a=document.activeElement;for(let i=0;a?.shadowRoot?.activeElement&&i<16;i++)a=a.shadowRoot.activeElement;return this===a}",objectGroup:focus.group,returnByValue:true},selected.sessionId);
      return result.result?.value===true;
    }catch{return false;}
  }
  private async releaseFocus(live:Live,selected:Selected,focus?:FocusReference){
    if(focus)await live.cdp.command("Runtime.releaseObjectGroup",{objectGroup:focus.group},selected.sessionId).catch(()=>{});
  }
  private async persistArtifact(live:Live,bytes:Buffer,width:number,height:number):Promise<BrowserUseArtifactView>{
    const id=randomUUID(),dir=join(this.dataDir,"browser-use",live.owner),path=join(dir,`${id}.png`);mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);writeFileSync(path,bytes,{flag:"wx",mode:0o600});chmodSync(path,0o600);
    const row:BrowserUseArtifactView={id,sessionId:live.owner,mime:"image/png",width,height,sha256:sha(bytes),bytes:bytes.length,createdAt:Date.now()};
    try{await this.storage.call("addBrowserArtifact",{...row});}
    catch{throw new Error("Chrome screenshot could not be stored safely");}
    await this.bump(live.owner);return row;
  }
  private async observe(live:Live,selected:Selected,onCapture?:()=>void){
    const assertCurrent=()=>{if(live.revoked||this.live!==live||live.selected!==selected)throw new Error("Chrome access was stopped; nothing was replayed");};
    await this.assertSelectedPageSafe(live,selected);assertCurrent();
    const safety=await this.pageSafety(live,selected);assertCurrent();
    if(safety.credential)throw new CredentialScreenshotBlocked("Screenshots are blocked while a visible credential or verification field is present; sign in manually in Chrome");
    if(safety.uninspectableFrame)throw new CredentialScreenshotBlocked("Screenshots are blocked because a visible frame could not be inspected");
    let focus:FocusReference|undefined,retained=false;
    try{
      focus=await this.captureFocus(live,selected);assertCurrent();onCapture?.();
      const shot=await this.screenshot(live,selected);assertCurrent();await this.assertSelectedPageSafe(live,selected);assertCurrent();
      const afterSafety=await this.pageSafety(live,selected);assertCurrent();
      if(afterSafety.credential)throw new CredentialScreenshotBlocked("Screenshots are blocked while a visible credential or verification field is present; sign in manually in Chrome");
      if(afterSafety.uninspectableFrame)throw new CredentialScreenshotBlocked("Screenshots are blocked because a visible frame could not be inspected");
      if(!await this.focusMatches(live,selected,focus))throw new Error("Focus changed while the screenshot was captured; take a fresh browser screenshot");assertCurrent();
      const previous=selected.observation,observation:Observation={id:randomUUID(),epoch:live.epoch,targetId:selected.targetId,sessionId:selected.sessionId,generation:selected.generation,width:shot.width,height:shot.height,cssWidth:shot.cssWidth,cssHeight:shot.cssHeight,sha256:shot.sha256,focus,at:Date.now()};
      await this.assertSelectedPageSafe(live,selected);assertCurrent();
      const artifact=await this.persistArtifact(live,shot.bytes,shot.width,shot.height);assertCurrent();
      await this.assertSelectedPageSafe(live,selected);assertCurrent();
      await this.releaseFocus(live,selected,previous?.focus);assertCurrent();selected.observation=observation;retained=true;return {shot,observation,artifact};
    }finally{if(focus&&!retained)await this.releaseFocus(live,selected,focus);}
  }
  private async actionRow(sessionId:string,kind:BrowserUseActionKind,selected:Selected,toolCallId:string,requestHash:string,detail:string){
    if(typeof toolCallId!=="string"||!toolCallId||toolCallId.length>512)throw new Error("Browser action ID is invalid");
    const id=`browser-${sha(`${sessionId}\0${toolCallId}`).slice(0,40)}`;
    const live=this.live;if(!live||live.owner!==sessionId)throw new Error("Browser session is no longer current");
    const row:BrowserUseActionView={id,sessionId,kind,mode:live.mode,target:selected.origin,status:"proposed",detail,createdAt:Date.now(),endedAt:null};
    const insert=await this.storage.call("addBrowserAction",{...row,requestHash}).then(()=>true,()=>false);
    const prior=await this.storage.call<(BrowserUseActionView&{requestHash?:string})|undefined>("browserAction",{id});if(!prior)throw new Error("Browser action could not be recorded");
    if(!insert){if(prior.requestHash!==requestHash)throw new Error(prior.requestHash?"This browser action ID was already used for different arguments; nothing was sent":"This browser action ID cannot be verified against its original request; nothing was replayed");if(prior.status==="done")return {prior};throw new Error(prior.status==="unknown"?"This browser action has an unknown outcome and was not replayed":"This browser action was already attempted and was not replayed");}
    return {row};
  }
  private async previousAction(sessionId:string,toolCallId:string,requestHash:string,images:boolean){
    if(typeof toolCallId!=="string"||!toolCallId||toolCallId.length>512)throw new Error("Browser action ID is invalid");
    const id=`browser-${sha(`${sessionId}\0${toolCallId}`).slice(0,40)}`,prior=await this.storage.call<(BrowserUseActionView&{requestHash?:string})|undefined>("browserAction",{id});
    if(!prior)return undefined;
    if(prior.requestHash!==requestHash)throw new Error(prior.requestHash?"This browser action ID was already used for different arguments; nothing was sent":"This browser action ID cannot be verified against its original request; nothing was replayed");
    if(prior.status==="done")return this.receipt(prior,images);
    throw new Error(prior.status==="unknown"?"This browser action has an unknown outcome and was not replayed":"This browser action was already attempted and was not replayed");
  }
  async act(sessionId:string,toolCallId:string,kind:BrowserUseActionKind,input:ActionInput,approve:Approve,images:boolean){
    if(!images)throw new Error("The selected model cannot view screenshots. Choose an image-capable Pi model before using Chrome.");
    await this.assertOwner(sessionId);
    const params=normalizedAction(kind,input),requestHash=sha(JSON.stringify({kind,params}));
    if(kind==="navigate"&&isControlPlaneUrl(new URL(String(params.url)),this.controlPlanePorts))throw new ControlPageDestinationBlocked();
    const prior=await this.previousAction(sessionId,toolCallId,requestHash,images);if(prior)return prior;
    const live=this.current(sessionId),selected=live.selected;if(!selected)throw new Error("Select an existing Chrome tab in this session first");if(live.busy)throw new Error("Another browser action is active");
    live.busy=true;let row:BrowserUseActionView|undefined,sent=false,completed=false,state:BrowserUseActionStatus="proposed";
    const check=()=>{if(selected.blockedControlPage)throw new ControlPageBlocked();if(live.revoked||this.live!==live||live.selected!==selected)throw new Error("Chrome access was stopped; nothing was replayed");};
    try{
      await this.assertSelectedPageSafe(live,selected);check();
      let approvalDetail:string,observedSafety:PageSafety|undefined;
      const checkObservation=()=>{
        const observation=selected.observation;
        if(!observation||typeof params.observationId!=="string"||observation.id!==params.observationId||observation.epoch!==live.epoch||observation.targetId!==selected.targetId||observation.sessionId!==selected.sessionId||observation.generation!==selected.generation)throw new Error("Observation is missing or stale; take a fresh browser screenshot first");
        return observation;
      };
      if(kind==="screenshot"){approvalDetail=`Capture visible page at ${selected.origin}`;}
      else if(kind==="navigate"){
        checkObservation();approvalDetail=`Navigate within ${new URL(String(params.url)).origin}`;
      }
      else if(kind==="click"||kind==="scroll"){
        checkObservation();approvalDetail=`${kind} at screenshot coordinate ${Math.round(Number(params.x))},${Math.round(Number(params.y))} on ${selected.origin}`;
      }else if(kind==="type"){
        checkObservation();approvalDetail=`Type non-secret text into the focused field on ${selected.origin}`;
      }else{
        checkObservation();approvalDetail=`Press ${String(params.key)} on ${selected.origin}`;
      }
      const prepared=await this.actionRow(sessionId,kind,selected,toolCallId,requestHash,approvalDetail);if("prior" in prepared)return this.receipt(prepared.prior,images);
      row=prepared.row;await this.bump(sessionId);check();
      const before=kind==="screenshot"?undefined:await this.screenshot(live,selected);if(kind!=="screenshot"){
        if(!before)throw new Error("A fresh browser observation is required");
        const expected=selected.observation,focusAction=kind==="type"||kind==="key";
        // ponytail: exact PNG equality safely rejects moving pages instead of adding a heuristic image-diff path.
        if(!expected||expected.id!==params.observationId||expected.width!==before.width||expected.height!==before.height||expected.cssWidth!==before.cssWidth||expected.cssHeight!==before.cssHeight||(!focusAction&&expected.sha256!==before.sha256))throw new Error("The Chrome page changed after it was observed; take a new screenshot before acting");
        if(focusAction&&!await this.focusMatches(live,selected,expected.focus))throw new Error("Focus changed since the screenshot; take a fresh browser screenshot before typing or pressing a key");
      }
      if(kind==="type"||kind==="key"){
        observedSafety=await this.pageSafety(live,selected);check();
        if(observedSafety.frame)throw new Error("Typing is disabled while focus is inside a frame");
        if(observedSafety.uninspectableFrame)throw new Error("Typing is disabled because a visible frame could not be inspected");
        if(observedSafety.credential||observedSafety.activeSensitive)throw new Error("Typing and Enter are blocked while a visible credential or verification field is present");
        if(kind==="type"&&!observedSafety.editable)throw new Error("Typing requires a verifiable text field or editable page area");
        if(!await this.focusMatches(live,selected,selected.observation!.focus))throw new Error("Focus changed since the screenshot; take a fresh browser screenshot before typing or pressing a key");
      }
      const allowed=await approve(approvalDetail);if(!allowed){await this.storage.call("browserActionTransition",{id:row.id,from:"proposed",to:"denied",patch:{endedAt:Date.now(),detail:"Denied by user"}});return this.receipt({...row,status:"denied",endedAt:Date.now(),detail:"Denied by user"},images);}
      check();await this.assertSelectedPageSafe(live,selected);check();
      if(kind!=="screenshot"){
        const fresh=await this.screenshot(live,selected),focusAction=kind==="type"||kind==="key",observation=selected.observation;
        if(selected.generation!==observation?.generation||fresh.width!==before!.width||fresh.height!==before!.height||fresh.cssWidth!==before!.cssWidth||fresh.cssHeight!==before!.cssHeight||(!focusAction&&fresh.sha256!==before!.sha256))throw new Error("The Chrome page changed while approval was pending; action cancelled");
        checkObservation();
        if(focusAction){
          const safety=await this.pageSafety(live,selected);check();
          if(safety.frame)throw new Error("Typing is disabled while focus is inside a frame");
          if(safety.uninspectableFrame)throw new Error("Typing is disabled because a visible frame could not be inspected");
          if(safety.credential||safety.activeSensitive||kind==="type"&&!safety.editable)throw new Error("Focus changed while approval was pending; action cancelled");
          if(!await this.focusMatches(live,selected,observation!.focus))throw new Error("Focus changed while approval was pending; action cancelled");
        }
      }
      await this.assertSelectedPageSafe(live,selected);check();
      const approved=await this.storage.call<BrowserUseActionView|undefined>("browserActionTransition",{id:row.id,from:"proposed",to:"approved",patch:{}});if(!approved)throw new Error("Browser action approval is no longer current");
      state="approved";check();await this.assertSelectedPageSafe(live,selected);check();const started=await this.storage.call<BrowserUseActionView|undefined>("browserActionTransition",{id:row.id,from:"approved",to:"dispatched",patch:{detail:"Command sent to the selected Chrome tab"}});if(!started)throw new Error("Browser action could not be dispatched");state="dispatched";await this.bump(sessionId);check();await this.assertSelectedPageSafe(live,selected);check();if(kind!=="screenshot")checkObservation();
      if(kind==="navigate"){
        checkObservation();const loaded=live.cdp.waitForEvent("Page.loadEventFired",selected.sessionId,8_000),within=live.cdp.waitForEvent("Page.navigatedWithinDocument",selected.sessionId,8_000),mainNavigated=live.cdp.waitForEvent("Page.frameNavigated",selected.sessionId,8_000,event=>!event.params.frame?.parentId);void loaded.promise.catch(()=>{});void within.promise.catch(()=>{});void mainNavigated.promise.catch(()=>{});sent=true;
        try{const result=await live.cdp.command("Page.navigate",{url:params.url},selected.sessionId);if(result.errorText)throw new Error("Chrome navigation did not complete");if(result.loaderId){within.cancel();await mainNavigated.promise;if(selected.blockedControlPage){completed=true;throw new ControlPageBlocked();}await loaded.promise;}else{loaded.cancel();mainNavigated.cancel();await within.promise;}completed=true;}finally{loaded.cancel();within.cancel();mainNavigated.cancel();}
      }else if(kind==="click"||kind==="scroll"){
        const observed=selected.observation!,current=await this.screenshot(live,selected);await this.assertSelectedPageSafe(live,selected);check();const visual=await live.cdp.command("Page.getLayoutMetrics",{},selected.sessionId),viewport=visual.cssVisualViewport;
        if(!viewport||!Number.isFinite(viewport.clientWidth)||!Number.isFinite(viewport.clientHeight)||viewport.clientWidth<=0||viewport.clientHeight<=0)throw new Error("Chrome viewport changed; take a fresh screenshot");
        if(current.width!==observed.width||current.height!==observed.height||current.sha256!==observed.sha256||selected.generation!==observed.generation)throw new Error("Chrome viewport changed; take a fresh screenshot");
        checkObservation();
        // CDP Input coordinates are relative to the visual viewport. Screenshot
        // pixels scale to that viewport; layout-viewport pan offsets are not added.
        const cssX=Number(params.x)*viewport.clientWidth/current.width,cssY=Number(params.y)*viewport.clientHeight/current.height;
        if(cssX<0||cssY<0||cssX>=viewport.clientWidth||cssY>=viewport.clientHeight)throw new Error("Coordinates are outside the current Chrome viewport");
        if(kind==="click"){
          sent=true;
          await live.cdp.command("Input.dispatchMouseEvent",{type:"mouseMoved",x:cssX,y:cssY},selected.sessionId);
          await live.cdp.command("Input.dispatchMouseEvent",{type:"mousePressed",x:cssX,y:cssY,button:"left",clickCount:1},selected.sessionId);
          await live.cdp.command("Input.dispatchMouseEvent",{type:"mouseReleased",x:cssX,y:cssY,button:"left",clickCount:1},selected.sessionId);
          completed=true;
        }else{sent=true;await live.cdp.command("Input.synthesizeScrollGesture",{x:cssX,y:cssY,xDistance:-Number(params.deltaX),yDistance:-Number(params.deltaY),gestureSourceType:"mouse",preventFling:true},selected.sessionId);completed=true;}
      }else if(kind==="type"){
        const safety=await this.pageSafety(live,selected);if(safety.frame)throw new Error("Typing is disabled while focus is inside a frame");if(safety.uninspectableFrame)throw new Error("Typing is disabled because a visible frame could not be inspected");if(safety.credential||safety.activeSensitive||!safety.editable)throw new Error("Typing was cancelled because the focused field could not be verified as a non-secret text field");
        if(!await this.focusMatches(live,selected,selected.observation!.focus))throw new Error("Focus changed while approval was pending; action cancelled");
        check();checkObservation();sent=true;await live.cdp.command("Input.insertText",{text:params.text},selected.sessionId);completed=true;
      }
      else if(kind==="key"){
        const safety=await this.pageSafety(live,selected);if(safety.frame||safety.uninspectableFrame||safety.credential||safety.activeSensitive)throw new Error("Key press was cancelled because a credential field or frame could receive it");
        if(!await this.focusMatches(live,selected,selected.observation!.focus))throw new Error("Focus changed while approval was pending; action cancelled");
        const key=String(params.key),keyCode=key==="Enter"?13:key==="Tab"?9:key==="Escape"?27:key.startsWith("Arrow")?({ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39} as Record<string,number>)[key]:key==="Home"?36:key==="End"?35:key==="PageUp"?33:key==="PageDown"?34:key==="Backspace"?8:key==="Delete"?46:32;
        check();checkObservation();sent=true;
        await live.cdp.command("Input.dispatchKeyEvent",{type:"keyDown",key,code:key==="Space"?"Space":key,keyCode,windowsVirtualKeyCode:keyCode},selected.sessionId);await live.cdp.command("Input.dispatchKeyEvent",{type:"keyUp",key,code:key==="Space"?"Space":key,keyCode,windowsVirtualKeyCode:keyCode},selected.sessionId);completed=true;
      }
      check();let result:{shot:{bytes:Buffer};observation:Observation;artifact:BrowserUseArtifactView};
      try{result=await this.observe(live,selected,()=>{if(kind==="screenshot")sent=true;});completed=true;}
      catch(error){
        if(!(error instanceof CredentialScreenshotBlocked)||!completed)throw error;
        check();const prior=selected.observation;selected.observation=undefined;await this.releaseFocus(live,selected,prior?.focus);check();
        const done=await this.storage.call<BrowserUseActionView|undefined>("browserActionTransition",{id:row.id,from:"dispatched",to:"done",patch:{endedAt:Date.now(),target:selected.origin,detail:"Action completed; screenshot blocked by page safety checks"}});
        if(!done)throw new Error("Browser action receipt could not be saved");state="done";await this.bump(sessionId);check();return this.receipt(done,images);
      }
      check();const done=await this.storage.call<BrowserUseActionView|undefined>("browserActionTransition",{id:row.id,from:"dispatched",to:"done",patch:{endedAt:Date.now(),target:selected.origin,detail:"Action completed; fresh screenshot captured",artifactId:result.artifact.id,observationId:result.observation.id}});if(!done)throw new Error("Browser action receipt could not be saved");state="done";await this.bump(sessionId);check();
      const receipt={...done,artifact:result.artifact,observationId:result.observation.id};return this.receipt(receipt,images,result.shot.bytes);
    }catch(error){
      if(row&&state==="dispatched"&&error instanceof ControlPageBlocked&&completed){
        const done=await this.storage.call<BrowserUseActionView|undefined>("browserActionTransition",{id:row.id,from:"dispatched",to:"done",patch:{endedAt:Date.now(),target:selected.origin,detail:"Navigation reached Sigma's local control page; it was blocked before capture"}}).catch(()=>undefined);
        if(done){state="done";await this.bump(sessionId);return this.receipt(done,images);}
      }
      if(row&&state!=="done"){const to:BrowserUseActionStatus=sent?"unknown":"cancelled",detail=sent?"Browser stopped or lost its receipt after dispatch; outcome unknown and never replayed":"Browser action cancelled before command delivery; nothing was sent";await this.storage.call("browserActionTransition",{id:row.id,from:state,to,patch:{endedAt:Date.now(),target:selected.origin,detail}}).catch(()=>{});await this.bump(sessionId);if(sent)this.revoke(sessionId);}
      const message=sent?"Browser action outcome is unknown; it was not replayed. Inspect Chrome before continuing.":error instanceof Error&&SAFE_ACTION_ERRORS.has(error.message)?error.message:"Browser action could not be completed; nothing was sent.";
      throw new Error(message);
    }finally{live.busy=false;}
  }
  private async receipt(row:any,images:boolean,image?:Buffer){
    const artifact=row.artifact??(row.artifactId?await this.storage.call<BrowserUseArtifactView|undefined>("browserArtifact",{id:row.artifactId}):undefined);
    let bytes=image;if(images&&!bytes&&artifact)bytes=(await this.artifact(row.sessionId,artifact.id)).bytes;
    const content:Array<{type:"text";text:string}|{type:"image";data:string;mimeType:string}>=[{type:"text",text:JSON.stringify({actionId:row.id,mode:row.mode??"chrome",status:row.status,detail:row.detail,...(artifact?{artifact,observationId:row.observationId}:{}),image:images&&bytes?"attached":images?"not available":"not attached: selected model does not accept images"})}];
    if(images&&bytes)content.push({type:"image",data:bytes.toString("base64"),mimeType:"image/png"});return {content,details:{}};
  }
  async view(sessionId:string):Promise<BrowserUseView>{
    const owner=await this.storage.call<any>("session",{id:sessionId});if(!owner||owner.parentId||owner.role!=="root"||owner.policy?.unsupervised||!owner.policy?.effective?.profile?.tools?.length)throw new Error("Browser history is limited to the supervised root session");
    const [actions,artifacts,modeCommands]=await Promise.all([
      this.storage.call<BrowserUseActionView[]>("browserActions",{sessionId}),
      this.storage.call<BrowserUseArtifactView[]>("browserArtifacts",{sessionId}),
      this.storage.call<BrowserModeCommandView[]>("browserModeCommands",{sessionId}),
    ]);
    const live=this.live?.owner===sessionId?this.live:undefined;
    const status:BrowserUseView["status"]=live?.selected?"selected":live?"connected":actions.some(action=>action.status==="unknown")?"unknown":"disconnected";
    return {status,mode:live?.mode??(this.modeOwner===sessionId?this.lastMode??null:null),targets:live?.targets.map(safeTargetView)??[],selected:live?.selected?{id:live.selected.alias,label:live.selected.label,host:live.selected.host,origin:live.selected.origin}:null,actions,artifacts,modeCommands};
  }
  async artifact(sessionId:string,id:string){
    const row=await this.storage.call<BrowserUseArtifactView|undefined>("browserArtifact",{id});if(!row||row.sessionId!==sessionId)throw new Error("Artifact unavailable");
    const path=join(this.dataDir,"browser-use",sessionId,`${id}.png`);try{const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size!==row.bytes||info.size>MAX_PNG_BYTES)throw new Error();const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:Buffer;try{bytes=readFileSync(fd);}finally{closeSync(fd);}const png=pngInfo(bytes);if(sha(bytes)!==row.sha256||png.width!==row.width||png.height!==row.height)throw new Error();return {row,bytes};}catch{throw new Error("Artifact unavailable");}
  }
  revoke(sessionId:string){
    if(this.attempt?.owner===sessionId)this.cancelAttempt(this.attempt);
    const live=this.live;if(live?.owner!==sessionId)return;
    live.revoked=true;live.removeEvents();live.selected=undefined;live.cdp.close();this.live=undefined;if(live.internalLease)void live.internalLease.stop();void this.bump(sessionId);
  }
  async disconnect(sessionId:string){const lease=this.live?.owner===sessionId?this.live.internalLease:this.attempt?.owner===sessionId?this.attempt.internalLease:undefined;this.revoke(sessionId);await lease?.stop();await this.bump(sessionId);return this.view(sessionId);}
  beginClose(){if(this.closing)return;this.closing=true;if(this.attempt)this.revoke(this.attempt.owner);if(this.live)this.revoke(this.live.owner);}
  async close(){this.beginClose();await this.internalChrome?.close();}
  tools(sessionId:string,images:()=>boolean,approve:Approve){
    return [
      defineTool({name:"browser_screenshot",label:"Browser screenshot",description:"First ask the user to choose a browser mode in Sigma. Current Chrome needs Chrome 144+, chrome://inspect/#remote-debugging, and its browser-wide Allow prompt; Internal Chrome starts only from the user's exact /browser internal command. Capture the tab selected in Sigma. Screenshots may contain page data and are retained in Pi and Sigma history. Requires an image-capable model; Ask mode prompts before dispatch.",parameters:Type.Object({}),execute:async(id)=>this.act(sessionId,id,"screenshot",{},approve,images())}),
      defineTool({name:"browser_click",label:"Browser click",description:"Click screenshot-pixel coordinates in the tab currently selected in Sigma: either the user's current Chrome or Internal Chrome started by the user's exact /browser internal command. Use the latest screenshot or completed action observationId. Follows Sigma access mode; an image-capable model is required.",parameters:Type.Object({x:Type.Number(),y:Type.Number(),observationId:Type.String({minLength:1,maxLength:100})}),execute:async(id,p)=>this.act(sessionId,id,"click",p as ActionInput,approve,images())}),
      defineTool({name:"browser_type",label:"Browser type",description:"Type up to 500 non-secret characters into the focused text field in the tab selected in Sigma: current Chrome or explicitly started Internal Chrome. Never enter passwords, one-time codes, payment details, or other secrets; tool arguments may remain in Pi history. Use a fresh observationId. Follows Sigma access mode; an image-capable model is required.",parameters:Type.Object({text:Type.String({minLength:1,maxLength:500}),observationId:Type.String({minLength:1,maxLength:100})}),execute:async(id,p)=>this.act(sessionId,id,"type",p as ActionInput,approve,images())}),
      defineTool({name:"browser_scroll",label:"Browser scroll",description:"Scroll the browser tab currently selected in Sigma: current Chrome or Internal Chrome started by the user's exact /browser internal command. Use screenshot-pixel coordinates and a fresh observationId. Follows Sigma access mode; an image-capable model is required.",parameters:Type.Object({x:Type.Number(),y:Type.Number(),deltaX:Type.Number(),deltaY:Type.Number(),observationId:Type.String({minLength:1,maxLength:100})}),execute:async(id,p)=>this.act(sessionId,id,"scroll",p as ActionInput,approve,images())}),
      defineTool({name:"browser_key",label:"Browser key",description:"Press one supported navigation key in the tab selected in Sigma: current Chrome or explicitly started Internal Chrome. Use a fresh observationId. Enter is blocked when a credential field or frame could receive it. Follows Sigma access mode; an image-capable model is required.",parameters:Type.Object({key:Type.String({minLength:1,maxLength:20}),observationId:Type.String({minLength:1,maxLength:100})}),execute:async(id,p)=>this.act(sessionId,id,"key",p as ActionInput,approve,images())}),
      defineTool({name:"browser_navigate",label:"Browser navigate",description:"Navigate the currently selected browser tab in Sigma: current Chrome or Internal Chrome started by the user's exact /browser internal command. Only HTTP or HTTPS URLs are allowed. Use the latest observationId; credentials in URLs are rejected. Follows Sigma access mode.",parameters:Type.Object({url:Type.String({minLength:8,maxLength:4096}),observationId:Type.String({minLength:1,maxLength:100})}),execute:async(id,p)=>this.act(sessionId,id,"navigate",p as ActionInput,approve,images())}),
    ];
  }
}
