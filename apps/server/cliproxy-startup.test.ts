import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer as netServer, connect } from "node:net";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { CliproxyProcess } from "./cliproxy-process.js";
import { repointProxyPort } from "./cliproxy-provision.js";

const root=resolve(import.meta.dirname,"../.."),installed=join(root,".data/cliproxyapi/bin/CLIProxyAPI-8.0.13");
const supported=process.platform==="darwin"&&process.arch==="arm64"&&existsSync(installed);
async function freePort(){const server=netServer();await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const port=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
function open(port:number){return new Promise<boolean>(resolve=>{const socket=connect({host:"127.0.0.1",port});socket.once("connect",()=>{socket.destroy();resolve(true);});socket.once("error",()=>resolve(false));});}
async function waitFor(check:()=>Promise<boolean>,phase:string,budget=10_000){const until=Date.now()+budget;while(Date.now()<until){if(await check())return;await new Promise(resolve=>setTimeout(resolve,30));}throw new Error(`Owned proxy lifecycle did not settle: ${phase}`);}

test("startup owns its proxy, preserves listeners, awaits models, and drains after parent death",{skip:!supported?"Pinned local ARM64 CLIProxyAPI deployment is not installed":false},async()=>{
  process.env.PI_OFFLINE="0";delete process.env.SIGMA_DEMO;delete process.env.PI_ORCH_DEMO;
  await mkdir(join(root,".scratch"),{recursive:true});const data=await mkdtemp(join(root,".scratch/cliproxy-startup-")),directory=join(data,"cliproxyapi"),auth=join(directory,"auth"),bin=join(directory,"bin"),port=await freePort();
  for(const path of [data,directory,auth,bin]){await mkdir(path,{recursive:true,mode:0o700});await chmod(path,0o700);}
  await copyFile(installed,join(bin,"CLIProxyAPI-8.0.13"));await chmod(join(bin,"CLIProxyAPI-8.0.13"),0o700);
  // A synthetic gateway key and empty OAuth directory; no real credentials or model requests.
  const key="test-only-sigma-startup-gateway-key-0000000000";
  const config={host:"127.0.0.1",port,"auth-dir":auth,"api-keys":[key],"remote-management":{"allow-remote":false,"secret-key":"","disable-control-panel":true},plugins:{enabled:false},"quota-exceeded":{"switch-project":false,"switch-preview-model":false,"antigravity-credits":false},debug:false,"logging-to-file":false,"request-log":false,"commercial-mode":true,"usage-statistics-enabled":false,"request-retry":0,"max-retry-credentials":1,"ws-auth":true};
  await writeFile(join(directory,"config.json"),JSON.stringify(config),{mode:0o600});await writeFile(join(directory,"connection.json"),JSON.stringify({baseUrl:`http://127.0.0.1:${port}/v1`,apiKey:key}),{mode:0o600});
  const owner=new CliproxyProcess(data),borrower=new CliproxyProcess(data);let crashChild:ReturnType<typeof spawn>|undefined;
  try{
    assert.equal(await owner.start(),true);assert.equal(await open(port),true,"startup launches the actual pinned proxy");
    assert.equal(await borrower.start(),true);await borrower.close();assert.equal(await open(port),true,"borrowed services are never terminated by Sigma");
    await owner.close();await waitFor(async()=>!await open(port),"owner close");
    const occupied=createServer((_req,res)=>{res.writeHead(401);res.end();});await new Promise<void>(resolve=>occupied.listen(port,"127.0.0.1",resolve));
    const refused=new CliproxyProcess(data);
    try{assert.equal(await refused.start(),true,"an occupied port moves the deployment to a free one");await refused.close();await waitFor(async()=>!await open(JSON.parse(await readFile(join(directory,"config.json"),"utf8")).port),"re-ported proxy close");assert.equal(await open(port),true,"port conflicts leave the existing listener untouched");}
    finally{await new Promise<void>(resolve=>occupied.close(()=>resolve()));repointProxyPort(data,port);}
    const wrapper=join(data,"parent.mjs");await writeFile(wrapper,`import {CliproxyProcess} from ${JSON.stringify(join(root,"apps/server/cliproxy-process.ts"))};\nconsole.log("loaded");const proxy=new CliproxyProcess(${JSON.stringify(data)});await proxy.start();console.log("ready");process.stdin.resume();\n`);
    crashChild=spawn(process.execPath,["--import","tsx",wrapper],{cwd:root,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,HOME:data,PI_OFFLINE:"0",NODE_NO_WARNINGS:"1"},stdio:["pipe","pipe","ignore"]});
    let ready=false,loaded=false;crashChild.stdout?.on("data",chunk=>{ready||=String(chunk).includes("ready");loaded||=String(chunk).includes("loaded");});
    const alive=()=>{assert.equal(crashChild!.exitCode,null,"Crash wrapper must remain alive before readiness");assert.equal(crashChild!.signalCode,null);};
    await waitFor(async()=>{alive();return loaded;},"crash wrapper module loading");
    await waitFor(async()=>{alive();return ready;},"crash wrapper proxy readiness");
    const exited=new Promise<void>(resolve=>crashChild!.once("exit",()=>resolve()));crashChild.kill("SIGKILL");await exited;await waitFor(async()=>!await open(port),"crash proxy drain");
    assert.equal(await open(port),false,"watchdog drains the proxy when its Sigma parent dies abruptly");
    // A listening gateway may initially have no catalog while it loads auth.
    // Exercise actual main startup and Pi model discovery, without model prompts.
    let catalogReads=0;
    const loading=createServer((req,res)=>{
      assert.equal(req.url,"/v1/models");assert.equal(req.headers.authorization,`Bearer ${key}`);
      catalogReads++;res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({data:catalogReads<=2?[]:[{id:"startup-fixture",object:"model",owned_by:"antigravity"}]}));
    });
    await new Promise<void>(resolve=>loading.listen(port,"127.0.0.1",resolve));
    const apiPort=await freePort(),origin=`http://127.0.0.1:${apiPort}`;
    await writeFile(join(directory,"enabled.json"),JSON.stringify({enabled:true}),{mode:0o600});
    crashChild=spawn(process.execPath,["--import","tsx","apps/server/main.ts"],{cwd:root,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,HOME:data,PI_OFFLINE:"0",PI_CODING_AGENT_DIR:join(data,"sdk"),SIGMA_PORT:String(apiPort),SIGMA_DATA_DIR:data,SIGMA_PARENT_WATCH:"1",NODE_NO_WARNINGS:"1"},stdio:["pipe","pipe","ignore"]});
    let listening=false;crashChild.stdout?.on("data",chunk=>{listening||=String(chunk).includes("Sigma API listening");});
    try{
      // Cold SDK loading precedes the separately bounded proxy/catalog startup.
      await waitFor(async()=>{assert.equal(crashChild!.exitCode,null);assert.equal(crashChild!.signalCode,null);return listening;},"main catalog readiness",30_000);
      const bootstrap=await fetch(`${origin}/api/bootstrap`,{method:"POST",headers:{origin}}),cookie=bootstrap.headers.get("set-cookie")!.split(";")[0];
      const {provider}=await (await fetch(`${origin}/api/cliproxy`,{headers:{cookie}})).json();
      assert.equal(provider.connected,true,"startup waits through an initially empty catalog before announcing readiness");
      const {models}=await (await fetch(`${origin}/api/models`,{headers:{cookie}})).json();assert.ok(models.some((model:any)=>model.provider==="sigma-cliproxy"&&model.id==="startup-fixture"));
      const exited=new Promise<void>(resolve=>crashChild!.once("exit",()=>resolve()));crashChild.stdin!.end();await exited;
      assert.equal(await open(port),true,"native parent EOF does not stop a borrowed gateway");
    }finally{if(crashChild.exitCode===null&&crashChild.signalCode===null)crashChild.kill("SIGTERM");await new Promise<void>(resolve=>loading.close(()=>resolve()));}
  }finally{if(crashChild?.exitCode===null&&crashChild.signalCode===null)crashChild.kill("SIGKILL");await borrower.close();await owner.close();}
});

