import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CODE_PROFILE, PARALLEL_CODE_PROFILE, type SessionPolicy } from "../../packages/contracts/index.js";
import { createCodeWorkspace, workspaceChanges } from "./editing.js";
import { PiHost } from "./pi-host.js";
import { SourceApply } from "./source-apply.js";
import { Storage } from "./storage.js";
import { Verification } from "./verification.js";
import { WorkerMerge } from "./worker-merge.js";

const root=resolve(import.meta.dirname,"../..");
const scratch=join(process.env.SIGMA_TEST_DIR||join(root,".scratch"),`worker-merge-${Date.now()}-${process.pid}`);
const git=(cwd:string,...args:string[])=>execFileSync("git",["-C",cwd,"-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false",...args],{env:{...process.env,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_AUTHOR_NAME:"Fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"Fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid"}}).toString().trim();

test("worker merge applies only an approved current preview and leaves conflicts untouched",async()=>{
  const source=join(scratch,"source"),data=join(scratch,"data");await mkdir(source,{recursive:true});await mkdir(data);
  git(source,"init","-q","-b","main");
  await writeFile(join(source,"clean.txt"),"one\ntwo\nthree\n");
  await writeFile(join(source,"conflict.txt"),"shared\n");
  await writeFile(join(source,"stale.txt"),"base\n");
  git(source,"add","--",".");git(source,"commit","-qm","base");

  const rootId=crypto.randomUUID(),workerId=crypto.randomUUID();
  const rootCopy=await createCodeWorkspace(source,data,rootId,undefined,"worktree"),workerCopy=await createCodeWorkspace(source,data,workerId,rootCopy.workspace.baseCommit,"worktree");
  assert.notEqual(rootCopy.cwd,workerCopy.cwd);assert.equal(rootCopy.workspace.baseCommit,workerCopy.workspace.baseCommit);
  const storage=new Storage(join(data,"state.sqlite"));
  const rootPolicy:SessionPolicy={version:1,requested:{cwd:source,model:"fixture/model",mode:"parallel"},effective:{cwd:rootCopy.cwd,model:"fixture/model",profile:structuredClone(PARALLEL_CODE_PROFILE)},workspace:rootCopy.workspace};
  const workerPolicy:SessionPolicy={version:1,requested:{cwd:source,model:"fixture/model",mode:"code"},effective:{cwd:workerCopy.cwd,model:"fixture/model",profile:structuredClone(CODE_PROFILE)},workspace:workerCopy.workspace};
  await storage.call("addSession",{id:rootId,cwd:rootCopy.cwd,file:"root.jsonl",model:"fixture/model",parentId:null,role:"root",policy:rootPolicy});
  await storage.call("addSession",{id:workerId,cwd:workerCopy.cwd,file:"worker.jsonl",model:"fixture/model",parentId:rootId,role:"worker",policy:workerPolicy,childLimit:2});
  await storage.call("status",{id:rootId,status:"settled"});await storage.call("status",{id:workerId,status:"settled"});
  process.env.PI_OFFLINE="1";process.env.SIGMA_DEMO="1";process.env.PI_CODING_AGENT_DIR=join(scratch,"agent");
  const host=new PiHost(storage,data,async()=>{});await host.init();
  const merge=new WorkerMerge(storage,host,data,async(id,type,payload,durable)=>{if(durable)await storage.event(id,type,payload);});
  try{
    await writeFile(join(rootCopy.cwd,"clean.txt"),"ONE\ntwo\nthree\n");
    await writeFile(join(workerCopy.cwd,"clean.txt"),"one\ntwo\nTHREE\n");
    const proposed=await merge.prepare(rootId,workerId,crypto.randomUUID());
    assert.equal(proposed.status,"pending");assert.equal(proposed.current,true);
    assert.equal(await readFile(join(rootCopy.cwd,"clean.txt"),"utf8"),"ONE\ntwo\nthree\n","preview must not write the integration copy");
    assert.equal(await readFile(join(source,"clean.txt"),"utf8"),"one\ntwo\nthree\n");
    const applied=await merge.decide(rootId,proposed.id,true);
    assert.equal(applied.status,"applied");assert.equal(applied.files[0].status,"applied");
    assert.equal(await readFile(join(rootCopy.cwd,"clean.txt"),"utf8"),"ONE\ntwo\nTHREE\n");
    assert.equal(await readFile(join(workerCopy.cwd,"clean.txt"),"utf8"),"one\ntwo\nTHREE\n");
    assert.equal(await readFile(join(source,"clean.txt"),"utf8"),"one\ntwo\nthree\n","integration must not touch the source repository");

    await writeFile(join(rootCopy.cwd,"conflict.txt"),"root\n");await writeFile(join(workerCopy.cwd,"conflict.txt"),"worker\n");
    const conflict=await merge.prepare(rootId,workerId,crypto.randomUUID());
    assert.equal(conflict.status,"conflict");assert.equal(conflict.files.find(file=>file.path==="conflict.txt")?.status,"conflict");
    assert.match(conflict.files.find(file=>file.path==="conflict.txt")!.preview,/<<<<<<< root[\s\S]*>>>>>>> worker/);
    assert.equal(await readFile(join(rootCopy.cwd,"conflict.txt"),"utf8"),"root\n");
    await assert.rejects(merge.decide(rootId,conflict.id,true),/no longer pending/);

    await writeFile(join(workerCopy.cwd,"conflict.txt"),"shared\n");
    await writeFile(join(workerCopy.cwd,"stale.txt"),"planned\n");
    const stale=await merge.prepare(rootId,workerId,crypto.randomUUID());assert.equal(stale.status,"pending");
    await writeFile(join(workerCopy.cwd,"stale.txt"),"changed after preview\n");
    await assert.rejects(merge.decide(rootId,stale.id,true),/preview changed|changed during merge preview/);
    assert.equal((await merge.list(rootId)).find(row=>row.id===stale.id)?.status,"expired");
    assert.equal(await readFile(join(rootCopy.cwd,"stale.txt"),"utf8"),"base\n");
    assert.equal(await readFile(join(source,"stale.txt"),"utf8"),"base\n");

    const recoveryPath=join(data,"recovery.sqlite");let recoveryStorage=new Storage(recoveryPath);
    await recoveryStorage.call("addSession",{id:rootId,cwd:rootCopy.cwd,file:"root.jsonl",model:"fixture/model",parentId:null,role:"root",policy:rootPolicy});
    await recoveryStorage.call("addSession",{id:workerId,cwd:workerCopy.cwd,file:"worker.jsonl",model:"fixture/model",parentId:rootId,role:"worker",policy:workerPolicy,childLimit:2});
    await recoveryStorage.call("status",{id:rootId,status:"settled"});await recoveryStorage.call("status",{id:workerId,status:"settled"});
    const recoveryHost=()=>Object.assign(new PiHost(recoveryStorage,data,async()=>{}),{repositoryCode:async()=>recoveryStorage.call<any>("session",{id:rootId}),changes:async(id:string)=>{const row=await recoveryStorage.call<any>("session",{id});return workspaceChanges(row.cwd,row.policy.workspace);}});
    let recoveryMerge=new WorkerMerge(recoveryStorage,recoveryHost(),data,async()=>{});
    const uncertain=await recoveryMerge.prepare(rootId,workerId,crypto.randomUUID());
    await recoveryStorage.call("workerMergeTransition",{id:uncertain.id,from:"pending",to:"running"});
    await recoveryStorage.call("workerMergeFile",{id:uncertain.id,path:"stale.txt",from:"ready",to:"applying"});
    await recoveryStorage.close();recoveryStorage=new Storage(recoveryPath);recoveryMerge=new WorkerMerge(recoveryStorage,recoveryHost(),data,async()=>{});
    try{
      const recovered=(await recoveryMerge.list(rootId)).find(row=>row.id===uncertain.id)!;
      const recoveredFile=recovered.files.find(file=>file.path==="stale.txt")!;
      assert.equal(recovered.status,"unknown");assert.equal(recoveredFile.status,"unknown");
      assert.equal(recoveredFile.observation,"before");assert.equal(recoveredFile.observedHash,recoveredFile.beforeHash);
      await assert.rejects(recoveryMerge.prepare(rootId,workerId,crypto.randomUUID()),/Resolve the current worker merge/);
      await assert.rejects(recoveryStorage.call("addSourceApply",{id:crypto.randomUUID(),sessionId:rootId,sourceCwd:source,status:"pending"}),/Resolve the worker merge/);
      const reconciled=await recoveryMerge.reconcile(rootId,uncertain.id);assert.equal(reconciled.status,"reconciled");
      const sourceApplyId=crypto.randomUUID();await recoveryStorage.call("addSourceApply",{id:sourceApplyId,sessionId:rootId,sourceCwd:source,status:"pending"});
      await recoveryStorage.call("sourceApplyTransition",{id:sourceApplyId,from:"pending",to:"denied"});
      assert.equal((await recoveryMerge.prepare(rootId,workerId,crypto.randomUUID())).status,"pending");
    }finally{await recoveryMerge.close();await recoveryStorage.close();}

    const directRootId=crypto.randomUUID(),directWorkerId=crypto.randomUUID();
    const directRoot=await createCodeWorkspace(source,data,directRootId,undefined,"direct"),directWorker=await createCodeWorkspace(source,data,directWorkerId,directRoot.workspace.baseCommit,"worktree");
    assert.equal(directRoot.cwd,source);assert.notEqual(directWorker.cwd,source);
    const directRootPolicy:SessionPolicy={version:1,requested:{cwd:source,model:"fixture/model",mode:"parallel"},effective:{cwd:source,model:"fixture/model",profile:structuredClone(PARALLEL_CODE_PROFILE)},workspace:directRoot.workspace};
    const directWorkerPolicy:SessionPolicy={version:1,requested:{cwd:source,model:"fixture/model",mode:"code",workspaceMode:"worktree"},effective:{cwd:directWorker.cwd,model:"fixture/model",profile:structuredClone(CODE_PROFILE)},workspace:directWorker.workspace};
    await storage.call("addSession",{id:directRootId,cwd:source,file:"direct-root.jsonl",model:"fixture/model",parentId:null,role:"root",policy:directRootPolicy});
    await storage.call("addSession",{id:directWorkerId,cwd:directWorker.cwd,file:"direct-worker.jsonl",model:"fixture/model",parentId:directRootId,role:"worker",policy:directWorkerPolicy,childLimit:2});
    await storage.call("status",{id:directRootId,status:"settled"});await storage.call("status",{id:directWorkerId,status:"settled"});
    await writeFile(join(source,"stale.txt"),"user staged\n");git(source,"add","stale.txt");await writeFile(join(source,"notes.txt"),"user untracked\n");
    const index=await readFile(join(source,".git/index"));
    await writeFile(join(directWorker.cwd,"clean.txt"),"one\ntwo\nTHREE\n");
    const directPreview=await merge.prepare(directRootId,directWorkerId,crypto.randomUUID());assert.equal(directPreview.status,"pending");
    const directResult=await merge.decide(directRootId,directPreview.id,true);assert.equal(directResult.status,"applied");
    assert.equal(await readFile(join(source,"clean.txt"),"utf8"),"one\ntwo\nTHREE\n");
    assert.equal(await readFile(join(source,"stale.txt"),"utf8"),"user staged\n");assert.equal(await readFile(join(source,"notes.txt"),"utf8"),"user untracked\n");
    assert.deepEqual(await readFile(join(source,".git/index")),index);
    const verification=new Verification(storage,host,data,async()=>{}),apply=new SourceApply(storage,host,verification,data,async()=>{});
    try{await assert.rejects(apply.prepare(directRootId,crypto.randomUUID()),/direct|source apply/i);}
    finally{await apply.close();await verification.close();}
  }finally{await merge.close();await host.close();await storage.close();}
});

test("shutdown waits for a held merge approval and prevents a late root write",async()=>{
  const source=join(scratch,"shutdown-source"),data=join(scratch,"shutdown-data");await mkdir(source,{recursive:true});await mkdir(data);
  git(source,"init","-q","-b","main");await writeFile(join(source,"file.txt"),"base\n");git(source,"add","--",".");git(source,"commit","-qm","base");
  const rootId=crypto.randomUUID(),workerId=crypto.randomUUID();
  const rootCopy=await createCodeWorkspace(source,data,rootId,undefined,"worktree"),workerCopy=await createCodeWorkspace(source,data,workerId,rootCopy.workspace.baseCommit,"worktree");
  const storage=new Storage(join(data,"state.sqlite"));
  const rootPolicy:SessionPolicy={version:1,requested:{cwd:source,model:"fixture/model",mode:"parallel"},effective:{cwd:rootCopy.cwd,model:"fixture/model",profile:structuredClone(PARALLEL_CODE_PROFILE)},workspace:rootCopy.workspace};
  const workerPolicy:SessionPolicy={version:1,requested:{cwd:source,model:"fixture/model",mode:"code"},effective:{cwd:workerCopy.cwd,model:"fixture/model",profile:structuredClone(CODE_PROFILE)},workspace:workerCopy.workspace};
  await storage.call("addSession",{id:rootId,cwd:rootCopy.cwd,file:"root.jsonl",model:"fixture/model",parentId:null,role:"root",policy:rootPolicy});
  await storage.call("addSession",{id:workerId,cwd:workerCopy.cwd,file:"worker.jsonl",model:"fixture/model",parentId:rootId,role:"worker",policy:workerPolicy,childLimit:2});
  await storage.call("status",{id:rootId,status:"settled"});await storage.call("status",{id:workerId,status:"settled"});
  await writeFile(join(workerCopy.cwd,"file.txt"),"worker\n");
  const host=new PiHost(storage,data,async()=>{});await host.init();const merge=new WorkerMerge(storage,host,data,async()=>{});
  let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>release=r),atTransition=new Promise<void>(r=>entered=r);
  const original=storage.call.bind(storage),guarded=storage.call.bind(storage);let hold=true;
  storage.call=((op:string,args:Record<string,unknown>={})=>op==="workerMergeTransition"&&args.from==="pending"&&args.to==="running"&&hold
    ?(hold=false,entered(),held.then(()=>original(op,args)))
    :guarded(op,args)) as typeof storage.call;
  try{
    const preview=await merge.prepare(rootId,workerId,crypto.randomUUID());
    const allowing=merge.decide(rootId,preview.id,true);await atTransition;
    const closing=merge.close();await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(await readFile(join(rootCopy.cwd,"file.txt"),"utf8"),"base\n","close must wait for the held admission before its outcome is known");
    release();await Promise.all([closing,assert.rejects(allowing,/shutting down/)]);
    assert.equal(await readFile(join(rootCopy.cwd,"file.txt"),"utf8"),"base\n","shutdown must not publish after the merge close snapshot");
    assert.equal((await storage.call<any>("workerMerge",{id:preview.id})).status,"cancelled");
  }finally{release();storage.call=guarded;await merge.close();await host.close();await storage.close();}
});

test("publish refuses deletion and reports a crash-leftover .pi-edit temp as a Conflict without deleting it",async()=>{
  const folder=join(scratch,"publish");await mkdir(folder,{recursive:true});
  const {createHash}=await import("node:crypto"),sha=(text:string)=>createHash("sha256").update(text).digest("hex");
  await writeFile(join(folder,"a.txt"),"before\n");
  const publish=(WorkerMerge.prototype as any).publish.bind(Object.create(WorkerMerge.prototype)),row={id:"merge-1",rootCwd:folder};
  const file={path:"a.txt",beforeHash:sha("before\n"),beforeMode:0o644,afterHash:sha("after\n"),afterMode:0o644};
  assert.throws(()=>publish(row,{...file,afterHash:"missing"},null),/deletion is not supported/);
  assert.equal(await readFile(join(folder,"a.txt"),"utf8"),"before\n");
  await writeFile(join(folder,".pi-edit-merge-1"),"leftover\n");
  assert.throws(()=>publish(row,file,Buffer.from("after\n")),/leftover merge temp file.*merge-1/);
  assert.equal(await readFile(join(folder,".pi-edit-merge-1"),"utf8"),"leftover\n");
  assert.equal(await readFile(join(folder,"a.txt"),"utf8"),"before\n");
});
