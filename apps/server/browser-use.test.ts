import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAssistantMessageEventStream, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { BrowserUse, NativeChromeCdp, readChromeEndpoint } from "./browser-use.js";
import { chromeUserDataDir } from "./chrome-path.js";
import { chromiumPath, pngInfo } from "./qa-browser.js";
import { PiHost } from "./pi-host.js";
import { Storage } from "./storage.js";

const root=resolve(import.meta.dirname,"../..");
const scratch=join(process.env.SIGMA_TEST_DIR||join(root,".scratch"),`browser-use-${Date.now()}-${process.pid}`);
const chromium=chromiumPath();
const skip=!existsSync(chromium)||typeof WebSocket==="undefined"?`Chrome for Testing or Node WebSocket is unavailable (${chromium})`:false;
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor<T>(read:()=>T|Promise<T>,ms=10_000):Promise<NonNullable<Awaited<T>>>{const end=Date.now()+ms;while(Date.now()<end){const value=await read();if(value!==undefined)return value as NonNullable<Awaited<T>>;await pause(50);}throw new Error("Browser fixture did not reach the expected state");}

test("DevToolsActivePort accepts only bounded loopback browser descriptors",async()=>{
  const home=join(scratch,"endpoint-home"),dir=chromeUserDataDir(home);mkdirSync(dir,{recursive:true});
  const descriptor=join(dir,"DevToolsActivePort");writeFileSync(descriptor,"9222\n/devtools/browser\n",{mode:0o600});
  assert.equal(readChromeEndpoint(home),"ws://127.0.0.1:9222/devtools/browser");
  writeFileSync(descriptor,"9222\n/devtools/browser/abc-123\n",{mode:0o600});
  assert.equal(readChromeEndpoint(home),"ws://127.0.0.1:9222/devtools/browser/abc-123");
  for(const contents of ["9222\n/devtools/page/secret\n","9222\nws://evil.example/devtools/browser\n","9222\n/devtools/browser/a?token=x\n","99999\n/devtools/browser\n",`${"1".repeat(600)}\n`]){
    writeFileSync(descriptor,contents,{mode:0o600});
    assert.throws(()=>readChromeEndpoint(home),/Chrome remote debugging is unavailable/);
  }
  const outside=join(home,"outside-descriptor");writeFileSync(outside,"9222\n/devtools/browser\n",{mode:0o600});rmSync(descriptor);
  await import("node:fs/promises").then(fs=>fs.symlink(outside,descriptor));
  assert.throws(()=>readChromeEndpoint(home),/Chrome remote debugging is unavailable/);
});

test("owned CDP pipe failures reject pending commands without an unhandled stream error",async()=>{
  const input=new PassThrough(),output=new PassThrough(),cdp=NativeChromeCdp.connectPipe(input,output);
  const sent=new Promise<void>(resolve=>input.once("data",()=>resolve())),pending=cdp.command("Browser.getVersion"),rejected=assert.rejects(()=>pending,/Chrome connection closed/);
  try{
    await sent;assert.doesNotThrow(()=>input.emit("error",new Error("fixture EPIPE")));
    await rejected;await assert.rejects(()=>cdp.command("Browser.getVersion"),/Chrome connection is closed/);
  }finally{cdp.close();input.destroy();output.destroy();}
});

