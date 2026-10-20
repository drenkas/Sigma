import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

export type FailureReason="timeout"|"idle_timeout"|"cancelled"|"shutdown"|"rate_limit"|"authentication"|"provider_configuration"|"native_protocol"|"transport"|"provider_error"|"internal_error";
/** Never persist arbitrary exception text: provider/SDK errors can contain credentials or prompts. */
export function failureReason(error:unknown):FailureReason{
  let text:string;
  try{text=(typeof error==="string"?error:error instanceof Error&&typeof error.message==="string"?error.message:"").slice(0,8192);}catch{return "internal_error";}
  if(/sent nothing|idle.?timeout/i.test(text))return "idle_timeout";
  if(/timed? out|time limit|timeout|did not finish.*within/i.test(text))return "timeout";
  if(/cancel|interrupt|stopped|abort/i.test(text))return "cancelled";
  if(/shut.*down/i.test(text))return "shutdown";
  if(/rate.?limit|quota|credits|429/i.test(text))return "rate_limit";
  if(/unauthori|authenticat|401|403|sign.?in|login/i.test(text))return "authentication";
  if(/provider_configuration|model.*unavailable|configuration/i.test(text))return "provider_configuration";
  if(/native_protocol|safety contract|protocol/i.test(text))return "native_protocol";
  if(/transport|ECONN|ENOTFOUND|fetch failed|network|socket/i.test(text))return "transport";
  if(/provider failed|provider failure/i.test(text))return "provider_error";
  return "internal_error";
}
export type DiagnosticEvent="service_start"|"service_shutdown"|"service_error"|"process_fatal"|"http_error"|"agent_start"|"agent_end"|"agent_stop"|"agent_timeout"|"provider_error"|"delegation_error"|"review_error"|"prompt_error"|"tool_error"|"background_error";
export interface DiagnosticFields {sessionId?:string;rootId?:string;parentId?:string|null;runId?:string;role?:string;reason?:FailureReason;durationMs?:number;timeoutMs?:number;statusCode?:number;exitCode?:number;status?:"idle"|"running"|"settled"|"interrupted"|"error";tool?:string;}
const EVENTS=new Set<DiagnosticEvent>(["service_start","service_shutdown","service_error","process_fatal","http_error","agent_start","agent_end","agent_stop","agent_timeout","provider_error","delegation_error","review_error","prompt_error","tool_error","background_error"]);
const REASONS=new Set<FailureReason>(["timeout","idle_timeout","cancelled","shutdown","rate_limit","authentication","provider_configuration","native_protocol","transport","provider_error","internal_error"]);
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const ROLES=new Set(["root","coordinator","planner","researcher","worker","reviewer","qa"]);
const TOOLS=new Set(["read","ls","edit","write","bash","delegate","delegate_repo","git_commit","ask_user"]);
/** Small synchronous records also survive fatal process exits. No open handles or unbounded queues.
 * One server owns DATA_DIR under its lease. Keep the current file + two backups (6 MiB total).
 */
export class Diagnostics {
  private warned=false;
  constructor(private dataDir:string,private maxBytes=2*1024*1024){}
  write(event:DiagnosticEvent,fields:DiagnosticFields={}):void{
    try{
      if(!EVENTS.has(event))return;
      const record:Record<string,unknown>={at:new Date().toISOString(),pid:process.pid,event};
      for(const key of ["sessionId","rootId","parentId","runId"] as const){const value=fields[key];if(typeof value==="string"&&UUID.test(value))record[key]=value;}
      if(fields.role&&ROLES.has(fields.role))record.role=fields.role;
      if(fields.reason&&REASONS.has(fields.reason))record.reason=fields.reason;
      if(fields.tool&&TOOLS.has(fields.tool))record.tool=fields.tool;
      if(fields.status&&["idle","running","settled","interrupted","error"].includes(fields.status))record.status=fields.status;
      if(typeof fields.exitCode==="number"&&Number.isInteger(fields.exitCode)&&fields.exitCode>=-255&&fields.exitCode<=255)record.exitCode=fields.exitCode;
      for(const key of ["durationMs","timeoutMs","statusCode"] as const){const value=fields[key];if(typeof value==="number"&&Number.isSafeInteger(value)&&value>=0)record[key]=value;}
      const line=Buffer.from(JSON.stringify(record)+"\n");
      const root=realpathSync(this.dataDir),dir=join(root,"logs");
      try{mkdirSync(dir,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
      const directory=lstatSync(dir);
      if(!directory.isDirectory()||directory.isSymbolicLink()||realpathSync(dir)!==resolve(dir))throw new Error("Unsafe diagnostic directory");
      const dfd=openSync(dir,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{fchmodSync(dfd,0o700);}finally{closeSync(dfd);}
      const file=join(dir,"runtime.jsonl");
      // Inspect backups as well; never chmod or append through symlinks/hardlinks.
      for(const path of [file,file+".1",file+".2"]){try{const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw new Error("Unsafe diagnostic file");const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const opened=fstatSync(fd);if(!opened.isFile()||opened.nlink!==1||opened.ino!==info.ino||opened.dev!==info.dev)throw new Error("Diagnostic file changed");fchmodSync(fd,0o600);}finally{closeSync(fd);}}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
      try{if(lstatSync(file).size+line.length>this.maxBytes){try{renameSync(file+".1",file+".2");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}renameSync(file,file+".1");}}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
      const fd=openSync(file,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
      try{const info=fstatSync(fd);if(!info.isFile()||info.nlink!==1)throw new Error("Unsafe diagnostic file");fchmodSync(fd,0o600);writeSync(fd,line);}finally{closeSync(fd);}
    }catch{
      // Sink failures must never hide the original failure or leak filesystem/error contents.
      if(!this.warned){this.warned=true;try{process.stderr.write("Sigma diagnostic log unavailable. Check DATA_DIR/logs permissions and free space.\n");}catch{}}
    }
  }
}
/** Observe, do not install an uncaughtException handler that would keep a corrupt process alive. */
export function observeFatalErrors(log:Diagnostics):()=>void{
  const listener=(error:Error)=>log.write("process_fatal",{reason:failureReason(error)});
  process.on("uncaughtExceptionMonitor",listener);
  return ()=>process.off("uncaughtExceptionMonitor",listener);
}