test("main starts the proxy only after opt-in; connect persists it, disconnect stops it, and it restarts in the same run",{skip:!supported?"Pinned local ARM64 CLIProxyAPI deployment is not installed":false},async()=>{
  process.env.PI_OFFLINE="0";delete process.env.SIGMA_DEMO;delete process.env.PI_ORCH_DEMO;
  await mkdir(join(root,".scratch"),{recursive:true});const data=await mkdtemp(join(root,".scratch/cliproxy-optin-")),directory=join(data,"cliproxyapi"),port=await freePort(),apiPort=await freePort(),origin=`http://127.0.0.1:${apiPort}`;
  const auth=join(directory,"auth"),bin=join(directory,"bin"),key="test-only-sigma-optin-gateway-key-00000000000";
  for(const path of [data,directory,auth,bin]){await mkdir(path,{recursive:true,mode:0o700});await chmod(path,0o700);}
  await copyFile(installed,join(bin,"CLIProxyAPI-8.0.13"));await chmod(join(bin,"CLIProxyAPI-8.0.13"),0o700);
  const config0={host:"127.0.0.1",port,"auth-dir":auth,"api-keys":[key],"remote-management":{"allow-remote":false,"secret-key":"","disable-control-panel":true},plugins:{enabled:false},"quota-exceeded":{"switch-project":false,"switch-preview-model":false,"antigravity-credits":false},debug:false,"logging-to-file":false,"request-log":false,"commercial-mode":true,"usage-statistics-enabled":false,"request-retry":0,"max-retry-credentials":1,"ws-auth":true};
  await writeFile(join(directory,"config.json"),JSON.stringify(config0),{mode:0o600});await writeFile(join(directory,"connection.json"),JSON.stringify({baseUrl:`http://127.0.0.1:${port}/v1`,apiKey:key}),{mode:0o600});
  const child=spawn(process.execPath,["--import","tsx","apps/server/main.ts"],{cwd:root,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,HOME:data,PI_OFFLINE:"0",PI_CODING_AGENT_DIR:join(data,"sdk"),SIGMA_PORT:String(apiPort),SIGMA_DATA_DIR:data,SIGMA_PARENT_WATCH:"1",NODE_NO_WARNINGS:"1"},stdio:["pipe","pipe","ignore"]});
  let listening=false;child.stdout?.on("data",chunk=>{listening||=String(chunk).includes("Sigma API listening");});
  try{
    await waitFor(async()=>{assert.equal(child.exitCode,null);return listening;},"main startup without opt-in",30_000);
    const bootstrap=await fetch(`${origin}/api/bootstrap`,{method:"POST",headers:{origin}}),cookie=bootstrap.headers.get("set-cookie")!.split(";")[0];
    const call=async(path:string,method="GET")=>(await (await fetch(`${origin}/api/cliproxy${path}`,{method,headers:{cookie,origin}})).json()).provider;
    const proxyPort=port;
    const before=await call("");
    assert.equal(before.proxy.state,"stopped");assert.match(before.proxy.reason,/Connect the local proxy/);
    assert.equal(await open(proxyPort),false,"no opt-in: proxy process is not launched");
    assert.equal(existsSync(join(directory,"bin/CLIProxyAPI-8.0.13")),true,"binary still provisioned");
    assert.equal(existsSync(join(directory,"enabled.json")),false);
    const connected=await call("/connect","POST");
    assert.equal(connected.proxy.state,"needs_login");assert.equal(await open(proxyPort),true,"connect launches the owned proxy");
    assert.equal(JSON.parse(await readFile(join(directory,"enabled.json"),"utf8")).enabled,true);
    const off=await call("/disconnect","POST");
    assert.equal(off.proxy.state,"stopped");await waitFor(async()=>!await open(proxyPort),"disconnect stops the owned proxy");
    assert.equal(JSON.parse(await readFile(join(directory,"enabled.json"),"utf8")).enabled,false);
    const again=await call("/connect","POST");
    assert.equal(again.proxy.state,"needs_login");assert.equal(await open(proxyPort),true,"connect works again after disconnect in the same run");
    const exited=new Promise<void>(resolve=>child.once("exit",()=>resolve()));child.stdin!.end();await exited;
    await waitFor(async()=>!await open(proxyPort),"shutdown drains the proxy");
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");}
});
