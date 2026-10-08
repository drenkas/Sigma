import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Runs agent shell commands on the host inside a macOS sandbox-exec profile that denies Sigma's credential files. */
export const SANDBOX_EXEC="/usr/bin/sandbox-exec";
export const SHELL="/bin/zsh";
export const DEFAULT_TIMEOUT_SECONDS=300;
export const MAX_TIMEOUT_SECONDS=1800;
export const MAX_OUTPUT_BYTES=30*1024;

/** Environment names that carry Sigma-internal state or provider credentials; none of them reach agent commands. */
const SECRET_NAME=/^(SIGMA_|PI_|PI_ORCH_|AGY_|ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_API|AZURE_OPENAI|MISTRAL_|GROQ_|XAI_|OPENROUTER_|CLAUDE_CODE_|CLIPROXY|CLI_PROXY|AWS_(SECRET|SESSION))|(API_?KEY|SECRET|(^|_)TOKEN|PASSWORD|PASSWD|CREDENTIALS?|COOKIES?|PRIVATE_KEY)$/i;
export function scrubEnv(env:NodeJS.ProcessEnv):NodeJS.ProcessEnv{
  const clean:NodeJS.ProcessEnv={};
  for(const [name,value] of Object.entries(env))if(value!==undefined&&!SECRET_NAME.test(name))clean[name]=value;
  return clean;
}

function canonical(path:string):string{
  let at=resolve(path);const suffix:string[]=[];
  while(true){
    try{return join(realpathSync(at),...suffix);}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=="ENOENT")return resolve(path);
      suffix.unshift(at.slice(dirname(at).length+1));const parent=dirname(at);if(parent===at)return resolve(path);at=parent;
    }
  }
}

/** What the sandbox denies: credential files, credential-only folders, and well-known credential file names under hidden home folders. Everything else stays readable and writable. */
export type Protected={files:string[];dirs:string[];patterns:string[]};
const CREDENTIAL_NAMES=["auth.json","credentials.json",".credentials.json","oauth_creds.json","google_accounts.json"];
const regexEscape=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const both=(paths:string[])=>[...new Set(paths.flatMap(path=>[resolve(path),canonical(path)]))];

export function protectedRoots(dataDir:string,agentDir:string,home=process.env.HOME,extraDataDir=process.env.SIGMA_DATA_DIR):Protected{
  const dataDirs=[dataDir,...(extraDataDir?[extraDataDir]:[])],files:string[]=[],dirs:string[]=[];
  for(const data of dataDirs){
    files.push(...["agent-access.json","native-providers.json","state.sqlite","state.sqlite-wal","state.sqlite-shm","sigma.lock"].map(name=>join(data,name)));
    dirs.push(join(data,"git-intents"),join(data,"cliproxyapi"),join(data,"antigravity-profile"));
    // Pi SDK keeps provider keys in the agent folder; its sessions, settings and the rest stay readable.
    for(const sdk of [join(data,"agent")])files.push(...["auth.json","models.json","models-store.json"].map(name=>join(sdk,name)));
  }
  files.push(...["auth.json","models.json","models-store.json"].map(name=>join(agentDir,name)));
  const patterns:string[]=[];
  if(home){
    files.push(join(home,".codex","auth.json"),join(home,".gemini","oauth_creds.json"),join(home,".gemini","google_accounts.json"),join(home,".claude",".credentials.json"),join(home,".claude","credentials.json"));
    dirs.push(join(home,".cli-proxy-api"));
    // Credential file names anywhere inside hidden folders of the home directory (tool config folders), never in ordinary project folders.
    for(const base of both([home]))patterns.push(`^${regexEscape(base)}/\\.[^/]+/(.*/)?(${CREDENTIAL_NAMES.map(regexEscape).join("|")})$`);
  }
  return {files:both(files),dirs:both(dirs),patterns:[...new Set(patterns)]};
}

const quote=(path:string)=>JSON.stringify(path);
/** SBPL: everything allowed (network, home, processes, workspaces), then only credential files and credential folders denied for reads and writes. */
export function sandboxProfile(denied:Protected):string{
  return [
    "(version 1)","(allow default)",
    ...denied.dirs.map(path=>`(deny file-read* file-write* (subpath ${quote(path)}))`),
    ...denied.files.map(path=>`(deny file-read* file-write* (literal ${quote(path)}))`),
    ...denied.patterns.map(pattern=>`(deny file-read* file-write* (regex #"${pattern.replace(/"/g,'\\"')}"))`),
  ].join("\n");
}

