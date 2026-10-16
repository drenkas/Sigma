import { AGENT_ROLES, type AgentRole, type ProjectRoleOverride, type RoleCatalog, type RoleReasoning, type RoleType } from "../../packages/contracts/index.js";

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
const has=(item:object,key:string)=>Object.prototype.hasOwnProperty.call(item,key);
/** Strict input for a project's agent overrides: known roles at most once, valid fields; rows that change nothing are dropped. */
export function projectAgentsInput(value:any):ProjectRoleOverride[] {
  if(!Array.isArray(value)||value.length>AGENT_ROLES.length)throw new Error("Project agents must be a list of role overrides");
  const result:ProjectRoleOverride[]=[],seen=new Set<string>();
  for(const item of value){
    if(!item||typeof item!=="object"||!AGENT_ROLES.includes(item.role)||Object.keys(item).some(key=>key!=="role"&&key!=="model"&&key!=="reasoning"))throw new Error("Each project agent override needs a known role");
    if(has(item,"model")&&!validModel(item.model)||has(item,"reasoning")&&!(item.reasoning===null||LEVELS.includes(item.reasoning)))throw new Error("Each project agent override needs a valid model and a valid reasoning");
    if(seen.has(item.role))throw new Error("Each role can be overridden once per project");seen.add(item.role);
    const override:ProjectRoleOverride={role:item.role};if(has(item,"model"))override.model=item.model;if(has(item,"reasoning"))override.reasoning=item.reasoning;
    if(has(override,"model")||has(override,"reasoning"))result.push(override);
  }
  return result;
}
/** Lenient read of stored overrides; anything invalid is ignored. */
export function normalizeProjectAgents(value:unknown):ProjectRoleOverride[] {
  if(!Array.isArray(value))return [];
  return value.flatMap(item=>{try{return projectAgentsInput([item]);}catch{return [];}}).filter((item,index,all)=>all.findIndex(other=>other.role===item.role)===index);
}
/**
 * The catalog chats in a project use: the global catalog with the project's fields laid over it.
 * When the two layers mix (project model with global reasoning or the reverse) and the model lacks that level, the level falls back to the model default.
 */
export function applyProjectAgents(catalog:RoleCatalog,overrides:ProjectRoleOverride[]|undefined,levels?:(model:string)=>string[]|undefined):RoleCatalog {
  const global=normalizeRoles(catalog),changes=normalizeProjectAgents(overrides);
  if(!changes.length)return global;
  return {revision:global.revision,roles:global.roles.map(item=>{
    const change=changes.find(other=>other.role===item.role);if(!change)return item;
    const model=has(change,"model")?change.model!:item.model;let reasoning=has(change,"reasoning")?change.reasoning!:item.reasoning;
    const mixed=has(change,"model")!==has(change,"reasoning"),supported=model&&reasoning?levels?.(model):undefined;
    if(mixed&&supported&&!supported.includes(reasoning!))reasoning=null;
    return {role:item.role,model,reasoning};
  })};
}
/** Root and coordinator always run on the chat's model; the catalog only maps delegated agents. */
export function resolveRole(catalog:RoleCatalog,type:RoleType,inheritedModel:string) {
  const item=type==="root"||type==="coordinator"?undefined:normalizeRoles(catalog).roles.find(item=>item.role===type);
  return {model:item?.model??inheritedModel,role:{type,catalog:structuredClone(catalog),requestedReasoning:(item?.reasoning??null) as RoleReasoning|null,instructions:""}};
}
