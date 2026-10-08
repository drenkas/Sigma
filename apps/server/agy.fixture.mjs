#!/usr/bin/env node
// Synthetic stand-in for the Antigravity CLI. Never contacts a model. Placeholders are replaced by the test when it is installed.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const scenario=JSON.parse(readFileSync('__SCENARIO__','utf8')),mode=scenario.mode,observed='__OBSERVED__';
const record=value=>appendFileSync(observed,JSON.stringify(value)+'\n');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
record({pid:process.pid,ppid:process.ppid,cwd:process.cwd(),argv:process.argv.slice(2),env:process.env,home:process.env.HOME});
function hang(){
  process.on('SIGTERM',()=>{});
  const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore']});
  record({descendant:child.pid});writeFileSync(scenario.ready,String(process.pid));setInterval(()=>{},1000);
}
const CID='fixture-conversation',step=(index,state,extra)=>send({event:'step_update',step_update:{conversation_id:CID,step_index:index,state,...extra}});
const usage={input_tokens:11,output_tokens:7,thinking_tokens:2,cache_read_tokens:3,total_tokens:21};
// agy 1.2.17 decodes one {"event":"user","message":{...}} object per line; anything else yields an ERROR result.
function decode(line){
  let value;try{value=JSON.parse(line);}catch{return 'invalid JSON input';}
  if(value===null||typeof value!=='object'||Array.isArray(value)||typeof value.event!=='string')return 'missing "event" field';
  if(value.event!=='user')return `unsupported event ${JSON.stringify(value.event)}`;
  if(value.message===null||typeof value.message!=='object'||Array.isArray(value.message))return 'message must be an object';
  return undefined;
}
if(mode==='hang-start')hang();
else createInterface({input:process.stdin}).on('line',line=>{
  record({stdin:line});const bad=decode(line);
  if(bad){send({event:'result',result:{conversation_id:CID,status:'ERROR',error:bad,duration_seconds:0.01,num_turns:0,usage:{}}});return;}
  // Verbatim capture of a real agy 1.2.17 turn.
  if(mode==='replay'){process.stdout.write(readFileSync(scenario.replay,'utf8'));return;}
  send({event:'init',conversation_id:CID,init:{cwd:process.cwd(),agent:process.argv[process.argv.indexOf('--agent')+1],tools:['view_file','run_command','write_to_file','manage_task'],permission_mode:'always-proceed'}});
  step(0,'DONE',{step_type:'user_input'});
  if(mode==='hang'){step(1,'ACTIVE',{step_type:'tool',tool_name:'run_command',tool_info:{name:'run_command',parameters:{CommandLine:'sleep 1000'}}});hang();return;}
  // AGY executes tools itself, inside its cwd.
  writeFileSync('agy-wrote.txt','written by the synthetic AGY\n');
  const write={TargetFile:'agy-wrote.txt',CodeContent:'x'.repeat(400)};
  step(1,'ACTIVE',{step_type:'tool',tool_name:'write_to_file',tool_info:{name:'write_to_file',parameters:write}});
  step(1,'DONE',{step_type:'tool',tool_name:'write_to_file',duration_seconds:0.02,tool_info:{name:'write_to_file',parameters:write,output:'ok '.repeat(400)}});
  step(2,'ACTIVE',{step_type:'tool',tool_name:'run_command',tool_info:{name:'run_command',parameters:{CommandLine:'false'}}});
  step(2,'ERROR',{step_type:'tool',tool_name:'run_command',duration_seconds:0.01,tool_info:{name:'run_command',parameters:{CommandLine:'false'},output:'exit 1'}});
  if(mode==='error'){send({event:'result',result:{conversation_id:CID,status:'ERROR',error:'model quota exhausted',duration_seconds:1,num_turns:1,usage}});return;}
  const deltas=['Hello ','\ud83d','\udc31 ünï ','– done'];
  deltas.forEach((text_delta,i)=>step(3,i===deltas.length-1?'DONE':'ACTIVE',{step_type:'agent_response',text_delta,...(i===deltas.length-1?{duration_seconds:0.5,usage}:{})}));
  send({event:'result',result:{conversation_id:CID,status:'SUCCESS',response:'Hello 🐱 ünï – done',duration_seconds:1,num_turns:1,usage}});
}).on('close',()=>process.exit(0));
