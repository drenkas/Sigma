import { spawn } from "node:child_process";
import { chmod, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readDeployment, proxyEnvironment } from "../apps/server/cliproxy-config.mjs";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const action=process.argv[2];
try{
  if(!["start","login"].includes(action))throw new Error();
  const {binary,directory,auth,configPath,baseUrl}=readDeployment(process.env.SIGMA_DATA_DIR??join(root,".data"));
  const env=proxyEnvironment();
  const args=["-local-model","-config",configPath];
  if(action==="login")args.push("-antigravity-login","-oauth-callback-port","51122");
  console.log(action==="start"?`Starting Sigma's private CLIProxyAPI 8.0.13 on ${baseUrl}.`:"Complete Antigravity sign-in in the browser opened by CLIProxyAPI.");
  const child=spawn(binary,args,{cwd:directory,env,stdio:["inherit","ignore","ignore"]});
  const stop=()=>child.kill("SIGTERM");process.on("SIGINT",stop);process.on("SIGTERM",stop);
  const code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",code=>resolve(code));});
  process.off("SIGINT",stop);process.off("SIGTERM",stop);
  if(action==="login"){
    for(const entry of await readdir(auth,{withFileTypes:true}))if(entry.isFile()&&!entry.isSymbolicLink())await chmod(join(auth,entry.name),0o600);
    console.log("Sign-in command ended. Connect or refresh the local proxy in Sigma to verify availability.");
  }
  process.exitCode=typeof code==="number"?code:1;
}catch{console.error("Local proxy could not run. Use start or login; verify the private Sigma configuration and the pinned CLIProxyAPI 8.0.13 binary.");process.exitCode=1;}
