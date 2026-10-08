import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import type { ProjectTaskView, ProjectView, WorkspaceMode } from "../../packages/contracts/index.js";
import { folderStatus } from "./projects.js";

export async function snapshotProjectTask(project:ProjectView,model:string,taskId:string,requestHash:string,workspaceMode:WorkspaceMode="direct"):Promise<ProjectTaskView>{
  if(project.folders.length<2||project.folders.length>4)throw new Error("A multi-repository task needs 2–4 project folders");
  const repositories:ProjectTaskView["repositories"]=[];
  for(const folder of project.folders){
    if(typeof folder!=="string"||!isAbsolute(folder))throw new Error("Project folder must be an absolute path");
    const status=await folderStatus(await realpath(folder));
    if(status.state!=="git"||!status.repository||!status.oid)throw new Error(`Project folder is not a committed Git repository: ${folder}`);
    const sourceCwd=await realpath(status.repository);
    if(repositories.some(repo=>repo.sourceCwd===sourceCwd))throw new Error(`Project folders must use distinct Git repositories: ${folder}`);
    if(repositories.some(repo=>sourceCwd.startsWith(repo.sourceCwd+sep)||repo.sourceCwd.startsWith(sourceCwd+sep)))throw new Error("Nested Git repositories cannot share a multi-repository task");
    repositories.push({id:randomUUID(),sourceCwd,baseCommit:status.oid,sessionId:randomUUID()});
  }
  return {id:taskId,projectId:project.id,projectName:project.name,coordinatorId:randomUUID(),model,requestHash,status:"creating",workspaceMode,repositories,createdAt:Date.now()};
}
