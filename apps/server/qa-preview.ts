import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, posix, sep } from "node:path";

export type PreviewManifestEntry={path:string;sha256:string;size:number};
export type Preview={origin:string;port:number;siteDir:string;manifest:PreviewManifestEntry[];manifestHash:string;requests:()=>number;paths:string[];close:()=>Promise<void>};
const types:Record<string,string>={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".json":"application/json",".svg":"image/svg+xml",".png":"image/png",".txt":"text/plain; charset=utf-8"};
const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");

/** Copy a fixture tree to <runDir>/site as read-only files and record a manifest. Symlinks/special files are rejected. */
export type Snapshot={siteDir:string;manifest:PreviewManifestEntry[];manifestHash:string;skipped:string[]};
/** `workspace` mode (a real Code workspace): skips sensitive/VCS paths, symlinks and special files instead of failing. */
export function snapshotSite(fixtureDir:string,runDir:string,options?:{workspace?:(relative:string)=>boolean}):Snapshot{
  const siteDir=join(runDir,"site"),manifest:PreviewManifestEntry[]=[],skipped:string[]=[];
  mkdirSync(siteDir,{recursive:true,mode:0o700});
  let total=0;
  const visit=(relative:string)=>{
    for(const entry of readdirSync(join(fixtureDir,relative),{withFileTypes:true})){
      const path=join(relative,entry.name),source=join(fixtureDir,path),stat=lstatSync(source);
      if(options?.workspace&&(options.workspace(path.split(sep).join("/"))||!stat.isDirectory()&&(!stat.isFile()||stat.nlink!==1||stat.size>8*1024*1024))){skipped.push(path.split(sep).join("/"));continue;}
      if(stat.isDirectory()){mkdirSync(join(siteDir,path),{recursive:true,mode:0o700});visit(path);continue;}
      if(!stat.isFile()||stat.nlink!==1||stat.size>8*1024*1024)throw new Error("Preview fixture has linked, special or oversized files");
      total+=stat.size;if(total>64*1024*1024||manifest.length>=2000)throw new Error("Preview fixture exceeds limits");
      const bytes=readFileSync(source),target=join(siteDir,path);
      writeFileSync(target,bytes,{mode:0o444,flag:"wx"});chmodSync(target,0o444);
      manifest.push({path:path.split(sep).join("/"),sha256:sha(bytes),size:bytes.length});
    }
  };
  visit("");manifest.sort((a,b)=>a.path.localeCompare(b.path));
  return {siteDir,manifest,manifestHash:sha(Buffer.from(JSON.stringify(manifest))),skipped};
}

export const startPreview=(fixtureDir:string,runDir:string)=>servePreview(snapshotSite(fixtureDir,runDir));
/** Serve an already-snapshotted site (loopback, random port, Host check, per-read rehash). */
export async function servePreview({siteDir,manifest,manifestHash}:Snapshot):Promise<Preview>{
  const byPath=new Map(manifest.map(entry=>[entry.path,entry]));
  let count=0,port=0;const paths:string[]=[];
  const server:Server=createServer((request,response)=>{
    count++;paths.push(request.url??"");
    const fail=(status:number,message:string)=>{response.writeHead(status,{"Content-Type":"text/plain","X-Content-Type-Options":"nosniff","Cache-Control":"no-store"});response.end(message);};
    if(request.headers.host!==`127.0.0.1:${port}`)return fail(421,"Bad host");
    if(request.method!=="GET"&&request.method!=="HEAD")return fail(405,"Method not allowed");
    let path:string;
    try{path=posix.normalize(decodeURIComponent(new URL(request.url??"/","http://x").pathname)).replace(/^\/+/,"");}catch{return fail(400,"Bad path");}
    if(path===""||path.endsWith("/"))path+="index.html";
    const entry=byPath.get(path);
    if(!entry)return fail(404,"Not in manifest");
    let fd=-1;
    try{
      fd=openSync(join(siteDir,path),constants.O_RDONLY|constants.O_NOFOLLOW);
      const stat=fstatSync(fd);
      if(!stat.isFile()||stat.size!==entry.size)return fail(409,"Preview file changed");
      const bytes=readFileSync(fd);
      if(sha(bytes)!==entry.sha256)return fail(409,"Preview file changed");
      response.writeHead(200,{"Content-Type":types[path.slice(path.lastIndexOf("."))]??"application/octet-stream","Content-Length":bytes.length,"X-Content-Type-Options":"nosniff","Cache-Control":"no-store"});
      response.end(request.method==="HEAD"?undefined:bytes);
    }catch{fail(409,"Preview file unreadable");}
    finally{if(fd>=0)try{closeSync(fd);}catch{}}
  });
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  port=(server.address() as {port:number}).port;
  return {origin:`http://127.0.0.1:${port}`,port,siteDir,manifest,manifestHash,requests:()=>count,paths,close:()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());})};
}

