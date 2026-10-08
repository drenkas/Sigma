import { spawn } from "node:child_process";

// Owns the browser's process group. Any loss of the server (stdin EOF, IPC disconnect, SIGTERM) kills the whole group.
// argv[2] JSON: {chromium,runDir,args,env,profile?}. fds 3/4 are inherited into Chromium as its CDP pipe.
const {chromium,args,env,profile,termGraceMs=500}=JSON.parse(process.argv[2]);
const command=profile?"/usr/bin/sandbox-exec":chromium;
const argv=profile?["-p",profile,chromium,...args]:args;
const child=spawn(command,argv,{detached:true,stdio:["ignore","ignore","pipe",3,4],env});
const pgid=child.pid;
let stopping="",finished=false,stderr="",infrastructureError="";
child.stderr.on("data",chunk=>{stderr=(stderr+Buffer.from(chunk).toString("utf8")).slice(-4096);});
const groupAlive=()=>{try{process.kill(-pgid,0);return true;}catch(error){return error.code==="EPERM";}};
function signal(name){try{process.kill(-pgid,name);}catch{}}
async function drain(){
  signal("SIGTERM");
  const deadline=Date.now()+termGraceMs;
  while(groupAlive()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
  if(groupAlive()){signal("SIGKILL");const end=Date.now()+3000;while(groupAlive()&&Date.now()<end)await new Promise(r=>setTimeout(r,25));}
}
function stop(reason){
  if(stopping)return;stopping=reason;
  drain().then(()=>{if(!finished)finish(null,"SIGKILL");});
}
let reported=false;
function finish(exitCode,sig){
  if(reported)return;reported=true;finished=true;
  process.send?.({type:"exit",exitCode,signal:sig,stopping,groupEmpty:!groupAlive(),stderr,infrastructureError},()=>process.exit(0));
  if(!process.send)process.exit(0);
}
process.stdin.on("end",()=>stop("cancelled"));process.stdin.on("error",()=>stop("cancelled"));process.stdin.resume();
process.on("disconnect",()=>stop("cancelled"));
process.on("SIGTERM",()=>stop("cancelled"));process.on("SIGHUP",()=>stop("cancelled"));
child.on("error",error=>{infrastructureError=error.message;stop("failed");});
child.on("spawn",()=>process.send?.({type:"started",pid:child.pid,pgid}));
// Browser main process exited on its own (Browser.close or crash): sweep any helpers, then report only once the group is empty.
child.on("close",(exitCode,sig)=>{drain().then(()=>finish(exitCode,sig));});
