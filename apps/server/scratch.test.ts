import assert from "node:assert/strict";
import {mkdtemp,rm,stat,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename,dirname,join} from "node:path";
import {randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import test from "node:test";
import {createScratchDir} from "./scratch.js";
test("scratch dirs are dated, private, git-backed, unique per id and stable on replay",async()=>{
  const root=await mkdtemp(join(tmpdir(),"sigma-scratch-"));process.env.SIGMA_SCRATCH_ROOT=root;
  try{
    const day=new Date(2026,9,7),a=randomUUID(),b=randomUUID(),first=await createScratchDir(a,day),again=await createScratchDir(a,day),other=await createScratchDir(b,day);
    assert.equal(first,again);assert.notEqual(first,other);
    assert.equal(basename(dirname(first)),"2026-10-07");assert.match(basename(first),/^[0-9a-z]{3}$/);
    assert.equal((await stat(first)).mode&0o777,0o700);
    assert.equal(execFileSync("git",["rev-parse","--show-toplevel"],{cwd:first,encoding:"utf8"}).trim(),await import("node:fs/promises").then(f=>f.realpath(first)));
    assert.equal(execFileSync("git",["rev-list","--count","HEAD"],{cwd:first,encoding:"utf8"}).trim(),"1");
    assert.equal(await readFile(join(first,".sigma-scratch"),"utf8"),a);
  }finally{await rm(root,{recursive:true,force:true});delete process.env.SIGMA_SCRATCH_ROOT;}
});
