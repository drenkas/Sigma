import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { InternalChrome } from "./internal-chrome.js";
import { NativeChromeCdp } from "./browser-use.js";
import { chromiumPath, pngInfo } from "./qa-browser.js";
import { syntheticChromeBinary } from "./chrome-test-fixture.js";

const root=resolve(import.meta.dirname,"../..");
const scratch=join(process.env.SIGMA_TEST_DIR||join(root,".scratch"),`internal-chrome-${Date.now()}-${process.pid}`);
const chromium=chromiumPath();
const skip=!existsSync(chromium)?`Chrome for Testing is unavailable (${chromium})`:false;
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(check:()=>boolean,timeout=8_000){const end=Date.now()+timeout;while(Date.now()<end){if(check())return;await pause(50);}throw new Error("Owned Chrome process did not reach the expected state");}
function processForProfile(profile:string,executable:string){
  const rows=execFileSync("ps",["-axo","pid=,pgid=,command="],{encoding:"utf8"}).split("\n");
  const row=rows.find(line=>{
    const match=/^\s*\d+\s+\d+\s+(.*)$/.exec(line),command=match?.[1]??"";
    return (command===executable||command.startsWith(`${executable} `))&&command.includes(`--user-data-dir=${profile}`);
  });
  if(!row)return undefined;
  const match=/^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(row);return match?{pid:Number(match[1]),pgid:Number(match[2]),command:match[3]}:undefined;
}
function processesForRunDir(runDir:string){
  const rows=execFileSync("ps",["-axo","pid=,pgid=,state=,command="],{encoding:"utf8"}).split("\n");
  return rows.flatMap(line=>{
    if(!line.includes(runDir))return [];
    const match=/^\s*(\d+)\s+(\d+)\s+(\S+)\s+/.exec(line);return match?[{pid:Number(match[1]),pgid:Number(match[2]),state:match[3]}]:[];
  });
}
function groupAlive(pgid:number){try{process.kill(-pgid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code==="EPERM";}}

test("internal Chrome keeps the macOS account home and secure storage with a private browser profile",{skip:process.platform!=="darwin",timeout:15_000},async()=>{
  const dir=join(scratch,"keychain-home"),data=join(dir,"data"),parentHome=join(dir,"parent-home"),receipt=join(dir,"environment.json"),binary=join(dir,"browser.mjs"),owner=randomUUID();
  mkdirSync(parentHome,{recursive:true,mode:0o700});
  writeFileSync(binary,`#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(receipt)},JSON.stringify({home:process.env.HOME,args:process.argv.slice(2)}));setInterval(()=>{},1000);\n`,{mode:0o700});
  const previousHome=process.env.HOME,previousChrome=process.env.SIGMA_QA_CHROMIUM;
  process.env.HOME=parentHome;process.env.SIGMA_QA_CHROMIUM=binary;
  const manager=new InternalChrome(data);
  try{
    await manager.launch(owner);await waitFor(()=>existsSync(receipt));
    const observed=JSON.parse(readFileSync(receipt,"utf8"));
    assert.equal(observed.home,userInfo().homedir,"native Keychain lookup uses the account home even when the server has an isolated HOME");
    assert.ok(observed.args.some((arg:string)=>arg.startsWith(`--user-data-dir=${join(data,"browser-use","internal",owner)}/`)&&arg.endsWith("/profile")));
    assert.ok(observed.args.includes("--remote-debugging-pipe"));
    assert.equal(observed.args.some((arg:string)=>/use-mock-keychain|password-store=basic|^--no-sandbox/.test(arg)),false,"real internal authentication keeps native encryption and sandbox protections");
  }finally{
    await manager.close();
    if(previousHome===undefined)delete process.env.HOME;else process.env.HOME=previousHome;
    if(previousChrome===undefined)delete process.env.SIGMA_QA_CHROMIUM;else process.env.SIGMA_QA_CHROMIUM=previousChrome;
    rmSync(dir,{recursive:true,force:true});
  }
});

test("owned internal Chrome launches a fresh profile, navigates, drains, and retains its profile",{skip,timeout:90_000},async()=>{
  mkdirSync(scratch,{recursive:true,mode:0o700});const data=join(scratch,"data"),owner=randomUUID();mkdirSync(data,{recursive:true,mode:0o700});
  let requests=0;const fixture=createServer((req,res)=>{if(req.url==="/")requests++;res.setHeader("Content-Type","text/html");res.end("<!doctype html><title>Owned internal fixture</title><p>local fixture</p>");});
  await new Promise<void>(resolve=>fixture.listen(0,"127.0.0.1",resolve));const port=(fixture.address() as {port:number}).port;
  const manager=new InternalChrome(data);let lease:Awaited<ReturnType<typeof manager.launch>>|undefined,cdp:NativeChromeCdp|undefined,sessionId:string|undefined;
  const previousChrome=process.env.SIGMA_QA_CHROMIUM;
  process.env.SIGMA_QA_CHROMIUM=syntheticChromeBinary(join(scratch,"launcher"),chromium);
  try{
    lease=await manager.launch(owner);
    const dir=join(data,"browser-use","internal",owner);const runs=await import("node:fs/promises").then(fs=>fs.readdir(dir));assert.equal(runs.length,1);
    const profile=join(dir,runs[0],"profile");assert.ok(!existsSync(join(profile,"DevToolsActivePort")),"internal Chrome exposes no loopback endpoint descriptor");
    const runDir=join(dir,runs[0]);
    cdp=NativeChromeCdp.connectPipe(lease.input,lease.output);await cdp.start(10_000);await cdp.command("Browser.getVersion",{},undefined,45_000);const targets=(await cdp.command("Target.getTargets",{},undefined,45_000)).targetInfos;
    const blank=targets.filter((item:any)=>item.type==="page"&&item.url==="about:blank");assert.equal(blank.length,1,`an empty owned profile exposes one initial blank page (${JSON.stringify(targets.map((item:any)=>({type:item.type,url:item.url})))})`);
    const attached=await cdp.command("Target.attachToTarget",{targetId:blank[0].targetId,flatten:true});sessionId=String(attached.sessionId);
    await cdp.command("Page.enable",{},sessionId);await cdp.command("Browser.setDownloadBehavior",{behavior:"deny"});
    const loaded=cdp.waitForEvent("Page.loadEventFired",sessionId,10_000);void loaded.promise.catch(()=>{});
    await cdp.command("Page.navigate",{url:`http://127.0.0.1:${port}/`},sessionId);await loaded.promise;loaded.cancel();
    assert.equal(requests,1,"the owned blank page navigates to a local HTTP fixture");
    const image=await cdp.command("Page.captureScreenshot",{format:"png",captureBeyondViewport:false},sessionId),bytes=Buffer.from(image.data,"base64");
    assert.ok(pngInfo(bytes).width>0&&pngInfo(bytes).height>0,"owned page screenshot is a real PNG");
    const running=processForProfile(profile,realpathSync(chromium));assert.ok(running,"the CFT process uses only its dedicated profile");assert.equal(running.pid,running.pgid,"the owned browser runs in its own process group");assert.match(running.command,/--remote-debugging-pipe/);assert.doesNotMatch(running.command,/--remote-debugging-port|--remote-debugging-address/);
    cdp.close();cdp=undefined;await lease.stop();lease=undefined;
    await waitFor(()=>!groupAlive(running.pgid)&&processesForRunDir(runDir).length===0);
    assert.ok(existsSync(profile),"disconnect retains the owned profile and its local browser state");
  }finally{
    if(sessionId&&cdp)await cdp.command("Target.detachFromTarget",{sessionId}).catch(()=>{});
    cdp?.close();await lease?.stop().catch(()=>{});await manager.close().catch(()=>{});
    if(previousChrome===undefined)delete process.env.SIGMA_QA_CHROMIUM;else process.env.SIGMA_QA_CHROMIUM=previousChrome;
    await new Promise<void>(resolve=>fixture.close(()=>resolve()));rmSync(scratch,{recursive:true,force:true});
  }
});

test("Stop during internal Chrome startup holds the launch lock until the owned process group drains",{timeout:15_000},async()=>{
  mkdirSync(scratch,{recursive:true,mode:0o700});const data=join(scratch,"startup-data"),fake=join(scratch,"slow-browser"),owner=randomUUID();mkdirSync(data,{recursive:true,mode:0o700});
  writeFileSync(fake,"#!/bin/sh\nsleep 30\n",{mode:0o700});
  const prior=process.env.SIGMA_QA_CHROMIUM;process.env.SIGMA_QA_CHROMIUM=fake;const manager=new InternalChrome(data);
  try{
    const launching=manager.launch(owner);const stopping=manager.stop(owner);
    await assert.rejects(()=>manager.launch(owner),/starting or still draining/,"a second launch is rejected while Stop drains the first");
    await stopping;await assert.rejects(()=>launching,/could not start|stopped/);
    const next=manager.launch(owner);const secondStop=manager.stop(owner);await secondStop;await assert.rejects(()=>next,/could not start|stopped/);
  }finally{
    await manager.close().catch(()=>{});if(prior===undefined)delete process.env.SIGMA_QA_CHROMIUM;else process.env.SIGMA_QA_CHROMIUM=prior;
    rmSync(scratch,{recursive:true,force:true});
  }
});

test("watchdog drains the owned Chrome process group after the server process dies",{skip,timeout:45_000},async()=>{
  mkdirSync(scratch,{recursive:true,mode:0o700});const data=join(scratch,"crash-data"),home=join(scratch,"home"),owner=randomUUID();mkdirSync(data,{recursive:true,mode:0o700});mkdirSync(home,{recursive:true,mode:0o700});
  const modulePath=fileURLToPath(new URL("./internal-chrome.ts",import.meta.url));
  const code=`import {InternalChrome} from ${JSON.stringify(modulePath)};const manager=new InternalChrome(${JSON.stringify(data)});await manager.launch(${JSON.stringify(owner)});console.log(JSON.stringify({owner:${JSON.stringify(owner)}}));setInterval(()=>{},1000);`;
  const env={PATH:process.env.PATH||"/usr/bin:/bin",HOME:home,TMPDIR:join(home,"tmp"),PI_OFFLINE:"1",PI_CODING_AGENT_DIR:join(home,"pi-agent"),SIGMA_QA_CHROMIUM:syntheticChromeBinary(join(scratch,"launcher"),chromium)};mkdirSync(env.TMPDIR,{recursive:true,mode:0o700});
  const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",code],{cwd:root,env,stdio:["ignore","pipe","pipe"]});let ready:any;
  try{
    ready=await new Promise((resolve,reject)=>{
      const lines=createInterface({input:child.stdout!}),timeout=setTimeout(()=>reject(new Error("Internal Chrome crash fixture did not start")),30_000);
      child.once("exit",()=>{clearTimeout(timeout);reject(new Error("Internal Chrome crash fixture exited early"));});
      lines.once("line",line=>{clearTimeout(timeout);try{resolve(JSON.parse(line));}catch{reject(new Error("Internal Chrome crash fixture receipt was invalid"));}lines.close();});
    });
    assert.equal(ready.owner,owner);
    const runDir=join(data,"browser-use","internal",owner),runs=await import("node:fs/promises").then(fs=>fs.readdir(runDir));assert.equal(runs.length,1);
    const ownedRunDir=join(runDir,runs[0]),profile=join(ownedRunDir,"profile"),chromeExecutable=realpathSync(chromium);let running=processForProfile(profile,chromeExecutable);for(let attempt=0;!running&&attempt<200;attempt++){await pause(50);running=processForProfile(profile,chromeExecutable);}assert.ok(running,"owned Chrome process is present before its server dies");assert.equal(running.pid,running.pgid,"the owned browser runs in its own process group");assert.match(running.command,/--remote-debugging-pipe/);assert.ok(!existsSync(join(profile,"DevToolsActivePort")));
    child.kill("SIGKILL");await new Promise<void>(resolve=>child.once("exit",()=>resolve()));
    await waitFor(()=>!groupAlive(running.pgid)&&processesForRunDir(ownedRunDir).length===0,12_000);
    assert.ok(existsSync(profile),"server-death cleanup retains rather than deletes the internal profile");
  }finally{
    if(child.exitCode===null&&child.signalCode===null){child.kill("SIGKILL");await new Promise<void>(resolve=>child.once("exit",()=>resolve()));}
    rmSync(scratch,{recursive:true,force:true});
  }
});
