import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';

// Root admitted this detached helper PGID before any CLI spawn. The CLI and
// descendants inherit that group, so helper death cannot lose root ownership.
const spec=JSON.parse(process.argv[2]),decoder=new StringDecoder('utf8');
const child=spawn(spec.binary,spec.args,{cwd:spec.cwd,env:spec.env,detached:false,stdio:['pipe','pipe','pipe']});
let stopped=false,closed=false,exitCode=null,signal=null,reason='',bytes=0,tail='',ending=false,mainExited=false;
const send=value=>{if(process.connected)process.send(value,()=>{});};
function stop(why){
  if(stopped)return;stopped=true;reason=why;
  try{process.kill(-process.pid,'SIGTERM');}catch{}
  // Referenced: parent-gone cleanup must survive even when the main CLI closes.
  setTimeout(()=>{try{process.kill(-process.pid,'SIGKILL');}catch{}},250);
}
async function finish(){
  if(ending)return;ending=true;
  // No root remains to drain. Keep the group owner alive until group SIGKILL.
  if(stopped&&reason!=='drain')return;
  if(process.connected)await new Promise(resolve=>{process.send({type:'closed',exitCode,signal,reason:'',mainClosed:true},()=>resolve());});
  process.exit(0);
}
child.stdout.on('data',chunk=>{
  bytes+=chunk.length;if(bytes>8_000_000){stop('output_limit');return;}
  tail+=decoder.write(chunk);let at;
  while((at=tail.indexOf('\n'))>=0){send({type:'line',line:tail.slice(0,at)});tail=tail.slice(at+1);}
});
child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>8_000_000)stop('output_limit');});
child.stdin.on('error',()=>{});
child.on('spawn',()=>send({type:'ready'}));
child.on('error',()=>{reason='spawn_failed';});
child.on('exit',(code,sig)=>{mainExited=true;exitCode=code;signal=sig;send({type:'main_exit',exitCode,signal});});
child.on('close',(code,sig)=>{closed=true;exitCode=code;signal=sig;tail+=decoder.end();if(tail)send({type:'line',line:tail});void finish();});
process.on('message',message=>{if(message?.type==='write'&&!closed)child.stdin.write(message.line+'\n');if(message?.type==='eof')child.stdin.end();if(message?.type==='stop')stop('cancelled');});
process.stdin.on('end',()=>stop('parent_gone'));process.stdin.resume();
process.on('disconnect',()=>stop('parent_gone'));process.on('SIGTERM',()=>stop(mainExited?'drain':'cancelled'));
const timer=setTimeout(()=>stop('timeout'),spec.timeoutMs);timer.unref();
