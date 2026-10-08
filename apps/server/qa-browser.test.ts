import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer as createTcp, type Server } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromiumPath, pngInfo, QaBrowser, type LaunchOptions } from "./qa-browser.js";
import { startPreview } from "./qa-preview.js";

const here=dirname(fileURLToPath(import.meta.url));
const chromium=chromiumPath();
const skip=process.platform!=="darwin"?"QA browser spike is macOS-only (sandbox-exec)":!existsSync("/usr/bin/sandbox-exec")?"/usr/bin/sandbox-exec is missing":
  !existsSync(chromium)?`Chromium not found at ${chromium}; set SIGMA_QA_CHROMIUM to a Chrome for Testing binary`:false;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const SCRATCH="/private/tmp";
const FIXTURE_HTML=`<!doctype html><meta charset=utf-8><body style="margin:0;background:#c33"><div style="width:100px;height:100px;background:#33c"></div>
<script>
window.probe=async other=>{
  const out={};
  const attempt=async(name,fn)=>{try{out[name]=await Promise.race([fn(),new Promise((_,r)=>setTimeout(()=>r(new Error("timeout")),4000))]);}catch(e){out[name]="denied:"+(e&&e.message||e);}};
  await attempt("fetchExternal",()=>fetch("http://example.com/",{mode:"no-cors"}).then(r=>"reached:"+r.status));
  await attempt("fetchLoopback",()=>fetch("http://127.0.0.1:"+other+"/",{mode:"no-cors"}).then(r=>"reached:"+r.status));
  await attempt("websocket",()=>new Promise((res,rej)=>{const w=new WebSocket("ws://127.0.0.1:"+other+"/");w.onopen=()=>res("reached");w.onerror=()=>rej(new Error("ws error"));w.onclose=()=>rej(new Error("ws closed"));}));
  await attempt("image",()=>new Promise((res,rej)=>{const i=new Image();i.onload=()=>res("reached");i.onerror=()=>rej(new Error("img error"));i.src="http://127.0.0.1:"+other+"/x.png";}));
  return out;
};
window.download=()=>{const a=document.createElement("a");a.href="/download.txt";a.download="out.txt";document.body.appendChild(a);a.click();return true;};
</script>`;

function fixtureDir(base:string){const dir=join(base,"fx");mkdirSync(dir,{recursive:true});writeFileSync(join(dir,"index.html"),FIXTURE_HTML);writeFileSync(join(dir,"download.txt"),"payload\n");return dir;}
function scratch(prefix:string){return mkdtempSync(join(SCRATCH,`sigma-qa-${prefix}-`));}
async function counter():Promise<{server:Server;port:number;count:()=>number}>{
  let n=0;const server=createTcp(socket=>{n++;socket.on("error",()=>{});socket.destroy();});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  return {server,port:(server.address() as {port:number}).port,count:()=>n};
}
async function withBrowser<T>(prefix:string,options:Partial<LaunchOptions>,body:(ctx:{browser:QaBrowser;preview:Awaited<ReturnType<typeof startPreview>>;base:string;run:string})=>Promise<T>){
  const base=scratch(prefix),run=join(base,"run");mkdirSync(run);
  const preview=await startPreview(fixtureDir(base),run);
  let browser:QaBrowser|undefined;
  try{browser=await QaBrowser.launch({runDir:run,previewPort:preview.port,...options});await browser.navigate(preview.origin+"/");return await body({browser,preview,base,run});}
  finally{const info=await browser?.close();await preview.close();rmSync(base,{recursive:true,force:true});if(info)assert.equal(info.groupEmpty,true,"browser group must be empty after close");}
}
function groupMembers(runDir:string){
  const out=spawnSync("/bin/ps",["-axo","pid=,pgid=,command="],{encoding:"utf8"}).stdout.split("\n");
  return out.filter(line=>line.includes(runDir));
}
const userChromeDir=join(homedir(),"Library/Application Support/Google/Chrome");
const listing=(dir:string)=>{
  try{return {mtime:statSync(dir).mtimeMs,entries:readdirSync(dir).sort().map(name=>[name,statSync(join(dir,name)).mtimeMs])};}
  catch(error){return {unreadable:(error as NodeJS.ErrnoException).code??"error"};}
};

