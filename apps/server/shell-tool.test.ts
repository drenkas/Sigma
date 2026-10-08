import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { formatShellResult, killAllShells, protectedRoots, runShell, runningShells, sandboxProfile, scrubEnv } from "./shell-tool.js";

const root=resolve(import.meta.dirname,"../.."),scratch=join(process.env.SIGMA_TEST_DIR||join(root,".scratch"),`shell-${Date.now()}-${process.pid}`);
async function fixture(){
  await mkdir(scratch,{recursive:true});
  const base=await realpath(scratch),data=join(base,"data"),agent=join(base,"pi-agent"),work=join(data,"workspaces","w1"),outside=join(base,"project");
  for(const dir of [join(data,"cliproxyapi"),join(data,"antigravity-profile"),agent,work,outside])await mkdir(dir,{recursive:true});
  await writeFile(join(data,"agent-access.json"),'{"mode":"full"}');await writeFile(join(data,"cliproxyapi","auth.json"),"SECRET-PROXY");await writeFile(join(agent,"auth.json"),"SECRET-SDK");await writeFile(join(data,"state.sqlite"),"SECRET-STATE");
  const home=join(base,"home");await mkdir(join(home,".codex"),{recursive:true});await mkdir(join(home,".gemini"),{recursive:true});await mkdir(join(home,".cli-proxy-api"),{recursive:true});await mkdir(join(home,".tool","nested"),{recursive:true});
  await writeFile(join(home,".codex","auth.json"),"SECRET-CODEX");await writeFile(join(home,".codex","config.toml"),"public-codex");await writeFile(join(home,".gemini","oauth_creds.json"),"SECRET-GEMINI");await writeFile(join(home,".gemini","settings.json"),"public-gemini");
  await writeFile(join(home,".cli-proxy-api","a.json"),"SECRET-PROXYHOME");await writeFile(join(home,".tool","nested","credentials.json"),"SECRET-GENERIC");await writeFile(join(home,".tool","config.txt"),"public-tool");
  await writeFile(join(data,"sessions.txt"),"public-data");await writeFile(join(agent,"settings.json"),"public-agent");await writeFile(join(outside,"auth.json"),"public-project-auth");
  const denied=protectedRoots(data,agent,home,undefined);
  return {base,home,data,agent,work,outside,denied,run:(command:string,extra:Partial<Parameters<typeof runShell>[0]>={})=>runShell({command,cwd:extra.cwd??outside,timeoutMs:20_000,denied,...extra})};
}

