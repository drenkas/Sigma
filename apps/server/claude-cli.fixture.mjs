#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const nativeSessionId=randomUUID();
const home=process.env.HOME,scenario=JSON.parse(readFileSync(join(home,'scenario.json'),'utf8')),mode=scenario.mode;
const record=value=>appendFileSync(join(home,'observed.jsonl'),JSON.stringify(value)+'\n');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
record({pid:process.pid,ppid:process.ppid,cwd:process.cwd(),envKeys:Object.keys(process.env),disableMds:process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS,userOwnerMatches:process.env.USER===scenario.ownerUser,home,kind:process.argv.includes('auth')?'status':'completion'});
if(process.argv.includes('auth')){
  if(['held-status','held-status-completion'].includes(mode)){writeFileSync(join(home,'status-ready'),String(process.pid));record({statusReady:true,pid:process.pid});setInterval(()=>{},1000);}
  else {process.stdout.write(JSON.stringify({loggedIn:true,authMethod:'claude.ai',subscriptionType:'pro'},null,2)+'\n');process.exit(0);}
}else if(['hang','descendant'].includes(mode)){
  process.on('SIGTERM',()=>{});if(mode==='descendant'){const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore']});record({descendant:child.pid});}
  writeFileSync(join(home,'ready'),String(process.pid));setInterval(()=>{},1000);
}else {
  const args=process.argv,effort=args.includes('--effort')?args[args.indexOf('--effort')+1]:null,model=args[args.indexOf('--model')+1],schema=JSON.parse(args[args.indexOf('--json-schema')+1]);
  record({args,systemMode:statSync(args[args.indexOf('--system-prompt-file')+1]).mode&0o777,schema});let stage=0,outputSent=false;
  createInterface({input:process.stdin}).on('line',line=>{
    const request=JSON.parse(line);
    if(request.type==='control_request'){
      const subtype=request.request.subtype;let response;
      if(subtype==='initialize'&&stage===0){stage=1;response={commands:[],account:{tokenSource:'none',apiProvider:'firstParty'},current_permission_mode:'dontAsk',hooks_applied:true,models:[effort===null?{value:'haiku',resolvedModel:model}:{value:model,resolvedModel:model,supportsEffort:true,supportedEffortLevels:['low','medium','high','xhigh','max']}]};}
      else if(subtype==='get_hooks_listing'&&stage===1){stage=2;response={events:[],hooks:[],policy:{allDisabled:mode!=='hooks',policyHookCount:0,managedOnly:false,pluginOnly:false},safeMode:{managedHooksStillApply:false}};}
      else if(subtype==='get_settings'&&stage===2){stage=3;response={effective:{disableAllHooks:true,enabledPlugins:{}},applied:{model,effort,advisor:null,ultracode:false}};}
      else process.exit(6);
      const envelope={subtype:'success',request_id:mode==='wrong-id'?'wrong':request.request_id,response,...(subtype==='initialize'?{pending_permission_requests:mode==='permission'?[{request_id:'bad'}]:[],pending_user_dialog_requests:[]}:{}),...(subtype==='get_hooks_listing'&&mode==='permission-later'?{pending_permission_requests:[{request_id:'bad'}]}:{}),...(subtype==='get_settings'&&mode==='permission-malformed'?{pending_user_dialog_requests:null}:{})};
      send({type:'control_response',response:envelope});return;
    }
    if(request.type!=='user'||stage!==3||outputSent)process.exit(7);outputSent=true;const blocks=Array.isArray(request.message.content)?request.message.content:undefined,payload=JSON.parse(blocks?blocks[0].text:request.message.content);record({transcript:payload.transcript,currentTools:payload.currentTools,...(blocks?{blocks}:{})});
    const last=payload.transcript.at(-1),toolResult=[...payload.transcript].reverse().find(message=>message.role==='toolResult'),user=[...payload.transcript].reverse().find(message=>message.role==='user');
    const input=typeof user?.content==='string'?user.content:user?.content?.filter(part=>part.type==='text').map(part=>part.text).join('')??'';
    const complete=()=>{
    send({type:'system',subtype:mode==='unknown-system'?'unverified':'init',model,session_id:nativeSessionId,tools:mode==='native-tool'?['Read']:['StructuredOutput'],mcp_servers:[],skills:[],plugins:[{name:'agents-md'},{name:'telemetry'}],slash_commands:[]});
    const wantsRead=input.startsWith('read:')&&!toolResult;
    const proposal={text:toolResult?(toolResult.isError?'Denied by Pi':'Read by Pi: '+toolResult.content.filter(part=>part.type==='text').map(part=>part.text).join('')):'Hello 🐱',toolCalls:wantsRead?[{name:'read',arguments:{path:input.slice(5).trim()}}]:[]};
    if(mode==='batch-invalid')proposal.toolCalls=[{name:'read',arguments:{path:'note.txt'}},{name:'unavailable',arguments:{}}];
    send({type:'system',subtype:'status',status:mode==='status-unknown'?'unverified':mode==='status-compacting'?'compacting':'requesting',session_id:mode==='status-session'?randomUUID():nativeSessionId,uuid:mode==='status-uuid'?'invalid':randomUUID(),...(mode==='status-extra'?{permissionMode:'dontAsk'}:{})});
    send({type:'system',subtype:'status',status:null,session_id:nativeSessionId,uuid:randomUUID()});
    send({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'tool_use',name:mode==='native-action'?'Bash':'StructuredOutput',id:'formatter'}}});
    const json=JSON.stringify(proposal);for(let at=0;at<json.length;at+=5)send({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:json.slice(at,at+5)}}});
    send({type:'stream_event',event:{type:'content_block_delta',index:1,delta:{type:'text_delta',text:'Native formatter text must never leak'}}});
    send({type:'assistant',message:{content:[{type:'tool_use',id:'formatter',name:'StructuredOutput',input:proposal}]}});
    send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'formatter',content:'formatted'}]}});
    send({type:'result',subtype:'success',is_error:false,usage:{input_tokens:11,output_tokens:19,cache_read_input_tokens:5,cache_creation_input_tokens:2},structured_output:proposal});
    };
    if(mode==='held-status-completion'){record({completionReady:true,pid:process.pid});const timer=setInterval(()=>{if(existsSync(join(home,`release-completion-${process.pid}`))){clearInterval(timer);complete();}},20);}else complete();
  });
}
