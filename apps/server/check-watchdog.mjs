import { spawn } from "node:child_process";

// This process owns the check. Losing the server's stdin pipe cancels it, including after SIGKILL.
const {node,cwd,args,profile,timeoutMs,outputLimit}=JSON.parse(process.argv[2]);
const child=spawn("/usr/bin/sandbox-exec",["-p",profile,node,...args],{
  cwd,detached:true,stdio:["ignore","pipe","pipe"],env:{PATH:"/usr/bin:/bin",HOME:cwd,TMPDIR:cwd,LC_ALL:"C"},
});
let output="",used=0,truncated=false,stopping="",finished=false,infrastructureError="",tail="",testReported=false;
function collect(chunk){
  tail=(tail+Buffer.from(chunk).toString("utf8")).slice(-1024);
  if(/(?:^|\n)# tests \d+/.test(tail))testReported=true;
  if(used>=outputLimit){truncated=true;return;}
  const bytes=Buffer.from(chunk),part=bytes.subarray(0,outputLimit-used);used+=part.length;
  output+=part.toString("utf8");if(part.length<bytes.length)truncated=true;
}
child.stdout.on("data",collect);child.stderr.on("data",collect);
function stop(reason){
  if(finished||stopping)return;stopping=reason;
  try{process.kill(-child.pid,"SIGTERM");}catch{}
  setTimeout(()=>{if(!finished)try{process.kill(-child.pid,"SIGKILL");}catch{}},250).unref();
}
const timer=setTimeout(()=>stop("timeout"),timeoutMs);
process.stdin.on("end",()=>stop("cancelled"));process.stdin.resume();
process.on("disconnect",()=>stop("cancelled"));
process.on("SIGTERM",()=>stop("cancelled"));process.stdout.on("error",()=>{});
child.on("error",error=>{infrastructureError=error.message;stop("failed");});
child.on("close",(exitCode,signal)=>{
  finished=true;clearTimeout(timer);
  process.send?.({exitCode,signal,output,truncated,stopping,infrastructureError,testReported},()=>process.exit(0));
});
