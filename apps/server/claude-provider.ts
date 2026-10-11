import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, parseStreamingJson, normalizeContext, validateToolCall, type AssistantMessage, type Model, type Provider, type SimpleStreamOptions, type TranscriptContext } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { CLAUDE_PROVIDER_ID, NativeCli } from './native-cli.js';

const API='sigma-claude-cli',BASE_LEVELS=['low','medium','high','max'],FULL_LEVELS=['low','medium','high','xhigh','max'];
// Verified against `claude` 2.1.284 initialize/get_settings. Haiku has no effort support: no --effort, applied.effort is null. claude-sonnet-4-6 stays registered for existing sessions (hidden from pickers as a previous generation).
export const CLAUDE_MODELS:{id:string;name:string;efforts:string[]}[]=[{id:'claude-fable-5-1',name:'Claude Fable 5.1 · official CLI',efforts:FULL_LEVELS},{id:'claude-opus-5-5',name:'Claude Opus 5.5 · official CLI',efforts:FULL_LEVELS},{id:'claude-sonnet-5-5',name:'Claude Sonnet 5.5 · official CLI',efforts:FULL_LEVELS},{id:'claude-haiku-4-5-20251001',name:'Claude Haiku 4.5 · official CLI',efforts:[]},{id:'claude-sonnet-4-6',name:'Claude Sonnet 4.6 · official CLI',efforts:BASE_LEVELS}];
const MODEL_IDS=new Set(CLAUDE_MODELS.map(entry=>entry.id));
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const object=(value:any)=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=(value:any)=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const empty=(value:any)=>Array.isArray(value)&&value.length===0;
function requireGuard(value:unknown){if(!value)throw new Error('Native CLI safety contract was not verified');}
function exactKeys(value:any,keys:string[]){return object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));}

