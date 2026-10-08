import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type Provider, type SimpleStreamOptions, type StreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { stream as streamOpenAICompletions, streamSimple as streamSimpleOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";

export const CLIPROXY_PROVIDER_ID="sigma-cliproxy";
const API="openai-completions" as const;
const CONFIG_DIR="cliproxyapi";
const MAX_CONFIG_BYTES=16_384;
const MAX_CATALOG_BYTES=1_000_000;
const MAX_MODELS=100;
type Connection={baseUrl:string;apiKey:string;raw:Buffer};
export type CliproxyState="missing"|"disconnected"|"connected"|"blocked"|"error";
export type CliproxyView={id:string;name:string;state:CliproxyState;configured:boolean;connected:boolean;modelCount:number;message:string};
const NAME="Antigravity · local CLIProxyAPI";
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const offline=()=>process.env.PI_OFFLINE==="1"||(process.env.SIGMA_DEMO??process.env.PI_ORCH_DEMO)==="1";
function failedStream(model:Model<any>):AssistantMessageEventStream{
  const stream=createAssistantMessageEventStream(),error:AssistantMessage={role:"assistant",content:[],provider:CLIPROXY_PROVIDER_ID,model:model.id,api:model.api,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"error",errorMessage:"Local proxy provider is unavailable or its configuration changed.",timestamp:Date.now()};
  stream.push({type:"error",reason:"error",error});return stream;
}

function privateDirectory(path:string){
  const info=lstatSync(path);
  if(info.isSymbolicLink()||!info.isDirectory()||(info.mode&0o077)!==0)throw new Error("unsafe directory");
}

function loadConnection(dataDir:string):Connection{
  const directory=resolve(dataDir,CONFIG_DIR),path=join(directory,"connection.json");
  privateDirectory(resolve(dataDir));privateDirectory(directory);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let raw:Buffer;
  try{
    const info=fstatSync(fd);
    if(!info.isFile()||info.nlink!==1||(info.mode&0o077)!==0||info.size<2||info.size>MAX_CONFIG_BYTES)throw new Error("unsafe connection file");
    raw=readFileSync(fd);
  }finally{closeSync(fd);}
  if(raw.length<2||raw.length>MAX_CONFIG_BYTES)throw new Error("unsafe connection file");
  let parsed:unknown;try{parsed=JSON.parse(raw.toString("utf8"));}catch{throw new Error("invalid connection file");}
  if(!object(parsed)||Object.keys(parsed).sort().join(",")!=="apiKey,baseUrl"||typeof parsed.baseUrl!=="string"||typeof parsed.apiKey!=="string"||!/^[A-Za-z0-9._~-]{32,512}$/.test(parsed.apiKey))throw new Error("invalid connection file");
  let url:URL;try{url=new URL(parsed.baseUrl);}catch{throw new Error("invalid connection file");}
  if(url.protocol!=="http:"||url.hostname!=="127.0.0.1"||!url.port||Number(url.port)<1024||Number(url.port)>65535||url.username||url.password||url.pathname!=="/v1"||url.search||url.hash||url.href!==`${url.origin}/v1`)throw new Error("invalid connection file");
  return {baseUrl:`${url.origin}/v1`,apiKey:parsed.apiKey,raw};
}

function modelDefinitions(value:unknown,baseUrl:string):Model<typeof API>[] {
  if(!object(value)||!Array.isArray(value.data)||value.data.length>MAX_MODELS)throw new Error("invalid model catalog");
  const seen=new Set<string>();
  return value.data.map(entry=>{
    if(!object(entry)||entry.object!=="model"||entry.owned_by!=="antigravity"||typeof entry.id!=="string"||!/^[A-Za-z0-9._-]{1,128}$/.test(entry.id)||seen.has(entry.id))throw new Error("invalid model catalog");
    seen.add(entry.id);
    // The proxy catalog carries IDs only, so keep conservative limits. CLIProxyAPI accepts the
    // OpenAI-style `reasoning_effort` (low|medium|high) and translates it per Antigravity model;
    // pi-ai emits it for this loopback base URL by default (detected compat.supportsReasoningEffort; the identity guard forbids a model-level compat override). "off" sends nothing.
    return {provider:CLIPROXY_PROVIDER_ID,id:entry.id,name:entry.id,api:API,baseUrl,reasoning:true,thinkingLevelMap:{minimal:null,xhigh:null,max:null},input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32_768,maxTokens:4_096};
  });
}

async function fetchModels(connection:Connection,signal:AbortSignal){
  const combined=AbortSignal.any([signal,AbortSignal.timeout(15_000)]);
  const response=await fetch(`${connection.baseUrl}/models`,{method:"GET",headers:{authorization:`Bearer ${connection.apiKey}`,accept:"application/json"},signal:combined,redirect:"error"});
  if(!response.ok)throw new Error("proxy unavailable");
  const length=Number(response.headers.get("content-length")||0);
  if(length>MAX_CATALOG_BYTES)throw new Error("invalid model catalog");
  const body=await response.text();if(body.length>MAX_CATALOG_BYTES)throw new Error("invalid model catalog");
  let parsed:unknown;try{parsed=JSON.parse(body);}catch{throw new Error("invalid model catalog");}
  return modelDefinitions(parsed,connection.baseUrl);
}

/** Explicit, local-only adapter. Its only credential source is the app-owned private connection file. */
export class CliproxyProvider {
  private connection?:Connection;
  private models:Model<typeof API>[]=[];
  private provider?:Provider<typeof API>;
  private state:CliproxyState="missing";
  private message="Configure the app-owned local proxy connection to continue.";
  private running?:{controller:AbortController;done:Promise<CliproxyView>};
  private streams=new Set<Promise<void>>();
  private streamControllers=new Set<AbortController>();
  private closing=false;
  private disconnecting=false;

  constructor(private runtime:ModelRuntime,private dataDir:string){
    const originalSimple=runtime.streamSimple.bind(runtime),originalStream=runtime.stream.bind(runtime);
    runtime.streamSimple=((selected,context,options)=>selected.provider===CLIPROXY_PROVIDER_ID?this.dispatch(selected,options?.signal,signal=>originalSimple(selected,context,{...options,signal})):originalSimple(selected,context,options)) as ModelRuntime["streamSimple"];
    runtime.stream=((selected,context,options)=>selected.provider===CLIPROXY_PROVIDER_ID?this.dispatch(selected,options?.signal,signal=>originalStream(selected,context,{...options,signal} as any)):originalStream(selected,context,options)) as ModelRuntime["stream"];
  }

  init(){
    try{this.connection=loadConnection(this.dataDir);this.state=offline()?"blocked":"disconnected";this.message=offline()?"Local proxy access is disabled in offline or demo mode.":"Local proxy is configured. Connect or refresh it to load available models.";}
    catch(error){this.state=(error as NodeJS.ErrnoException).code==="ENOENT"?"missing":"blocked";this.message=this.state==="missing"?"Local proxy is not configured; other providers remain available.":"Local proxy configuration is unsafe or invalid.";}
  }

  private providerIdentity(){
    const provider=this.runtime.getRegisteredNativeProvider(CLIPROXY_PROVIDER_ID),composed=this.runtime.getProvider(CLIPROXY_PROVIDER_ID),models=this.runtime.getModels(CLIPROXY_PROVIDER_ID);
    const compositionError=this.runtime.getError();
    return !process.env.OPENAI_CUSTOM_HEADERS&&!process.env.OPENAI_LOG&&!compositionError?.includes(CLIPROXY_PROVIDER_ID)&&!!this.provider&&provider===this.provider&&composed===this.provider&&models.length===this.models.length&&this.models.every(expected=>models.some(model=>model.id===expected.id&&model.provider===CLIPROXY_PROVIDER_ID&&model.api===API&&model.baseUrl===expected.baseUrl&&!model.headers&&!model.compat&&model.contextWindow===32_768&&model.maxTokens===4_096));
  }

  private invalidate(state:CliproxyState,message:string){
    if(this.provider)this.runtime.unregisterProvider(CLIPROXY_PROVIDER_ID);
    this.provider=undefined;this.models=[];this.connection=undefined;this.state=state;this.message=message;
  }

  isConnected(model?:Model<any>){
    if(this.closing)return false;
    if(offline()){
      if(this.state==="connected")this.invalidate("blocked","Local proxy access is disabled in offline or demo mode.");
      return false;
    }
    if(this.state!=="connected"||!this.connection)return false;
    if(!this.providerIdentity()){this.invalidate("blocked","Local proxy provider registration changed or collided with another provider.");return false;}
    try{
      const current=loadConnection(this.dataDir);
      if(!current.raw.equals(this.connection.raw)){
        this.invalidate("blocked","Local proxy connection changed. Review the private connection file before reconnecting.");return false;
      }
      return !model||model.provider===CLIPROXY_PROVIDER_ID&&model.api===API&&model.baseUrl===this.connection.baseUrl&&this.models.some(item=>item.id===model.id);
    }catch{
      this.invalidate("blocked","Local proxy connection changed or failed its safety checks. Reconnect after reviewing the private connection file.");return false;
    }
  }

  view():CliproxyView{
    const connected=this.state==="connected"&&this.isConnected();
    return {id:CLIPROXY_PROVIDER_ID,name:NAME,state:this.state,configured:!!this.connection,connected,modelCount:connected?this.models.length:0,message:this.message};
  }

  private async run(){
    if(this.closing)throw new Error("Provider is shutting down");
    if(offline()){this.invalidate("blocked","Local proxy access is disabled in offline or demo mode.");throw new Error(this.message);}
    if(this.running||this.disconnecting)throw new Error("Provider action is already active");
    let connection:Connection;
    try{
      connection=loadConnection(this.dataDir);
      if(this.connection&&this.state==="connected"&&!connection.raw.equals(this.connection.raw))throw new Error("connection changed");
      if(this.state!=="connected")this.connection=connection;
    }catch(error){
      const missing=(error as NodeJS.ErrnoException).code==="ENOENT";
      this.invalidate(missing?"missing":"blocked",missing?"Local proxy is not configured; other providers remain available.":"Local proxy configuration is unsafe, invalid, or changed.");throw new Error(this.message);
    }
    if(!this.provider&&(this.runtime.getProvider(CLIPROXY_PROVIDER_ID)||this.runtime.getRegisteredProviderConfig(CLIPROXY_PROVIDER_ID)||this.runtime.getRegisteredNativeProvider(CLIPROXY_PROVIDER_ID)))throw new Error("Provider ID collides with an existing Pi configuration");
    const controller=new AbortController();
    const work=(async()=>{
      const models=await fetchModels(connection,controller.signal);
      if(controller.signal.aborted)throw new Error("cancelled");
      if(!models.length)throw new Error("empty catalog");
      const owner=this;
      const safe=(model:Model<typeof API>,context:TranscriptContext,options?:StreamOptions|SimpleStreamOptions,simple=false)=>{
        if(!owner.isConnected(model))throw new Error("Local proxy provider is unavailable or its configuration changed.");
        const localFetch:typeof fetch=async(input,init={})=>{
          if(process.env.OPENAI_CUSTOM_HEADERS||process.env.OPENAI_LOG)throw new Error("ambient OpenAI transport settings are not allowed");
          let target:URL;try{target=new URL(input instanceof Request?input.url:String(input));}catch{throw new Error("invalid proxy request");}
          const base=new URL(connection.baseUrl);
          if(target.origin!==base.origin||target.pathname!==`${base.pathname}/chat/completions`||target.search||target.hash)throw new Error("proxy request left the local API route");
          const supplied=new Headers(init.headers),headers=new Headers({authorization:`Bearer ${connection.apiKey}`});
          for(const name of ["accept","content-type","user-agent"]){const value=supplied.get(name);if(value)headers.set(name,value);}
          return globalThis.fetch(target,{method:"POST",headers,body:init.body,signal:init.signal,redirect:"error"});
        };
        const forced={...options,apiKey:connection.apiKey,headers:undefined,env:{},fetch:localFetch};
        return simple?streamSimpleOpenAICompletions(model,context,forced):streamOpenAICompletions(model,context,forced);
      };
      const provider:Provider<typeof API>={
        id:CLIPROXY_PROVIDER_ID,name:NAME,baseUrl:connection.baseUrl,
        auth:{apiKey:{name:"Local CLIProxyAPI",check:async({credential})=>!credential&&owner.isConnected()?{type:"api_key",source:"local CLIProxyAPI"}:undefined,resolve:async({credential})=>!credential&&owner.isConnected()?{auth:{apiKey:connection.apiKey},source:"local CLIProxyAPI"}:undefined}},
        getModels:()=>models,
        stream:(model,context,options)=>safe(model,context,options),
        streamSimple:(model,context,options)=>safe(model,context,options,true),
      };
      this.connection=connection;this.models=models;this.provider=provider;
      this.runtime.registerNativeProvider(provider);
      if(!this.providerIdentity())throw new Error("provider composition changed");
      this.state="connected";this.message=`Connected to the local proxy with ${models.length} catalog models.`;
      const refreshed=await this.runtime.refresh({providers:[CLIPROXY_PROVIDER_ID],allowNetwork:false,signal:controller.signal});
      if(controller.signal.aborted)throw new Error("cancelled");
      if(refreshed.errors.has(CLIPROXY_PROVIDER_ID))throw new Error("provider availability refresh failed");
      return this.view();
    })();
    this.running={controller,done:work};
    try{return await work;}catch(error){
      if(controller.signal.aborted){
        if(this.provider)this.runtime.unregisterProvider(CLIPROXY_PROVIDER_ID);
        this.provider=undefined;this.models=[];this.state=this.connection?"disconnected":"missing";
        this.message="Local proxy request cancelled. No models are routable; reconnect to continue.";
        throw new Error("Local proxy request cancelled");
      }
      this.invalidate("error","Local proxy is unavailable or returned an invalid/empty model catalog. Refresh to retry.");throw new Error(this.message);
    }finally{if(this.running?.done===work)this.running=undefined;}
  }

  connect(){return this.run();}
  refresh(){return this.run();}
  async disconnect(){
    if(this.running||this.disconnecting||this.closing)throw new Error("Cancel or finish the active proxy request first");
    this.disconnecting=true;this.state=this.connection?"disconnected":"missing";this.message="Disconnecting the local proxy and draining active requests.";
    try{
      for(const controller of this.streamControllers)controller.abort();
      await Promise.allSettled([...this.streams]);
      if(this.provider)this.runtime.unregisterProvider(CLIPROXY_PROVIDER_ID);
      this.provider=undefined;this.models=[];
      this.state=this.connection?"disconnected":"missing";this.message=this.connection?"Disconnected from the local proxy; no models are routable.":"Local proxy is not configured; other providers remain available.";
      return this.view();
    }finally{this.disconnecting=false;}
  }
  async cancel(){const running=this.running;if(!running)return this.view();running.controller.abort();await running.done.catch(()=>{});return this.view();}
  async close(){this.closing=true;await this.cancel();if(this.provider)this.runtime.unregisterProvider(CLIPROXY_PROVIDER_ID);this.provider=undefined;this.models=[];this.state="blocked";for(const controller of this.streamControllers)controller.abort();await Promise.allSettled([...this.streams]);}

  private dispatch(model:Model<any>,parentSignal:AbortSignal|undefined,create:(signal:AbortSignal)=>AssistantMessageEventStream){
    if(!this.isConnected(model))return failedStream(model);
    const output=createAssistantMessageEventStream();
    const controller=new AbortController(),signal=parentSignal?AbortSignal.any([parentSignal,controller.signal]):controller.signal;
    this.streamControllers.add(controller);
    let finish!:()=>void;
    const done=new Promise<void>(resolve=>{finish=resolve;});this.streams.add(done);
    let source:import("@earendil-works/pi-ai").AssistantMessageEventStream;
    try{source=create(signal);}catch{
      const error:AssistantMessage={role:"assistant",content:[],provider:CLIPROXY_PROVIDER_ID,model:"",api:API,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"error",errorMessage:"Local proxy request failed.",timestamp:Date.now()};
      output.push({type:"error",reason:"error",error});this.streamControllers.delete(controller);this.streams.delete(done);finish();return output;
    }
    void (async()=>{
      try{
        for await(const event of source){
          if(event.type==="error"){
            const error:AssistantMessage={role:"assistant",content:event.error.content,provider:CLIPROXY_PROVIDER_ID,model:event.error.model,api:API,usage:event.error.usage,stopReason:event.reason,errorMessage:"Local proxy request failed.",timestamp:event.error.timestamp};
            output.push({type:"error",reason:event.reason,error});
          }else output.push(event);
        }
        output.end(await source.result());
      }catch{
        const error:AssistantMessage={role:"assistant",content:[],provider:CLIPROXY_PROVIDER_ID,model:"",api:API,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"error",errorMessage:"Local proxy request failed.",timestamp:Date.now()};
        output.push({type:"error",reason:"error",error});
      }
      finally{this.streamControllers.delete(controller);this.streams.delete(done);finish();}
    })();
    return output;
  }
}
