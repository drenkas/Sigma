import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, unlink, writeFile, chmod, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { PiHost } from "./pi-host.js";
import { Storage } from "./storage.js";
import { prepareCommit, executeCommit } from "./git-intents.js";

const exec=promisify(execFile),fixture=resolve(import.meta.dirname,`../../.scratch/git-actions-${Date.now()}-${process.pid}`);
process.env.PI_OFFLINE="1";process.env.SIGMA_DEMO="1";process.env.PI_CODING_AGENT_DIR=join(fixture,"agent");
// Git actions use the user's global config, so point HOME at a fixture identity and never at a real repository.
process.env.HOME=fixture;
async function git(cwd:string,...args:string[]){return (await exec("git",["-c","core.hooksPath=/dev/null",...args],{cwd,env:{PATH:process.env.PATH,HOME:fixture,LC_ALL:"C"},encoding:"utf8"})).stdout.trim();}
async function waitFor<T>(check:()=>Promise<T|undefined>):Promise<T>{const end=Date.now()+6000;while(Date.now()<end){const result=await check();if(result!==undefined)return result;await new Promise(r=>setTimeout(r,20));}throw new Error("Timed out");}

test("a scoped Git commit preserves unrelated staged, dirty and untracked state",async()=>{
  const source=join(fixture,"scope");await mkdir(source,{recursive:true});
  await git(source,"init","-b","main");await git(source,"config","user.name","Fixture");await git(source,"config","user.email","fixture@example.invalid");await git(source,"config","commit.gpgSign","false");
  const selected=["safe.txt","new [literal]*.txt","deleted.txt"];
  for(const path of ["safe.txt","deleted.txt","outside.txt","removed.txt","dirty.txt"])await writeFile(join(source,path),`base ${path}\n`);
  await git(source,"add",".");await git(source,"commit","-m","Base");
  await writeFile(join(source,"outside.txt"),"staged outside\n");await unlink(join(source,"removed.txt"));
  await writeFile(join(source,".env.fixture"),"SYNTHETIC_F4_SENTINEL\n");
  await git(source,"add","-A","--","outside.txt","removed.txt",".env.fixture");
  await writeFile(join(source,"outside.txt"),"unstaged outside\n");await writeFile(join(source,"dirty.txt"),"dirty only\n");await writeFile(join(source,"untracked.txt"),"untracked only\n");
  const outside=["outside.txt","removed.txt",".env.fixture","dirty.txt","untracked.txt"];
  await git(source,"update-index","--assume-unchanged","--","dirty.txt");await git(source,"update-index","--split-index");
  const flags=await git(source,"ls-files","-v","--",...outside);
  const index=await git(source,"ls-files","--stage","-z","--",...outside);
  const status=await git(source,"status","--porcelain=v1","-z","--untracked-files=all","--",...outside);
  await writeFile(join(source,"safe.txt"),"selected staged\n");await git(source,"add","--","safe.txt");await writeFile(join(source,"safe.txt"),"selected working tree\n");
  await writeFile(join(source,selected[1]),"literal new file\n");await unlink(join(source,"deleted.txt"));
  const indexPath=join(source,".git","index");await chmod(indexPath,0o660);
  const before=await git(source,"rev-parse","HEAD");const oldMask=process.umask(0o077);let sha:string;
  try{sha=await executeCommit(await prepareCommit(crypto.randomUUID(),source,"Selected only",selected,join(fixture,"scope-data"),()=>{}),async()=>{},()=>{},()=>{});}finally{process.umask(oldMask);}
  assert.equal((await stat(indexPath)).mode&0o777,0o660,"Shared repository index permissions survive the application umask");
  assert.equal(sha,await git(source,"rev-parse","HEAD"));
  assert.deepEqual((await git(source,"diff-tree","--no-commit-id","--name-only","-r","-z",before,sha)).split("\0").filter(Boolean).sort(),[...selected].sort());
  assert.equal(await git(source,"show","HEAD:safe.txt"),"selected working tree");
  assert.equal(await git(source,"show",`HEAD:${selected[1]}`),"literal new file");
  assert.equal(await git(source,"show","HEAD:outside.txt"),"base outside.txt");
  assert.equal(await git(source,"ls-files","--stage","-z","--",...outside),index);assert.equal(await git(source,"ls-files","-v","--",...outside),flags);
  assert.equal(await git(source,"status","--porcelain=v1","-z","--untracked-files=all","--",...outside),status);
  assert.equal(await readFile(join(source,"outside.txt"),"utf8"),"unstaged outside\n");
  assert.equal(await readFile(join(source,"untracked.txt"),"utf8"),"untracked only\n");
  assert.equal(await git(source,"status","--porcelain=v1","-z","--",...selected),"");
});