export type ShellResult={exitCode:number|null;signal:string|null;timedOut:boolean;aborted:boolean;output:string;truncatedBytes:number};
export type ShellOptions={
  command:string;cwd:string;timeoutMs:number;signal?:AbortSignal;env?:NodeJS.ProcessEnv;
  denied:Protected;
  /** Overrides for tests; production always sandboxes with the system tools. */
  sandbox?:string;shell?:string;maxOutput?:number;killGraceMs?:number;
};

export function sandboxAvailable(sandbox=SANDBOX_EXEC){return process.platform==="darwin"&&existsSync(sandbox)&&existsSync(SHELL);}

const running=new Set<ChildProcess>();
const killGroup=(child:ChildProcess,signal:NodeJS.Signals)=>{if(child.pid===undefined)return;try{process.kill(-child.pid,signal);}catch{try{child.kill(signal);}catch{}}};
/** Kills every running agent command's process group; used on server shutdown. */
export function killAllShells(){for(const child of running)killGroup(child,"SIGKILL");}
export const runningShells=()=>running.size;

export function runShell(options:ShellOptions):Promise<ShellResult>{
  const sandbox=options.sandbox??SANDBOX_EXEC,shell=options.shell??SHELL,cap=options.maxOutput??MAX_OUTPUT_BYTES,grace=options.killGraceMs??2000;
  // Fail closed: never fall back to an unsandboxed shell.
  if(process.platform!=="darwin"||!existsSync(sandbox))return Promise.reject(new Error("The bash tool needs macOS sandbox-exec to protect Sigma's credentials; it is unavailable, so no command was run."));
  if(options.signal?.aborted)return Promise.reject(new Error("Agent stopped"));
  const profile=sandboxProfile(options.denied);
  return new Promise((resolveResult,reject)=>{
    const child=spawn(sandbox,["-p",profile,shell,"-lc",options.command],{cwd:options.cwd,env:options.env??scrubEnv(process.env),detached:true,stdio:["ignore","pipe","pipe"]});
    running.add(child);
    const chunks:Buffer[]=[];let kept=0,total=0,timedOut=false,aborted=false,settled=false,exited=false;
    const push=(chunk:Buffer)=>{
      total+=chunk.length;chunks.push(chunk);kept+=chunk.length;
      while(kept-chunks[0].length>=cap&&chunks.length>1){kept-=chunks[0].length;chunks.shift();}
    };
    child.stdout!.on("data",push);child.stderr!.on("data",push);
    let escalate:ReturnType<typeof setTimeout>|undefined;
    const stop=()=>{killGroup(child,"SIGTERM");escalate??=setTimeout(()=>killGroup(child,"SIGKILL"),grace);escalate.unref?.();};
    const timer=setTimeout(()=>{timedOut=true;stop();},options.timeoutMs);
    const onAbort=()=>{aborted=true;stop();};
    options.signal?.addEventListener("abort",onAbort,{once:true});
    const finish=(exitCode:number|null,signal:NodeJS.Signals|null)=>{
      if(settled)return;settled=true;clearTimeout(timer);if(escalate)clearTimeout(escalate);options.signal?.removeEventListener("abort",onAbort);
      // The command is over: nothing it left running in its group may outlive it.
      killGroup(child,"SIGKILL");running.delete(child);child.stdout!.destroy();child.stderr!.destroy();
      const all=Buffer.concat(chunks),tail=all.length>cap?all.subarray(all.length-cap):all;
      resolveResult({exitCode,signal,timedOut,aborted,output:tail.toString("utf8"),truncatedBytes:total-tail.length});
    };
    child.once("error",error=>{if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener("abort",onAbort);running.delete(child);reject(error);});
    child.once("exit",(code,signal)=>{exited=true;
      // Background processes may still hold the pipes open; give buffered output a moment, then finish.
      setTimeout(()=>finish(code,signal),100).unref?.();
    });
    child.once("close",(code,signal)=>{if(exited)finish(code,signal);});
  });
}

/** Text returned to the model: truncation note, output, exit status. */
export function formatShellResult(result:ShellResult,timeoutSeconds:number):string{
  const parts:string[]=[];
  if(result.truncatedBytes>0)parts.push(`[truncated ${result.truncatedBytes} bytes]`);
  if(result.output)parts.push(result.output.replace(/\n$/,""));
  if(result.timedOut)parts.push(`[timed out after ${timeoutSeconds}s; the command and its child processes were killed]`);
  else if(result.aborted)parts.push("[stopped; the command and its child processes were killed]");
  parts.push(`[exit code ${result.exitCode??`none (signal ${result.signal})`}]`);
  return parts.join("\n");
}