function browserProvider(runtime:ModelRuntime,state:{imageSeen:boolean;errorSeen:boolean}){
  const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
  runtime.registerProvider("sigma-browser-fixture",{
    api:"sigma-browser-fixture",apiKey:"fixture-only",baseUrl:"http://127.0.0.1/unused",
    models:[{id:"vision",name:"Browser fixture vision",reasoning:false,input:["text","image"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:4096,maxTokens:512}],
    streamSimple:(model:Model<any>,context:TranscriptContext)=>{
      const stream=createAssistantMessageEventStream(),lastUser=context.messages.map(message=>message.role).lastIndexOf("user"),user=context.messages[lastUser],text=user?.role==="user"?(typeof user.content==="string"?user.content:user.content.filter(part=>part.type==="text").map(part=>part.text).join("")):"";
      const result=context.messages.slice(lastUser+1).find(message=>message.role==="toolResult");
      if(result){state.imageSeen=result.content.some(part=>part.type==="image");state.errorSeen=result.isError===true;}
      const output:any={role:"assistant",content:[],api:model.api,provider:model.provider,model:model.id,usage,stopReason:"pending",timestamp:Date.now()};
      const toolCall=text.startsWith("browser-fixture:screenshot")&&!result?{type:"toolCall" as const,id:`${crypto.randomUUID()}|${crypto.randomUUID()}`,name:"browser_screenshot",arguments:{}}:undefined;
      queueMicrotask(()=>{
        stream.push({type:"start",partial:output});
        if(toolCall){output.content.push(toolCall);stream.push({type:"toolcall_start",contentIndex:0,partial:output});stream.push({type:"toolcall_end",contentIndex:0,toolCall,partial:output});output.stopReason="toolUse";stream.push({type:"done",reason:"toolUse",message:output});}
        else{const answer=result?.isError?"Browser tool was correctly blocked.":"Browser screenshot tool completed.";output.content.push({type:"text",text:answer});stream.push({type:"text_start",contentIndex:0,partial:output});stream.push({type:"text_end",contentIndex:0,content:answer,partial:output});output.stopReason="stop";stream.push({type:"done",reason:"stop",message:output});}
        stream.end();
      });
      return stream;
    },
  });
}

function parseReceipt(result:any){const text=result.content.find((part:any)=>part.type==="text")?.text;assert.equal(typeof text,"string");return JSON.parse(text);}
function observation(result:any){const value=parseReceipt(result).observationId;assert.equal(typeof value,"string");return value as string;}
async function startFixture():Promise<{server:Server;origin:string;otherOrigin:string;controlOrigin:string;events:Record<string,number>;viewport:{width:number;height:number}|undefined;scrollY:number;cookieSeen:boolean;slowHits:number;slowResponses:number;controlBootstrapHits:number;close:()=>Promise<void>}>{
  const events:Record<string,number>={},state:{viewport?:{width:number;height:number};scrollY:number;cookieSeen:boolean;slowHits:number;slowResponses:number;controlBootstrapHits:number}={scrollY:0,cookieSeen:false,slowHits:0,slowResponses:0,controlBootstrapHits:0};
  let otherOrigin="",controlOrigin="";
  const page=`<!doctype html><meta charset="utf-8"><title>Fixture first tab</title><style>body{margin:0;min-height:3000px;background:linear-gradient(#d44,#44d)}button,input{position:fixed;z-index:2}#target{left:40px;top:40px;width:100px;height:60px}#plain,#plain2{left:180px;width:180px;height:36px}#plain{top:40px}#plain2{top:90px}#reveal{left:400px;top:40px;width:120px;height:44px}#secret{left:540px;top:40px;width:140px;height:36px;display:none}</style><button id="target">Target</button><input id="plain" type="text"><input id="plain2" type="text"><button id="reveal">Reveal secret field</button><input id="secret" type="password"><script>const send=(kind,detail='')=>fetch('/event?kind='+encodeURIComponent(kind)+'&detail='+encodeURIComponent(detail),{credentials:'same-origin',keepalive:true}).catch(()=>{});const secret=document.querySelector('#secret');document.querySelector('#target').onclick=()=>send('click');for(const input of document.querySelectorAll('#plain,#plain2'))input.oninput=()=>send('input');document.querySelector('#reveal').onclick=()=>{secret.style.display='block'};addEventListener('scroll',()=>fetch('/scroll?y='+scrollY,{credentials:'same-origin',keepalive:true}).catch(()=>{}),{passive:true});document.addEventListener('visibilitychange',()=>send('visibility',document.visibilityState+':'+location.pathname));send('visibility',document.visibilityState+':'+location.pathname);document.addEventListener('keydown',e=>{if(e.key==='Escape')send('key')});fetch('/viewport?w='+innerWidth+'&h='+innerHeight).catch(()=>{});</script>`;
  const server=createServer((req,res)=>{
    const url=new URL(req.url||"/","http://127.0.0.1");
    if(url.pathname==="/"||url.pathname==="/second"){res.setHeader("Set-Cookie","fixture-auth=opaque-fixture; HttpOnly; SameSite=Lax; Path=/");res.setHeader("Content-Type","text/html; charset=utf-8");res.end(url.pathname==="/second"?page.replace("Fixture first tab","Fixture second tab"):page);return;}
    if(url.pathname==="/event"){const kind=url.searchParams.get("kind")||"unknown",detail=url.searchParams.get("detail")||"",key=`${kind}:${detail}`;events[key]=(events[key]||0)+1;res.end("ok");return;}
    if(url.pathname==="/scroll"){state.scrollY=Number(url.searchParams.get("y"))||0;events.scroll=(events.scroll||0)+1;res.end("ok");return;}
    if(url.pathname==="/viewport"){events.viewport=(events.viewport||0)+1;state.viewport={width:Number(url.searchParams.get("w")),height:Number(url.searchParams.get("h"))};res.end("ok");return;}
    if(url.pathname==="/next"){state.cookieSeen=(req.headers.cookie||"").includes("fixture-auth=opaque-fixture");res.setHeader("Content-Type","text/html; charset=utf-8");res.end("<!doctype html><body style='height:3000px;background:linear-gradient(#3a3,#aa3)'>next</body>");return;}
    if(url.pathname==="/control-pending"){res.setHeader("Content-Type","text/html; charset=utf-8");res.end("<!doctype html><title>Control pending fixture</title><p>Safe project page</p>");return;}
    if(url.pathname==="/control-redirect-start"){res.setHeader("Content-Type","text/html; charset=utf-8");res.end("<!doctype html><title>Control redirect fixture</title><p>Safe project page</p>");return;}
    if(url.pathname==="/redirect-control"){res.statusCode=302;res.setHeader("Location",`${controlOrigin}/ui`);res.end();return;}
    if(url.pathname==="/iframe"){res.setHeader("Content-Type","text/html; charset=utf-8");res.end("<!doctype html><title>Iframe OTP fixture</title><iframe src='/otp' style='position:fixed;left:20px;top:20px;width:360px;height:140px'></iframe>");return;}
    if(url.pathname==="/otp"){res.setHeader("Content-Type","text/html; charset=utf-8");res.end("<!doctype html><title>OTP child fixture</title><input autocomplete='one-time-code' value='SYNTHETIC_OTP_FRAME_984201' style='margin:20px;width:280px;height:48px'>");return;}
    if(url.pathname==="/shadow-otp"){res.setHeader("Content-Type","text/html; charset=utf-8");res.end("<!doctype html><title>Shadow OTP fixture</title><div id='host'></div><script>const root=document.querySelector('#host').attachShadow({mode:'open'});const input=document.createElement('input');input.autocomplete='one-time-code';input.value='SYNTHETIC_OTP_SHADOW_276410';input.style='position:fixed;left:30px;top:30px;width:280px;height:48px';root.append(input)</script>");return;}
    if(url.pathname==="/uninspectable"){res.setHeader("Content-Type","text/html; charset=utf-8");res.end(`<!doctype html><title>Cross-origin child fixture</title><iframe src='${otherOrigin}/' style='position:fixed;left:20px;top:20px;width:360px;height:140px'></iframe>`);return;}
    if(url.pathname==="/shadow-safe"){res.setHeader("Content-Type","text/html; charset=utf-8");res.end("<!doctype html><title>Open shadow focus fixture</title><div id='shadow-host'></div><script>const root=document.querySelector('#shadow-host').attachShadow({mode:'open'});for(const id of ['shadow-a','shadow-b']){const input=document.createElement('input');input.id=id;input.type='text';input.style=`position:fixed;left:${id==='shadow-a'?30:230}px;top:40px;width:180px;height:40px`;input.oninput=()=>fetch('/event?kind=shadow-input',{keepalive:true});root.append(input)}root.querySelector('#shadow-a').focus()</script>");return;}
    if(url.pathname==="/pan"){res.setHeader("Content-Type","text/html; charset=utf-8");res.end("<!doctype html><meta charset='utf-8'><title>Pan coordinate fixture</title><style>html,body{margin:0;width:100%;height:1800px}#pan-target{position:absolute;left:520px;top:310px;width:80px;height:40px}</style><button id='pan-target'>Pan target</button><script>document.querySelector('#pan-target').onclick=()=>fetch('/event?kind=pan-click',{keepalive:true});addEventListener('hashchange',()=>fetch('/event?kind=hashchange',{keepalive:true}))</script>");return;}
    if(url.pathname==="/slow"){state.slowHits++;setTimeout(()=>{if(!res.destroyed){res.setHeader("Content-Type","text/html");res.end("<!doctype html><title>Slow outcome fixture</title><p>slow done</p>");state.slowResponses++;}},2500);return;}
    res.statusCode=404;res.end();
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const port=(server.address() as {port:number}).port;
  const other=createServer((_req,res)=>{res.setHeader("Content-Type","text/html; charset=utf-8");res.end("<!doctype html><title>Alternate origin fixture</title><body>Alternate fixture</body>");});
  await new Promise<void>(resolve=>other.listen(0,"127.0.0.1",resolve));const otherPort=(other.address() as {port:number}).port;otherOrigin=`http://127.0.0.1:${otherPort}`;
  const control=createServer((req,res)=>{const path=new URL(req.url||"/","http://127.0.0.1").pathname;if(path==="/api/bootstrap"){state.controlBootstrapHits++;res.setHeader("Content-Type","application/json");res.end('{"ok":true}');return;}res.setHeader("Content-Type","text/html; charset=utf-8");res.end("<!doctype html><meta charset='utf-8'><title>Sigma local control fixture</title><button id='control'>Sigma control</button><script>document.querySelector('#control').onclick=()=>fetch('/api/bootstrap',{method:'POST'})</script>");});
  await new Promise<void>(resolve=>control.listen(0,"127.0.0.1",resolve));const controlPort=(control.address() as {port:number}).port;controlOrigin=`http://127.0.0.1:${controlPort}`;
  return {server,origin:`http://127.0.0.1:${port}`,otherOrigin:`http://127.0.0.1:${otherPort}`,controlOrigin,events,close:()=>Promise.all([server,other,control].map(item=>new Promise<void>(resolve=>item.close(()=>resolve())))).then(()=>{}),get viewport(){return state.viewport;},get scrollY(){return state.scrollY;},get cookieSeen(){return state.cookieSeen;},get slowHits(){return state.slowHits;},get slowResponses(){return state.slowResponses;},get controlBootstrapHits(){return state.controlBootstrapHits;}};
}
async function killChrome(child:ChildProcess){
  if(child.pid)try{process.kill(-child.pid,"SIGTERM");}catch{}
  await Promise.race([new Promise<void>(resolve=>child.once("exit",()=>resolve())),pause(3000)]);
  if(child.pid)try{process.kill(-child.pid,"SIGKILL");}catch{}
}
async function launchChrome(home:string){
  const userData=chromeUserDataDir(home);mkdirSync(userData,{recursive:true,mode:0o700});
  const child=spawn(chromium,["--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check","--disable-extensions","--hide-scrollbars","--use-mock-keychain","--remote-debugging-address=127.0.0.1","--remote-debugging-port=0","--force-device-scale-factor=2","--window-size=800,700",`--user-data-dir=${userData}`,"about:blank"],{detached:true,stdio:["ignore","ignore","pipe"],env:{PATH:process.env.PATH,HOME:home,TMPDIR:process.env.TMPDIR}});
  let stderr="",spawnError="";child.stderr?.on("data",part=>{stderr=(stderr+String(part)).slice(-3000);});child.on("error",error=>{spawnError=error.message;});
  const descriptor=join(userData,"DevToolsActivePort");try{await waitFor(()=>{if(spawnError)throw new Error("Chrome for Testing could not start: "+spawnError);if(child.exitCode!==null)throw new Error("Chrome for Testing exited before remote debugging was ready: "+stderr.slice(-1000));return existsSync(descriptor)?true:undefined;},30_000);return child;}catch(error){await killChrome(child);throw error;}
}
async function createFixtureTab(endpoint:string){
  const socket=new WebSocket(endpoint);
  try{
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("CFT test connection timed out")),5_000);socket.addEventListener("open",()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener("error",()=>{clearTimeout(timer);reject(new Error("CFT test connection failed"));},{once:true});});
    const result=new Promise<string>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("CFT fixture tab creation timed out")),5_000);socket.addEventListener("message",async event=>{let message:any;try{message=JSON.parse(typeof event.data==="string"?event.data:await (event.data as Blob).text());}catch{return;}if(message.id!==1)return;clearTimeout(timer);if(message.error)reject(new Error("CFT fixture tab creation failed"));else resolve(String(message.result?.targetId||""));});});
    socket.send(JSON.stringify({id:1,method:"Target.createTarget",params:{url:"about:blank"}}));const id=await result;if(!id)throw new Error("CFT fixture tab creation returned no target ID");return id;
  }finally{try{socket.close();}catch{}}
}
async function rawCdp(endpoint:string){
  const socket=new WebSocket(endpoint);let nextId=0;const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("CFT raw fixture connection timed out")),5_000);socket.addEventListener("open",()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener("error",()=>{clearTimeout(timer);reject(new Error("CFT raw fixture connection failed"));},{once:true});});
  socket.addEventListener("message",async event=>{let message:any;try{message=JSON.parse(typeof event.data==="string"?event.data:await (event.data as Blob).text());}catch{return;}const item=pending.get(message.id);if(!item)return;pending.delete(message.id);message.error?item.reject(new Error("CFT raw fixture command failed")):item.resolve(message.result);});
  return {command(method:string,params:Record<string,unknown>={},sessionId?:string){const id=++nextId;return new Promise<any>((resolve,reject)=>{pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});},close(){try{socket.close();}catch{}}};
}
async function pinchFixtureTab(endpoint:string,url:string){
  const cdp=await rawCdp(endpoint);let sessionId:string|undefined;
  try{const targets=(await cdp.command("Target.getTargets")).targetInfos,target=targets.find((item:any)=>item.type==="page"&&item.url===url);if(!target)throw new Error("CFT pinch fixture page was not found");const attached=await cdp.command("Target.attachToTarget",{targetId:target.targetId,flatten:true});sessionId=String(attached.sessionId);await cdp.command("Input.synthesizePinchGesture",{x:600,y:350,scaleFactor:2,relativeSpeed:800,gestureSourceType:"touch"},sessionId);}
  finally{if(sessionId)await cdp.command("Target.detachFromTarget",{sessionId}).catch(()=>{});cdp.close();}
}
async function fixtureVisualViewport(endpoint:string,url:string){
  const cdp=await NativeChromeCdp.connect(endpoint,10_000);let sessionId:string|undefined;
  try{const targets=(await cdp.command("Target.getTargets")).targetInfos,target=targets.find((item:any)=>item.type==="page"&&item.url===url);if(!target)throw new Error("CFT viewport fixture page was not found");const attached=await cdp.command("Target.attachToTarget",{targetId:target.targetId,flatten:true});sessionId=String(attached.sessionId);return (await cdp.command("Page.getLayoutMetrics",{},sessionId)).cssVisualViewport;}
  finally{if(sessionId)await cdp.command("Target.detachFromTarget",{sessionId}).catch(()=>{});cdp.close();}
}
async function loadFixtureTab(endpoint:string,targetId:string,url:string){
  const cdp=await NativeChromeCdp.connect(endpoint,10_000);let sessionId:string|undefined;
  let stage="attach";try{const attached=await cdp.command("Target.attachToTarget",{targetId,flatten:true}),activeSession=String(attached.sessionId);sessionId=activeSession;stage="enable";await cdp.command("Page.enable",{},activeSession);stage="bring-to-front";await cdp.command("Page.bringToFront",{},activeSession);const loaded=cdp.waitForEvent("Page.loadEventFired",activeSession,10_000);void loaded.promise.catch(()=>{});try{stage="navigate";const result=await cdp.command("Page.navigate",{url},activeSession);if(result.errorText)throw new Error("CFT fixture navigation failed");stage="wait-load";await loaded.promise;}finally{loaded.cancel();}}
  catch(error){throw new Error(`CFT fixture ${stage} failed: ${error instanceof Error?error.message:"unknown error"}`);}
  finally{if(sessionId)await cdp.command("Target.detachFromTarget",{sessionId}).catch(()=>{});cdp.close();}
}
async function focusFixtureInput(endpoint:string,url:string,x:number,y:number){
  const cdp=await NativeChromeCdp.connect(endpoint,10_000);let sessionId:string|undefined;
  try{const targets=(await cdp.command("Target.getTargets")).targetInfos,target=targets.find((item:any)=>item.type==="page"&&item.url===url);if(!target)throw new Error("CFT focus fixture tab was not found");const attached=await cdp.command("Target.attachToTarget",{targetId:target.targetId,flatten:true}),activeSession=String(attached.sessionId);sessionId=activeSession;await cdp.command("Page.bringToFront",{},activeSession);await cdp.command("Input.dispatchMouseEvent",{type:"mouseMoved",x,y},activeSession);await cdp.command("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1},activeSession);await cdp.command("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",clickCount:1},activeSession);}
  finally{if(sessionId)await cdp.command("Target.detachFromTarget",{sessionId}).catch(()=>{});cdp.close();}
}
async function focusShadowFixtureInput(endpoint:string,url:string,id:"shadow-a"|"shadow-b"){
  const cdp=await NativeChromeCdp.connect(endpoint,10_000);let sessionId:string|undefined;
  try{const targets=(await cdp.command("Target.getTargets")).targetInfos,target=targets.find((item:any)=>item.type==="page"&&item.url===url);if(!target)throw new Error("CFT open-shadow fixture page was not found");const attached=await cdp.command("Target.attachToTarget",{targetId:target.targetId,flatten:true}),activeSession=String(attached.sessionId);sessionId=activeSession;await cdp.command("Page.bringToFront",{},activeSession);const expression=`document.querySelector('#shadow-host').shadowRoot.querySelector('#${id}').focus()`;await cdp.command("Runtime.evaluate",{expression},activeSession);}
  finally{if(sessionId)await cdp.command("Target.detachFromTarget",{sessionId}).catch(()=>{});cdp.close();}
}

test("Pi browser tools use the supervised owner gate and real Chrome target without replay",{skip,timeout:120_000},async()=>{
  mkdirSync(scratch,{recursive:true,mode:0o700});const home=join(scratch,"home"),data=join(scratch,"data");mkdirSync(home,{recursive:true,mode:0o700});mkdirSync(data,{recursive:true,mode:0o700});
  const fixture=await startFixture();
  const envKeys=["HOME","PI_CODING_AGENT_DIR","PI_OFFLINE","SIGMA_APPROVAL_MODE","SIGMA_DEMO","PI_ORCH_DEMO","OPENAI_API_KEY","ANTHROPIC_API_KEY","CLAUDE_CODE_OAUTH_TOKEN","GEMINI_API_KEY","GOOGLE_API_KEY","AGY_ACCESS_TOKEN","GITHUB_TOKEN","OPENROUTER_API_KEY","MISTRAL_API_KEY","DEEPSEEK_API_KEY","XAI_API_KEY","COHERE_API_KEY","CEREBRAS_API_KEY","GROQ_API_KEY","TOGETHER_API_KEY","SIGMA_SESSION_TOKEN","SIGMA_COOKIE"] as const;
  const oldEnv=new Map(envKeys.map(key=>[key,process.env[key]]));for(const key of envKeys)delete process.env[key];
  process.env.HOME=home;process.env.PI_CODING_AGENT_DIR=join(home,"pi-agent");process.env.PI_OFFLINE="1";process.env.SIGMA_APPROVAL_MODE="ask";
  let child:ChildProcess|undefined,storage=new Storage(join(data,"state.sqlite")),host:PiHost|undefined;
  const providerState={imageSeen:false,errorSeen:false};let browser:BrowserUse|undefined,sessionId="",phase="PiHost setup";
  try{
    host=new PiHost(storage,data,async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);});const piHost=host;
    await piHost.init();browserProvider((piHost as any).runtime as ModelRuntime,providerState);browser=new BrowserUse(storage,data,async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);},home,undefined,[Number(new URL(fixture.controlOrigin).port),4317]);piHost.attachBrowserUse(browser);
    sessionId=await piHost.create(root,"sigma-browser-fixture/vision");
    await piHost.prompt(sessionId,"browser-fixture:screenshot");
    await waitFor(()=>piHost.snapshot(sessionId).then(view=>view.status==="settled"?view:undefined));
    assert.equal(providerState.errorSeen,true,"Pi tool_call gate rejects an ungranted Chrome screenshot");
    assert.equal((await piHost.snapshot(sessionId)).approvals.filter(item=>item.tool==="browser_action").length,0,"No approval appears before a selected tab exists");

    phase="CFT launch and synthetic tabs";child=await launchChrome(home);
    const endpoint=readChromeEndpoint(home);assert.match(endpoint,/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser(?:\/|$)/);
    phase="CFT first synthetic tab";const firstFixtureTab=await createFixtureTab(endpoint);await loadFixtureTab(endpoint,firstFixtureTab,fixture.origin);
    phase="CFT second synthetic tab";const secondFixtureTab=await createFixtureTab(endpoint);await loadFixtureTab(endpoint,secondFixtureTab,`${fixture.origin}/second`);
    phase="CFT pre-opened control tab";const controlTab=await createFixtureTab(endpoint);await loadFixtureTab(endpoint,controlTab,`${fixture.controlOrigin}/ui`);
    phase="CFT target inventory";
    const tabCheck=await NativeChromeCdp.connect(endpoint,10_000);try{await waitFor(async()=>{const targets=(await tabCheck.command("Target.getTargets")).targetInfos.filter((item:any)=>item.url?.startsWith(fixture.origin));return targets.length===2?targets:undefined;});}finally{tabCheck.close();}
    phase="disconnect fences owner lookup";let releaseOwnerRead!:()=>void,ownerReadStarted!:()=>void;const ownerReadGate=new Promise<void>(resolve=>{releaseOwnerRead=resolve;}),ownerRead=new Promise<void>(resolve=>{ownerReadStarted=resolve;});let holdOwnerRead=true;
    const heldStorage={call:<T=any>(op:string,args:Record<string,unknown>={})=>{if(op==="session"&&holdOwnerRead){holdOwnerRead=false;ownerReadStarted();return ownerReadGate.then(()=>storage.call<T>(op,args));}return storage.call<T>(op,args);}} as Storage;
    const pendingBrowser=new BrowserUse(heldStorage,data,async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);},home),pendingConnect=pendingBrowser.connect(sessionId,endpoint);
    await ownerRead;pendingBrowser.revoke(sessionId);releaseOwnerRead();await assert.rejects(()=>pendingConnect,/Chrome connection was stopped/);assert.equal((await pendingBrowser.view(sessionId)).status,"disconnected","Disconnect during owner lookup cannot resurrect the connection");await pendingBrowser.close();
    let admissionStarted!:()=>void,releaseAdmission!:()=>void;const admitted=new Promise<void>(resolve=>{admissionStarted=resolve;}),admissionGate=new Promise<void>(resolve=>{releaseAdmission=resolve;});
    const admissionBrowser=new BrowserUse(storage,data,async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);},home),admissionConnect=admissionBrowser.connect(sessionId,endpoint,async check=>{check();admissionStarted();await admissionGate;check();});
    await admitted;admissionBrowser.revoke(sessionId);releaseAdmission();await assert.rejects(()=>admissionConnect,/Chrome connection was stopped/);assert.equal((await admissionBrowser.view(sessionId)).status,"disconnected","Disconnect during API admission cannot resurrect the connection");await admissionBrowser.close();
    phase="Chrome target picker and selection";let view=await browser.connect(sessionId);assert.equal(view.status,"connected");assert.ok(view.targets.some(target=>target.origin===fixture.origin));assert.equal(view.targets.some(target=>target.origin===fixture.controlOrigin),false,"an already-open Sigma control page is hidden from target selection");
    let sameOrigin=view.targets.filter(item=>item.origin===fixture.origin);assert.equal(sameOrigin.length,2);assert.deepEqual(sameOrigin.map(item=>item.label).sort(),["Fixture first tab","Fixture second tab"],"same-origin tabs stay distinguishable in the picker");
    const target=sameOrigin.find(item=>item.label==="Fixture first tab")!,firstVisibleBefore=fixture.events["visibility:visible:/"]||0;view=await browser.select(sessionId,target.id);assert.equal(view.selected?.id,target.id);await waitFor(()=>(fixture.events["visibility:visible:/"]||0)>firstVisibleBefore?true:undefined);
    const otherTab=sameOrigin.find(item=>item.label==="Fixture second tab")!,secondVisibleBefore=fixture.events["visibility:visible:/second"]||0;view=await browser.select(sessionId,otherTab.id);assert.equal(view.selected?.id,otherTab.id);await waitFor(()=>(fixture.events["visibility:visible:/second"]||0)>secondVisibleBefore?true:undefined);
    view=await browser.refresh(sessionId);sameOrigin=view.targets.filter(item=>item.origin===fixture.origin);assert.ok(sameOrigin.some(item=>item.label==="Fixture second tab"),"Chrome supplies the final tab title after the selected page loads");
    const firstVisibleAgain=fixture.events["visibility:visible:/"]||0;view=await browser.select(sessionId,target.id);assert.equal(view.status,"selected");assert.equal(view.selected?.label,"Fixture first tab");await waitFor(()=>(fixture.events["visibility:visible:/"]||0)>firstVisibleAgain?true:undefined);
    phase="Pi screenshot tool call";providerState.errorSeen=false;const prompt=piHost.prompt(sessionId,"browser-fixture:screenshot");
    const approval=await waitFor(()=>piHost.snapshot(sessionId).then(snapshot=>snapshot.approvals.find(item=>item.tool==="browser_action"&&item.status==="pending")));
    assert.ok(approval);
    assert.equal(approval.preview.includes(fixture.origin),true);assert.equal(approval.preview.includes("fixture-auth"),false);
    await piHost.decide(sessionId,approval.id,true);await prompt;
    await waitFor(()=>piHost.snapshot(sessionId).then(snapshot=>snapshot.status==="settled"?snapshot:undefined));
    assert.equal(providerState.errorSeen,false);assert.equal(providerState.imageSeen,true,"Pi receives the actual PNG image block from the selected tab");
    view=await browser.view(sessionId);const firstShot=view.artifacts.at(-1)!;
    assert.equal(firstShot.mime,"image/png");assert.equal(statSync(join(data,"browser-use",sessionId,`${firstShot.id}.png`)).mode&0o777,0o600);
    const stored=readFileSync(join(data,"browser-use",sessionId,`${firstShot.id}.png`));assert.deepEqual(pngInfo(stored),{width:firstShot.width,height:firstShot.height});
    const approvalRows=await piHost.snapshot(sessionId);assert.ok(approvalRows.approvals.some(item=>item.tool==="browser_action"&&item.status==="approved"));

    const piScreenshot=async()=>{
      providerState.imageSeen=false;providerState.errorSeen=false;
      const turn=piHost.prompt(sessionId,"browser-fixture:screenshot");
      const pending=await waitFor(()=>piHost.snapshot(sessionId).then(snapshot=>snapshot.approvals.find(item=>item.tool==="browser_action"&&item.status==="pending")));
      await piHost.decide(sessionId,pending.id,true);await turn;
      await waitFor(()=>piHost.snapshot(sessionId).then(snapshot=>snapshot.status==="settled"?snapshot:undefined));
    };

    phase="Pi screenshot safety across iframe and shadow DOM";
    for(const [path,label] of [["/iframe","Iframe OTP fixture"],["/shadow-otp","Shadow OTP fixture"],["/uninspectable","Cross-origin child fixture"]] as const){
      const pageId=await createFixtureTab(endpoint);await loadFixtureTab(endpoint,pageId,`${fixture.origin}${path}`);
      view=await browser.refresh(sessionId);const page=view.targets.find(item=>item.label===label);assert.ok(page,`${label} is available for explicit selection`);await browser.select(sessionId,page.id);
      const artifactsBeforeSafety:number=(await browser.view(sessionId)).artifacts.length;await piScreenshot();
      assert.equal(providerState.errorSeen,true,`${label} is rejected before its screenshot reaches Pi`);
      assert.equal(providerState.imageSeen,false,`${label} does not attach an image to Pi history`);
      assert.equal((await browser.view(sessionId)).artifacts.length,artifactsBeforeSafety,`${label} does not create a screenshot artifact`);
      if(path==="/iframe")assert.ok(!(await browser.view(sessionId)).actions.at(-1)?.detail?.includes("SYNTHETIC_OTP_FRAME_984201"));
      if(path==="/shadow-otp")assert.ok(!(await browser.view(sessionId)).actions.at(-1)?.detail?.includes("SYNTHETIC_OTP_SHADOW_276410"));
    }
    view=await browser.refresh(sessionId);const firstSafeTab=view.targets.find(item=>item.label==="Fixture first tab")!;await browser.select(sessionId,firstSafeTab.id);

    phase="coordinate, scroll and action approvals";const allow=async()=>true,call=async(id:string,kind:any,input:any)=>browser!.act(sessionId,id,kind,input,allow,true),info=(value:any)=>parseReceipt(value),latestObservation=async()=>observation(await call(`shot-${crypto.randomUUID()}`,"screenshot",{}));
    const initialObservation=await latestObservation();assert.ok(initialObservation);
    phase="control-plane destination aliases and protected target filtering";
    const protectedPort=Number(new URL(fixture.controlOrigin).port),beforeControlView=await browser.view(sessionId),beforeControlApprovals=(await piHost.snapshot(sessionId)).approvals.length;let controlApprovalCalls=0;
    const blockedHosts=["localhost","localhost.","nested.localhost","localhost.localdomain","127.0.0.1","127.1","2130706433","0x7f000001","[::1]","[::ffff:127.0.0.1]","[::ffff:7f00:1]","0.0.0.0"];
    for(let index=0;index<blockedHosts.length;index++)await assert.rejects(()=>browser!.act(sessionId,`control-destination-${index}`,"navigate",{url:`http://${blockedHosts[index]}:${protectedPort}/api/bootstrap`,observationId:initialObservation},async()=>{controlApprovalCalls++;return true;},true),/Sigma control pages cannot be opened through browser tools/);
    const afterControlView=await browser.view(sessionId);assert.equal(controlApprovalCalls,0,"control-page destinations are rejected before approval");assert.equal(afterControlView.actions.length,beforeControlView.actions.length,"blocked destinations create no action rows");assert.equal(afterControlView.artifacts.length,beforeControlView.artifacts.length,"blocked destinations create no artifacts");assert.equal((await piHost.snapshot(sessionId)).approvals.length,beforeControlApprovals,"blocked destinations create no Pi approval");assert.equal(fixture.controlBootstrapHits,0,"no control-plane bootstrap request is dispatched");assert.equal(afterControlView.selected?.origin,fixture.origin,"a blocked destination leaves the selected project tab unchanged");
    phase="user navigation to a control page while screenshot approval is pending";
    const pendingTab=await createFixtureTab(endpoint);await loadFixtureTab(endpoint,pendingTab,`${fixture.origin}/control-pending`);view=await browser.refresh(sessionId);const pendingTarget=view.targets.find(item=>item.label==="Control pending fixture");assert.ok(pendingTarget);await browser.select(sessionId,pendingTarget!.id);
    const artifactsBeforePendingControl=(await browser.view(sessionId)).artifacts.length;let controlApprovalReached=false,finishControlApproval!:(approved:boolean)=>void;
    const pendingControlScreenshot=browser.act(sessionId,"control-user-navigation-screenshot","screenshot",{},async()=>{controlApprovalReached=true;return await new Promise<boolean>(resolve=>{finishControlApproval=resolve;});},true);void pendingControlScreenshot.catch(()=>{});
    await waitFor(()=>controlApprovalReached?true:undefined);await loadFixtureTab(endpoint,pendingTab,`${fixture.controlOrigin}/ui`);await waitFor(async()=>{const current=await browser!.view(sessionId);return current.status==="connected"&&!current.selected?current:undefined;});finishControlApproval(true);
    await assert.rejects(()=>pendingControlScreenshot,/selected tab reached Sigma's local control page and was detached/);view=await browser.view(sessionId);assert.equal(view.actions.at(-1)?.status,"cancelled","a screenshot waiting for approval is cancelled after the selected tab enters Sigma UI");assert.equal(view.artifacts.length,artifactsBeforePendingControl,"the protected page is not retained as a screenshot artifact");assert.equal(fixture.controlBootstrapHits,0,"the protected UI fixture did not receive a bootstrap action");
    phase="redirect into a control page";const redirectTab=await createFixtureTab(endpoint);await loadFixtureTab(endpoint,redirectTab,`${fixture.origin}/control-redirect-start`);view=await browser.refresh(sessionId);const redirectTarget=view.targets.find(item=>item.label==="Control redirect fixture");assert.ok(redirectTarget);await browser.select(sessionId,redirectTarget!.id);
    const redirectObservation=await latestObservation(),artifactsBeforeRedirect=(await browser.view(sessionId)).artifacts.length,redirectResult=await call("redirect-into-control-page","navigate",{url:`${fixture.origin}/redirect-control`,observationId:redirectObservation}),redirectReceipt=info(redirectResult);
    assert.equal(redirectReceipt.status,"done","a completed redirect into a control page has a truthful receipt");assert.equal(redirectResult.content.some((part:any)=>part.type==="image"),false,"redirecting to Sigma UI never returns a screenshot");assert.equal((await browser.view(sessionId)).artifacts.length,artifactsBeforeRedirect,"redirecting to Sigma UI stores no screenshot artifact");assert.equal((await browser.view(sessionId)).selected,null,"a protected redirect detaches the selected target");assert.equal(fixture.controlBootstrapHits,0,"the control-page redirect does not bootstrap Sigma");
    view=await browser.refresh(sessionId);const firstSafeAfterControl=view.targets.find(item=>item.label==="Fixture first tab");assert.ok(firstSafeAfterControl);await browser.select(sessionId,firstSafeAfterControl!.id);const reselectedObservation=await latestObservation();
    const css=await waitFor(()=>fixture.viewport);
    const pixel=(x:number,y:number,artifact:typeof firstShot)=>({x:x*artifact.width/css.width,y:y*artifact.height/css.height});
    assert.ok(firstShot.width>=css.width&&firstShot.height>=css.height,"screenshot pixels must cover CSS viewport coordinates at DPR 2");

    const clickReceipt=info(await call("click-target","click",{...pixel(90,70,firstShot),observationId:reselectedObservation}));assert.equal(clickReceipt.status,"done");
    await waitFor(()=>fixture.events["click:"]===1?true:undefined);assert.equal(fixture.events["click:"],1);
    const replayedClick=info(await call("click-target","click",{...pixel(90,70,firstShot),observationId:reselectedObservation}));assert.equal(replayedClick.status,"done");assert.equal(fixture.events["click:"],1,"an identical completed action ID returns its saved receipt without another click");
    const idempotentShotId=`idempotent-shot-${crypto.randomUUID()}`,idempotentShot=info(await call(idempotentShotId,"screenshot",{})),artifactCountBeforeRetry=(await browser.view(sessionId)).artifacts.length;
    const idempotentRetry=info(await call(idempotentShotId,"screenshot",{}));assert.equal(idempotentRetry.artifact.id,idempotentShot.artifact.id);assert.equal((await browser.view(sessionId)).artifacts.length,artifactCountBeforeRetry,"an identical completed screenshot retry returns the same artifact without storing another one");
    const inputEventsBeforeConflict=fixture.events["input:"]||0;
    await assert.rejects(()=>call(idempotentShotId,"type",{text:"must not be typed",observationId:idempotentShot.observationId}),/already used for different arguments/);
    assert.equal(fixture.events["input:"]||0,inputEventsBeforeConflict,"a completed screenshot ID cannot be reused for a different typing request");
    const scrollObservation=await latestObservation(),beforeScroll=(await browser.view(sessionId)).artifacts.at(-1)!,scrollStart=fixture.scrollY;
    const down=info(await call("scroll-down","scroll",{...pixel(400,500,beforeScroll),deltaX:0,deltaY:450,observationId:scrollObservation}));assert.equal(down.status,"done");await waitFor(()=>fixture.scrollY>scrollStart?fixture.scrollY:undefined);
    const downY=fixture.scrollY,up=info(await call("scroll-up","scroll",{...pixel(400,500,(await browser.view(sessionId)).artifacts.at(-1)!),deltaX:0,deltaY:-200,observationId:down.observationId}));assert.equal(up.status,"done");await waitFor(()=>fixture.scrollY<downY?fixture.scrollY:undefined);

    const stopObservation=await latestObservation(),clicksBeforeStop=fixture.events["click:"],artifactsBeforeStop=(await browser.view(sessionId)).artifacts.length;
    let approvalReached=false,finishApproval!:(approved:boolean)=>void;
    const pendingAction=browser.act(sessionId,"stop-before-send","click",{...pixel(90,70,(await browser.view(sessionId)).artifacts.at(-1)!),observationId:stopObservation},async()=>{approvalReached=true;return await new Promise<boolean>(resolve=>{finishApproval=resolve;});},true);
    void pendingAction.catch(()=>{});
    await waitFor(()=>approvalReached?true:undefined);const release=piHost.stopFence(sessionId);
    try{finishApproval(true);await assert.rejects(()=>pendingAction,/Chrome access was stopped/);}finally{release();}
    assert.equal(fixture.events["click:"],clicksBeforeStop,"Stop fences a click waiting for approval before dispatch");
    assert.equal((await browser.view(sessionId)).artifacts.length,artifactsBeforeStop,"cancelled pre-dispatch actions do not publish screenshots");
    assert.ok((await browser.view(sessionId)).actions.some(item=>item.status==="cancelled"&&item.kind==="click"));
    assert.equal(child.exitCode,null,"session Stop detaches without closing the Chrome process");
    phase="Stop and reconnect";const afterStop=await browser.connect(sessionId);view=await browser.select(sessionId,afterStop.targets.find(item=>item.label==="Fixture first tab")!.id);

    phase="authenticated navigation and unknown outcome";const navigationObservation=await latestObservation();await call("navigate-fixture","navigate",{url:`${fixture.origin}/next`,observationId:navigationObservation});await waitFor(()=>fixture.cookieSeen?true:undefined);assert.equal(fixture.cookieSeen,true,"the existing Chrome profile's synthetic fixture cookie stays attached to the tab");

    const crossOriginObservation=await latestObservation();await call("navigate-cross-origin","navigate",{url:fixture.otherOrigin,observationId:crossOriginObservation});await waitFor(()=>browser!.view(sessionId).then(value=>value.selected?.origin===fixture.otherOrigin?true:undefined));
    assert.equal((await browser.view(sessionId)).selected?.host,new URL(fixture.otherOrigin).host,"selected origin metadata tracks a safe cross-origin navigation without retaining URL paths");
    assert.equal((await browser.view(sessionId)).actions.at(-1)?.target,fixture.otherOrigin,"completed action history records the current safe origin");
    const returnObservation=await latestObservation();await call("navigate-return","navigate",{url:`${fixture.origin}/`,observationId:returnObservation});await waitFor(()=>browser!.view(sessionId).then(value=>value.selected?.origin===fixture.origin?true:undefined));
    phase="same-document fragment navigation";const baseObservation=await latestObservation();await call("navigate-fragment-base","navigate",{url:`${fixture.origin}/pan`,observationId:baseObservation});
    const fragmentObservation=await latestObservation(),fragment=info(await call("navigate-fragment","navigate",{url:`${fixture.origin}/pan#same-document`,observationId:fragmentObservation}));
    assert.equal(fragment.status,"done","same-document navigation returns a completed receipt");assert.notEqual(fragment.observationId,fragmentObservation,"fragment changes invalidate the prior page observation");await waitFor(()=>fixture.events["hashchange:"]===1?true:undefined);
    await assert.rejects(()=>call(`stale-fragment-${crypto.randomUUID()}`,"click",{x:20,y:20,observationId:fragmentObservation}),/Observation is missing or stale/);
    phase="authenticated navigation and unknown outcome";const slowObservation=await latestObservation(),slowArgs={url:`${fixture.origin}/slow`,observationId:slowObservation},slowAction=call("unknown-slow-navigation","navigate",slowArgs);
    await waitFor(()=>fixture.slowHits===1?true:undefined);browser.revoke(sessionId);
    await assert.rejects(()=>slowAction,/Browser action outcome is unknown/);
    await waitFor(()=>fixture.slowResponses===1?true:undefined);
    view=await browser.view(sessionId);assert.ok(view.actions.some(item=>item.status==="unknown"&&item.kind==="navigate"));
    await browser.connect(sessionId);view=await browser.refresh(sessionId);const same=view.targets.find(item=>item.label==="Slow outcome fixture");assert.ok(same,"the uncertain navigation reaches the fixture's final page");await browser.select(sessionId,same!.id);
    const afterReconnect=await latestObservation();
    await assert.rejects(()=>call("unknown-slow-navigation","navigate",slowArgs),/unknown outcome and was not replayed/);
    await assert.rejects(()=>call("unknown-slow-navigation","navigate",{url:`${fixture.origin}/slow`,observationId:afterReconnect}),/already used for different arguments/);
    assert.equal(fixture.slowHits,1,"the uncertain navigation is never automatically replayed");

    phase="pinch-pan coordinate calibration";const panNavigation=await latestObservation();await call("navigate-pan-fixture","navigate",{url:`${fixture.origin}/pan`,observationId:panNavigation});
    const panEndpoint=readChromeEndpoint(home);await pinchFixtureTab(panEndpoint,`${fixture.origin}/pan`);
    const viewport=await waitFor(async()=>{const value=await fixtureVisualViewport(panEndpoint,`${fixture.origin}/pan`);return value.scale>1.5&&value.offsetX>10&&value.offsetY>10?value:undefined;});
    const panObservation=await latestObservation(),panShot=(await browser.view(sessionId)).artifacts.at(-1)!,panX=(560-viewport.offsetX)*panShot.width/viewport.clientWidth,panY=(330-viewport.offsetY)*panShot.height/viewport.clientHeight;
    assert.ok(panX>=0&&panX<panShot.width&&panY>=0&&panY<panShot.height,"panned target remains inside the screenshot viewport");
    const panClick=info(await call("pan-coordinate-click","click",{x:panX,y:panY,observationId:panObservation}));assert.equal(panClick.status,"done");await waitFor(()=>fixture.events["pan-click:"]===1?true:undefined);assert.equal(fixture.events["pan-click:"],1,"pinch-pan screenshot coordinates map to the visible target without adding viewport offsets");
    phase="credential screenshot guard";const nextObservation=await latestObservation();await call("reveal-sensitive","navigate",{url:`${fixture.origin}/`,observationId:nextObservation});
    const revealObservation=await latestObservation(),beforeSensitive=(await browser.view(sessionId)).artifacts.length,revealShot=(await browser.view(sessionId)).artifacts.at(-1)!;
    await call("reveal-field","click",{...pixel(460,62,revealShot),observationId:revealObservation});
    const revealed=(await browser.view(sessionId));assert.equal(revealed.artifacts.length,beforeSensitive,"a credential screen is never stored as a screenshot");assert.equal(revealed.actions.at(-1)?.status,"done");assert.match(revealed.actions.at(-1)?.detail||"",/screenshot blocked/);
    const denyShotId=`credential-screenshot-${crypto.randomUUID()}`,beforeDenied=(await browser.view(sessionId)).artifacts.length;
    await assert.rejects(()=>call(denyShotId,"screenshot",{}),/Screenshots are blocked while a visible credential/);
    assert.equal((await browser.view(sessionId)).artifacts.length,beforeDenied,"a denied screenshot does not create an artifact");

    phase="unsupported file target invalidation";const file=join(scratch,"outside-page.html");writeFileSync(file,"<!doctype html><title>Outside browser page</title>");
    assert.equal((await browser.view(sessionId)).status,"selected","the selected original tab remains active through safe HTTP navigation");
    const liveEndpoint=readChromeEndpoint(home),control=await NativeChromeCdp.connect(liveEndpoint,10_000),targetId=firstFixtureTab;
    const currentTarget=(await control.command("Target.getTargets")).targetInfos.find((item:any)=>item.targetId===targetId);assert.equal(currentTarget?.url,`${fixture.origin}/`,"the directly navigated target is the currently selected HTTP tab");
    const attached=await control.command("Target.attachToTarget",{targetId,flatten:true});
    try{await control.command("Page.enable",{},attached.sessionId);await control.command("Page.navigate",{url:new URL(`file://${file}`).toString()},attached.sessionId);await waitFor(()=>browser!.view(sessionId).then(value=>value.status==="connected"&&!value.selected?true:undefined));
      await assert.rejects(()=>call(`outside-protocol-${crypto.randomUUID()}`,"screenshot",{}),/Select an existing Chrome tab/);
    }finally{await control.command("Target.detachFromTarget",{sessionId:attached.sessionId}).catch(()=>{});control.close();}
    phase="key, focus binding and typing";view=await browser.refresh(sessionId);const safeTab=view.targets.find(item=>item.label==="Fixture second tab")!;view=await browser.select(sessionId,safeTab.id);
    const keyObservation=await latestObservation(),keyReceipt=info(await call("key-fixture","key",{key:"Escape",observationId:keyObservation}));await waitFor(()=>fixture.events["key:"]===1?true:undefined);assert.equal(fixture.events["key:"],1);
    const keyShot=(await browser.view(sessionId)).artifacts.at(-1)!,inputPoint=pixel(270,58,keyShot),clickField=info(await call("focus-input","click",{...inputPoint,observationId:keyReceipt.observationId}));
    let focusApprovalReached=false,finishFocusApproval!:(approved:boolean)=>void;
    const focusChangedType=browser.act(sessionId,"reject-safe-focus-change","type",{text:"must not be inserted",observationId:clickField.observationId},async()=>{focusApprovalReached=true;return await new Promise<boolean>(resolve=>{finishFocusApproval=resolve;});},true);
    void focusChangedType.catch(()=>{});
    await waitFor(()=>focusApprovalReached?true:undefined);await focusFixtureInput(liveEndpoint,`${fixture.origin}/second`,270,108);finishFocusApproval(true);
    await assert.rejects(()=>focusChangedType,/Focus changed while approval was pending/);assert.equal(fixture.events["input:"]||0,0,"a different safe field never receives approved text after focus changes");
    await focusFixtureInput(liveEndpoint,`${fixture.origin}/second`,270,58);const typeObservation=await latestObservation();
    const typeReceipt=info(await call("type-fixture","type",{text:"fixture text",observationId:typeObservation}));assert.equal(typeReceipt.status,"done");await waitFor(()=>fixture.events["input:"]===1?true:undefined);assert.equal(fixture.events["input:"],1);

    phase="open shadow root focus binding";const shadowSafeId=await createFixtureTab(liveEndpoint);await loadFixtureTab(liveEndpoint,shadowSafeId,`${fixture.origin}/shadow-safe`);
    view=await browser.refresh(sessionId);const shadowSafe=view.targets.find(item=>item.label==="Open shadow focus fixture")!;await browser.select(sessionId,shadowSafe.id);
    await focusShadowFixtureInput(liveEndpoint,`${fixture.origin}/shadow-safe`,"shadow-a");const shadowObservation=await latestObservation();let shadowApprovalReached=false,finishShadowApproval!:(approved:boolean)=>void;
    const shadowType=browser.act(sessionId,"reject-shadow-focus-change","type",{text:"must not reach the other shadow field",observationId:shadowObservation},async()=>{shadowApprovalReached=true;return await new Promise<boolean>(resolve=>{finishShadowApproval=resolve;});},true);
    void shadowType.catch(()=>{});
    phase="open shadow root focus binding: wait for approval";await waitFor(()=>shadowApprovalReached?true:undefined);await focusShadowFixtureInput(liveEndpoint,`${fixture.origin}/shadow-safe`,"shadow-b");finishShadowApproval(true);
    await assert.rejects(()=>shadowType,/Focus changed while approval was pending/);assert.equal(fixture.events["shadow-input:"]||0,0,"approved typing never follows a changed focus into another open-shadow field");
    phase="open shadow root focus binding: observe and type";await focusShadowFixtureInput(liveEndpoint,`${fixture.origin}/shadow-safe`,"shadow-a");const shadowTypeObservation=await latestObservation();
    const shadowTyped=info(await call("type-open-shadow","type",{text:"allowed fixture text",observationId:shadowTypeObservation}));assert.equal(shadowTyped.status,"done");phase="open shadow root focus binding: verify input delivery";await waitFor(()=>fixture.events["shadow-input:"]===1?true:undefined);assert.equal(fixture.events["shadow-input:"],1,"the actual editable leaf inside an open shadow root is controlled safely");

    phase="restart unknown recovery";const recoveryId=`restart-${crypto.randomUUID()}`,origin=fixture.origin;
    await storage.call("addBrowserAction",{id:recoveryId,sessionId,kind:"click",target:origin,status:"proposed",detail:"Fixture recovery row",createdAt:Date.now(),endedAt:null});
    await storage.call("browserActionTransition",{id:recoveryId,from:"proposed",to:"approved",patch:{}});
    await storage.call("browserActionTransition",{id:recoveryId,from:"approved",to:"dispatched",patch:{detail:"Command sent to selected tab"}});
    await browser.close();await host.close();host=undefined;await storage.close();
    storage=new Storage(join(data,"state.sqlite"));assert.equal((await storage.call<any>("browserAction",{id:recoveryId})).status,"unknown","restart recovery converts durable dispatch to unknown without replay");
  }catch(error){throw new Error(`${phase}: ${error instanceof Error?error.message:"browser test failed"}`);}finally{
    try{browser?.close();}catch{}
    try{await host?.close();}catch{}
    try{await storage.close();}catch{}
    if(child)await killChrome(child);await fixture.close();rmSync(scratch,{recursive:true,force:true});
    for(const key of envKeys){const value=oldEnv.get(key);if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
});
