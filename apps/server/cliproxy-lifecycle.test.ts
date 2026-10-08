import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer as netServer, connect } from "node:net";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { CliproxyProcess } from "./cliproxy-process.js";
import { provisionProviderData, proxyEnabled, repointProxyPort, writeProxyEnabled } from "./cliproxy-provision.js";
import { PINNED_BINARY_NAME } from "./cliproxy-config.mjs";

const root=resolve(import.meta.dirname,"../..");
// Fake proxy: serves /v1/models on the port from -config. Control files live next to config.json: crash (exit on start), die (exit once), unhealthy (500s).
const SCRIPT=`const fs=require("fs"),http=require("http"),path=require("path");
const cfg=process.argv[process.argv.indexOf("-config")+1],dir=path.dirname(cfg),c=JSON.parse(fs.readFileSync(cfg,"utf8"));
const has=n=>fs.existsSync(path.join(dir,n));
if(has("crash"))process.exit(3);
http.createServer((q,r)=>{
  if(has("unhealthy")||q.headers.authorization!=="Bearer "+c["api-keys"][0]||q.url!=="/v1/models"){r.writeHead(has("unhealthy")?500:401);return r.end();}
  r.writeHead(200,{"content-type":"application/json"});r.end(JSON.stringify({data:[{id:"fake"}]}));
}).listen(c.port,"127.0.0.1");
setInterval(()=>{if(has("die")){fs.unlinkSync(path.join(dir,"die"));process.exit(4);}},20);`;
const FAKE=`#!/bin/sh\nexec node -e '${SCRIPT}' -- "$@"\n`;
const FAKE_SHA=createHash("sha256").update(FAKE).digest("hex");
async function freePort(){const server=netServer();await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const port=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
function open(port:number){return new Promise<boolean>(resolve=>{const socket=connect({host:"127.0.0.1",port});socket.once("connect",()=>{socket.destroy();resolve(true);});socket.once("error",()=>resolve(false));});}
async function waitFor(check:()=>Promise<boolean>|boolean,phase:string,budget=10_000){const until=Date.now()+budget;while(Date.now()<until){if(await check())return;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error(`did not settle: ${phase}`);}
async function fixture(){
  await mkdir(join(root,".scratch"),{recursive:true});
  const data=await mkdtemp(join(root,".scratch/cliproxy-lifecycle-")),source=join(data,"fake-proxy.js");
  await writeFile(source,FAKE,{mode:0o700});await chmod(source,0o700);
  const dir=join(data,"cliproxyapi"),port=await freePort();
  return {data,source,dir,port,auth:join(dir,"auth"),opts:{binarySource:source,sha256:FAKE_SHA,port}};
}
const treeHash=(dir:string)=>{const h=createHash("sha256");for(const n of readdirSync(dir).sort())h.update(n).update(readFileSync(join(dir,n)));return h.digest("hex");};
const mode=(path:string)=>statSync(path).mode&0o777;

test("provisioning is idempotent, private, never overwrites config/key, never reads auth, and reports state",async()=>{
  const f=await fixture();
  let r=provisionProviderData(f.data,{port:f.port,sha256:FAKE_SHA});
  assert.equal(r.state,"not_installed");
  for(const p of [f.dir,join(f.dir,"bin"),f.auth])assert.equal(mode(p),0o700);
  for(const n of ["config.json","connection.json"])assert.equal(mode(join(f.dir,n)),0o600);
  const config=readFileSync(join(f.dir,"config.json")),connection=readFileSync(join(f.dir,"connection.json"));
  assert.match(JSON.parse(connection.toString()).apiKey,/^[A-Za-z0-9._~-]{32,512}$/);
  r=provisionProviderData(f.data,f.opts);assert.equal(r.state,"needs_login");
  const binary=join(f.dir,"bin",PINNED_BINARY_NAME);assert.equal(mode(binary),0o700);assert.equal(createHash("sha256").update(readFileSync(binary)).digest("hex"),FAKE_SHA);
  assert.ok(readFileSync(join(f.dir,"config.json")).equals(config)&&readFileSync(join(f.dir,"connection.json")).equals(connection),"existing config and key are never regenerated");
  // Unreadable credential file: only names are counted, contents are never opened or changed.
  const cred=join(f.auth,"account.json");await writeFile(cred,"secret-bytes",{mode:0o600});chmodSync(cred,0o000);
  r=provisionProviderData(f.data,f.opts);assert.equal(r.state,"ready");assert.equal(r.authEntries,1);assert.equal(mode(cred),0);chmodSync(cred,0o600);
  assert.equal(readFileSync(cred,"utf8"),"secret-bytes");
  // Different binary is replaced by a matching source; a mismatching source never replaces it.
  await writeFile(binary,"tampered",{mode:0o700});provisionProviderData(f.data,f.opts);assert.equal(createHash("sha256").update(readFileSync(binary)).digest("hex"),FAKE_SHA);
  const badSource=join(f.data,"bad");await writeFile(badSource,"nope",{mode:0o700});provisionProviderData(f.data,{...f.opts,binarySource:badSource});assert.equal(createHash("sha256").update(readFileSync(binary)).digest("hex"),FAKE_SHA);
  // Pre-existing foreign config is preserved byte for byte.
  const other=await fixture();await mkdir(join(other.dir,"auth"),{recursive:true,mode:0o700});await writeFile(join(other.dir,"config.json"),"{\"custom\":1}",{mode:0o600});
  provisionProviderData(other.data,other.opts);assert.equal(readFileSync(join(other.dir,"config.json"),"utf8"),"{\"custom\":1}");assert.equal(existsSync(join(other.dir,"connection.json")),false);
});

test("owned proxy walks not_installed -> needs_login -> ready, then recovers from a crash",async()=>{
  const f=await fixture(),proxy=new CliproxyProcess(f.data,{...f.opts,binarySource:undefined,backoffMs:10,healthMs:40});
  try{
    assert.equal(await proxy.start(),false);assert.equal(proxy.status().state,"not_installed");
    const needs=new CliproxyProcess(f.data,{...f.opts,backoffMs:10,healthMs:40});
    try{
      assert.equal(await needs.start(),true);assert.equal(needs.status().state,"needs_login");assert.equal(await open(f.port),true);
      await writeFile(join(f.auth,"login.json"),"{}",{mode:0o600});
      await waitFor(()=>needs.status().state==="ready","needs_login->ready via health tick");
      await writeFile(join(f.dir,"die"),"");
      await waitFor(()=>needs.status().restarts===1&&needs.status().state==="ready","restart after crash");
      assert.equal(await open(f.port),true);
    }finally{await needs.close();}
    assert.equal(needs.status().state,"stopped");await waitFor(async()=>!await open(f.port),"drain");
  }finally{await proxy.close();}
});

test("repeated crashes are bounded and end degraded; health failures degrade then recover",async()=>{
  const f=await fixture();provisionProviderData(f.data,f.opts);await writeFile(join(f.auth,"login.json"),"{}",{mode:0o600});
  const proxy=new CliproxyProcess(f.data,{...f.opts,maxRestarts:3,backoffMs:5,healthMs:30,healthFailures:2});
  try{
    assert.equal(await proxy.start(),true);assert.equal(proxy.status().state,"ready");
    await writeFile(join(f.dir,"unhealthy"),"");await waitFor(()=>proxy.status().state==="degraded","health degrade");
    assert.match(proxy.status().reason,/health check/);assert.equal(await open(f.port),true,"unhealthy owned proxy is not killed");
    unlinkSync(join(f.dir,"unhealthy"));await waitFor(()=>proxy.status().state==="ready","health recover");
    await writeFile(join(f.dir,"crash"),"");await writeFile(join(f.dir,"die"),"");
    await waitFor(()=>proxy.status().state==="degraded"&&/repeatedly/.test(proxy.status().reason),"bounded restarts");
    assert.equal(proxy.status().restarts,3);assert.equal(await open(f.port),false);
  }finally{await proxy.close();}
});

test("a borrowed listener is verified, reported, and never stopped or restarted",async()=>{
  const f=await fixture();provisionProviderData(f.data,f.opts);
  const key=JSON.parse(readFileSync(join(f.dir,"connection.json"),"utf8")).apiKey as string;
  const server=createServer((req,res)=>{if(req.headers.authorization!==`Bearer ${key}`){res.writeHead(401);return res.end();}res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({data:[]}));});
  await new Promise<void>(resolve=>server.listen(f.port,"127.0.0.1",resolve));
  const proxy=new CliproxyProcess(f.data,{...f.opts,healthMs:20});
  try{
    assert.equal(await proxy.start(),true);assert.equal(proxy.status().state,"borrowed");
    await new Promise(resolve=>setTimeout(resolve,120));assert.equal(proxy.status().state,"borrowed");
    await proxy.close();assert.equal(await open(f.port),true,"close leaves the foreign listener running");
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await proxy.close();}
});

test("server SIGKILL drains the owned proxy group",async()=>{
  const f=await fixture();provisionProviderData(f.data,f.opts);await writeFile(join(f.auth,"login.json"),"{}",{mode:0o600});
  const wrapper=join(f.data,"parent.mjs");
  await writeFile(wrapper,`import {CliproxyProcess} from ${JSON.stringify(join(root,"apps/server/cliproxy-process.ts"))};\nconst proxy=new CliproxyProcess(${JSON.stringify(f.data)},${JSON.stringify(f.opts)});await proxy.start();console.log("ready");process.stdin.resume();\n`);
  const child=spawn(process.execPath,["--import","tsx",wrapper],{cwd:root,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,HOME:f.data,PI_OFFLINE:"0",NODE_NO_WARNINGS:"1"},stdio:["pipe","pipe","ignore"]});
  let ready=false;child.stdout?.on("data",chunk=>{ready||=String(chunk).includes("ready");});
  try{
    await waitFor(()=>ready,"wrapper ready",20_000);assert.equal(await open(f.port),true);
    const exited=new Promise<void>(resolve=>child.once("exit",()=>resolve()));child.kill("SIGKILL");await exited;
    await waitFor(async()=>!await open(f.port),"watchdog drain");
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");}
});

test("opt-in flag defaults off, is private, round-trips, and migrates existing sign-ins",async()=>{
  const f=await fixture();
  assert.equal(proxyEnabled(f.data),false,"no deployment: off");
  provisionProviderData(f.data,f.opts);
  assert.equal(proxyEnabled(f.data),false,"provisioned without sign-in: off");
  assert.equal(existsSync(join(f.dir,"enabled.json")),false,"default off writes nothing");
  writeProxyEnabled(f.data,true);assert.equal(mode(join(f.dir,"enabled.json")),0o600);assert.equal(proxyEnabled(f.data),true);
  writeProxyEnabled(f.data,false);assert.equal(proxyEnabled(f.data),false);
  // Tampered or over-permissive flag files never enable the proxy.
  await writeFile(join(f.dir,"enabled.json"),"{\"enabled\":true,\"x\":1}",{mode:0o600});assert.equal(proxyEnabled(f.data),false);
  await writeFile(join(f.dir,"enabled.json"),"{\"enabled\":true}",{mode:0o600});chmodSync(join(f.dir,"enabled.json"),0o644);assert.equal(proxyEnabled(f.data),false);
  // Migration: prior sign-in and no flag => enabled and persisted.
  const m=await fixture();provisionProviderData(m.data,m.opts);await writeFile(join(m.auth,"login.json"),"{}",{mode:0o600});
  assert.equal(existsSync(join(m.dir,"enabled.json")),false);
  assert.equal(proxyEnabled(m.data),true);assert.equal(JSON.parse(readFileSync(join(m.dir,"enabled.json"),"utf8")).enabled,true);assert.equal(mode(join(m.dir,"enabled.json")),0o600);
  // An explicit opt-out survives the presence of auth entries.
  writeProxyEnabled(m.data,false);assert.equal(proxyEnabled(m.data),false);
});

test("prepare provisions without launching; stop is restartable and leaves borrowed listeners alone",async()=>{
  const f=await fixture(),missing=new CliproxyProcess(f.data,{...f.opts,binarySource:undefined});
  missing.prepare();assert.equal(missing.status().state,"not_installed");assert.equal(await open(f.port),false);
  const proxy=new CliproxyProcess(f.data,{...f.opts,backoffMs:10,healthMs:40});
  try{
    proxy.prepare();
    assert.equal(proxy.status().state,"stopped");assert.match(proxy.status().reason,/Connect the local proxy/);
    assert.equal(await open(f.port),false,"prepare never launches");
    assert.equal(mode(join(f.dir,"bin",PINNED_BINARY_NAME)),0o700,"binary still provisioned");
    assert.equal(await proxy.start(),true);assert.equal(proxy.status().state,"needs_login");assert.equal(await open(f.port),true);
    await proxy.stop();assert.equal(proxy.status().state,"stopped");await waitFor(async()=>!await open(f.port),"owned proxy stopped");
    // Same server run: start works again after stop, with supervision.
    assert.equal(await proxy.start(),true);assert.equal(proxy.status().state,"needs_login");assert.equal(await open(f.port),true);
    await writeFile(join(f.dir,"die"),"");
    await waitFor(()=>proxy.status().restarts===1&&proxy.status().state==="needs_login","supervised restart after stop/start");
    await proxy.stop();await waitFor(async()=>!await open(f.port),"second stop");
    assert.equal(await proxy.start(),true);await proxy.close();
    assert.equal(proxy.status().state,"stopped");await waitFor(async()=>!await open(f.port),"close after restart");
  }finally{await proxy.close();}
  // Borrowed listener: stop never touches it.
  const b=await fixture();provisionProviderData(b.data,b.opts);
  const key=JSON.parse(readFileSync(join(b.dir,"connection.json"),"utf8")).apiKey as string;
  const server=createServer((req,res)=>{if(req.headers.authorization!==`Bearer ${key}`){res.writeHead(401);return res.end();}res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({data:[]}));});
  await new Promise<void>(resolve=>server.listen(b.port,"127.0.0.1",resolve));
  const borrower=new CliproxyProcess(b.data,b.opts);
  try{
    assert.equal(await borrower.start(),true);assert.equal(borrower.status().state,"borrowed");
    await borrower.stop();assert.equal(borrower.status().state,"stopped");assert.equal(await open(b.port),true,"stop leaves the foreign listener running");
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await borrower.close();}
});

