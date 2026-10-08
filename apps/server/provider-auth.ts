import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { CredentialSynchronizationError, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { ProviderLoginState, ProviderLoginView, ProviderView } from "../../packages/contracts/index.js";

import { NATIVE_PROVIDER_IDS } from "./native-cli.js";
import { CLIPROXY_PROVIDER_ID } from "./cliproxy-provider.js";
import { assertProviderAllowed, providerAllowed } from "./provider-allowlist.js";

type Operation={view:ProviderLoginView;controller:AbortController;sdkController:AbortController;publishing:boolean;done:Promise<void>;finish:()=>void;settled:boolean;providerRuns:Set<Promise<unknown>>;browserOpens:Set<Promise<void>>;answer?:(value:string)=>void;cancelPrompt?:()=>void};
const active=(op:Operation)=>!op.settled;
const validId=(id:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
function httpsUrl(raw:string){try{const url=new URL(raw);return raw.length<=16000&&url.protocol==="https:"&&!url.username&&!url.password?url.href:undefined;}catch{return undefined;}}

/** Bridges interaction only; the host's runtime remains the sole credential owner. */
export class ProviderAuth {
  private operations=new Map<string,Operation>();
  private usedIds=new Map<string,string>();
  private closing=false;
  private refreshes=new Set<Promise<unknown>>();
  private openers=new Set<{abort:()=>void;done:Promise<void>}>();
  private closeWork?:Promise<void>;
  constructor(private runtime:ModelRuntime){}
  private check(){if(this.closing)throw new Error("Provider service is shutting down");}
  private current(providerId:string,id:string){assertProviderAllowed(providerId);const op=this.operations.get(providerId);if(!op||op.view.id!==id.toLowerCase())throw new Error("Sign-in operation is no longer current");return op;}
  operation(providerId:string,id:string){return structuredClone(this.current(providerId,id).view);}
  async list():Promise<ProviderView[]>{
    const credentials=await this.runtime.listCredentials();
    return this.runtime.getProviders().filter(provider=>!NATIVE_PROVIDER_IDS.has(provider.id)&&provider.id!==CLIPROXY_PROVIDER_ID&&providerAllowed(provider.id)).map(provider=>{
      const status=this.runtime.getProviderAuthStatus(provider.id),op=this.operations.get(provider.id);
      return {id:provider.id,name:provider.name,owner:"pi_sdk",oauth:!!provider.auth.oauth,loginLabel:provider.auth.oauth?.loginLabel??provider.auth.oauth?.name,configured:status.configured,source:status.source,credentialType:credentials.find(credential=>credential.providerId===provider.id)?.type,...(op?{operation:structuredClone(op.view)}:{})};
    });
  }
  start(providerId:string,id:string):ProviderLoginView{
    this.check();assertProviderAllowed(providerId);
    if(this.refreshes.size)throw new Error("Provider status is refreshing");
    if(!validId(id))throw new Error("Sign-in operation ID required");id=id.toLowerCase();
    const used=this.usedIds.get(id);
    if(used!==undefined){if(used!==providerId)throw new Error("Sign-in ID belongs to another provider");return this.operation(providerId,id);}
    if(!this.runtime.getProvider(providerId)?.auth.oauth)throw new Error("OAuth is unavailable for this provider");
    const previous=this.operations.get(providerId);if(previous&&!previous.settled)throw new Error("Sign-in is already active");
    if(previous?.view.state==="sync_pending")throw new Error("Synchronize saved credentials before another sign-in");
    // Bounded lifetime admission prevents old IDs from ever replaying a login.
    if(this.usedIds.size>=10000)throw new Error("Sign-in operation limit reached; restart the service");
    let finish!:()=>void;
    const op:Operation={view:{id,providerId,state:"starting"},controller:new AbortController(),sdkController:new AbortController(),publishing:false,done:new Promise<void>(resolve=>{finish=resolve;}),finish:()=>finish(),settled:false,providerRuns:new Set(),browserOpens:new Set()};
    this.usedIds.set(id,providerId);this.operations.set(providerId,op);
    void this.run(op);return structuredClone(op.view);
  }
  private async run(op:Operation){
    const oauth=this.runtime.getProvider(op.view.providerId)!.auth.oauth!,login=oauth.login;
    // SDK login races abort and can return before the provider's callback cleanup.
    // Track that public provider promise as well, without touching its credential.
    const tracked:typeof login=interaction=>{
      const work=Promise.resolve().then(()=>login.call(oauth,{...interaction,signal:op.controller.signal})).then(credential=>{
        // The SDK now owns publication. Aborting its signal could return before
        // a recomposed provider's model refresh finalizer; let save/sync drain.
        if(!op.controller.signal.aborted){
          op.cancelPrompt?.();op.publishing=true;op.view.state="finishing";
          delete op.view.authUrl;delete op.view.deviceCode;delete op.view.deviceExpiresAt;
        }
        return credential;
      });
      op.providerRuns.add(work);void work.then(()=>{},()=>{});return work;
    };
    let outcome:ProviderLoginState="failed";
    try{
      oauth.login=tracked;
      await this.runtime.login(op.view.providerId,"oauth",{signal:op.sdkController.signal,prompt:prompt=>this.prompt(op,prompt),notify:event=>this.notify(op,event)});
      outcome="succeeded";op.view.state="finishing";op.view.credentialStored=true;
    }catch(error){
      if(error instanceof CredentialSynchronizationError){outcome="sync_pending";op.view.state="finishing";op.view.credentialStored=true;op.view.message="Credentials were saved. Refresh provider status to synchronize models; do not repeat sign-in.";}
      else{outcome=op.controller.signal.aborted&&!op.publishing?"cancelled":"failed";op.view.state=outcome==="cancelled"?"cancelling":"finishing";op.view.message=outcome==="cancelled"?"Sign-in cancelled. Existing credentials are kept.":"Sign-in did not complete. Check the provider and try again explicitly.";}
    }finally{
      op.cancelPrompt?.();delete op.view.authUrl;delete op.view.deviceCode;delete op.view.deviceExpiresAt;
      await Promise.allSettled([...op.providerRuns,...op.browserOpens]);op.providerRuns.clear();op.browserOpens.clear();if(oauth.login===tracked)oauth.login=login;
      try{const credentials=await this.runtime.listCredentials();op.view.credentialStored=credentials.some(item=>item.providerId===op.view.providerId&&item.type==="oauth");}
      catch{op.view.metadataUnavailable=true;}
      op.view.state=outcome;if(outcome==="succeeded")delete op.view.message;op.settled=true;op.finish();
    }
  }
  private prompt(op:Operation,prompt:AuthPrompt):Promise<string>{
    if(!active(op)||op.controller.signal.aborted||prompt.signal?.aborted)return Promise.reject(new Error("Sign-in prompt cancelled"));
    op.cancelPrompt?.();
    return new Promise((resolve,reject)=>{
      const signal=prompt.signal?AbortSignal.any([prompt.signal,op.controller.signal]):op.controller.signal;
      const clean=()=>{signal.removeEventListener("abort",cancel);delete op.answer;delete op.cancelPrompt;delete op.view.prompt;};
      const cancel=()=>{clean();reject(new Error("Sign-in prompt cancelled"));};
      op.view.state="waiting";
      op.view.prompt={id:randomUUID(),type:prompt.type,message:prompt.message,...("placeholder" in prompt&&prompt.placeholder?{placeholder:prompt.placeholder}:{}),...(prompt.type==="select"?{options:prompt.options.map(option=>({...option}))}:{})};
      op.answer=value=>{clean();resolve(value);};op.cancelPrompt=cancel;
      signal.addEventListener("abort",cancel,{once:true});if(signal.aborted)cancel();
    });
  }
  private notify(op:Operation,event:AuthEvent){
    if(!active(op)||op.controller.signal.aborted)return;
    if(event.type==="auth_url"||event.type==="device_code"){
      const url=httpsUrl(event.type==="auth_url"?event.url:event.verificationUri);
      if(!url){this.cancelOperation(op);return;}
      op.view.authUrl=url;op.view.state="waiting";
      if(event.type==="device_code"){
        op.view.deviceCode=event.userCode;
        if(Number.isFinite(event.expiresInSeconds)&&event.expiresInSeconds!>0)op.view.deviceExpiresAt=Date.now()+event.expiresInSeconds!*1000;
      }
    }else op.view.message=event.type==="progress"?"Waiting for provider sign-in…":"Follow the provider's sign-in instructions.";
  }
  answer(providerId:string,id:string,promptId:string,value:unknown){
    this.check();const op=this.current(providerId,id),prompt=op.view.prompt;
    if(op.view.state!=="waiting"||op.controller.signal.aborted||!prompt||prompt.id!==promptId||!op.answer)throw new Error("Sign-in prompt is no longer pending");
    if(typeof value!=="string"||!value.trim()||value.length>16000||prompt.type==="select"&&!prompt.options?.some(option=>option.id===value))throw new Error("Invalid sign-in response");
    op.answer(value);return structuredClone(op.view);
  }
  private cancelOperation(op:Operation){
    op.view.state=op.publishing?"finishing":"cancelling";op.controller.abort();
    if(op.publishing)op.view.message="Credential save and model synchronization are finishing. Existing and saved credentials are kept.";
    else op.sdkController.abort();
  }
  async cancel(providerId:string,id:string){const op=this.current(providerId,id);if(active(op))this.cancelOperation(op);await op.done;return structuredClone(op.view);}
  refresh(providerId?:string){
    this.check();if(providerId)assertProviderAllowed(providerId);if(this.refreshes.size)throw new Error("Provider status is already refreshing");if(providerId&&!this.runtime.getProvider(providerId))throw new Error("Provider unavailable");
    const op=providerId?this.operations.get(providerId):undefined;
    if([...this.operations.values()].some(op=>!op.settled))throw new Error("Cancel or complete sign-in before refreshing");
    // Registered synchronously, so close also waits for metadata/model synchronization.
    const work=(async()=>{const result=await this.runtime.refresh({...(providerId?{providers:[providerId]}:{}),allowNetwork:false});if(result.aborted||result.errors.size)throw new Error("Provider status could not synchronize");if(op?.view.state==="sync_pending"){op.view.state="succeeded";delete op.view.message;}return this.list();})();
    this.refreshes.add(work);void work.then(()=>this.refreshes.delete(work),()=>this.refreshes.delete(work));return work;
  }
  open(providerId:string,id:string){
    this.check();const op=this.current(providerId,id),url=op.view.authUrl&&httpsUrl(op.view.authUrl);
    if(!active(op)||op.controller.signal.aborted||!url)throw new Error("Current sign-in link unavailable");
    if(process.platform!=="darwin")throw new Error("Use the browser sign-in link on this platform");
    let finish!:()=>void,failed=false,timer:ReturnType<typeof setTimeout>|undefined;
    const owned={abort:()=>{child.kill("SIGTERM");timer??=setTimeout(()=>child.kill("SIGKILL"),750);timer.unref();},done:new Promise<void>(resolve=>{finish=resolve;})};
    this.openers.add(owned);op.browserOpens.add(owned.done);
    const child=spawn("/usr/bin/open",[url],{stdio:"ignore",shell:false});
    op.controller.signal.addEventListener("abort",owned.abort,{once:true});
    child.once("error",()=>{failed=true;});child.once("close",code=>{failed||=code!==0;if(timer)clearTimeout(timer);op.controller.signal.removeEventListener("abort",owned.abort);this.openers.delete(owned);op.browserOpens.delete(owned.done);finish();});
    return owned.done.then(()=>{if(failed)throw new Error("Browser could not open; use the sign-in link");return {opened:true};});
  }
  beginShutdown(){this.closing=true;for(const op of this.operations.values())if(active(op))this.cancelOperation(op);for(const owned of this.openers)owned.abort();}
  close(){this.beginShutdown();return this.closeWork??=Promise.allSettled([...this.operations.values()].map(op=>op.done).concat([...this.refreshes].map(work=>work.then(()=>{})),[...this.openers].map(owned=>owned.done))).then(()=>{});}
}
