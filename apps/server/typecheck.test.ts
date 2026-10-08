import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PiHost } from "./pi-host.js";
import { Storage } from "./storage.js";
import { Verification } from "./verification.js";

const root=resolve(import.meta.dirname,"../..");
const scratch=join(process.env.SIGMA_TEST_DIR||join(root,".scratch"),`typecheck-${Date.now()}-${process.pid}`);
process.env.PI_OFFLINE="1";process.env.SIGMA_DEMO="1";process.env.PI_CODING_AGENT_DIR=join(scratch,"agent");
const git=(cwd:string,...args:string[])=>execFileSync("git",["-C",cwd,"-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false",...args],{env:{...process.env,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_AUTHOR_NAME:"Fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"Fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid"}});
async function waitFor<T>(read:()=>Promise<T|false>,ms=180000){const end=Date.now()+ms;while(Date.now()<end){const value=await read();if(value)return value;await new Promise(r=>setTimeout(r,40));}throw new Error("Timed out waiting for TypeScript check");}

test("approved direct TypeScript check uses selected files and copied dependency bytes",async t=>{
  if(process.platform!=="darwin"){t.skip("Native sandbox profile is macOS-only");return;}
  const source=join(scratch,"source"),data=join(scratch,"data");await mkdir(source,{recursive:true});await mkdir(data);
  git(source,"init","-q","-b","main");
  await writeFile(join(source,".gitignore"),"node_modules/\n");
  await writeFile(join(source,"tsconfig.json"),JSON.stringify({compilerOptions:{strict:true,target:"ES2022",lib:["es2020"],skipLibCheck:true},files:["main.ts"]}));
  await writeFile(join(source,"main.ts"),"export const value: number = 1;\n");
  git(source,"add","--",".");git(source,"commit","-qm","base");
  await cp(join(root,"node_modules","typescript"),join(source,"node_modules","typescript"),{recursive:true});
  const storage=new Storage(join(data,"state.sqlite")),host=new PiHost(storage,data,async()=>{});await host.init();
  const verification=new Verification(storage,host,data,async()=>{});
  try{
    const sid=await host.create(source,"sigma-demo/offline",crypto.randomUUID(),"code",{workspaceMode:"worktree"});
    const first=await verification.prepareTypecheck(sid,crypto.randomUUID(),"tsconfig.json",[]);
    assert.equal(first.kind,"typescript");assert.ok(first.dependencyDigest);assert.match(first.argv.join(" "),/typescript\/bin\/tsc --noEmit -p/);
    const direct=await host.create(source,"sigma-demo/offline",crypto.randomUUID(),"code");
    assert.equal((await host.snapshot(direct)).cwd,source);
    assert.equal((await verification.prepareTypecheck(direct,crypto.randomUUID(),"tsconfig.json",[])).kind,"typescript");
    const priorUmask=process.umask(0o077);
    try{await verification.decide(sid,first.id,true);const passed=await waitFor(async()=>{const row=(await verification.evidence(sid)).checks.find(x=>x.id===first.id);return row&&!["pending","approved","running"].includes(row.status)?row:false;});assert.equal(passed.status,"passed",passed.output);}
    finally{process.umask(priorUmask);}
    assert.equal((await stat(join(first.cwd,"main.ts"))).mode&0o777,0o644);
    assert.equal((await stat(join(first.cwd,"typescript","bin","tsc"))).mode&0o777,(await stat(join(source,"node_modules","typescript","bin","tsc"))).mode&0o777);
    const privatePath=join(data,"private-fixture.txt");await writeFile(privatePath,"fixture only\n");
    const guard=join(first.cwd,"guard.mjs");
    await writeFile(guard,`import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {connect} from 'node:net';
const code=fn=>{try{fn();return 'allowed';}catch(error){return error.code;}};
const network=await new Promise(resolve=>{const socket=connect(9,'127.0.0.1');socket.once('error',error=>resolve(error.code));socket.once('connect',()=>{socket.destroy();resolve('allowed');});});
process.stdout.write(JSON.stringify({source:code(()=>readFileSync(${JSON.stringify(join(source,"main.ts"))})),private:code(()=>readFileSync(${JSON.stringify(privatePath)})),write:code(()=>writeFileSync(${JSON.stringify(join(source,"blocked-fixture.txt"))},'blocked')),fork:spawnSync(process.execPath,['-e','0']).error?.code??'allowed',network}));`);
    const profile=(verification as unknown as {profile(cwd:string,node:string):string}).profile(first.cwd,process.execPath);
    const denied=JSON.parse(execFileSync("/usr/bin/sandbox-exec",["-p",profile,process.execPath,guard],{encoding:"utf8",timeout:30000,env:{PATH:"/usr/bin:/bin",HOME:first.cwd,TMPDIR:first.cwd,LC_ALL:"C"}}));
    for(const key of ["source","private","write","fork","network"])assert.equal(denied[key],"EPERM",`${key} escaped the TypeScript sandbox profile`);
    await assert.rejects(stat(join(source,"blocked-fixture.txt")));
    const copy=(await host.snapshot(sid)).cwd;await writeFile(join(copy,"main.ts"),"export const value: number = 'wrong';\n");
    const second=await verification.prepareTypecheck(sid,crypto.randomUUID(),"tsconfig.json",[]);await verification.decide(sid,second.id,true);
    const failed=await waitFor(async()=>{const row=(await verification.evidence(sid)).checks.find(x=>x.id===second.id);return row&&!["pending","approved","running"].includes(row.status)?row:false;});
    assert.equal(failed.status,"failed",failed.output);assert.equal(failed.exitCode,2);assert.match(failed.output,/TS2322/);
    assert.equal((await verification.evidence(sid)).checks.find(x=>x.id===first.id)?.current,false);
    const stale=await verification.prepareTypecheck(sid,crypto.randomUUID(),"tsconfig.json",[]);
    const dependency=join(source,"node_modules","typescript","package.json");await writeFile(dependency,(await readFile(dependency,"utf8"))+"\n");
    await assert.rejects(verification.decide(sid,stale.id,true),/changed/);
    const staleEvidence=await verification.evidence(sid);
    assert.equal(staleEvidence.checks.filter(check=>check.kind==="typescript").every(check=>!check.current),true);
    await assert.rejects(stat(stale.cwd));
  }finally{await verification.close();await host.close();await storage.close();}
});
