import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec=promisify(execFile);
// User-initiated Git commands keep the user's own identity, remotes and credential helpers,
// but never run repository hooks: agents can edit hook scripts such as .husky/* in the working tree.
const env=()=>({...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("GIT_"))),GIT_TERMINAL_PROMPT:"0",GIT_OPTIONAL_LOCKS:"0",LC_ALL:"C"});
async function run(cwd:string,args:string[],timeout=15_000,indexFile?:string){
  try{
    const {stdout}=await exec("git",["--no-pager","-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false",...args],{cwd,env:{...env(),...(indexFile?{GIT_INDEX_FILE:indexFile}:{})},encoding:"utf8",timeout,maxBuffer:4*1024*1024});
    return stdout;
  }catch(error){
    const failure=error as {stderr?:string;killed?:boolean;message?:string};
    if(failure.killed)throw new Error(`git ${args[0]} timed out`);
    const detail=(failure.stderr||failure.message||"").trim().split("\n").filter(line=>line&&!line.startsWith("hint:")).slice(-3).join(" ");
    throw new Error(`git ${args[0]} failed${detail?`: ${detail}`:""}`);
  }
}

export async function gitHead(cwd:string){return (await run(cwd,["rev-parse","--verify","HEAD^{commit}"])).trim();}
export async function gitBranches(cwd:string){
  return (await run(cwd,["for-each-ref","--format=%(refname:short)","refs/heads"])).split("\n").filter(Boolean).slice(0,200);
}
async function currentBranch(cwd:string){
  const name=(await run(cwd,["symbolic-ref","--quiet","--short","HEAD"]).catch(()=>"")).trim();
  if(!name)throw new Error("HEAD is detached; switch to a branch first");
  return name;
}
export async function gitSwitch(cwd:string,branch:unknown){
  if(typeof branch!=="string"||!branch||branch.startsWith("-")||!(await gitBranches(cwd)).includes(branch))throw new Error("Choose an existing local branch");
  await run(cwd,["switch",branch]);
}
export async function gitPull(cwd:string){
  await currentBranch(cwd);
  return (await run(cwd,["pull","--ff-only","--no-rebase"],60_000)).trim();
}
// Push arguments only; the push itself runs through the supervised Git intent path (git-intents.ts dispatchGit).
export async function pushArgs(cwd:string){
  const branch=await currentBranch(cwd);
  const upstream=(await run(cwd,["rev-parse","--abbrev-ref","--symbolic-full-name","@{upstream}"]).catch(()=>"")).trim();
  if(upstream)return ["push"];
  if(!(await run(cwd,["remote"])).split("\n").includes("origin"))throw new Error("No upstream branch and no origin remote to push to");
  return ["push","--set-upstream","origin",`refs/heads/${branch}:refs/heads/${branch}`];
}
export type GitStash={ref:string;oid:string;subject:string;at:number};
export async function gitStashes(cwd:string):Promise<GitStash[]>{
  return (await run(cwd,["stash","list","--format=%gd%x1f%H%x1f%ct%x1f%gs"])).split("\n").filter(Boolean).slice(0,50).map(line=>{const [ref,oid,at,subject]=line.split("\x1f");return {ref,oid,subject:subject??"",at:Number(at)*1000};});
}
// Stash arguments only; like push, the stash runs through the supervised Git intent path. Apply, pop and drop name the stash by ref and commit so a list that changed meanwhile is refused.
export async function stashArgs(cwd:string,body:{op?:unknown;ref?:unknown;oid?:unknown;message?:unknown}){
  if(body.op==="save"){
    const message=typeof body.message==="string"?body.message.trim():"";
    if(message.length>200||/[\x00-\x1f]/.test(message))throw new Error("Stash message must be one line of up to 200 characters");
    return ["stash","push","--include-untracked",...(message?["--message",message]:[])];
  }
  if(body.op!=="apply"&&body.op!=="pop"&&body.op!=="drop")throw new Error("Unknown stash action");
  const stash=(await gitStashes(cwd)).find(item=>item.ref===body.ref&&item.oid===body.oid);
  if(!stash)throw new Error("The stash list changed; refresh and try again");
  return ["stash",body.op,stash.ref];
}
export type GitWorktree={path:string;head:string|null;branch:string|null;detached:boolean;bare:boolean;locked:boolean;prunable:boolean};
export async function gitWorktrees(cwd:string):Promise<GitWorktree[]>{
  const list:GitWorktree[]=[];
  for(const block of (await run(cwd,["worktree","list","--porcelain"])).split("\n\n")){
    const lines=block.split("\n").filter(Boolean),field=(name:string)=>lines.find(line=>line===name||line.startsWith(`${name} `));
    const path=field("worktree")?.slice(9);if(!path)continue;
    list.push({path,head:field("HEAD")?.slice(5)??null,branch:field("branch")?.slice(7).replace(/^refs\/heads\//,"")??null,detached:!!field("detached"),bare:!!field("bare"),locked:!!field("locked"),prunable:!!field("prunable")});
  }
  return list.slice(0,100);
}
export function commitMessage(input:unknown){
  if(typeof input!=="string")throw new Error("Commit message required");
  const message=input.replace(/\r\n/g,"\n").trim();
  if(!message||message.length>4000||/[\x00]/.test(message))throw new Error("Commit message must be 1–4000 characters");
  return message;
}