test("git actions commit through an approved agent message, push, pull and switch branches while direct sessions follow HEAD; sessions archive and restore",async()=>{
  await mkdir(fixture,{recursive:true});
  await writeFile(join(fixture,".gitconfig"),"[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[commit]\n\tgpgSign = false\n[init]\n\tdefaultBranch = main\n");
  const remote=join(fixture,"remote.git"),source=join(fixture,"source"),other=join(fixture,"other"),data=join(fixture,"data");
  await git(fixture,"init","--bare","-b","main",remote);await git(fixture,"clone",remote,source);
  await writeFile(join(source,"calc.ts"),"export const answer = 41;\n");await git(source,"add",".");await git(source,"commit","-m","Fixture");
  await git(source,"push","-u","origin","main");await git(source,"branch","feature");await mkdir(data);
  const storage=new Storage(join(data,"state.sqlite"));const host=new PiHost(storage,data,async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);});
  await host.init();
  try{
    const sid=await host.create(source,"sigma-demo/offline",crypto.randomUUID(),"code");
    const isolated=await host.create(source,"sigma-demo/offline",crypto.randomUUID(),"code",{workspaceMode:"worktree"});
    assert.deepEqual(await host.gitInfo(sid),{enabled:true,commit:true,branches:["feature","main"]});
    assert.equal((await host.gitInfo(isolated)).enabled,false);
    await host.snapshot(sid);
    await writeFile(join(source,"calc.ts"),"export const answer = 42;\n");
    const tool=(host as any).active.get(sid).session.getToolDefinition("git_commit");
    for(const [path,bytes] of [[".env.fixture",Buffer.from("SYNTHETIC_F4_SENTINEL\n")],["binary.dat",Buffer.from([0,1,2])]] as const){
      await writeFile(join(source,path),bytes);await git(source,"add","--",path);
      const headBefore=await git(source,"rev-parse","HEAD"),indexBefore=await git(source,"ls-files","--stage","-z");
      assert.equal((await host.changes(sid)).omitted,1);
      await assert.rejects(tool.execute(crypto.randomUUID(),{message:"Must reject omitted scope"}),/unsupported or sensitive/);
      assert.equal((await host.snapshot(sid)).approvals.filter(a=>a.status==="pending").length,0);
      assert.equal(await git(source,"rev-parse","HEAD"),headBefore);assert.equal(await git(source,"ls-files","--stage","-z"),indexBefore);
      await git(source,"reset","--",path);await unlink(join(source,path));
    }
    for(const [path,expected] of [[".env.fixture",/changed after approval/],["late.txt",/scope changed after approval/]] as const){
      const running=tool.execute(crypto.randomUUID(),{message:"Scope before Allow"});
      const approval=await waitFor(async()=>(await host.snapshot(sid)).approvals.find(a=>a.status==="pending"));
      await writeFile(join(source,path),"SYNTHETIC_LATE_SCOPE\n");if(path===".env.fixture")await git(source,"add","--",path);
      const headBefore=await git(source,"rev-parse","HEAD"),indexBefore=await git(source,"ls-files","--stage","-z");
      await host.decide(sid,approval.id,true);await assert.rejects(running,expected);
      assert.equal(await git(source,"rev-parse","HEAD"),headBefore);assert.equal(await git(source,"ls-files","--stage","-z"),indexBefore);
      assert.equal(await readFile(join(source,path),"utf8"),"SYNTHETIC_LATE_SCOPE\n");
      await git(source,"reset","--",path);await unlink(join(source,path));
    }
    const denied=tool.execute(crypto.randomUUID(),{message:"Deny commit"});
    const deniedApproval=await waitFor(async()=>(await host.snapshot(sid)).approvals.find(a=>a.status==="pending"));
    const deniedHead=await git(source,"rev-parse","HEAD"),deniedIndex=await git(source,"ls-files","--stage","-z");
    await host.decide(sid,deniedApproval.id,false);await assert.rejects(denied,/Commit denied/);
    assert.equal(await git(source,"rev-parse","HEAD"),deniedHead);assert.equal(await git(source,"ls-files","--stage","-z"),deniedIndex);
    const conflict="index-conflict [literal]*.txt";
    await mkdir(join(source,conflict));await writeFile(join(source,conflict,"staged.txt"),"unrelated staged child\n");
    await git(source,"add","--",`:(literal)${conflict}/staged.txt`);await rm(join(source,conflict),{recursive:true});await writeFile(join(source,conflict),"approved leaf\n");
    assert.equal((await host.changes(sid)).omitted,0);
    const conflicting=tool.execute(crypto.randomUUID(),{message:"Keep unrelated staged child"});
    const conflictHead=await git(source,"rev-parse","HEAD"),conflictIndex=await git(source,"ls-files","--stage","-z");
    await assert.rejects(conflicting,/scope conflicts with staged paths/);
    assert.equal(await git(source,"rev-parse","HEAD"),conflictHead);assert.equal(await git(source,"ls-files","--stage","-z"),conflictIndex);
    assert.equal(await readFile(join(source,conflict),"utf8"),"approved leaf\n");
    await git(source,"reset","--",`:(literal)${conflict}`);await unlink(join(source,conflict));
    // Replace a selected new file at the actual Git boundary, after both owner previews.
    // A literal directory pathspec still recurses unless descendants are excluded.
    const swappedPath=join(source,"swap.txt"),wrapper=join(fixture,"git-wrapper"),marker=join(wrapper,"swap-once");
    const nativeGit=(await exec("which",["git"],{encoding:"utf8"})).stdout.trim();
    await writeFile(swappedPath,"approved leaf\n");await mkdir(wrapper);await writeFile(marker,"");
    await writeFile(join(wrapper,"git"),`#!${process.execPath}\nimport { existsSync, unlinkSync, mkdirSync, writeFileSync } from "node:fs";\nimport { spawnSync } from "node:child_process";\nconst args=process.argv.slice(2);\nif(args.includes("commit-tree")&&existsSync(${JSON.stringify(marker)})){\n  unlinkSync(${JSON.stringify(marker)});unlinkSync(${JSON.stringify(swappedPath)});mkdirSync(${JSON.stringify(swappedPath)});\n  writeFileSync(${JSON.stringify(join(swappedPath,".env.fixture"))},"SYNTHETIC_F4_SENTINEL\\n");\n  writeFileSync(${JSON.stringify(join(swappedPath,"unapproved.txt"))},"unapproved descendant\\n");\n}\nconst result=spawnSync(${JSON.stringify(nativeGit)},args,{stdio:"inherit"});\nprocess.exit(result.status??1);\n`,{mode:0o700});
    const swapped=tool.execute(crypto.randomUUID(),{message:"Only selected leaf"});
    const swappedApproval=await waitFor(async()=>(await host.snapshot(sid)).approvals.find(a=>a.status==="pending"));
    const swapHead=await git(source,"rev-parse","HEAD"),swapIndex=await git(source,"ls-files","--stage","-z"),originalPath=process.env.PATH;
    process.env.PATH=`${wrapper}:${originalPath}`;
    try{await host.decide(sid,swappedApproval.id,true);await assert.rejects(swapped,/changed after approval/);}
    finally{process.env.PATH=originalPath;}
    assert.equal(await git(source,"rev-parse","HEAD"),swapHead);assert.equal(await git(source,"ls-files","--stage","-z"),swapIndex);
    assert.equal(await readFile(join(swappedPath,".env.fixture"),"utf8"),"SYNTHETIC_F4_SENTINEL\n");
    await rm(swappedPath,{recursive:true});
    const running=tool.execute(crypto.randomUUID(),{message:"Raise the answer\n\nKeeps the fixture honest."});
    const approval=await waitFor(async()=>(await host.snapshot(sid)).approvals.find(a=>a.status==="pending"));
    assert.equal(approval.tool,"git_commit");assert.equal(approval.git?.message,"Raise the answer\n\nKeeps the fixture honest.");assert.match(approval.git?.diff??"",/answer = 42/);
    await host.decide(sid,approval.id,true);
    const result=await running,head=await git(source,"rev-parse","HEAD");
    assert.equal(result.details.sha,head);assert.equal(await git(source,"log","-1","--format=%B"),"Raise the answer\n\nKeeps the fixture honest.");
    assert.equal((await host.snapshot(sid)).policy?.workspace?.baseCommit,head);
    assert.deepEqual((await host.changes(sid)).files,[]);
    await assert.rejects(tool.execute(crypto.randomUUID(),{message:"Empty"}),/Nothing to commit/);

    await host.gitAction(sid,"push",{},crypto.randomUUID());
    assert.equal(await git(remote,"rev-parse","main"),head);

    await git(fixture,"clone",remote,other);await writeFile(join(other,"extra.txt"),"from elsewhere\n");await git(other,"add",".");await git(other,"commit","-m","Elsewhere");await git(other,"push");
    await host.gitAction(sid,"pull",{},crypto.randomUUID());
    const pulled=await git(source,"rev-parse","HEAD");
    assert.equal(pulled,await git(other,"rev-parse","HEAD"));assert.equal((await host.snapshot(sid)).policy?.workspace?.baseCommit,pulled);

    await assert.rejects(host.gitAction(sid,"switch",{branch:"--orphan"},crypto.randomUUID()),/existing local branch/);
    await host.gitAction(sid,"switch",{branch:"feature"},crypto.randomUUID());
    assert.equal(await git(source,"branch","--show-current"),"feature");
    assert.equal((await host.snapshot(sid)).policy?.workspace?.baseCommit,await git(source,"rev-parse","HEAD"));
    await host.changes(sid);
    await assert.rejects(host.gitAction(isolated,"pull",{},crypto.randomUUID()),/isolated workspace/);
    await storage.call("archiveSession",{id:isolated,archived:true});
    assert.ok((await host.list() as any[]).find(item=>item.id===isolated).archived_at);
    await storage.call("archiveSession",{id:isolated,archived:false});
    assert.equal((await host.list() as any[]).find(item=>item.id===isolated).archived_at,null);
    await writeFile(join(source,"calc.ts"),"export const answer = 43;\n");
    const stopped=tool.execute(crypto.randomUUID(),{message:"Stop commit"});
    await waitFor(async()=>(await host.snapshot(sid)).approvals.find(a=>a.status==="pending"));
    const stoppedHead=await git(source,"rev-parse","HEAD"),stoppedIndex=await git(source,"ls-files","--stage","-z");
    await host.abort(sid);await assert.rejects(stopped,/Commit denied/);
    assert.equal(await git(source,"rev-parse","HEAD"),stoppedHead);assert.equal(await git(source,"ls-files","--stage","-z"),stoppedIndex);
  }finally{await host.close();await storage.close();}
});
