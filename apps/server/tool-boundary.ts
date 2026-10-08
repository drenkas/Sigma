import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createLsToolDefinition, createReadToolDefinition, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export function sensitivePath(path:string){return /(^|\/)(\.git(?:\/|$)|\.hg(?:\/|$)|\.svn(?:\/|$)|node_modules(?:\/|$)|\.pi-edit-[^/]*|\.env[^/]*|\.ssh(?:\/|$)|\.aws(?:\/|$))|auth\.json|credentials|private[_-]?key|\.(pem|key|p12|pfx)$/i.test(path);}
const inside=(root:string,path:string)=>{const rel=relative(root,path);return rel===""||rel!==".."&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel);};
function canonicalCandidate(path:string):string{
  let at=resolve(path);const suffix:string[]=[];
  while(true){try{return join(realpathSync(at),...suffix);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;suffix.unshift(at.slice(dirname(at).length+1));const parent=dirname(at);if(parent===at)throw error;at=parent;}}
}
export function credentialGuard(roots:string[]){
  const protectedRoots=[...new Set(roots.flatMap(root=>[resolve(root),canonicalCandidate(root)]))];
  return (path:string)=>{
    const targets=[resolve(path),canonicalCandidate(path)];
    // Re-resolve roots as well: a protected directory may have been replaced by an alias.
    if(protectedRoots.some(root=>[root,canonicalCandidate(root)].some(at=>targets.some(target=>inside(at,target)))))throw new Error("Application credential files are unavailable to workspace tools");
  };
}
export type PathGuard=(path:string)=>void;
type Identity={path:string;dev:number;ino:number;mode:number;nlink:number};
export type CheckedPath={target:string;rel:string;chain:Identity[];info?:Stats};
const identity=(path:string,info:Stats):Identity=>({path,dev:info.dev,ino:info.ino,mode:info.mode,nlink:info.isFile()?info.nlink:0});
const same=(a:Identity,b:Identity)=>a.path===b.path&&a.dev===b.dev&&a.ino===b.ino&&a.mode===b.mode&&a.nlink===b.nlink;
export function checkWorkspacePath(cwd:string,path:string,guard:PathGuard=()=>{},missing=false):CheckedPath{
  if(realpathSync(cwd)!==cwd)throw new Error("Workspace location changed");
  const target=resolve(cwd,path),rel=relative(cwd,target);
  if(!inside(cwd,target)||sensitivePath(rel)||/[\x00-\x1f\x7f]/.test(rel))throw new Error("Path outside workspace or sensitive");
  guard(target);const chain:Identity[]=[];let info:Stats|undefined;
  let at=cwd;
  for(const part of ["",...rel.split(sep).filter(Boolean)]){
    at=join(at,part);
    try{info=lstatSync(at);}catch(error){if(missing&&(error as NodeJS.ErrnoException).code==="ENOENT"){info=undefined;continue;}throw error;}
    if(info.isSymbolicLink()||!info.isFile()&&!info.isDirectory()||info.isFile()&&info.nlink!==1)throw new Error("Symlinks, hardlinks and special files are unavailable to workspace tools");
    chain.push(identity(at,info));
  }
  return {target,rel,chain,info};
}
export function recheckWorkspacePath(cwd:string,checked:CheckedPath,guard:PathGuard=()=>{},missing=false){
  const current=checkWorkspacePath(cwd,checked.target,guard,missing);
  if(current.chain.length!==checked.chain.length||current.chain.some((item,index)=>!same(item,checked.chain[index])))throw new Error("Path changed since approval; request a new decision");
  return current;
}
export function readCheckedFile(cwd:string,checked:CheckedPath,guard:PathGuard=()=>{},maxBytes?:number){
  recheckWorkspacePath(cwd,checked,guard);
  const fd=openSync(checked.target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const info=fstatSync(fd),expected=checked.chain.at(-1)!;
    if(!info.isFile()||info.nlink!==1||!same(identity(checked.target,info),expected)||maxBytes!==undefined&&info.size>maxBytes)throw new Error("Read target identity or type changed");
    recheckWorkspacePath(cwd,checked,guard);
    // The SDK receives only bytes read from this checked descriptor, never a reopened path.
    const bytes=readFileSync(fd);
    if(fstatSync(fd).nlink!==1)throw new Error("Read target link policy changed");
    recheckWorkspacePath(cwd,checked,guard);return {bytes,mode:info.mode&0o777};
  }finally{closeSync(fd);}
}

// The pinned SDK's buffer detector preserves its PNG/APNG/BMP behavior without
// invoking its public file detector, which would reopen an unvalidated path.
const {detectSupportedImageMimeType}=await import(new URL("utils/mime.js",import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {detectSupportedImageMimeType:(buffer:Buffer)=>string|null};
export function inspectionTools(cwd:string,guard:PathGuard,approve:(tool:string,preview:string)=>Promise<unknown>,stopped:()=>boolean):ToolDefinition<any>[]{
  return ["read","ls"].map(tool=>{
    const definition=tool==="read"?defineTool(createReadToolDefinition(cwd)):defineTool(createLsToolDefinition(cwd));
    return {...definition,execute:async(...args:Parameters<typeof definition.execute>)=>{
      const check=()=>{if(args[2]?.aborted||stopped())throw new Error("Agent stopped");};
      let checked:CheckedPath,bytes:Buffer|undefined;
      const allow=async(path:string)=>{
        check();checked=checkWorkspacePath(cwd,path,guard);
        if(tool==="read"?!checked.info?.isFile():!checked.info?.isDirectory())throw new Error("Tool path type not allowed");
        if(!await approve(tool,`${tool} ${checked.rel||"."}`))throw new Error("Tool denied or approval unavailable");
        check();recheckWorkspacePath(cwd,checked,guard);
      };
      const read=(path:string)=>{check();if(path!==checked.target)throw new Error("Read path changed");return bytes??=readCheckedFile(cwd,checked,guard).bytes;};
      const entryInfo=new Map<string,{isDirectory:()=>boolean}>();
      const guarded=tool==="read"?defineTool(createReadToolDefinition(cwd,{operations:{access:allow,readFile:async path=>read(path),detectImageMimeType:async path=>detectSupportedImageMimeType(read(path).subarray(0,4100))}})):defineTool(createLsToolDefinition(cwd,{operations:{
        exists:async path=>{await allow(path);return true;},
        stat:path=>{check();if(path===checked.target){recheckWorkspacePath(cwd,checked,guard);return checked.info!;}const info=entryInfo.get(path);if(!info)throw new Error("Entry unavailable");return info;},
        readdir:path=>{
          check();recheckWorkspacePath(cwd,checked,guard);const dir=opendirSync(path);const names:string[]=[];
          try{
            recheckWorkspacePath(cwd,checked,guard);
            for(let entry=dir.readSync();entry;entry=dir.readSync()){
              const target=join(path,entry.name);
              try{const child=checkWorkspacePath(cwd,target,guard);entryInfo.set(target,child.info!);names.push(entry.name);}catch{/* Omit sensitive, linked and unavailable entries. */}
            }
            recheckWorkspacePath(cwd,checked,guard);return names;
          }finally{dir.closeSync();}
        },
      }}));
      const result=await guarded.execute(...args as Parameters<typeof guarded.execute>);
      check();recheckWorkspacePath(cwd,checked!,guard);return result;
    }};
  });
}
