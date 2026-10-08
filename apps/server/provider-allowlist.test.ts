import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const scratch=resolve(import.meta.dirname,"../../.scratch",`allowlist-${Date.now()}-${process.pid}`);
await mkdir(scratch,{recursive:true});
for(const key of Object.keys(process.env))if(!["PATH","TMPDIR","SystemRoot"].includes(key))delete process.env[key];
process.env.HOME=scratch;process.env.PI_OFFLINE="1";process.env.PI_CODING_AGENT_DIR=resolve(scratch,"agent");
const {ModelRuntime}=await import("@earendil-works/pi-coding-agent");
const {ProviderAuth}=await import("./provider-auth.js");
const {providerAllowed,assertProviderAllowed}=await import("./provider-allowlist.js");
const {registerAuthFixture}=await import("./provider-auth.fixture.js");

test("only OpenAI, Claude Code and Antigravity families are allowed",()=>{
  for(const id of ["google","anthropic","openrouter","github-copilot","xai","mistral","groq"])assert.equal(providerAllowed(id),false,id);
  for(const id of ["openai","openai-codex","sigma-cliproxy","sigma-claude-cli","sigma-antigravity-cli","sigma-antigravity-unsupervised","sigma-demo","sigma-auth-fixture","role-fixture"])assert.equal(providerAllowed(id),true,id);
  assert.throws(()=>assertProviderAllowed("google"),/not supported in Sigma/);
});

test("ProviderAuth hides and rejects disallowed Pi SDK providers",async()=>{
  const runtime=await ModelRuntime.create({authPath:resolve(scratch,"auth.json"),modelsPath:null,allowModelNetwork:false});
  registerAuthFixture(runtime);await runtime.refresh({allowNetwork:false});
  const auth=new ProviderAuth(runtime),ids=(await auth.list()).map(p=>p.id);
  assert.ok(runtime.getProviders().some(p=>p.id==="google"||p.id==="anthropic"),"SDK still exposes built-ins");
  for(const id of ids)assert.equal(providerAllowed(id),true,id);
  assert.ok(ids.includes("sigma-auth-fixture"));
  assert.throws(()=>auth.start("google",crypto.randomUUID()),/not supported in Sigma/);
  assert.throws(()=>auth.refresh("anthropic"),/not supported in Sigma/);
  await auth.close();
});
