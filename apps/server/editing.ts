import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createEditToolDefinition, createWriteToolDefinition, generateUnifiedPatch, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runSupervised } from "./git-intents.js";
import { checkWorkspacePath, readCheckedFile, recheckWorkspacePath, sensitivePath, type PathGuard } from "./tool-boundary.js";
export { sensitivePath } from "./tool-boundary.js";
import type { ChangesView, CodeWorkspace, FileChange, WorkspaceMode, WorkspaceSetup, WriteOutcome } from "../../packages/contracts/index.js";

const exec=promisify(execFile);
const gitEnv={PATH:process.env.PATH,HOME:process.env.HOME,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_TERMINAL_PROMPT:"0",GIT_OPTIONAL_LOCKS:"0",GIT_NO_LAZY_FETCH:"1",LC_ALL:"C"};
export async function git(cwd:string,args:string[],maxBuffer=2*1024*1024){
  const {stdout}=await exec("git",["--no-pager","-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","-c","submodule.recurse=false","-c","protocol.allow=never","-c","protocol.file.allow=always",...args],{cwd,env:gitEnv,encoding:"utf8",timeout:120_000,maxBuffer});
  return stdout;
}
const gitOptions=["--no-pager","-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","-c","submodule.recurse=false","-c","protocol.allow=never","-c","protocol.file.allow=always"];
// Mutating allocation commands: supervised process group, cancelled by Stop/Quit, reaped when the server dies.
export const gitSupervised=(cwd:string,args:string[],check:()=>void)=>runSupervised(cwd,[...gitOptions,...args],gitEnv as Record<string,string|undefined>,check);
export async function describeGitRoot(path:string,baseCommit?:string){
  const sourceCwd=await realpath(resolve(path));if(!(await stat(sourceCwd)).isDirectory())throw new Error("Workspace must be a directory");
  const root=await realpath(resolve(sourceCwd,(await git(sourceCwd,["rev-parse","--show-toplevel"])).trim()));if(root!==sourceCwd)throw new Error("Code mode requires the repository root directory");
  const head=(await git(sourceCwd,["rev-parse","--verify","HEAD^{commit}"])).trim();
  const commit=baseCommit??head;if(!/^[0-9a-f]{40,64}$/.test(commit)||(await git(sourceCwd,["cat-file","-t",commit])).trim()!=="commit")throw new Error("Code base commit is unavailable");
  const gitDir=await realpath(resolve(sourceCwd,(await git(sourceCwd,["rev-parse","--git-dir"])).trim()));
  const commonDir=await realpath(resolve(sourceCwd,(await git(sourceCwd,["rev-parse","--git-common-dir"])).trim()));
  const rootInfo=statSync(sourceCwd),gitInfo=statSync(gitDir),identity=statSync(commonDir),baseline=createHash("sha256");
  baseline.update(await git(sourceCwd,["status","--porcelain=v2","-z","--untracked-files=all"]));
  const changed=(await git(sourceCwd,["diff","--no-ext-diff","--no-textconv","--no-renames","--name-only","-z","HEAD"])).split("\0");
  const staged=(await git(sourceCwd,["diff","--no-ext-diff","--no-textconv","--no-renames","--cached","--name-only","-z","HEAD"])).split("\0");
  const untracked=(await git(sourceCwd,["ls-files","--others","--exclude-standard","-z"])).split("\0");
  const paths=[...new Set([...changed,...staged,...untracked].filter(Boolean))].sort();
  for(const path of paths){const target=resolve(sourceCwd,path),rel=relative(sourceCwd,target);if(!rel||rel===".."||rel.startsWith(`..${sep}`))throw new Error("Changed source path escaped the repository");baseline.update(path).update("\0");if(sensitivePath(path)){baseline.update("sensitive-path");continue;}try{const info=lstatSync(target);baseline.update(`${info.mode}\0${info.size}\0`);if(info.isSymbolicLink())baseline.update(readlinkSync(target));else if(info.isFile())baseline.update(readFileSync(target));else baseline.update("non-file");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;baseline.update("missing");}}
  return {sourceCwd,sourceDev:rootInfo.dev,sourceIno:rootInfo.ino,sourceBaseline:baseline.digest("hex"),gitDir,gitDev:gitInfo.dev,gitIno:gitInfo.ino,commonDir,commonDev:identity.dev,commonIno:identity.ino,head,baseCommit:commit};
}
export function worktreeRecords(value:string){
  const records:Array<{path?:string;head?:string;locked?:boolean}> = [];let row:Record<string,string|boolean>={};
  for(const field of value.split("\0")){
    if(!field){if(Object.keys(row).length){records.push(row as typeof records[number]);row={};}continue;}
    const at=field.indexOf(" "),key=at<0?field:field.slice(0,at),data=at<0?true:field.slice(at+1);
    if(key==="worktree")row.path=data;else if(key==="HEAD")row.head=data;else if(key==="locked")row.locked=true;
  }
  if(Object.keys(row).length)records.push(row as typeof records[number]);return records;
}
export async function inspectWorkspaceSetup(setup:WorkspaceSetup):Promise<{cwdExists:boolean;registered:boolean;head:string|null;workspaceGitDir:string|null;reason?:string}>{
  if(!setup.sourceCwd||!setup.gitDir||!setup.commonDir||setup.sourceDev===undefined||setup.sourceIno===undefined||setup.gitDev===undefined||setup.gitIno===undefined||setup.commonDev===undefined||setup.commonIno===undefined||!setup.baseCommit)return {cwdExists:false,registered:false,head:null,workspaceGitDir:null,reason:"Descriptor lacks Git ownership identity"};
  try{
    if(await realpath(setup.sourceCwd)!==setup.sourceCwd)return {cwdExists:false,registered:false,head:null,workspaceGitDir:null,reason:"Source path changed"};
    const source=await describeGitRoot(setup.sourceCwd,setup.baseCommit);
    if(source.sourceDev!==setup.sourceDev||source.sourceIno!==setup.sourceIno||source.gitDir!==setup.gitDir||source.gitDev!==setup.gitDev||source.gitIno!==setup.gitIno||source.commonDir!==setup.commonDir||source.commonDev!==setup.commonDev||source.commonIno!==setup.commonIno)return {cwdExists:false,registered:false,head:source.head,workspaceGitDir:null,reason:"Source Git identity changed"};
    if(setup.sourceHead&&source.head!==setup.sourceHead)return {cwdExists:false,registered:false,head:source.head,workspaceGitDir:null,reason:"Source HEAD changed since setup was frozen"};
    if(setup.inPlace){try{if(!lstatSync(setup.cwd).isDirectory())throw new Error("not a directory");}catch{return {cwdExists:false,registered:false,head:source.head,workspaceGitDir:null,reason:"Saved in-place working directory is unavailable"};}return {cwdExists:true,registered:true,head:source.head,workspaceGitDir:source.gitDir};}
    if(setup.workspaceMode!=="worktree"){const reason=source.head!==setup.baseCommit?"Direct source HEAD differs from saved base":setup.sourceBaseline&&!["dispatching","ready"].includes(setup.phase)&&source.sourceBaseline!==setup.sourceBaseline?"Direct source contents changed since setup was frozen":undefined;return {cwdExists:true,registered:true,head:source.head,workspaceGitDir:source.gitDir,...(reason?{reason}:{})};}
    if(setup.phase==="reserved"){
      const records=worktreeRecords(await git(setup.sourceCwd,["worktree","list","--porcelain","-z"]));
      try{lstatSync(setup.cwd);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT"&&!records.some(row=>row.path===setup.cwd))return {cwdExists:false,registered:false,head:null,workspaceGitDir:null};throw error;}
      return {cwdExists:true,registered:records.some(row=>row.path===setup.cwd),head:null,workspaceGitDir:null,reason:"Reserved workspace path already exists without allocation proof"};
    }
    const expected=await realpath(setup.cwd);if(expected!==setup.cwd)return {cwdExists:false,registered:false,head:null,workspaceGitDir:null,reason:"Workspace path resolves elsewhere"};
    const root=await realpath((await git(expected,["rev-parse","--show-toplevel"])).trim());
    const gitDir=await realpath(resolve(expected,(await git(expected,["rev-parse","--git-dir"])).trim()));
    const commonDir=await realpath(resolve(expected,(await git(expected,["rev-parse","--git-common-dir"])).trim()));
    const head=(await git(expected,["rev-parse","--verify","HEAD^{commit}"])).trim();
    const matching=worktreeRecords(await git(setup.sourceCwd,["worktree","list","--porcelain","-z"])).filter(item=>item.path===expected&&item.head===head);
    const workspaceInfo=statSync(expected),workspaceGitInfo=statSync(gitDir);
    if(root!==expected||workspaceInfo.dev!==setup.workspaceDev||workspaceInfo.ino!==setup.workspaceIno||commonDir!==setup.commonDir||matching.length!==1||head!==setup.baseCommit||setup.workspaceGitDir&&gitDir!==setup.workspaceGitDir||workspaceGitInfo.dev!==setup.workspaceGitDev||workspaceGitInfo.ino!==setup.workspaceGitIno)return {cwdExists:true,registered:matching.length===1,head,workspaceGitDir:gitDir,reason:"Git worktree path, common directory, registration or HEAD differs from descriptor"};
    if(["reserved","allocating","allocated"].includes(setup.phase)&&(await git(expected,["status","--porcelain=v2","-z","--untracked-files=all"])))return {cwdExists:true,registered:true,head,workspaceGitDir:gitDir,reason:"Unopened worktree differs from its saved base tree; inspect-only recovery"};
    return {cwdExists:true,registered:true,head,workspaceGitDir:gitDir};
  }catch(error){return {cwdExists:false,registered:false,head:null,workspaceGitDir:null,reason:error instanceof Error?error.message:"Cannot inspect saved Git identity"};}
}
export async function createCodeWorkspace(source:string,dataDir:string,id:string,commit?:string,kind:WorkspaceMode="direct",check:()=>void=()=>{}):Promise<{cwd:string;workspace:CodeWorkspace}>{
  const identity=await describeGitRoot(source,commit),{sourceCwd,baseCommit}=identity;
  check();if(kind==="direct"){
    if((await git(sourceCwd,["rev-parse","--verify","HEAD^{commit}"])).trim()!==baseCommit)throw new Error("Source HEAD changed before direct Code session creation");
    check();return {cwd:sourceCwd,workspace:{sourceCwd,baseCommit,kind}};
  }
  const workspaces=join(await realpath(dataDir),"workspaces");check();await mkdir(workspaces,{recursive:true,mode:0o700});if(await realpath(workspaces)!==workspaces)throw new Error("Workspace directory resolves outside the application data directory");
  check();const cwd=join(workspaces,id);
  try{
    check();await gitSupervised(sourceCwd,["worktree","add","--detach","--no-checkout",cwd,baseCommit],check);
    check();await gitSupervised(cwd,["checkout","--detach",baseCommit],check);
  }catch{throw new Error("Cannot create Git worktree. Check repository access; any partial worktree is retained in .data/workspaces.");}
  return {cwd:await realpath(cwd),workspace:{sourceCwd,baseCommit,kind}};
}

export async function assertWorkspaceHead(cwd:string,workspace:CodeWorkspace){
  if(!workspace.kind)return; // Sessions saved before workspace modes used independent clones.
  const root=await realpath((await git(cwd,["rev-parse","--show-toplevel"])).trim());
  if(root!==cwd||(await git(cwd,["rev-parse","--verify","HEAD^{commit}"])).trim()!==workspace.baseCommit)throw new Error("Workspace HEAD changed since Code session creation");
}
export function assertNotIgnored(cwd:string,path:string){
  const result=spawnSync("git",["--no-pager","-c","core.fsmonitor=false","check-ignore","-q","-z","--stdin"],{cwd,env:gitEnv,input:`${path}\0`,timeout:10_000,encoding:"utf8"});
  if(result.status===1)return;
  if(result.status===0)throw new Error(`Git-ignored path cannot be edited in a direct workspace: ${path}`);
  throw new Error("Cannot inspect Git ignore rules");
}

const limit=128*1024;
const hash=(value:Buffer|null)=>value===null?"missing":createHash("sha256").update(value).digest("hex");
function text(value:Buffer){if(value.length>limit||value.includes(0))throw new Error("Only UTF-8 text files up to 128 KiB can be edited");try{return new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(value);}catch{throw new Error("Only UTF-8 text files can be edited");}}
function location(cwd:string,path:string,guard:PathGuard=()=>{}){
  const checked=checkWorkspacePath(cwd,path,guard,true);
  if(!checked.rel)throw new Error("Path outside workspace or sensitive");
  return {target:checked.target,rel:checked.rel};
}
function snapshot(cwd:string,path:string,guard:PathGuard=()=>{}){
  const checked=checkWorkspacePath(cwd,path,guard,true),{target,rel}=checked;
  if(!rel)throw new Error("Path outside workspace or sensitive");
  if(!checked.info)return {target,rel,bytes:null,mode:0o644};
  const {bytes,mode}=readCheckedFile(cwd,checked,guard,limit);text(bytes);return {target,rel,bytes,mode};
}
export function readCodeInput(cwd:string,path:string){
  const value=snapshot(cwd,path);
  if(!value.bytes)throw new Error(`Input file unavailable: ${path}`);
  return {path:value.rel,bytes:value.bytes,hash:hash(value.bytes),mode:value.mode};
}
export function inspectCodePath(cwd:string,path:string){
  const value=snapshot(cwd,path);
  return {path:value.rel,target:value.target,bytes:value.bytes,hash:hash(value.bytes),mode:value.mode};
}
export function codeRevision(baseCommit:string,diff:string){return createHash("sha256").update(baseCommit).update("\0").update(diff).digest("hex");}
export function codePatch(path:string,before:Buffer|null,after:Buffer|null){
  let diff=generateUnifiedPatch(path,before?text(before):"",after?text(after):"");
  diff=diff.replace(/^--- .*$/m,()=>`--- ${before===null?"/dev/null":JSON.stringify(`a/${path}`)}\t`);
  diff=diff.replace(/^\+\+\+ .*$/m,()=>`+++ ${after===null?"/dev/null":JSON.stringify(`b/${path}`)}\t`);
  return `${before===null?`diff --git ${JSON.stringify(`a/${path}`)} ${JSON.stringify(`b/${path}`)}\nnew file mode 100644\n`:after===null?`diff --git ${JSON.stringify(`a/${path}`)} ${JSON.stringify(`b/${path}`)}\ndeleted file mode 100644\n`:""}${diff}`;
}
export async function codeBaseFile(cwd:string,commit:string,path:string){
  const entry=await git(cwd,["ls-tree","-z",commit,"--",`:(literal)${path}`]);
  if(!entry)return {bytes:null,mode:null};
  const match=/^(100644|100755) blob ([0-9a-f]{40,64})\t/.exec(entry);
  if(!match||!entry.endsWith("\0"))throw new Error(`Unsupported base file: ${path}`);
  const {stdout}=await exec("git",["--no-pager","cat-file","blob",match[2]],{cwd,env:gitEnv,encoding:"buffer",timeout:120_000,maxBuffer:limit+4096});
  text(stdout);
  return {bytes:stdout,mode:match[1]==="100755"?0o755:0o644};
}
type Approve=(tool:string,change:FileChange,toolCallId:string)=>Promise<string|null>;
type Outcome=(id:string,outcome:WriteOutcome)=>Promise<void>;
export function mutationTools(cwd:string,approve:Approve,outcome:Outcome,stopped:()=>boolean,applied:(toolCallId:string)=>void=()=>{},beforeMutation:(path:string,approvalId?:string)=>Promise<void>=async()=>{},protectPath:PathGuard=()=>{}):ToolDefinition<any>[]{
  return ["edit","write"].map(tool=>{
    const definition:ToolDefinition<any>=tool==="edit"?defineTool(createEditToolDefinition(cwd)):defineTool(createWriteToolDefinition(cwd));
    return {...definition,execute:async(...args:Parameters<typeof definition.execute>)=>{
      const signal=args[2];let original:ReturnType<typeof snapshot>|undefined;
      const check=()=>{if(signal?.aborted||stopped())throw new Error("Agent stopped");};
      const write=async(path:string,content:string)=>{
        check();protectPath(path);const before=original??snapshot(cwd,path,protectPath);await beforeMutation(before.rel);
        check();const after=Buffer.from(content,"utf8");text(after);
        if(before.bytes?.equals(after))return;
        const change:FileChange={path:before.rel,diff:codePatch(before.rel,before.bytes,after),beforeHash:hash(before.bytes),afterHash:hash(after),beforeMode:before.bytes===null?null:before.mode,afterMode:before.mode};
        if(Buffer.byteLength(change.diff)>256*1024)throw new Error("Change is too large to preview; use a smaller edit");
        const id=await approve(tool,change,args[0]);if(!id)throw new Error("Change denied or approval expired");
        check();await outcome(id,"applying");let temporary:string|undefined;
        try{
          await beforeMutation(change.path,id);protectPath(path);
          check();const now=snapshot(cwd,path,protectPath);
          if(hash(now.bytes)!==change.beforeHash)throw new Error("File changed since the preview; read it again and request a new edit");
          // No awaits between final validation and atomic replacement. Tools cannot interleave here.
          mkdirSync(dirname(now.target),{recursive:true});location(cwd,path,protectPath);
          const boundary=checkWorkspacePath(cwd,path,protectPath,true);
          const temporaryPath=join(dirname(now.target),`.pi-edit-${randomUUID()}`),fd=openSync(temporaryPath,"wx",now.mode);temporary=temporaryPath;
          try{
            protectPath(temporaryPath);const temp=lstatSync(temporaryPath),info=fstatSync(fd);
            if(!info.isFile()||info.nlink!==1||temp.isSymbolicLink()||info.dev!==temp.dev||info.ino!==temp.ino)throw new Error("Write target identity changed");
            recheckWorkspacePath(cwd,boundary,protectPath,true);writeFileSync(fd,after);fchmodSync(fd,now.mode);
            recheckWorkspacePath(cwd,boundary,protectPath,true);
          }finally{closeSync(fd);}
          renameSync(temporary,now.target);applied(args[0]);temporary=undefined;
        }catch(error){if(temporary)try{unlinkSync(temporary);}catch{}await outcome(id,"failed");throw error;}
        // A crash between replacement and this durable receipt remains unknown, never replayed.
        await outcome(id,"applied");
      };
      const guarded:ToolDefinition<any>=tool==="edit"?defineTool(createEditToolDefinition(cwd,{operations:{
        access:async path=>{check();protectPath(path);const value=snapshot(cwd,path,protectPath);if(!value.bytes)throw new Error("File unavailable");},
        readFile:async path=>{check();protectPath(path);original=snapshot(cwd,path,protectPath);if(!original.bytes)throw new Error("File unavailable");return original.bytes;},
        writeFile:write,
      }})):defineTool(createWriteToolDefinition(cwd,{operations:{mkdir:async()=>{},writeFile:write}}));
      return guarded.execute(...args as Parameters<typeof guarded.execute>);
    }};
  });
}

export async function workspaceChanges(cwd:string,workspace:CodeWorkspace):Promise<ChangesView>{
  await assertWorkspaceHead(cwd,workspace);
  const changed=await git(cwd,["-c","core.filemode=true","diff","--no-ext-diff","--no-textconv","--name-only","-z",workspace.baseCommit,"--"]);
  const added=await git(cwd,["ls-files","--others",...(workspace.kind==="direct"?["--exclude-standard"]:[]),"-z"]);
  const newFiles=new Set(added.split("\0"));
  const paths=[...new Set((changed+added).split("\0").filter(Boolean))];
  const visible=paths.filter(path=>!sensitivePath(path));
  if(visible.length>200)throw new Error("Too many changed files to preview (limit 200)");
  const files:string[]=[];let diff="",omitted=paths.length-visible.length;
  for(const path of visible){
    let after:ReturnType<typeof snapshot>;try{after=snapshot(cwd,path);}catch{omitted++;continue;}
    let before:Buffer|null=null,baseMode="100644";
    // ls-files distinguishes a new file from a failure to read a tracked Git object.
    if(!newFiles.has(path)){
      try{
        baseMode=(await git(cwd,["ls-tree","-z",workspace.baseCommit,"--",`:(literal)${path}`])).slice(0,6);
        if(baseMode!=="100644"&&baseMode!=="100755")throw new Error("Unsupported Git file mode");
        const result=await exec("git",["--no-pager","show",`${workspace.baseCommit}:${path}`],{cwd,env:gitEnv,encoding:"buffer",timeout:10_000,maxBuffer:limit});before=result.stdout;
      }catch{omitted++;continue;}
    }
    if((after.bytes===null&&(newFiles.has(path)||baseMode==="100755"))||
       (after.bytes!==null&&Boolean(after.mode&0o111)!==(baseMode==="100755"))){omitted++;continue;}
    try{const delta=codePatch(path,before,after.bytes);diff+=delta;files.push(path);}catch{omitted++;}
    if(Buffer.byteLength(diff)>1024*1024)throw new Error("Diff exceeds 1 MiB; inspect the workspace directly");
  }
  await assertWorkspaceHead(cwd,workspace);
  return {cwd,...workspace,files,diff,omitted,revision:codeRevision(workspace.baseCommit,diff)};
}