test("an occupied unverified port re-points this deployment to a free port, keeping the key and every other field",async()=>{
  const f=await fixture();provisionProviderData(f.data,f.opts);
  const before=JSON.parse(readFileSync(join(f.dir,"config.json"),"utf8")),beforeConn=JSON.parse(readFileSync(join(f.dir,"connection.json"),"utf8"));
  const foreign=createServer((_req,res)=>{res.writeHead(401);res.end();});await new Promise<void>(resolve=>foreign.listen(f.port,"127.0.0.1",resolve));
  const proxy=new CliproxyProcess(f.data,{...f.opts,healthMs:20});
  try{
    assert.equal(await proxy.start(),true);assert.equal(proxy.status().state,"needs_login");
    const config=JSON.parse(readFileSync(join(f.dir,"config.json"),"utf8")),connection=JSON.parse(readFileSync(join(f.dir,"connection.json"),"utf8"));
    assert.notEqual(config.port,f.port);assert.equal(connection.baseUrl,`http://127.0.0.1:${config.port}/v1`);
    assert.equal(connection.apiKey,beforeConn.apiKey);assert.deepEqual({...config,port:0},{...before,port:0});
    for(const n of ["config.json","connection.json"])assert.equal(mode(join(f.dir,n)),0o600);
    assert.equal(readdirSync(f.dir).some(n=>n.startsWith(".config")||n.startsWith(".connection")),false,"no temp files left behind");
    assert.equal(await open(config.port),true,"owned proxy listens on the new port");assert.equal(await open(f.port),true,"foreign listener untouched");
  }finally{await proxy.close();await new Promise<void>(resolve=>foreign.close(()=>resolve()));}
  assert.throws(()=>repointProxyPort(f.data,80),/Invalid proxy port/);
});
