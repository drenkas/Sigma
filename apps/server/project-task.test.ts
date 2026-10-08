import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ProjectTaskView, ProjectView } from "../../packages/contracts/index.js";
import { snapshotProjectTask } from "./project-task.js";
import { Storage } from "./storage.js";

const exec=promisify(execFile);
const fixture=resolve(import.meta.dirname,`../../.scratch/project-task-${Date.now()}-${process.pid}`);
async function git(cwd:string,...args:string[]){
  const {stdout}=await exec("git",["-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false",...args],{cwd,env:{PATH:process.env.PATH,HOME:fixture,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_AUTHOR_NAME:"Fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"Fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid",LC_ALL:"C"}});
  return stdout.trim();
}
async function committedRepo(path:string){await mkdir(path,{recursive:true});await git(path,"init","-b","main");await writeFile(join(path,"README.md"),"base\n");await git(path,"add","README.md");await git(path,"commit","-m","base");}

test("multi-repository task pins distinct committed roots and never resumes uncertain admission",async()=>{
  await mkdir(fixture,{recursive:true});await git(fixture,"init","--bare");
  const first=join(fixture,"first"),second=join(fixture,"second"),plain=join(fixture,"plain"),empty=join(fixture,"empty");
  await committedRepo(first);await committedRepo(second);await mkdir(plain);await mkdir(empty);await git(empty,"init","-b","main");
  const project:ProjectView={id:randomUUID(),name:"Two repositories",folders:[first,second]};
  const task=await snapshotProjectTask(project,"fixture/model",randomUUID(),"request hash");
  assert.deepEqual(task.repositories.map(repo=>[repo.sourceCwd,repo.baseCommit]),[[first,await git(first,"rev-parse","HEAD")],[second,await git(second,"rev-parse","HEAD")]]);
  assert.equal(new Set([task.coordinatorId,...task.repositories.flatMap(repo=>[repo.id,repo.sessionId])]).size,5);
  assert.equal(task.status,"creating");
  const sub=join(first,"sub");await mkdir(sub);
  await assert.rejects(snapshotProjectTask({...project,folders:[first,sub]},"fixture/model",randomUUID(),"hash"),/distinct Git repositories/);
  const nested=join(first,"nested");await committedRepo(nested);
  await assert.rejects(snapshotProjectTask({...project,folders:[first,nested]},"fixture/model",randomUUID(),"hash"),/Nested Git repositories/);
  await assert.rejects(snapshotProjectTask({...project,folders:[first,plain]},"fixture/model",randomUUID(),"hash"),/committed Git repository/);
  await assert.rejects(snapshotProjectTask({...project,folders:[first,empty]},"fixture/model",randomUUID(),"hash"),/committed Git repository/);

  let storage=new Storage(join(fixture,"tasks.sqlite"));
  try{
    const admitted=await storage.call<{fresh:boolean;task:ProjectTaskView}>("addProjectTask",{...task});
    assert.equal(admitted.fresh,true);
    const duplicate=await storage.call<{fresh:boolean;task:ProjectTaskView}>("addProjectTask",{...task,coordinatorId:randomUUID()});
    assert.equal(duplicate.fresh,false);assert.equal(duplicate.task.coordinatorId,task.coordinatorId);
    await assert.rejects(storage.call("addProjectTask",{...task,requestHash:"different"}),/Task ID conflict/);
    const other={...task,id:randomUUID(),coordinatorId:randomUUID()};
    await storage.call("addProjectTask",other);
    const running=await storage.call<ProjectTaskView>("projectTaskStatus",{id:task.id,status:"running"});assert.equal(running.status,"running");
  }finally{await storage.close();}
  storage=new Storage(join(fixture,"tasks.sqlite"));
  try{
    assert.equal((await storage.call<ProjectTaskView>("projectTask",{id:task.id})).status,"running");
    const tasks=await storage.call<ProjectTaskView[]>("projectTasks");assert.equal(tasks.length,2);assert.equal(tasks[0].status,"unknown");
    assert.equal(await storage.call("projectTaskStatus",{id:tasks[0].id,status:"running"}),undefined);
  }finally{await storage.close();}
});
