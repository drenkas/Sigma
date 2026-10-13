import { realpathSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, normalizeContext, type AssistantMessage, type Model, type Provider, type SimpleStreamOptions, type TranscriptContext } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AgyActivity } from '../../packages/contracts/index.js';
import { AGY_UNSUPERVISED_PROVIDER_ID, type NativeCli } from './native-cli.js';

// UNSUPERVISED route: AGY executes its own tools. Nothing here is a Pi approval; Sigma only relays what AGY reports.
const API='sigma-antigravity-unsupervised',MODEL='antigravity-default',MAX_ACTIVITY=500,MAX_PROMPT=120_000,MAX_OUTPUT=500;
// `-p=` (empty, attached): a bare `-p` would swallow the next flag as its prompt; the prompt itself arrives on stdin.
// No `--agent`: custom agent definitions restrict AGY's tool set (only read tools, cannot create files); the default main agent keeps write_to_file etc. Verified live against agy 1.2.17 on 2026-10-05.
export const AGY_ARGV=['-p=','--input-format','stream-json','--output-format','stream-json','--sandbox','--dangerously-skip-permissions'];
// Pi's options.timeoutMs is an HTTP idle timeout (5 min by default) and must not cut a whole AGY agent turn; it can only raise the 30 min deadline, up to 60 min.
const AGY_TURN_TIMEOUT_MS=1_800_000,AGY_MAX_TIMEOUT_MS=3_600_000;
export const agyTurnTimeout=(requested?:number)=>Math.min(Math.max(requested??0,AGY_TURN_TIMEOUT_MS),AGY_MAX_TIMEOUT_MS);
export function agyTimeoutMessage(timeoutMs:number){const minutes=Math.max(1,Math.round(timeoutMs/60000));return `Antigravity did not finish this turn within ${minutes} minute${minutes===1?'':'s'}. Try again, or split the task into smaller steps.`;}
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const object=(value:any)=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const count=(value:any)=>Number.isSafeInteger(value)&&value>=0?value as number:0;
const clip=(value:unknown,max:number)=>{let text:string;try{text=typeof value==='string'?value:JSON.stringify(value)??'';}catch{text='';}text=text.replace(/[\u0000-\u001f\u007f]+/g,' ').trim();return text.length>max?text.slice(0,max-1).replace(/[\uD800-\uDBFF]$/,'')+'…':text;};
/** Real agy 1.2.17 stdin: one `{"event":"user","message":{...}}` line per turn; text/content/prompt are all accepted so all are set. */
export const agyInputLine=(text:string)=>({event:'user',message:{text,content:text,prompt:text}});
const IMAGE_EXT:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'};
const isImage=(part:any)=>part?.type==='image'&&typeof part.data==='string';
/** Images of user messages in transcript order; they reach AGY as temporary files it opens with view_file. */
const imagesOf=(context:TranscriptContext)=>(context.messages as any[]).flatMap(message=>message.role==='user'&&Array.isArray(message.content)?message.content.filter(isImage):[]);
function transcript(context:TranscriptContext,paths:string[]=[]){
  const lines:string[]=[];let next=0;
  for(const message of context.messages as any[]){
    const parts=(typeof message.content==='string'?[message.content]:Array.isArray(message.content)?message.content:[]).map((part:any)=>typeof part==='string'?part:part?.type==='text'&&typeof part.text==='string'?part.text:message.role==='user'&&isImage(part)&&paths[next]?`[image ${next+1}: ${paths[next++]} — open it with view_file to see it]`:undefined).filter((part:string|undefined)=>part!==undefined);
    const text=parts.join('\n').trim();if(text&&(message.role==='user'||message.role==='assistant'))lines.push(`[${message.role}] ${text}`);
  }
  let body=lines.join('\n\n');if(body.length>MAX_PROMPT)body=body.slice(body.length-MAX_PROMPT);
  return `You are working in the current directory, an isolated Git workspace. Conversation so far:\n\n${body}\n\nContinue by answering the last [user] message.`;
}
export type AgySession={cwd:string;check:()=>void;activity:(record:Omit<AgyActivity,'agentId'>)=>void};

