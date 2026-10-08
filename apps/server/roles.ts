import { AGENT_ROLES, type AgentRole, type RoleCatalog, type RoleReasoning, type RoleType } from "../../packages/contracts/index.js";

const LEVELS=["off","minimal","low","medium","high","xhigh","max"],MODEL=/^[^\s/]+\/[^\s]+$/,validModel=(value:any)=>value===null||typeof value==="string"&&value.length<=240&&MODEL.test(value);
export function defaultRoles():RoleCatalog {return {revision:0,roles:AGENT_ROLES.map(role=>({role,model:null,reasoning:null}))};}
/** Reads the current shape or a pre-0.4.0 catalog (groups, reasoning, instructions): effective model is role.model ?? group.model; everything else is dropped. Never throws. */
export function normalizeRoles(value:any):RoleCatalog {
  const revision=Number.isSafeInteger(value?.revision)&&value.revision>=0?value.revision:0,groups:any[]=Array.isArray(value?.groups)?value.groups:[],roles:any[]=Array.isArray(value?.roles)?value.roles:[];
  return {revision,roles:AGENT_ROLES.map(role=>{
    const item=roles.find(item=>item?.role===role),group=groups.find(group=>group?.id===item?.groupId),model=item?.model??group?.model??null;
    const reasoning=item?.reasoning??group?.reasoning??null;
    return {role,model:typeof model==="string"&&model?model:null,reasoning:LEVELS.includes(reasoning)?reasoning as RoleReasoning:null};
  })};
}
export function roleInput(value:any):RoleCatalog {
  if(!value||!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.roles)||value.groups!==undefined||value.roles.length!==AGENT_ROLES.length)throw new Error("Valid role catalog required");
  const roles=value.roles.map((item:any)=>{
    if(!item||!AGENT_ROLES.includes(item.role)||!validModel(item.model)||!(item.reasoning===null||LEVELS.includes(item.reasoning)))throw new Error("Each role needs a known role, a valid model and a valid reasoning");
    return {role:item.role as AgentRole,model:item.model as string|null,reasoning:item.reasoning as RoleReasoning|null};
  });
  if(new Set(roles.map((item:any)=>item.role)).size!==AGENT_ROLES.length)throw new Error("Each role must appear exactly once");
  return {revision:value.revision,roles};
}
/** Root and coordinator always run on the chat's model; the catalog only maps delegated agents. */
export function resolveRole(catalog:RoleCatalog,type:RoleType,inheritedModel:string) {
  const item=type==="root"||type==="coordinator"?undefined:normalizeRoles(catalog).roles.find(item=>item.role===type);
  return {model:item?.model??inheritedModel,role:{type,catalog:structuredClone(catalog),requestedReasoning:(item?.reasoning??null) as RoleReasoning|null,instructions:""}};
}
