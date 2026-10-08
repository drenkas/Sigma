import { spawn } from "node:child_process";
import { readDeployment, proxyEnvironment } from "./cliproxy-config.mjs";

// Sigma admits this detached group before any proxy spawn. IPC/stdin closure
// also tears it down when the server or native parent dies unexpectedly.
let stopping=false,child;
function stop(){
  if(stopping)return;stopping=true;
  try{process.kill(-process.pid,"SIGTERM");}catch{}
  setTimeout(()=>{try{process.kill(-process.pid,"SIGKILL");}catch{}},250);
}
process.on("disconnect",stop);process.on("SIGTERM",stop);process.on("SIGINT",stop);
process.stdin.on("end",stop);process.stdin.resume();
process.on("message",message=>{if(message?.type==="stop")stop();});
try{
  const spec=readDeployment(process.argv[2],process.argv[3]?{sha256:process.argv[3]}:undefined);
  if(!stopping){
    child=spawn(spec.binary,["-local-model","-config",spec.configPath],{cwd:spec.directory,env:proxyEnvironment(),stdio:"ignore"});
    child.on("error",stop);
    child.on("exit",stop);
  }
}catch{stop();}