export function registerAgyUnsupervisedProvider(runtime:ModelRuntime,owner:NativeCli){
  const model:Model<typeof API>={provider:AGY_UNSUPERVISED_PROVIDER_ID,api:API,id:MODEL,name:'Antigravity · unsupervised (AGY runs its own tools)',baseUrl:'',reasoning:false,input:['text','image'],contextWindow:200000,maxTokens:16384,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const sessions=new Map<string,AgySession>();
  const identity=(selected?:Model<any>)=>runtime.getProvider(AGY_UNSUPERVISED_PROVIDER_ID)===provider&&runtime.getRegisteredNativeProvider(AGY_UNSUPERVISED_PROVIDER_ID)===provider&&(!selected||selected.provider===AGY_UNSUPERVISED_PROVIDER_ID&&selected.api===API&&selected.id===MODEL);
  function stream(selected:Model<any>,context:TranscriptContext,options?:SimpleStreamOptions){
    const events=createAssistantMessageEventStream(),output:AssistantMessage={role:'assistant',content:[],provider:selected.provider,model:selected.id,api:selected.api,usage:structuredClone(usage),stopReason:'pending',timestamp:Date.now()};
    const operation=new AbortController(),abort=()=>operation.abort();options?.signal?.addEventListener('abort',abort,{once:true});if(options?.signal?.aborted)operation.abort();
    void (async()=>{
      let failure='provider_configuration',full='',emitted='',terminal:any,agyError='',imageDir:string|undefined,finishTimer:ReturnType<typeof setTimeout>|undefined,steps=0,startedAt=0,deadlineMs=0;const records=new Map<string,Omit<AgyActivity,'agentId'>>(),local=new AbortController();
      const emit=(final:boolean)=>{let stable=full;if(!final&&/[\uD800-\uDBFF]$/.test(stable))stable=stable.slice(0,-1);if(!stable.startsWith(emitted)||stable.length===emitted.length)return;const delta=stable.slice(emitted.length);if(!output.content.length){output.content.push({type:'text',text:''});events.push({type:'text_start',contentIndex:0,partial:output});}emitted=stable;(output.content[0] as {text:string}).text=emitted;events.push({type:'text_delta',contentIndex:0,delta,partial:output});};
      try{
        const session=options?.sessionId?sessions.get(options.sessionId):undefined;
        if(!identity(selected)||!owner.isAgyUnsupervisedEnabled()||options?.apiKey||!session)throw new Error('Unsupervised route is not enabled for this session');
        session.check();if(realpathSync(session.cwd)!==session.cwd)throw new Error('Workspace location changed');
        // Images go to a private temp dir outside the git workspace, handed to AGY with --add-dir for this turn only and removed in `finally`.
        const images=imagesOf(context);let paths:string[]=[];
        if(images.length){const made=await mkdtemp(join(tmpdir(),'sigma-agy-images-'));imageDir=made;const dir=await realpath(made);imageDir=dir;paths=await Promise.all(images.map(async(image:any,index:number)=>{const path=join(dir,`image-${index+1}.${IMAGE_EXT[image.mimeType]??'png'}`);await writeFile(path,Buffer.from(image.data,'base64'),{mode:0o600});return path;}));}
        const prompt=transcript(context,paths);operation.signal.throwIfAborted();events.push({type:'start',partial:output});failure='transport';
        const record=(step:any)=>{
          const info=object(step.tool_info)?step.tool_info:{},name=clip(step.tool_name??info.name??'tool',80),key=clip(step.step_index??`${name}:${steps}`,80);
          const state=String(step.state??'').toUpperCase(),failed=state==='ERROR'||state==='FAILED'||state==='CANCELLED'||!!info.error;
          const next:Omit<AgyActivity,'agentId'>={step:key,tool:name,params:clip(info.parameters??'',200),status:failed?'error':state==='DONE'?'done':'running'};
          if(info.output!==undefined&&info.output!==null&&info.output!=='')next.output=clip(info.output,MAX_OUTPUT);
          const before=records.get(key);if(!before&&records.size>=MAX_ACTIVITY)return;steps++;
          if(before&&before.tool===next.tool&&before.params===next.params&&before.status===next.status&&before.output===next.output)return;
          records.set(key,next);session.activity(next);
        };
        deadlineMs=agyTurnTimeout(options?.timeoutMs);startedAt=Date.now();
        const result=await owner.run({agy:{cwd:session.cwd},signal:AbortSignal.any([operation.signal,local.signal]),timeoutMs:deadlineMs,prepare:async()=>imageDir?[...AGY_ARGV,'--add-dir',imageDir]:AGY_ARGV,onStart:send=>send(agyInputLine(prompt)),onLine:(line,send)=>{
          if(!line.trim())return;failure='native_protocol';const event=JSON.parse(line);if(!object(event)||terminal)throw new Error('Unexpected AGY event');
          if(event.event==='init')return;
          if(event.event==='step_update'){
            const step=event.step_update;if(!object(step))throw new Error('Malformed AGY step');
            if(step.step_type==='tool')record(step);
            else if(step.step_type==='agent_response'&&typeof step.text_delta==='string'){full+=step.text_delta;emit(false);}
            return;
          }
          if(event.event==='result'){
            const res=event.result;if(!object(res))throw new Error('Malformed AGY result');
            if(res.status!=='SUCCESS'){failure='agy_error';agyError=clip(res.error??'AGY reported an error',300);throw new Error(agyError);}
            terminal=res;if(typeof res.response==='string'&&res.response.startsWith(full))full=res.response;
            const nativeUsage=object(res.usage)?res.usage:{};output.usage.input=count(nativeUsage.input_tokens);output.usage.output=count(nativeUsage.output_tokens);output.usage.cacheRead=count(nativeUsage.cache_read_tokens);output.usage.totalTokens=count(nativeUsage.total_tokens)||output.usage.input+output.usage.output+output.usage.cacheRead;
            send.end();finishTimer=setTimeout(()=>local.abort(),3000);return;
          }
        }}).catch(error=>{if(terminal&&!operation.signal.aborted&&local.signal.aborted)return undefined;throw error;});
        if(finishTimer)clearTimeout(finishTimer);
        operation.signal.throwIfAborted();failure='terminal';if(!terminal||result&&result.exitCode!==0&&result.exitCode!==null)throw new Error('AGY turn did not finish cleanly');
        emit(true);if(output.content[0]?.type==='text')events.push({type:'text_end',contentIndex:0,content:full,partial:output});
        output.stopReason='stop';events.push({type:'done',reason:'stop',message:output});
      }catch{output.stopReason=operation.signal.aborted?'aborted':'error';output.errorMessage=operation.signal.aborted?'Antigravity request cancelled':startedAt&&Date.now()-startedAt>=deadlineMs?agyTimeoutMessage(deadlineMs):`Antigravity unsupervised request failed (${failure})${agyError?`: ${agyError}`:''}`;events.push({type:'error',reason:output.stopReason,error:output});}
      finally{if(finishTimer)clearTimeout(finishTimer);if(imageDir)await rm(imageDir,{recursive:true,force:true}).catch(()=>{});options?.signal?.removeEventListener('abort',abort);events.end();}
    })();return events;
  }
  const deny=async({credential}:{credential?:unknown})=>{if(credential)throw new Error('Native routes do not accept Pi credentials');return identity()&&owner.isAgyUnsupervisedEnabled()?{source:'unsupervised Antigravity profile'}:undefined;};
  const provider:Provider={id:AGY_UNSUPERVISED_PROVIDER_ID,name:'Antigravity · unsupervised',auth:{apiKey:{name:'Antigravity profile',check:async(input:any)=>{const ok=await deny(input);return ok?{type:'api_key' as const,source:ok.source}:undefined;},resolve:async(input:any)=>{const ok=await deny(input);return ok?{auth:{},source:ok.source}:undefined;}}},getModels:()=>[model],stream:stream as Provider['stream'],streamSimple:stream};
  const originalSimple=runtime.streamSimple.bind(runtime),originalStream=runtime.stream.bind(runtime);
  runtime.streamSimple=(selected,context,options)=>selected.provider===AGY_UNSUPERVISED_PROVIDER_ID&&!identity(selected)?stream(selected,normalizeContext(context),options):originalSimple(selected,context,options);
  runtime.stream=((selected,context,options)=>selected.provider===AGY_UNSUPERVISED_PROVIDER_ID&&!identity(selected)?stream(selected,normalizeContext(context),options as SimpleStreamOptions):originalStream(selected,context,options)) as ModelRuntime['stream'];
  const enable=()=>{if(runtime.getRegisteredNativeProvider(AGY_UNSUPERVISED_PROVIDER_ID)!==provider)runtime.registerNativeProvider(provider);};
  const disable=()=>{if(runtime.getRegisteredNativeProvider(AGY_UNSUPERVISED_PROVIDER_ID))runtime.unregisterProvider(AGY_UNSUPERVISED_PROVIDER_ID);};
  owner.setAgyHook(on=>{if(on)enable();else disable();});
  return {identity,bind:(id:string,session:AgySession)=>{sessions.set(id,session);},unbind:(id:string)=>{sessions.delete(id);}};
}