test("screenshot: PNG magic, IHDR equals viewport, stable sha256",{skip,timeout:60_000},async()=>{
  await withBrowser("shot",{viewport:{width:640,height:480}},async({browser})=>{
    const a=await browser.screenshot(),b=await browser.screenshot();
    assert.deepEqual([...a.bytes.subarray(0,8)],[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
    assert.deepEqual(pngInfo(a.bytes),{width:640,height:480});
    assert.equal(a.width,640);assert.equal(a.height,480);
    assert.equal(a.sha256,createHash("sha256").update(a.bytes).digest("hex"));
    assert.equal(a.sha256,b.sha256,"identical page renders identical bytes");
    assert.equal(await browser.evaluate("1+1"),2);
    await assert.rejects(()=>browser.evaluate("throw new Error('boom')"),/boom/);
  });
});

for(const variant of [
  {name:"proxy only (no SBPL, no CDP filter)",options:{isolation:"none" as const,cdpFilter:false}},
  {name:"proxy + SBPL (no CDP filter)",options:{isolation:"outer" as const,cdpFilter:false}},
  {name:"proxy + SBPL + CDP filter",options:{isolation:"outer" as const,cdpFilter:true}},
])test(`real denials: external fetch, WebSocket, <img>, second loopback listener [${variant.name}]`,{skip,timeout:90_000},async()=>{
  const other=await counter();
  try{
    await withBrowser("deny",variant.options,async({browser,preview})=>{
      const before=preview.paths.length;
      const result=await browser.evaluate<Record<string,string>>(`window.probe(${other.port})`);
      for(const [name,value] of Object.entries(result))assert.match(value,/^denied:/,`${name} must be denied, got ${value}`);
      assert.deepEqual(Object.keys(result).sort(),["fetchExternal","fetchLoopback","image","websocket"]);
      await sleep(300);
      assert.equal(other.count(),0,"second loopback listener must see zero connections");
      assert.deepEqual(preview.paths.slice(before).filter(p=>p!=="/favicon.ico"),[],"probe made no preview requests (favicon aside)");
      if(variant.options.cdpFilter)assert.ok(browser.blocked.some(url=>url.startsWith("http://example.com"))&&browser.blocked.some(url=>url.includes(`:${other.port}/`)),`CDP filter denial counters moved: ${browser.blocked.join(",")}`);
      else assert.deepEqual(browser.blocked,[]);
    });
  }finally{other.server.close();}
});

test("user's Chrome profile is untouched",{skip,timeout:60_000},async t=>{
  const before=listing(userChromeDir);
  if("unreadable" in before)t.diagnostic(`user Chrome dir not listable here (${before.unreadable}); only the absence of changes in what is visible is checked`);
  await withBrowser("profile",{},async({browser})=>{await browser.screenshot();});
  assert.deepEqual(listing(userChromeDir),before);
});

test("SBPL isolation: browser cannot write or read outside its run dir (control: unsandboxed can)",{skip,timeout:90_000},async()=>{
  const outcome=async(isolation:"outer"|"none")=>{
    const outside=scratch("outside"),secret=join(outside,"secret.txt"),downloads=join(outside,"dl");mkdirSync(downloads);writeFileSync(secret,"TOP-SECRET-MARKER");
    try{
      return await withBrowser("sbpl",{isolation,cdpFilter:false},async({browser})=>{
        await browser.browserCommand("Browser.setDownloadBehavior",{behavior:"allow",downloadPath:downloads});
        await browser.evaluate("window.download()");await sleep(1500);
        const wrote=readdirSync(downloads).length>0;
        let text="";try{await browser.navigate(`file://${secret}`);text=await browser.evaluate<string>("document.documentElement.innerText");}catch{}
        return {wrote,read:text.includes("TOP-SECRET-MARKER")};
      });
    }finally{rmSync(outside,{recursive:true,force:true});}
  };
  const control=await outcome("none");
  assert.deepEqual(control,{wrote:true,read:true},"test is only meaningful if the unsandboxed control can write/read");
  assert.deepEqual(await outcome("outer"),{wrote:false,read:false});
});

test("SIGKILL of the owning server leaves no browser processes",{skip,timeout:60_000},async()=>{
  const base=scratch("kill"),run=join(base,"run");mkdirSync(run);
  const preview=await startPreview(fixtureDir(base),run);
  const code=`import {QaBrowser} from ${JSON.stringify(join(here,"qa-browser.ts"))};
    const b=await QaBrowser.launch({runDir:${JSON.stringify(run)},previewPort:${preview.port}});
    await b.navigate("http://127.0.0.1:${preview.port}/");
    console.log("READY "+b.pgid);setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",code],{stdio:["ignore","pipe","inherit"]});
  try{
    const pgid=await new Promise<number>((resolve,reject)=>{let out="";const t=setTimeout(()=>reject(new Error("child did not become ready")),30_000);
      child.stdout.on("data",d=>{out+=d;const m=/READY (\d+)/.exec(out);if(m){clearTimeout(t);resolve(Number(m[1]));}});child.on("exit",()=>reject(new Error("child exited early")));});
    assert.ok(groupMembers(run).length>0,"browser processes exist before kill");
    child.kill("SIGKILL");
    const deadline=Date.now()+3000;
    while(Date.now()<deadline&&(groupMembers(run).length>0))await sleep(100);
    assert.deepEqual(groupMembers(run),[],"no processes referencing the run dir remain within 3s");
    assert.throws(()=>process.kill(-pgid,0),/ESRCH/,"process group is gone");
  }finally{try{child.kill("SIGKILL");}catch{}await preview.close();rmSync(base,{recursive:true,force:true});}
});

test("preview manifest: tamper, traversal, host and non-manifest requests fail",{skip:false,timeout:30_000},async()=>{
  const base=scratch("preview"),run=join(base,"run");mkdirSync(run);
  const preview=await startPreview(fixtureDir(base),run);
  const get=(path:string,host=`127.0.0.1:${preview.port}`)=>new Promise<{status:number;body:string}>((resolve,reject)=>{
    const req=request({host:"127.0.0.1",port:preview.port,path,headers:{Host:host}},res=>{let body="";res.on("data",d=>body+=d);res.on("end",()=>resolve({status:res.statusCode??0,body}));});req.on("error",reject);req.end();});
  try{
    assert.deepEqual(preview.manifest.map(e=>e.path),["download.txt","index.html"]);
    assert.ok(preview.manifest.every(e=>/^[0-9a-f]{64}$/.test(e.sha256)&&e.size>0));
    assert.equal(statSync(join(preview.siteDir,"index.html")).mode&0o777,0o444);
    assert.equal((await get("/")).status,200);
    assert.equal((await get("/","evil.example:80")).status,421);
    assert.equal((await get("/secret")).status,404);
    assert.equal((await get("/../run/profile")).status,404);
    assert.equal((await get("/%2e%2e/%2e%2e/etc/passwd")).status,404);
    // Same-size tamper (hash differs) and size-changing tamper both fail.
    const target=join(preview.siteDir,"download.txt");chmodSync(target,0o644);writeFileSync(target,"PAYLOAD\n");
    assert.equal((await get("/download.txt")).status,409);
    writeFileSync(target,"longer payload\n");
    assert.equal((await get("/download.txt")).status,409);
    assert.equal((await get("/")).status,200,"untouched files still serve");
  }finally{await preview.close();rmSync(base,{recursive:true,force:true});}
});
