import { execFile } from "node:child_process";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
const exec=promisify(execFile);
export type MentionFile={path:string;kind:"file"|"dir"};
export type MentionSkill={name:string;description:string;file:string};
export type MentionTool={name:string;description:string};
export type MentionSources={cwd?:string;skills?:MentionSkill[];tools?:MentionTool[];deny?:string[]};
const MAX_FILES=20_000,CACHE_MS=10_000,FILE_BYTES=32*1024,DIR_ENTRIES=200,BLOCK_BYTES=100*1024,SKIP=new Set([".git","node_modules","dist","target"]);
const OPEN="<sigma-mentions>",CLOSE="</sigma-mentions>",MARK=`\n\n${OPEN}\n`;
const inside=(root:string,path:string)=>{const rel=relative(root,path);return rel===""||rel!==".."&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel);};
const canonical=async(path:string)=>realpath(path).catch(()=>path);
/** Deny roots that do not contain the folder itself, as paths relative to it ("" never matches). */
async function denyRels(cwd:string,deny:string[]){
  const real=await canonical(cwd),out:string[]=[];
  for(const root of deny)for(const candidate of new Set([root,await canonical(root)])){const rel=relative(real,candidate);if(rel&&rel!==".."&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel))out.push(rel.split(sep).join("/"));}
  return out;
}
const cache=new Map<string,{at:number;files:MentionFile[]}>();
async function gitFiles(cwd:string){
  const {stdout}=await exec("git",["ls-files","-co","--exclude-standard","-z"],{cwd,maxBuffer:64*1024*1024,timeout:8000,encoding:"utf8"});
  return stdout.split("\0").filter(Boolean);
}
async function walkFiles(cwd:string){
  const out:string[]=[],queue=[""];
  while(queue.length&&out.length<MAX_FILES){
    const rel=queue.shift()!,entries=await readdir(join(cwd,rel),{withFileTypes:true}).catch(()=>[]);
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
      if(SKIP.has(entry.name)||entry.isSymbolicLink())continue;
      const path=rel?`${rel}/${entry.name}`:entry.name;
      if(entry.isDirectory())queue.push(path);else if(entry.isFile()&&out.length<MAX_FILES)out.push(path);
    }
  }
  return out;
}
/** Project files and the folders that contain them, relative to cwd (Git-aware, cached for a few seconds). */
export async function listFiles(cwd:string,deny:string[]=[]):Promise<MentionFile[]>{
  const key=`${cwd}\0${deny.join("\0")}`,hit=cache.get(key);
  if(hit&&Date.now()-hit.at<CACHE_MS)return hit.files;
  let paths:string[];
  try{paths=await gitFiles(cwd);}catch{paths=await walkFiles(cwd);}
  const blocked=await denyRels(cwd,deny),dirs=new Set<string>(),files:MentionFile[]=[];
  for(const raw of paths.slice(0,MAX_FILES)){
    const path=raw.replace(/\/+$/,"");
    if(!path||blocked.some(root=>path===root||path.startsWith(`${root}/`)))continue;
    if(raw.endsWith("/")){dirs.add(path);continue;}
    files.push({path,kind:"file"});
    for(let dir=dirname(path);dir!=="."&&dir!=="/"&&!dirs.has(dir);dir=dirname(dir))dirs.add(dir);
  }
  const all=[...[...dirs].map((path):MentionFile=>({path,kind:"dir"})),...files].sort((a,b)=>a.path.localeCompare(b.path));
  if(cache.size>16)cache.clear();
  cache.set(key,{at:Date.now(),files:all});
  return all;
}
export function searchFiles(files:MentionFile[],query:string,limit=50):MentionFile[]{
  const q=query.toLowerCase().replace(/\/+$/,"");
  if(!q)return [...files].sort((a,b)=>a.path.split("/").length-b.path.split("/").length||a.path.localeCompare(b.path)).slice(0,limit);
  const ranked:Array<{file:MentionFile;rank:number}>=[];
  for(const file of files){
    const path=file.path.toLowerCase(),base=basename(path),rank=base.startsWith(q)?0:base.includes(q)?1:path.includes(q)?2:-1;
    if(rank>=0)ranked.push({file,rank});
  }
  return ranked.sort((a,b)=>a.rank-b.rank||a.file.path.length-b.file.path.length||a.file.path.localeCompare(b.file.path)).slice(0,limit).map(item=>item.file);
}
/** Minimal YAML frontmatter reader: scalar `key: value` lines plus folded or literal block values. */
export function parseFrontmatter(text:string):{meta:Record<string,string>;body:string}{
  const match=/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if(!match)return {meta:{},body:text};
  const meta:Record<string,string>={},lines=match[1].split(/\r?\n/);
  for(let i=0;i<lines.length;i++){
    const pair=/^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);if(!pair)continue;
    let value=pair[2].trim();
    if(/^[>|][+-]?$/.test(value)){const parts:string[]=[];while(i+1<lines.length&&/^\s+\S|^\s*$/.test(lines[i+1]))parts.push(lines[++i].trim());value=parts.filter(Boolean).join(" ");}
    else if(/^(["']).*\1$/.test(value))value=value.slice(1,-1);
    meta[pair[1]]=value;
  }
  return {meta,body:text.slice(match[0].length)};
}
const SKILL_NAME=/^[\w.-]+$/;
/** SKILL.md folders from the project, the user's home and extra directories; the first definition of a name wins. */
export async function listSkills(cwd:string|undefined,extra:string[]=[],home=homedir()):Promise<MentionSkill[]>{
  const roots=[...cwd?[".claude",".agents",".pi"].map(dir=>join(cwd,dir,"skills")):[],join(home,".claude","skills"),join(home,".agents","skills"),...extra],found=new Map<string,MentionSkill>();
  for(const root of roots){
    for(const entry of (await readdir(root).catch(()=>[] as string[])).sort()){
      const file=join(root,entry,"SKILL.md"),raw=await readFile(file,"utf8").catch(()=>null);
      if(raw===null)continue;
      const {meta}=parseFrontmatter(raw),name=meta.name&&SKILL_NAME.test(meta.name)?meta.name:entry;
      if(!SKILL_NAME.test(name)||found.has(name))continue;
      found.set(name,{name,description:(meta.description??"").replace(/\s+/g," ").slice(0,300),file});
    }
  }
  return [...found.values()];
}
export type MentionToken={raw:string;value:string};
/** `@path`, `@"path with spaces"`, `@skill:name`, `@tool:name`; the `@` must start the text or follow whitespace. */
export function parseMentions(text:string):MentionToken[]{
  const seen=new Set<string>(),out:MentionToken[]=[];
  for(const match of text.matchAll(/(?<!\S)@(?:"([^"\n]+)"|(\S+))/g)){
    const value=match[1]??match[2];
    if(!seen.has(value)){seen.add(value);out.push({raw:match[0],value});}
  }
  return out;
}
const escapeBlock=(text:string)=>text.replace(/<(\/?)sigma-mentions>/g,"<$1​sigma-mentions>");
const attr=(text:string)=>text.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;");
async function resolveFile(cwd:string,rootReal:string,deny:string[],value:string){
  const path=value.replace(/\/+$/,"");
  if(!path||path==="."||path.includes("\0")||isAbsolute(path)||/^[A-Za-z]:/.test(path)||path.split(/[\\/]/).includes(".."))return null;
  const real=await realpath(join(rootReal,path)).catch(()=>null);
  if(!real||!inside(rootReal,real))return null;
  for(const root of deny){if(inside(root,rootReal))continue;for(const candidate of new Set([root,await canonical(root)]))if(inside(candidate,real))return null;}
  const info=await stat(real).catch(()=>null);
  return info&&(info.isFile()||info.isDirectory())?{path,real,info}:null;
}
async function fileEntry(path:string,real:string,info:Stats){
  if(info.isDirectory()){
    const names=(await readdir(real,{withFileTypes:true}).catch(()=>[])).sort((a,b)=>a.name.localeCompare(b.name)),shown=names.slice(0,DIR_ENTRIES).map(entry=>entry.isDirectory()?`${entry.name}/`:entry.name);
    return `<folder path="${attr(path)}">\n${escapeBlock(shown.join("\n"))}${names.length>DIR_ENTRIES?`\n[${names.length-DIR_ENTRIES} more entries not listed]`:""}\n</folder>`;
  }
  if(info.size>FILE_BYTES)return `<file path="${attr(path)}" size="${info.size}">Large file (${Math.ceil(info.size/1024)} KB); not inlined. Read it with the file tools if needed.</file>`;
  const handle=await open(real,"r").catch(()=>null);
  if(!handle)return null;
  try{
    const buffer=Buffer.alloc(FILE_BYTES+1),{bytesRead}=await handle.read(buffer,0,buffer.length,0),data=buffer.subarray(0,bytesRead);
    if(bytesRead>FILE_BYTES)return `<file path="${attr(path)}">Large file; not inlined. Read it with the file tools if needed.</file>`;
    if(data.subarray(0,8192).includes(0))return `<file path="${attr(path)}" size="${info.size}">Binary file; not inlined. Read it with the file tools if needed.</file>`;
    return `<file path="${attr(path)}">\n${escapeBlock(data.toString("utf8"))}\n</file>`;
  }finally{await handle.close();}
}
/** Appends the resolved @-mention context to a prompt; unresolved tokens stay plain text. */
export async function expandMentions(text:string,sources:MentionSources):Promise<string>{
  const tokens=parseMentions(text);
  if(!tokens.length)return text;
  const rootReal=sources.cwd?await realpath(sources.cwd).catch(()=>null):null,deny=sources.deny??[],entries:string[]=[],seenFiles=new Set<string>(),seenOther=new Set<string>();
  for(const {value} of tokens){
    const trimmed=value.replace(/[.,;:!?)\]}'"]+$/,"");
    for(const candidate of new Set([value,trimmed])){
      if(!candidate)continue;
      const skill=candidate.startsWith("skill:")?sources.skills?.find(item=>item.name===candidate.slice(6)):undefined;
      if(skill){
        if(seenOther.has(`skill:${skill.name}`))break;
        const raw=await readFile(skill.file,"utf8").catch(()=>null);if(raw===null)continue;
        seenOther.add(`skill:${skill.name}`);
        entries.push(`<skill name="${attr(skill.name)}" path="${attr(skill.file)}">\n${escapeBlock(parseFrontmatter(raw).body.trim())}\n</skill>\nThe skill's base directory is ${dirname(skill.file)}; resolve relative paths in the skill against it and read them with the file tools.`);
        break;
      }
      const tool=candidate.startsWith("tool:")?sources.tools?.find(item=>item.name===candidate.slice(5)):undefined;
      if(tool){
        if(!seenOther.has(`tool:${tool.name}`)){seenOther.add(`tool:${tool.name}`);entries.push(`The user asks you to use the \`${tool.name}\` tool for this request.`);}
        break;
      }
      if(candidate.startsWith("skill:")||candidate.startsWith("tool:")||!rootReal)continue;
      const file=await resolveFile(sources.cwd!,rootReal,deny,candidate);
      if(!file)continue;
      if(!seenFiles.has(file.real)){
        seenFiles.add(file.real);
        const entry=await fileEntry(file.path,file.real,file.info);if(entry)entries.push(entry);
      }
      break;
    }
  }
  if(!entries.length)return text;
  let block=`${MARK}The user referenced these items with @-mentions in the message above:\n`;
  for(const entry of entries){
    const next=`${entry}\n`;
    if(Buffer.byteLength(block)+Buffer.byteLength(next)>BLOCK_BYTES-64){block+="[Further mentioned items omitted: mention context limit reached]\n";break;}
    block+=next;
  }
  return `${text}${block}${CLOSE}`;
}
/** Removes the trailing context block added by expandMentions, leaving what the user typed. */
export function stripMentionContext(text:string):string{
  if(!text.endsWith(CLOSE))return text;
  const at=text.lastIndexOf(MARK);
  return at<0?text:text.slice(0,at);
}
const queryKind=(query:string)=>query.startsWith("skill:")?"skill":query.startsWith("tool:")?"tool":"";
/** Picker results for a query; `skill:` and `tool:` prefixes narrow to that kind. */
export async function searchMentions(query:string,sources:MentionSources){
  const kind=queryKind(query),q=kind?query.slice(kind.length+1):query,needle=q.toLowerCase();
  const rank=(item:{name:string})=>item.name.toLowerCase().startsWith(needle)?0:1,pick=<T extends {name:string}>(items:T[])=>items.filter(item=>!needle||item.name.toLowerCase().includes(needle)).sort((a,b)=>rank(a)-rank(b));
  const files=!kind&&sources.cwd?searchFiles(await listFiles(sources.cwd,sources.deny).catch(()=>[]),q):[];
  const skills=kind==="tool"?[]:pick(sources.skills??[]).map(({name,description})=>({name,description}));
  const tools=kind==="skill"?[]:pick(sources.tools??[]);
  return {files,skills:skills.slice(0,50),tools:tools.slice(0,50)};
}
