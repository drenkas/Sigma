import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Storage } from "./storage.js";
import { folderStatus, projectInput, projectStatus } from "./projects.js";

const exec=promisify(execFile);
const fixture=resolve(import.meta.dirname,`../../.scratch/git-checks-${Date.now()}-${process.pid}`);
// All Git mutations below only construct fixtures under this new directory.
async function git(cwd:string,...args:string[]){
  const {stdout}=await exec("git",["-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false","-c","core.fsmonitor=false",...args],{cwd,env:{PATH:process.env.PATH,HOME:fixture,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_AUTHOR_NAME:"Fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"Fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid",LC_ALL:"C"}});
  return stdout.trim();
}

test("project Git status reflects real worktrees, changes, divergence and unavailable folders without modifying the index",async()=>{
  await mkdir(fixture,{recursive:true});
  // A bare parent makes the ordinary-folder case independent of the checkout containing .scratch.
  await git(fixture,"init","--bare");
  const repo=join(fixture,"repo with spaces"),plain=join(fixture,"notes");await mkdir(repo);await mkdir(plain);
  await git(repo,"init","-b","main");
  let status=await folderStatus(repo);assert.equal(status.branch,"main");assert.equal(status.oid,null);assert.equal(status.ahead,null);
  await writeFile(join(repo,"tracked.txt"),"base\n");
  const oddName="# branch.head forged\nname.txt";
  await writeFile(join(repo,oddName),"rename source\n");
  await git(repo,"add","--",".");await git(repo,"commit","-m","Fixture base");
  await git(repo,"branch","upstream");await git(repo,"branch","--set-upstream-to=upstream");
  status=await folderStatus(repo);assert.equal(status.state,"git");assert.equal(status.upstream,"upstream");assert.equal(status.ahead,0);assert.equal(status.behind,0);assert.equal(status.staged,0);assert.equal(status.unstaged,0);assert.equal(status.untracked,0);
  await git(repo,"commit","--allow-empty","-m","Local fixture change");
  await git(repo,"switch","upstream");await git(repo,"commit","--allow-empty","-m","Upstream fixture change");await git(repo,"switch","main");
  await rename(join(repo,oddName),join(repo,"renamed.txt"));await git(repo,"add","--",".");
  await writeFile(join(repo,"tracked.txt"),"working change\n");await writeFile(join(repo,"new.txt"),"untracked\n");
  const indexBefore=await readFile(join(repo,".git/index"));
  status=await folderStatus(repo);
  assert.equal(status.branch,"main","A rename pathname cannot impersonate a branch header");
  assert.equal(status.ahead,1);assert.equal(status.behind,1);assert.equal(status.staged,1);assert.equal(status.unstaged,1);assert.equal(status.untracked,1);assert.equal(status.conflicts,0);
  assert.deepEqual(await readFile(join(repo,".git/index")),indexBefore,"Inspection must not rewrite the Git index");
  await git(repo,"add","--",".");await git(repo,"commit","-m","Save fixture changes");
  await git(repo,"switch","--detach","HEAD");status=await folderStatus(repo);assert.equal(status.branch,null);assert.ok(status.oid);assert.equal(status.ahead,null);assert.equal(status.upstream,null);
  await git(repo,"switch","main");await git(repo,"config","branch.main.merge","refs/heads/gone");
  status=await folderStatus(repo);assert.equal(status.ahead,null);assert.equal(status.behind,null,"Missing upstream must never report zero commits");
  const alias=join(fixture,"alias");await symlink(repo,alias);
  assert.deepEqual(await projectInput({name:" Product ",folders:[repo,alias,plain]}),{name:"Product",folders:[repo,plain]});
  await assert.rejects(projectInput({name:"Product",folders:[join(repo,"tracked.txt")]}),/not a directory/);
  const snapshot=await projectStatus({id:"fixture",name:"Product",folders:[repo,plain,join(fixture,"missing")]});
  assert.deepEqual(snapshot.folders.map(f=>f.state),["git","folder","missing"]);
  const nested=join(repo,"nested");await mkdir(nested);assert.equal((await folderStatus(nested)).repository,repo);
});

test("merge conflicts are reported separately from staged and unstaged entries",async()=>{
  const repo=join(fixture,"conflict");await mkdir(repo,{recursive:true});await git(repo,"init","-b","main");
  await writeFile(join(repo,"file.txt"),"base\n");await git(repo,"add","--",".");await git(repo,"commit","-m","base");await git(repo,"branch","other");
  await writeFile(join(repo,"file.txt"),"main\n");await git(repo,"commit","-am","main change");
  await git(repo,"switch","other");await writeFile(join(repo,"file.txt"),"other\n");await git(repo,"commit","-am","other change");
  await assert.rejects(git(repo,"merge","main"));
  const status=await folderStatus(repo);assert.equal(status.state,"git");assert.equal(status.conflicts,1);assert.equal(status.staged,0);assert.equal(status.unstaged,0);
});

test("archiveProject keeps data across saves and deleteProject removes the row", async()=>{
  const dir=await mkdtemp(join(tmpdir(),"sigma-proj-")),storage=new Storage(join(dir,"state.sqlite"));
  try{
    const id="11111111-1111-4111-8111-111111111111";
    await storage.call("saveProject",{id,name:"A",folders:["/a"]});
    assert.equal((await storage.call<any>("project",{id})).archivedAt,null);
    await storage.call("archiveProject",{id,archived:true});
    await storage.call("saveProject",{id,name:"B",folders:["/b"]});
    const archived=await storage.call<any>("project",{id});
    assert.equal(typeof archived.archivedAt,"number");assert.equal(archived.name,"B");assert.deepEqual(archived.folders,["/b"]);
    await storage.call("archiveProject",{id,archived:false});
    assert.equal((await storage.call<any[]>("projects"))[0].archivedAt,null);
    await storage.call("deleteProject",{id});
    assert.equal(await storage.call("project",{id}),undefined);
  }finally{await storage.close();await rm(dir,{recursive:true,force:true});}
});
