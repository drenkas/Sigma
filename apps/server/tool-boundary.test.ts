import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile, symlink, link, rename } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { promisify } from "node:util";

const exec=promisify(execFile),fixture=await mkdtemp(resolve(".scratch/f1-f2-check-"));
// Only synthetic credentials and offline SDK state. No inherited provider env or home.
for(const key of Object.keys(process.env))if(!["PATH","TMPDIR","USER","SIGMA_APPROVAL_MODE"].includes(key))delete process.env[key];
process.env.HOME=fixture;process.env.PI_CODING_AGENT_DIR=join(fixture,"sdk");process.env.PI_OFFLINE="1";process.env.SIGMA_DEMO="1";
const {PiHost}=await import("./pi-host.js"),{Storage}=await import("./storage.js"),{createAssistantMessageEventStream}=await import("@earendil-works/pi-ai");
async function waitFor<T>(check:()=>Promise<T|undefined>):Promise<T>{const until=Date.now()+10000;while(Date.now()<until){const value=await check();if(value!==undefined)return value;await new Promise(r=>setTimeout(r,10));}throw new Error("Offline fixture wait expired");}
async function git(cwd:string,...args:string[]){await exec("git",["-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false",...args],{cwd,env:{PATH:process.env.PATH,HOME:fixture,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_AUTHOR_NAME:"Fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"Fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid"}});}

test("offline Pi file tools guard credential aliases and bind approval to the actual read descriptor",async()=>{
  const data=join(fixture,"data"),outside=join(fixture,"outside");await mkdir(data);await mkdir(outside);
  const sentinel="sigma-f1-f2-synthetic-protected-bytes",outsideSentinel="sigma-f1-f2-synthetic-outside-bytes";
  const protectedFiles=["data/antigravity-profile/.gemini/antigravity-cli/auth_tokens.json","data/cliproxyapi/provider-token.json","data/agent/token.txt","sdk/provider-token.txt"];
  for(const path of protectedFiles){await mkdir(join(fixture,path,".."),{recursive:true});await writeFile(join(fixture,path),sentinel);}
  await writeFile(join(outside,"sentinel.txt"),outsideSentinel);await writeFile(join(fixture,"safe.txt"),"first\nsecond\nthird\n");
  await writeFile(join(fixture,".gitignore"),"*\n!safe.txt\n!new.txt\n!.gitignore\n!write-parent/\n!write-parent/view.txt\n");
  await git(fixture,"init","-b","main");await git(fixture,"add","safe.txt",".gitignore");await git(fixture,"commit","-m","Fixture");
  const storage=new Storage(join(data,"state.sqlite")),host=new PiHost(storage,data,async()=>{});await host.init();
  let leakedToModel=false;
  const runtime=(host as any).runtime,originalStream=runtime.streamSimple.bind(runtime);
  runtime.streamSimple=(model:any,context:any,options:any)=>{
    leakedToModel ||= context.messages.some((message:any)=>message.role==="toolResult"&&[sentinel,outsideSentinel].some(value=>JSON.stringify(message.content).includes(value)));
    const last=context.messages.at(-1);
    const input=typeof last?.content==="string"?last.content:last?.content?.filter((part:any)=>part.type==="text").map((part:any)=>part.text).join("");
    if(last?.role!=="user"||!input?.startsWith("tool:"))return originalStream(model,context,options);
    const {name,args}=JSON.parse(input.slice(5)),stream=createAssistantMessageEventStream();
    const message:any={role:"assistant",content:[{type:"toolCall",id:crypto.randomUUID(),name,arguments:args}],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"toolUse",timestamp:Date.now()};
    queueMicrotask(()=>{stream.push({type:"start",partial:message});stream.push({type:"toolcall_start",contentIndex:0,partial:message});stream.push({type:"toolcall_end",contentIndex:0,toolCall:message.content[0],partial:message});stream.push({type:"done",reason:"toolUse",message});stream.end();});return stream;
  };
  const originalOpen=fs.openSync,originalRead=fs.readFileSync;
  try{
    const sid=await host.create(fixture,"sigma-demo/offline"),code=await host.create(fixture,"sigma-demo/offline",crypto.randomUUID(),"code");
    const settled=(id:string)=>waitFor(async()=>(await host.snapshot(id)).status==="settled"?true:undefined);
    const pending=(id:string)=>waitFor(async()=>(await host.snapshot(id)).approvals.find(item=>item.status==="pending"));
    const prompt=(id:string,name:string,args:unknown)=>host.prompt(id,`tool:${JSON.stringify({name,args})}`);
    const result=async(id:string)=>{const row=await storage.call<any>("session",{id});const entries=(await readFile(row.file,"utf8")).trim().split("\n").map(line=>JSON.parse(line));return entries.filter(entry=>entry.type==="message"&&entry.message.role==="toolResult").at(-1)?.message;};
    const evidence:Array<Record<string,unknown>>=[];
    for(const [index,path] of protectedFiles.entries()){
      const alias=`credential-alias-${index}`;await symlink(join(fixture,path,".."),join(fixture,alias));
      for(const target of [path,`${alias}/${path.split("/").at(-1)}`]){
        for(const name of ["read","ls","edit","write"]){
          const id=["edit","write"].includes(name)?code:sid;
          const args=name==="ls"?{path:target.slice(0,target.lastIndexOf("/"))}:name==="write"?{path:target,content:"must not write"}:name==="edit"?{path:target,edits:[{oldText:"harmless match",newText:"must not edit"}]}:{path:target};
          const count=(await host.snapshot(id)).approvals.length;await prompt(id,name,args);await waitFor(async()=>{const view=await host.snapshot(id);return view.status==="settled"||view.approvals.some(item=>item.status==="pending")?true:undefined;});
          assert.equal((await host.snapshot(id)).approvals.length,count,`${name} ${target} must reject before Allow`);assert.equal((await result(id)).isError,true);
        }
      }
      assert.equal(await readFile(join(fixture,path),"utf8"),sentinel);
    }
    // Effective SDK path resolution (@ prefix) gets the same guard.
    await prompt(sid,"read",{path:`@${protectedFiles[0]}`});await settled(sid);assert.equal((await result(sid)).isError,true);
    await link(join(fixture,protectedFiles[0]),join(fixture,"hardlink.txt"));await prompt(sid,"read",{path:"hardlink.txt"});await settled(sid);assert.equal((await result(sid)).isError,true);
    for(const phase of ["pending-outside","pending-protected","pending-directory","pending-replacement","open-outside","open-protected","open-directory","read-outside"]){
      const path=`${phase}.txt`,absolute=join(fixture,path),dir=join(fixture,`${phase}-parent`);
      const directory=phase.includes("directory");if(directory)await mkdir(dir);
      const target=directory?join(dir,"view.txt"):absolute;await writeFile(target,"harmless approved target");
      const replacement=join(fixture,`${phase}-replacement`);
      const protectedTarget=phase.includes("protected")?join(fixture,protectedFiles[1]):join(outside,"sentinel.txt");
      const swap=()=>{
        if(directory){fs.renameSync(dir,`${dir}-original`);fs.symlinkSync(outside,dir);}
        else if(phase==="pending-replacement"){fs.writeFileSync(replacement,"different ordinary file");fs.renameSync(replacement,target);}
        else{fs.symlinkSync(protectedTarget,replacement);fs.renameSync(replacement,target);}
      };
      if(directory)await writeFile(join(outside,"view.txt"),outsideSentinel);
      await prompt(sid,"read",{path:relativePath(target)});const approval=await pending(sid);let fired=false;
      if(phase.startsWith("pending")){swap();fired=true;}
      else if(phase.startsWith("open")){
        fs.openSync=((path:any,...args:any[])=>{if(path===target&&!fired){fired=true;swap();}return (originalOpen as any)(path,...args);}) as typeof fs.openSync;syncBuiltinESMExports();
      }else{
        fs.readFileSync=((path:any,...args:any[])=>{if(typeof path==="number"&&!fired){fired=true;swap();}return (originalRead as any)(path,...args);}) as typeof fs.readFileSync;syncBuiltinESMExports();
      }
      await host.decide(sid,approval.id,true);await settled(sid);fs.openSync=originalOpen;fs.readFileSync=originalRead;syncBuiltinESMExports();
      assert.equal(fired,true,`${phase} reached the actual file boundary`);assert.equal((await result(sid)).isError,true,`${phase} rejects stale approval`);
      evidence.push({phase,rejected:true});
    }
    // SDK text slicing, image formatting, normal ls, Allow, Deny and Stop still work.
    await prompt(sid,"read",{path:"@safe.txt",offset:2,limit:1});let approval=await pending(sid);await host.decide(sid,approval.id,true);await settled(sid);assert.match(JSON.stringify((await result(sid)).content),/second/);assert.doesNotMatch(JSON.stringify((await result(sid)).content),/first/);
    const chunk=(name:string,bytes:Buffer)=>{const header=Buffer.alloc(4);header.writeUInt32BE(bytes.length);const content=Buffer.concat([Buffer.from(name),bytes]),crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(content));return Buffer.concat([header,content,crc]);};
    const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=2;
    const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ihdr),chunk("IDAT",deflateSync(Buffer.from([0,255,0,0]))),chunk("IEND",Buffer.alloc(0))]);await writeFile(join(fixture,"pixel.png"),png);
    await prompt(sid,"read",{path:"pixel.png"});approval=await pending(sid);await host.decide(sid,approval.id,true);await settled(sid);assert.equal((await result(sid)).content.some((part:any)=>part.type==="image"&&part.mimeType==="image/png"),true);
    await mkdir(join(fixture,"listing"));await writeFile(join(fixture,"listing","visible.txt"),"visible");await symlink(join(fixture,"data","cliproxyapi"),join(fixture,"listing","hidden"));
    await prompt(sid,"ls",{path:"listing",limit:1});approval=await pending(sid);await host.decide(sid,approval.id,true);await settled(sid);assert.equal((await result(sid)).content[0].text,"visible.txt");
    await prompt(sid,"ls",{path:"listing"});approval=await pending(sid);await rename(join(fixture,"listing"),join(fixture,"listing-original"));await symlink(outside,join(fixture,"listing"));await host.decide(sid,approval.id,true);await settled(sid);assert.equal((await result(sid)).isError,true);
    await prompt(sid,"read",{path:"safe.txt"});approval=await pending(sid);await host.decide(sid,approval.id,false);await settled(sid);assert.equal((await result(sid)).isError,true);
    await prompt(sid,"read",{path:"safe.txt"});approval=await pending(sid);await host.abort(sid);await assert.rejects(host.decide(sid,approval.id,true),/no longer pending/);
    // The edit SDK reads a preimage before constructing its approval diff. A parent
    // swapped at its open must not place outside bytes into that diff or history.
    const editParent=join(fixture,"edit-parent"),editTarget=join(editParent,"view.txt");await mkdir(editParent);await writeFile(editTarget,"harmless original");
    let editSwap=false;fs.openSync=((path:any,...args:any[])=>{if(path===editTarget&&!editSwap){editSwap=true;fs.renameSync(editParent,`${editParent}-original`);fs.symlinkSync(outside,editParent);}return (originalOpen as any)(path,...args);}) as typeof fs.openSync;syncBuiltinESMExports();
    const beforeEdit=(await host.snapshot(code)).approvals.length;await prompt(code,"edit",{path:"edit-parent/view.txt",edits:[{oldText:"harmless",newText:"changed"}]});await settled(code);fs.openSync=originalOpen;syncBuiltinESMExports();
    assert.equal(editSwap,true);assert.equal((await host.snapshot(code)).approvals.length,beforeEdit);assert.equal((await result(code)).isError,true);evidence.push({phase:"edit-preimage-parent",rejected:true});
    for(const name of ["edit","write"]){
      const path=name==="edit"?"safe.txt":"new.txt",target=join(fixture,path),replacement=join(fixture,`${name}-protected-swap`);
      await prompt(code,name,name==="edit"?{path,edits:[{oldText:"first",newText:"must not apply"}]}:{path,content:"must not apply"});approval=await pending(code);
      await symlink(join(fixture,protectedFiles[1]),replacement);await rename(replacement,target);await host.decide(code,approval.id,true);await settled(code);
      assert.equal((await result(code)).isError,true);assert.equal((await host.snapshot(code)).approvals.find(item=>item.id===approval.id)?.outcome,"failed");
      // Preserve the synthetic alias while restoring the ordinary path for smoke checks.
      await rename(target,join(fixture,`${name}-retained-alias`));if(name==="edit")await writeFile(target,"first\nsecond\nthird\n");evidence.push({phase:`${name}-pending-protected`,rejected:true});
    }
    const writeParent=join(fixture,"write-parent");await mkdir(writeParent);let writeSwap=false;
    await prompt(code,"write",{path:"write-parent/view.txt",content:"must not reach a credential directory"});approval=await pending(code);
    fs.openSync=((path:any,...args:any[])=>{if(typeof path==="string"&&path.startsWith(`${writeParent}/.pi-edit-`)&&!writeSwap){writeSwap=true;fs.renameSync(writeParent,`${writeParent}-original`);fs.symlinkSync(join(fixture,"data","cliproxyapi"),writeParent);}return (originalOpen as any)(path,...args);}) as typeof fs.openSync;syncBuiltinESMExports();
    await host.decide(code,approval.id,true);await settled(code);fs.openSync=originalOpen;syncBuiltinESMExports();assert.equal(writeSwap,true);assert.equal((await result(code)).isError,true);assert.equal((await host.snapshot(code)).approvals.find(item=>item.id===approval.id)?.outcome,"failed");
    assert.equal(fs.existsSync(join(fixture,"data","cliproxyapi","view.txt")),false);assert.equal(await readFile(join(fixture,protectedFiles[1]),"utf8"),sentinel);evidence.push({phase:"write-open-protected-parent",rejected:true});
    await prompt(code,"edit",{path:"safe.txt",edits:[{oldText:"first",newText:"changed"}]});approval=await pending(code);await host.decide(code,approval.id,true);await settled(code);assert.match(await readFile(join(fixture,"safe.txt"),"utf8"),/^changed/);
    await prompt(code,"write",{path:"new.txt",content:"allowed write"});approval=await pending(code);await host.decide(code,approval.id,true);await settled(code);assert.equal(await readFile(join(fixture,"new.txt"),"utf8"),"allowed write");
    for(const id of [sid,code]){const row=await storage.call<any>("session",{id}),history=await readFile(row.file,"utf8");for(const secret of [sentinel,outsideSentinel])assert.equal(history.includes(secret),false,"Protected bytes never enter persisted native history");}
    assert.equal(leakedToModel,false,"Protected bytes never enter the next model input");
    await writeFile(join(fixture,"evidence.json"),JSON.stringify({fixture,phases:evidence,protectedBytesInHistory:false,protectedBytesInModel:false},null,2));
    console.log(`F1/F2 evidence: ${join(fixture,"evidence.json")}`);
  }finally{fs.openSync=originalOpen;fs.readFileSync=originalRead;syncBuiltinESMExports();await host.close();await storage.close();}
  function relativePath(path:string){return path.slice(fixture.length+1);}
});
