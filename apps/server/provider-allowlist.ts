import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

/** Sigma supports OpenAI (Pi SDK), Claude Code and Antigravity only; every other Pi SDK built-in provider is hidden. */
const PI_ALLOWED=new Set(["openai","openai-codex"]);
const builtin=new Set<string>(getBuiltinProviders());
export const providerAllowed=(id:string)=>PI_ALLOWED.has(id)||!builtin.has(id);
export function assertProviderAllowed(id:string){if(!providerAllowed(id))throw new Error("Provider is not supported in Sigma");}