test("protected paths cover credential files and credential-only folders, not whole folders", async()=>{
  const f=await fixture(),roots=protectedRoots(f.data,f.agent,"/Users/example","/elsewhere/data");
  for(const expected of [join(f.data,"agent-access.json"),join(f.data,"native-providers.json"),join(f.data,"state.sqlite"),join(f.data,"state.sqlite-wal"),join(f.data,"sigma.lock"),join(f.agent,"auth.json"),join(f.data,"agent","auth.json"),"/elsewhere/data/agent-access.json","/Users/example/.codex/auth.json","/Users/example/.gemini/oauth_creds.json","/Users/example/.gemini/google_accounts.json","/Users/example/.claude/.credentials.json","/Users/example/.claude/credentials.json"])assert.ok(roots.files.includes(expected),`${expected} must be denied`);
  for(const expected of [join(f.data,"cliproxyapi"),join(f.data,"antigravity-profile"),join(f.data,"git-intents"),"/elsewhere/data/cliproxyapi","/Users/example/.cli-proxy-api"])assert.ok(roots.dirs.includes(expected),`${expected} must be denied`);
  for(const whole of [f.data,f.agent,"/elsewhere/data","/Users/example","/Users/example/.gemini","/Users/example/.claude","/Users/example/.codex",join(f.data,"workspaces")])assert.ok(![...roots.dirs,...roots.files].includes(whole),`${whole} must stay accessible`);
  const profile=sandboxProfile(roots);
  assert.match(profile,/^\(version 1\)\n\(allow default\)/);
  assert.ok(profile.includes(`(deny file-read* file-write* (literal ${JSON.stringify(join(f.data,"agent-access.json"))}))`));
  assert.doesNotMatch(profile,/\(allow file-/);
});

test("scrubEnv strips Sigma internals and provider keys but keeps the toolchain", ()=>{
  const clean=scrubEnv({PATH:"/usr/bin",HOME:"/h",USER:"u",LANG:"C",SIGMA_SESSION_TOKEN:"x",SIGMA_COOKIE:"x",SIGMA_DATA_DIR:"/d",PI_CODING_AGENT_DIR:"/a",OPENAI_API_KEY:"k",ANTHROPIC_API_KEY:"k",AGY_ACCESS_TOKEN:"k",GITHUB_TOKEN:"k",MY_SERVICE_PASSWORD:"k",NODE_ENV:"test"});
  assert.deepEqual(Object.keys(clean).sort(),["HOME","LANG","NODE_ENV","PATH","USER"]);
});

test("commands run in the given folder, return output and the real exit code", async()=>{
  const f=await fixture();
  const ok=await f.run("pwd; echo to-stderr >&2; echo done");
  assert.equal(ok.exitCode,0);assert.match(ok.output,new RegExp(f.outside));assert.match(ok.output,/to-stderr/);assert.match(ok.output,/done/);
  const bad=await f.run("echo failing; exit 7");assert.equal(bad.exitCode,7);
  assert.match(formatShellResult(bad,300),/failing\n\[exit code 7\]$/);
  assert.equal((await f.run("node --version")).exitCode,0,"login shell puts node on PATH");
});

test("the sandbox denies credential files but leaves sibling files, folders and workspaces usable", async()=>{
  const f=await fixture();
  for(const secret of [join(f.data,"cliproxyapi","auth.json"),join(f.agent,"auth.json"),join(f.data,"state.sqlite"),join(f.data,"agent-access.json"),join(f.home,".codex","auth.json"),join(f.home,".gemini","oauth_creds.json"),join(f.home,".cli-proxy-api","a.json"),join(f.home,".tool","nested","credentials.json")]){
    const read=await f.run(`cat ${JSON.stringify(secret)}`);assert.notEqual(read.exitCode,0,secret);assert.doesNotMatch(read.output,/SECRET-/);assert.match(read.output,/Operation not permitted/);
  }
  assert.notEqual((await f.run(`echo hacked > ${JSON.stringify(join(f.data,"agent-access.json"))}`)).exitCode,0);
  assert.equal(await readFile(join(f.data,"agent-access.json"),"utf8"),'{"mode":"full"}');
  for(const [path,text] of [[join(f.data,"sessions.txt"),"public-data"],[join(f.agent,"settings.json"),"public-agent"],[join(f.home,".codex","config.toml"),"public-codex"],[join(f.home,".gemini","settings.json"),"public-gemini"],[join(f.home,".tool","config.txt"),"public-tool"],[join(f.outside,"auth.json"),"public-project-auth"]]){
    const read=await f.run(`cat ${JSON.stringify(path)}`);assert.equal(read.exitCode,0,read.output);assert.match(read.output,new RegExp(text));
  }
  for(const dir of [f.data,f.agent,join(f.home,".gemini"),join(f.home,".codex")]){const list=await f.run(`ls ${JSON.stringify(dir)}`);assert.equal(list.exitCode,0,list.output);}
  assert.equal((await f.run(`echo new > ${JSON.stringify(join(f.data,"extra.txt"))}`)).exitCode,0,"non-credential files in the data folder are writable");
  const workspace=await f.run("echo ok > file.txt && cat file.txt && pwd",{cwd:f.work});assert.equal(workspace.exitCode,0,workspace.output);assert.match(workspace.output,/ok/);
  assert.equal(await readFile(join(f.work,"file.txt"),"utf8"),"ok\n");
  const plain=await f.run("echo hi > out.txt && cat out.txt");assert.equal(plain.exitCode,0);
  assert.equal((await f.run("curl --version >/dev/null && git --version")).exitCode,0);
});

test("output is capped to the tail with a truncation note", async()=>{
  const f=await fixture();
  const result=await f.run("i=0; while [ $i -lt 4000 ]; do echo line-$i-0123456789012345678901234567890123456789; i=$((i+1)); done; echo THE-END",{maxOutput:2000});
  assert.equal(result.exitCode,0);assert.ok(Buffer.byteLength(result.output)<=2000);assert.match(result.output,/THE-END/);assert.ok(result.truncatedBytes>100_000);assert.doesNotMatch(result.output,/line-0-/);
  assert.match(formatShellResult(result,300),new RegExp(`^\\[truncated ${result.truncatedBytes} bytes\\]\\n`));
});

test("timeouts kill the whole process group", async()=>{
  const f=await fixture(),marker=join(f.outside,"survivor");
  const started=Date.now();
  const result=await f.run(`(sleep 3; echo alive > ${JSON.stringify(marker)}) & sleep 30`,{timeoutMs:400,killGraceMs:200});
  assert.equal(result.timedOut,true);assert.ok(Date.now()-started<5000);assert.match(formatShellResult(result,1),/timed out after 1s/);
  await new Promise(r=>setTimeout(r,3500));
  await assert.rejects(readFile(marker),"A background child of the command was killed with its group");
  assert.equal(runningShells(),0);
});

test("a command that ignores SIGTERM is killed, and aborting stops a running command", async()=>{
  const f=await fixture();
  const stubborn=await f.run("trap '' TERM; while true; do sleep 1; done",{timeoutMs:300,killGraceMs:300});assert.equal(stubborn.timedOut,true);
  const controller=new AbortController(),pending=f.run("sleep 30",{signal:controller.signal,killGraceMs:200});
  setTimeout(()=>controller.abort(),200);const stopped=await pending;assert.equal(stopped.aborted,true);assert.match(formatShellResult(stopped,300),/stopped/);
  await assert.rejects(f.run("echo no",{signal:controller.signal}),/stopped/);
});

test("processes left behind by a finished command are killed and killAllShells ends running commands", async()=>{
  const f=await fixture(),marker=join(f.outside,"daemon");
  const finished=await f.run(`(sleep 2; echo alive > ${JSON.stringify(marker)}) & echo started`);assert.equal(finished.exitCode,0);
  await new Promise(r=>setTimeout(r,2500));await assert.rejects(readFile(marker));
  const running=f.run("sleep 30");await new Promise(r=>setTimeout(r,300));assert.equal(runningShells(),1);killAllShells();
  const result=await running;assert.equal(result.signal,"SIGKILL");assert.equal(runningShells(),0);
});

test("without sandbox-exec nothing runs", async()=>{
  const f=await fixture(),marker=join(f.outside,"unsandboxed");
  await assert.rejects(f.run(`echo no > ${JSON.stringify(marker)}`,{sandbox:"/nonexistent/sandbox-exec"}),/sandbox-exec/);
  await assert.rejects(readFile(marker));
});
