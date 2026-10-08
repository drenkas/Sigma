import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { PINNED_BINARY_NAME, PINNED_BINARY_SHA256 } from "./cliproxy-config.mjs";

export const DEFAULT_PROXY_PORT=8319;
export type ProvisionState="not_installed"|"needs_login"|"ready";
export type Provisioned={state:ProvisionState;reason:string;binaryInstalled:boolean;configured:boolean;authEntries:number};
const MAX_BINARY=100_000_000;
const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
function ensureDir(path:string){
  try{const info=lstatSync(path);if(!info.isDirectory()||info.isSymbolicLink())throw new Error("Private provider path is not a real directory.");if((info.mode&0o077)!==0)chmodSync(path,0o700);}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;mkdirSync(path,{mode:0o700});chmodSync(path,0o700);}
}
/** Number of visible entries only; credential contents are never opened. */
export function authEntryCount(auth:string){try{return readdirSync(auth).filter(name=>!name.startsWith(".")).length;}catch{return 0;}}
function readRegular(path:string,max:number){
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const info=fstatSync(fd);if(!info.isFile()||info.size>max)throw new Error("Unsuitable binary source.");return readFileSync(fd);}finally{closeSync(fd);}
}
function exists(path:string){try{lstatSync(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}}
function placeBinary(bin:string,source:string|undefined,sha256:string){
  const target=join(bin,PINNED_BINARY_NAME);
  if(source){
    let bytes:Buffer|undefined;try{bytes=readRegular(source,MAX_BINARY);}catch{}
    if(bytes&&sha(bytes)===sha256){
      let current:string|undefined;try{current=sha(readRegular(target,MAX_BINARY));}catch{}
      if(current!==sha256){const temp=join(bin,`.${PINNED_BINARY_NAME}.${process.pid}.${randomBytes(4).toString("hex")}`);writeFileSync(temp,bytes,{mode:0o700,flag:"wx"});chmodSync(temp,0o700);renameSync(temp,target);}
      else chmodSync(target,0o700);
    }
  }
  try{return sha(readRegular(target,MAX_BINARY))===sha256;}catch{return false;}
}
/** First-run, idempotent, credential-free provisioning of the private proxy deployment. */
export function provisionProviderData(dataDir:string,options:{binarySource?:string;port?:number;sha256?:string}={}):Provisioned{
  const data=resolve(dataDir),directory=join(data,"cliproxyapi"),auth=join(directory,"auth"),bin=join(directory,"bin");
  const sha256=options.sha256??PINNED_BINARY_SHA256,port=options.port??DEFAULT_PROXY_PORT;
  if(!exists(data)){mkdirSync(data,{recursive:true,mode:0o700});chmodSync(data,0o700);}
  for(const path of [directory,auth,bin])ensureDir(path);
  const binaryInstalled=placeBinary(bin,options.binarySource,sha256);
  const configPath=join(directory,"config.json"),connectionPath=join(directory,"connection.json");
  // Never overwrite an existing config or key; generate only when both are absent.
  if(!exists(configPath)&&!exists(connectionPath)){
    const apiKey=randomBytes(32).toString("base64url");
    const config={host:"127.0.0.1",port,"auth-dir":auth,"api-keys":[apiKey],"remote-management":{"allow-remote":false,"secret-key":"","disable-control-panel":true},plugins:{enabled:false},"quota-exceeded":{"switch-project":false,"switch-preview-model":false,"antigravity-credits":false},debug:false,"logging-to-file":false,"request-log":false,"commercial-mode":true,"usage-statistics-enabled":false,"request-retry":0,"max-retry-credentials":1,"ws-auth":true};
    writeFileSync(connectionPath,JSON.stringify({baseUrl:`http://127.0.0.1:${port}/v1`,apiKey}),{mode:0o600,flag:"wx"});
    writeFileSync(configPath,JSON.stringify(config),{mode:0o600,flag:"wx"});
  }
  const configured=exists(configPath)&&exists(connectionPath),authEntries=authEntryCount(auth);
  if(!binaryInstalled)return {state:"not_installed",reason:"CLIProxyAPI is not installed; Sigma provisioning did not find the pinned binary.",binaryInstalled,configured,authEntries};
  if(!authEntries)return {state:"needs_login",reason:"Sign in to Antigravity through the local proxy (no credentials found).",binaryInstalled,configured,authEntries};
  return {state:"ready",reason:"Local proxy deployment is provisioned.",binaryInstalled,configured,authEntries};
}

const ENABLED_FILE="enabled.json";
/** Opt-in flag for starting the private proxy. Read with O_NOFOLLOW; anything unexpected counts as "off". */
function readEnabledFlag(directory:string):boolean|undefined{
  let fd:number;
  try{fd=openSync(join(directory,ENABLED_FILE),constants.O_RDONLY|constants.O_NOFOLLOW);}catch{return undefined;}
  try{
    const info=fstatSync(fd);if(!info.isFile()||info.nlink!==1||(info.mode&0o077)!==0||info.size>1024)return false;
    const value=JSON.parse(readFileSync(fd,"utf8"));
    return !!value&&typeof value==="object"&&Object.keys(value).join(",")==="enabled"&&value.enabled===true;
  }catch{return false;}finally{closeSync(fd);}
}
/** Persist the opt-in flag atomically (temp file + rename, mode 0600) inside the private 0700 deployment directory. */
export function writeProxyEnabled(dataDir:string,enabled:boolean){
  const data=resolve(dataDir),directory=join(data,"cliproxyapi");
  if(!exists(data)){mkdirSync(data,{recursive:true,mode:0o700});chmodSync(data,0o700);}
  ensureDir(directory);
  const target=join(directory,ENABLED_FILE),temp=join(directory,`.${ENABLED_FILE}.${process.pid}.${randomBytes(4).toString("hex")}`);
  writeFileSync(temp,JSON.stringify({enabled}),{mode:0o600,flag:"wx"});chmodSync(temp,0o600);
  try{renameSync(temp,target);}catch(error){try{unlinkSync(temp);}catch{}throw error;}
}
/** Default off. Existing installs that already signed in (auth entries, no flag yet) are migrated to on. */
export function proxyEnabled(dataDir:string):boolean{
  const directory=join(resolve(dataDir),"cliproxyapi");
  const flag=readEnabledFlag(directory);
  if(flag!==undefined)return flag;
  if(authEntryCount(join(directory,"auth"))>0){try{writeProxyEnabled(dataDir,true);}catch{}return true;}
  return false;
}

function listenable(port:number){return new Promise<boolean>(done=>{const server=createServer();server.once("error",()=>done(false));server.listen(port,"127.0.0.1",()=>server.close(()=>done(true)));});}
/** First free loopback port at or above `from` (default 8320), else an OS-assigned one. */
export async function findFreeProxyPort(from=DEFAULT_PROXY_PORT+1,span=100){
  for(let port=from;port<from+span;port++)if(await listenable(port))return port;
  return new Promise<number>((resolve,reject)=>{const server=createServer();server.once("error",reject);server.listen(0,"127.0.0.1",()=>{const port=(server.address() as {port:number}).port;server.close(()=>resolve(port));});});
}
function rewritePrivate(path:string,update:(value:any)=>void){
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);let raw:Buffer;
  try{const info=fstatSync(fd);if(!info.isFile()||info.nlink!==1||(info.mode&0o077)!==0||info.size>65_536)throw new Error("Unsafe deployment file.");raw=readFileSync(fd);}finally{closeSync(fd);}
  const value=JSON.parse(raw.toString("utf8"));update(value);
  const temp=join(resolve(path,".."),`.${path.split("/").pop()}.${process.pid}.${randomBytes(4).toString("hex")}`);
  writeFileSync(temp,JSON.stringify(value),{mode:0o600,flag:"wx"});chmodSync(temp,0o600);
  return {temp,path};
}
/** Move this Sigma-owned deployment to another loopback port; apiKey and every other field stay unchanged. Both files are staged first, then renamed back to back. */
export function repointProxyPort(dataDir:string,port:number){
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error("Invalid proxy port.");
  const directory=join(resolve(dataDir),"cliproxyapi");
  const staged=[rewritePrivate(join(directory,"config.json"),value=>{value.port=port;}),rewritePrivate(join(directory,"connection.json"),value=>{value.baseUrl=`http://127.0.0.1:${port}/v1`;})];
  try{for(const item of staged)renameSync(item.temp,item.path);}
  catch(error){for(const item of staged)try{unlinkSync(item.temp);}catch{}throw error;}
}
