import test from "node:test";
import assert from "node:assert/strict";
import { geminiNonFlash, previousGeneration } from "./model-generations.js";
const m=(provider:string,ids:string[])=>ids.map(id=>({provider,id}));
const codex=m("openai-codex",["gpt-5.3-codex-spark","gpt-5.5","gpt-5.6-luna","gpt-5.6-sol","gpt-5.6-terra","gpt-6-astra","gpt-6-luna","gpt-6-sol","gpt-6.1-sol"]);
const proxy=m("sigma-cliproxy",["gemini-3.5-flash-lite","claude-sonnet-5-5-high","gemini-3-flash","gemini-pro-agent","gemini-3.1-pro-low","gpt-oss-120b-medium","claude-opus-5-5-high","gemini-3.6-flash-high","gemini-3.7-flash-high","gemini-3.8-flash-high","gemini-3.1-flash-image","gemini-3.1-flash-lite"]);
test("hides only models below the newest major generation of their family",()=>{
  assert.deepEqual([...previousGeneration([...codex,...proxy])].sort(),["gpt-5.3-codex-spark","gpt-5.5","gpt-5.6-luna","gpt-5.6-sol","gpt-5.6-terra"].map(id=>`openai-codex/${id}`).sort());
});
test("120b is not a version and unversioned ids are never hidden",()=>{
  assert.equal(previousGeneration(m("p",["gpt-oss-120b-medium","gpt-oss-2-x","gemini-pro-agent","gemini-3","plain","7"])).size,0);
});
test("families are separated per provider",()=>{
  assert.deepEqual([...previousGeneration([...m("a",["gpt-5","gpt-6"]),...m("b",["gpt-5"])])],["a/gpt-5"]);
});
test("claude-sonnet and claude-opus are separate families",()=>{
  assert.deepEqual([...previousGeneration(m("p",["claude-sonnet-4","claude-sonnet-5-5-high","claude-opus-4"]))],["p/claude-sonnet-4"]);
});
test("a future generation hides the previous one",()=>{
  assert.ok(previousGeneration([...codex,...m("openai-codex",["gpt-7-sol"])]).has("openai-codex/gpt-6.1-sol"));
});
test("only the newest plain Gemini Flash is offered; other gemini models are legacy",()=>{
  const off=m("sigma-cliproxy",["gemini-3.8-flash-high","gemini-3.7-flash-high","gemini-3.6-flash-high","gemini-3-flash","gemini-3.1-pro-low","gemini-3.1-flash-lite","gemini-3.5-flash-lite","gemini-3.1-flash-image","gemini-pro-agent","claude-opus-5-5-high","claude-sonnet-5-5-high","gpt-oss-120b-medium"]);
  const old=new Set([...previousGeneration(off),...geminiNonFlash(off)]);
  assert.deepEqual(off.map(x=>x.id).filter(id=>!old.has(`sigma-cliproxy/${id}`)).sort(),["claude-opus-5-5-high","claude-sonnet-5-5-high","gemini-3.8-flash-high","gpt-oss-120b-medium"]);
});
test("dotted versions compare numerically and gemini is untouched without a plain flash",()=>{
  assert.deepEqual([...geminiNonFlash(m("p",["gemini-3.10-flash","gemini-3.9-flash"]))],["p/gemini-3.9-flash"]);
  assert.equal(geminiNonFlash(m("p",["gemini-3.1-pro-low","gemini-3.1-flash-lite"])).size,0);
});
