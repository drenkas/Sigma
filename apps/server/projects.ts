import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { FolderStatus, ProjectStatus, ProjectView } from "../../packages/contracts/index.js";

const exec=promisify(execFile);
const gitEnv={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("GIT_"))),GIT_OPTIONAL_LOCKS:"0",GIT_TERMINAL_PROMPT:"0",LC_ALL:"C"};
async function git(cwd:string,args:string[]){
  const {stdout}=await exec("git",["--no-pager","-c","core.fsmonitor=false",...args],{cwd,env:gitEnv,encoding:"utf8",timeout:8000,maxBuffer:8*1024*1024});
  return stdout;
}

export async function projectInput(input:unknown):Promise<Pick<ProjectView,"name"|"folders">>{
  const body=input as Partial<ProjectView>|null;
  if(typeof body?.name!=="string"||!body.name.trim()||body.name.trim().length>80||/[\x00-\x1f\x7f]/.test(body.name))throw new Error("Project name must be 1–80 characters");
  if(!Array.isArray(body.folders)||body.folders.length<1||body.folders.length>20)throw new Error("Choose 1–20 folders");
  const folders:string[]=[];
  for(const [index,folder] of body.folders.entries()){
    if(typeof folder!=="string"||folder.length>4096||!isAbsolute(folder)||/[\x00-\x1f\x7f]/.test(folder))throw new Error(`Folder ${index+1} must be an absolute directory path`);
    let canonical:string;
    try{canonical=await realpath(folder);if(!(await stat(canonical)).isDirectory())throw new Error();}
    catch{throw new Error(`Folder ${index+1} is unavailable or is not a directory`);}
    if(!folders.includes(canonical))folders.push(canonical);
  }
  return {name:body.name.trim(),folders};
}

export async function folderStatus(path:string):Promise<FolderStatus>{
  try{if(!(await stat(path)).isDirectory())return {path,state:"missing"};}
  catch{return {path,state:"missing"};}
  let repository:string;
  try{repository=(await git(path,["rev-parse","--show-toplevel"])).replace(/\n$/,"");}
  catch(error){
    const failure=error as {stderr?:string;code?:string};
    if(/not a git repository|must be run in a work tree/.test(failure.stderr??""))return {path,state:"folder"};
    return {path,state:"error",error:failure.code==="ENOENT"?"Git is not installed or not on PATH":"Cannot inspect Git (permissions, ownership or timeout)"};
  }
  try{
    const output=await git(repository,["status","--porcelain=v2","--branch","--ahead-behind","-z","--untracked-files=normal","--ignore-submodules=none"]);
    const result:FolderStatus={path,state:"git",repository,branch:null,oid:null,upstream:null,ahead:null,behind:null,staged:0,unstaged:0,untracked:0,conflicts:0};
    const entries=output.split("\0");
    for(let i=0;i<entries.length;i++){
      const entry=entries[i];
      if(entry.startsWith("# branch.head ")){const head=entry.slice(14);result.branch=head==="(detached)"?null:head;}
      else if(entry.startsWith("# branch.oid ")){const oid=entry.slice(13);result.oid=oid==="(initial)"?null:oid;}
      else if(entry.startsWith("# branch.upstream "))result.upstream=entry.slice(18);
      else if(entry.startsWith("# branch.ab ")){const match=entry.match(/^# branch\.ab \+(\d+) -(\d+)$/);if(match){result.ahead=Number(match[1]);result.behind=Number(match[2]);}}
      else if(entry.startsWith("? "))result.untracked!++;
      else if(entry.startsWith("u "))result.conflicts!++;
      else if(entry.startsWith("1 ")||entry.startsWith("2 ")){
        if(entry[2]!==".")result.staged!++;
        if(entry[3]!==".")result.unstaged!++;
        // -z renames have a second pathname, which may itself look like a header.
        if(entry[0]==="2")i++;
      }
    }
    return result;
  }catch{return {path,state:"error",error:"Git status unavailable (timeout, permissions or oversized result)"};}
}

export async function projectStatus(project:ProjectView):Promise<ProjectStatus>{
  const folders:FolderStatus[]=[];
  // ponytail: four Git processes per batch; add a shared queue if many clients poll concurrently.
  for(let i=0;i<project.folders.length;i+=4)folders.push(...await Promise.all(project.folders.slice(i,i+4).map(folderStatus)));
  return {id:project.id,checkedAt:Date.now(),folders};
}