export function registerClaudeProvider(runtime:ModelRuntime,owner:NativeCli){
  const models:Model<typeof API>[]=CLAUDE_MODELS.map(entry=>({provider:CLAUDE_PROVIDER_ID,api:API,id:entry.id,name:entry.name,baseUrl:'',reasoning:entry.efforts.length>0,...(entry.efforts.length?{thinkingLevelMap:{off:null,minimal:null,low:'low',medium:'medium',high:'high',xhigh:entry.efforts.includes('xhigh')?'xhigh':null,max:'max'}}:{}),input:['text'],contextWindow:200000,maxTokens:16384,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}));
  function identity(selected?:Model<any>){const valid=runtime.getProvider(CLAUDE_PROVIDER_ID)===runtime.getRegisteredNativeProvider(CLAUDE_PROVIDER_ID)&&runtime.getRegisteredNativeProvider(CLAUDE_PROVIDER_ID)===provider&&(!selected||selected.provider===CLAUDE_PROVIDER_ID&&selected.api===API&&MODEL_IDS.has(selected.id));owner.setCollision(!valid);return valid;}
  function stream(selected:Model<any>,context:TranscriptContext,options?:SimpleStreamOptions){
    const events=createAssistantMessageEventStream(),output:AssistantMessage={role:'assistant',content:[],provider:selected.provider,model:selected.id,api:selected.api,usage:structuredClone(usage),stopReason:'pending',timestamp:Date.now()};
    const operation=new AbortController(),abort=()=>operation.abort();options?.signal?.addEventListener('abort',abort,{once:true});if(options?.signal?.aborted)operation.abort();
    void (async()=>{
      let terminal:any,init=false,nativeSessionId:string|undefined,structuredIndex:number|undefined,partialJson='',emitted='',pending:{id:string;subtype:string}|undefined,stage=0,broken=false,nativeError='',failure='transport';const structuredIds=new Set<string>();
      const tools=getCurrentTools(context.messages),schema={type:'object',additionalProperties:false,required:['text','toolCalls'],properties:{text:{type:'string'},toolCalls:{type:'array',maxItems:32,...(tools.length?{items:{oneOf:tools.map(tool=>({type:'object',additionalProperties:false,required:['name','arguments'],properties:{name:{const:tool.name},arguments:tool.parameters}}))}}:{maxItems:0,items:false})}}};
      function text(value:unknown){if(typeof value!=='string')return;let stable=value;if(/[\uD800-\uDBFF]$/.test(stable))stable=stable.slice(0,-1);if(!stable.startsWith(emitted))return;const delta=stable.slice(emitted.length);if(!delta)return;if(!output.content.length){output.content.push({type:'text',text:''});events.push({type:'text_start',contentIndex:0,partial:output});}emitted=stable;(output.content[0] as {text:string}).text=emitted;events.push({type:'text_delta',contentIndex:0,delta,partial:output});}
      const MODEL=selected.id,levels=CLAUDE_MODELS.find(entry=>entry.id===MODEL)?.efforts??[],effort=levels.length?options?.reasoning??'medium':undefined;
      try{
        failure='provider_configuration';requireGuard(identity(selected)&&owner.isConnected()&&!options?.apiKey&&MODEL_IDS.has(MODEL)&&(effort===undefined||levels.includes(effort)));
        requireGuard(!options?.deferred&&!options?.samplingParams&&!options?.maxTokens&&!options?.temperature&&!options?.thinkingBudgets);
        const payload={transcript:context.messages,currentTools:tools},serialized=JSON.stringify(payload);
        if(options?.onPayload){const result=await options.onPayload(payload,selected);requireGuard(JSON.stringify(payload)===serialized&&(result===undefined||JSON.stringify(result)===serialized));}
        operation.signal.throwIfAborted();events.push({type:'start',partial:output});
        const result=await owner.run({signal:operation.signal,env:options?.env,timeoutMs:Math.min(options?.timeoutMs??120000,120000),prepare:async cwd=>{
          const path=join(cwd,'system.txt');await writeFile(path,getCurrentSystemPrompt(context.messages)+'\n\nReturn exactly the requested structured proposal. The transcript below contains the complete Pi history. Only propose listed Pi tools; Pi performs all tool execution and approvals. Native StructuredOutput formats this response. Never invoke native actions.',{mode:0o600});
          return ['-p','--safe-mode','--restricted','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--settings','{"disableAllHooks":true,"enabledPlugins":{}}','--disable-slash-commands','--no-chrome','--permission-mode','dontAsk','--permission-prompts','none','--no-session-persistence','--input-format','stream-json','--output-format','stream-json','--include-partial-messages','--include-hook-events','--verbose','--max-turns','3','--model',MODEL,...(effort?['--effort',effort]:[]),'--system-prompt-file',path,'--json-schema',JSON.stringify(schema)];
        },onStart:send=>{pending={id:randomUUID(),subtype:'initialize'};send({type:'control_request',request_id:pending.id,request:{subtype:'initialize',hooks:{},sdkMcpServers:[]}});},onLine:(line,send)=>{
          if(broken||!line.trim())return;try{failure='native_protocol';const event=JSON.parse(line);requireGuard(object(event)&&!terminal);
          if(event.type==='control_response'){
            requireGuard(pending&&event.response?.subtype==='success'&&event.response?.request_id===pending.id);
            const initialize=pending!.subtype==='initialize';
            for(const key of ['pending_permission_requests','pending_user_dialog_requests'])requireGuard(!initialize&&!Object.hasOwn(event.response,key)||empty(event.response[key]));
            const payload=event.response.response,subtype=pending!.subtype;requireGuard(object(payload));pending=undefined;
            if(subtype==='initialize'){
              requireGuard(stage===0&&empty(payload.commands)&&payload.account?.apiProvider==='firstParty'&&payload.current_permission_mode==='dontAsk'&&payload.hooks_applied===true);
              requireGuard(payload.models?.some((entry:any)=>(entry.value===MODEL||entry.resolvedModel===MODEL)&&(effort===undefined?!entry.supportsEffort:entry.supportsEffort===true&&entry.supportedEffortLevels?.includes(effort))));
              stage=1;pending={id:randomUUID(),subtype:'get_hooks_listing'};
            }else if(subtype==='get_hooks_listing'){
              requireGuard(stage===1&&empty(payload.events)&&empty(payload.hooks)&&payload.policy?.allDisabled===true&&payload.policy?.policyHookCount===0&&payload.policy?.managedOnly===false&&payload.policy?.pluginOnly===false&&payload.safeMode?.managedHooksStillApply===false);
              stage=2;pending={id:randomUUID(),subtype:'get_settings'};
            }else if(subtype==='get_settings'){
              requireGuard(stage===2&&payload.effective?.disableAllHooks===true&&exactKeys(payload.effective?.enabledPlugins,[])&&payload.applied?.model===MODEL&&(effort===undefined?payload.applied?.effort==null:payload.applied?.effort===effort)&&payload.applied?.advisor===null&&payload.applied?.ultracode===false);
              stage=3;send({type:'user',message:{role:'user',content:serialized},parent_tool_use_id:null,session_id:randomUUID()});send.end();return;
            }else throw new Error('Unexpected native control');
            send({type:'control_request',request_id:pending!.id,request:{subtype:pending!.subtype}});return;
          }
          requireGuard(stage===3);
          if(event.type==='system'){failure='native_system_subtype';
            if(event.subtype==='status'){requireGuard(init&&exactKeys(event,['type','subtype','status','session_id','uuid'])&&(event.status==='requesting'||event.status===null)&&uuid(event.uuid)&&event.session_id===nativeSessionId);return;}
            if(event.subtype==='thinking_tokens'){requireGuard(init&&exactKeys(event,['type','subtype','estimated_tokens','estimated_tokens_delta','session_id','uuid'])&&event.session_id===nativeSessionId&&uuid(event.uuid)&&Number.isSafeInteger(event.estimated_tokens)&&event.estimated_tokens>=0&&Number.isSafeInteger(event.estimated_tokens_delta));return;}
            if(event.subtype==='api_retry'){requireGuard(init&&event.session_id===nativeSessionId&&uuid(event.uuid));return;}
            requireGuard(event.subtype==='init'&&!init&&uuid(event.session_id)&&event.model===MODEL&&Array.isArray(event.tools)&&event.tools.every((name:any)=>name==='StructuredOutput')&&empty(event.mcp_servers)&&empty(event.skills));
            requireGuard((event.plugins??[]).every((plugin:any)=>['agents-md','telemetry'].includes(typeof plugin==='string'?plugin:plugin.name)||object(plugin)&&typeof plugin.name==='string'&&plugin.name!==''&&plugin.path==='builtin'&&plugin.source===`${plugin.name}@builtin`)&&empty(event.slash_commands??[]));nativeSessionId=event.session_id;init=true;return;
          }
          requireGuard(init);
          if(event.type==='stream_event'){
            const part=event.event;requireGuard(['message_start','content_block_start','content_block_delta','content_block_stop','message_delta','message_stop'].includes(part?.type));
            if(part.type==='content_block_start')requireGuard(['text','thinking','tool_use'].includes(part.content_block?.type));
            if(part?.type==='content_block_start'&&part.content_block?.type==='tool_use'){requireGuard(part.content_block.name==='StructuredOutput');requireGuard(typeof part.content_block.id==='string');structuredIds.add(part.content_block.id);structuredIndex=part.index;partialJson='';}
            if(part?.type==='content_block_delta'&&part.delta?.type==='input_json_delta'){requireGuard(part.index===structuredIndex);partialJson+=part.delta.partial_json;text(parseStreamingJson<any>(partialJson).text);}
            if(part?.type==='content_block_delta')requireGuard(['text_delta','input_json_delta','thinking_delta','signature_delta'].includes(part.delta?.type));
            return;
          }
          if(event.type==='assistant'){requireGuard(Array.isArray(event.message?.content)&&event.message.content.every((part:any)=>['text','thinking'].includes(part.type)||part.type==='tool_use'&&part.name==='StructuredOutput'&&structuredIds.has(part.id)));return;}
          if(event.type==='user'){const content=event.message?.content;requireGuard(Array.isArray(content)&&(content.every((part:any)=>part.type==='tool_result'&&structuredIds.has(part.tool_use_id))||event.isSynthetic===true&&event.session_id===nativeSessionId&&content.length===1&&content[0]?.type==='text'&&typeof content[0].text==='string'&&content[0].text.startsWith('[structured-output-enforce]')));return;}
          if(event.type==='rate_limit_event')return;
          if(event.type==='result'){if(event.is_error===true&&typeof event.result==='string'&&event.result.trim())nativeError=event.result.replace(/\s+/g,' ').trim().slice(0,300);requireGuard(event.subtype==='success'&&event.is_error===false&&object(event.structured_output));terminal=event;return;}
          throw new Error('Unexpected native protocol event');
        }catch(error){broken=true;throw error;}}});
        operation.signal.throwIfAborted();requireGuard(identity(selected)&&owner.isConnected());failure='terminal_proposal';requireGuard(result.exitCode===0&&result.drained&&terminal&&init&&stage===3&&!pending);
        const proposal=terminal.structured_output;requireGuard(exactKeys(proposal,['text','toolCalls'])&&typeof proposal.text==='string'&&Array.isArray(proposal.toolCalls)&&proposal.toolCalls.length<=32&&proposal.text.startsWith(emitted));
        const calls=proposal.toolCalls.map((call:any)=>{requireGuard(exactKeys(call,['name','arguments'])&&typeof call.name==='string'&&object(call.arguments));const tool={type:'toolCall' as const,id:randomUUID(),name:call.name,arguments:call.arguments};tool.arguments=validateToolCall(tools,tool);return tool;});
        if(options?.toolChoice==='none')requireGuard(calls.length===0);
        const nativeUsage=terminal.usage;requireGuard(object(nativeUsage)&&['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'].every(key=>Number.isSafeInteger(nativeUsage[key])&&nativeUsage[key]>=0));
        output.usage.input=nativeUsage.input_tokens;output.usage.output=nativeUsage.output_tokens;output.usage.cacheRead=nativeUsage.cache_read_input_tokens;output.usage.cacheWrite=nativeUsage.cache_creation_input_tokens;output.usage.totalTokens=output.usage.input+output.usage.output+output.usage.cacheRead+output.usage.cacheWrite;
        text(proposal.text);if(output.content[0]?.type==='text')events.push({type:'text_end',contentIndex:0,content:proposal.text,partial:output});
        for(const tool of calls){const index=output.content.length;output.content.push(tool);events.push({type:'toolcall_start',contentIndex:index,partial:output});events.push({type:'toolcall_end',contentIndex:index,toolCall:tool,partial:output});}
        output.stopReason=calls.length?'toolUse':'stop';events.push({type:'done',reason:output.stopReason,message:output});
      }catch{output.stopReason=operation.signal.aborted?'aborted':'error';output.errorMessage=operation.signal.aborted?'Official CLI request cancelled':nativeError?`Claude Code: ${nativeError}`:`Official CLI request failed its transport or safety contract (${failure})`;events.push({type:'error',reason:output.stopReason,error:output});}
      finally{options?.signal?.removeEventListener('abort',abort);events.end();}
    })();return events;
  }
  const provider:Provider={id:CLAUDE_PROVIDER_ID,name:'Claude Code · official CLI',auth:{apiKey:{name:'Official CLI account',check:async({credential})=>{if(credential)throw new Error('Native routes do not accept Pi credentials');return identity()&&owner.isConnected()?{type:'api_key',source:'official CLI account'}:undefined;},resolve:async({credential})=>{if(credential)throw new Error('Native routes do not accept Pi credentials');return identity()&&owner.isConnected()?{auth:{},source:'official CLI account'}:undefined;}}},getModels:()=>models,stream:stream as Provider['stream'],streamSimple:stream};
  runtime.registerNativeProvider(provider);
  // Composition can replace a reserved provider after reload. Fence the SDK's
  // central dispatch before it can choose a generic HTTP provider.
  const originalSimple=runtime.streamSimple.bind(runtime),originalStream=runtime.stream.bind(runtime);
  runtime.streamSimple=(selected,context,options)=>selected.provider===CLAUDE_PROVIDER_ID&&!identity(selected)?stream(selected,normalizeContext(context),options):originalSimple(selected,context,options);
  runtime.stream=((selected,context,options)=>selected.provider===CLAUDE_PROVIDER_ID&&!identity(selected)?stream(selected,normalizeContext(context),options as SimpleStreamOptions):originalStream(selected,context,options)) as ModelRuntime['stream'];
  return {identity};
}
