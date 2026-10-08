import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export const AGY_AGENT_NAME='sigma-antigravity';
export const AGY_LEGACY_UNSUPERVISED_AGENT_NAME='sigma-antigravity-unsupervised';
const profile=`---
name: ${AGY_AGENT_NAME}
description: Sigma isolated provider login profile
mainAgent: true
subagent: false
excludeDefaultComponents: true
inheritCustomizations: false
tools: []
mcpServers: []
skills: []
plugins: []
rules: []
hooks: []
commandExecutionPolicy: off
---
`;
// Legacy: earlier Sigma builds wrote this custom agent file for the unsupervised route; custom agents restrict AGY's tools, so it is no longer written and is removed on preparation.
// Two accepted settings variants. Strict denies every built-in tool family; unsupervised (explicit user opt-in) only keeps MCP denied.
const STRICT_DENY=['command(*)','read_file(*)','write_file(*)','read_url(*)','execute_url(*)','mcp(*)'],UNSUPERVISED_DENY=['mcp(*)'];
const denyFor=(unsupervised:boolean)=>unsupervised?UNSUPERVISED_DENY:STRICT_DENY;
const settingsText=(unsupervised:boolean,trusted?:string[])=>JSON.stringify({permissions:{deny:denyFor(unsupervised)},hooks:{},useG1Credits:false,...(trusted?.length?{trustedWorkspaces:trusted}:{})},null,2)+'\n';
const globalHooks='{}\n';
const ownedFiles=(home:string):Array<[string,string]>=>[
  [join(home,'.gemini','config','agents',`${AGY_AGENT_NAME}.md`),profile],
  [join(home,'.gemini','config','hooks.json'),globalHooks],
  [join(home,'.agents','hooks.json'),globalHooks],
];
const settingsPath=(home:string)=>join(home,'.gemini','antigravity-cli','settings.json');
const ownedDirectories=(home:string)=>[home,join(home,'.gemini'),join(home,'.gemini','config'),join(home,'.gemini','config','agents'),join(home,'.gemini','antigravity-cli'),join(home,'.agents')];
const object=(value:unknown):value is Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exactKeys=(value:Record<string,unknown>,allowed:string[])=>Object.keys(value).every(key=>allowed.includes(key));
function hasDuplicateJsonMembers(text:string){
  let at=0,duplicate=false;
  const whitespace=()=>{while(/[\t\n\r ]/.test(text[at]??''))at++;};
  const string=()=>{
    const start=at++;
    while(at<text.length){const character=text[at++];if(character==='"')return JSON.parse(text.slice(start,at)) as string;if(character==='\\')at++;}
    throw new Error('Invalid JSON string');
  };
  const value=():void=>{
    whitespace();const next=text[at];
    if(next==='{'){
      at++;whitespace();const keys=new Set<string>();if(text[at]==='}'){at++;return;}
      while(at<text.length){whitespace();if(text[at]!=='"')throw new Error('Invalid JSON object key');const key=string();if(keys.has(key))duplicate=true;keys.add(key);whitespace();if(text[at++]!==':')throw new Error('Invalid JSON object');value();whitespace();const separator=text[at++];if(separator==='}')return;if(separator!==',')throw new Error('Invalid JSON object');}
      throw new Error('Invalid JSON object');
    }
    if(next==='['){
      at++;whitespace();if(text[at]===']'){at++;return;}
      while(at<text.length){value();whitespace();const separator=text[at++];if(separator===']')return;if(separator!==',')throw new Error('Invalid JSON array');}
      throw new Error('Invalid JSON array');
    }
    if(next==='"'){string();return;}
    const start=at;while(at<text.length&&!/[\t\n\r ,\]}]/.test(text[at]))at++;if(at===start)throw new Error('Invalid JSON value');
  };
  try{value();whitespace();if(at!==text.length)return true;return duplicate;}catch{return true;}
}
function safeSettings(contents:string,home:string,unsupervised=false){
  try{
    if(hasDuplicateJsonMembers(contents))return false;
    const value=JSON.parse(contents);
    if(!object(value)||!exactKeys(value,['hooks','permissions','trustedWorkspaces','useG1Credits'])||value.useG1Credits!==undefined&&value.useG1Credits!==false)return false;
    // agy persists sparsely after sign-in: empty hooks/allow/ask and false flags may be omitted, and arrays may be reordered. Anything that adds behaviour is rejected.
    if(value.hooks!==undefined&&(!object(value.hooks)||Object.keys(value.hooks).length!==0)||!object(value.permissions)||!exactKeys(value.permissions,['deny','allow','ask']))return false;
    const deny=value.permissions.deny,allow=value.permissions.allow,ask=value.permissions.ask,required=denyFor(unsupervised);
    if(!Array.isArray(deny)||deny.some(entry=>typeof entry!=='string')||new Set(deny).size!==required.length||!required.every(entry=>deny.includes(entry)))return false;
    if(allow!==undefined&&(!Array.isArray(allow)||allow.length!==0)||ask!==undefined&&(!Array.isArray(ask)||ask.length!==0))return false;
    const trusted=value.trustedWorkspaces;
    return trusted===undefined||Array.isArray(trusted)&&(trusted.length===0||trusted.length===1&&trusted[0]===home);
  }catch{return false;}
}

async function writeSettingsAtomically(path:string,contents:string){
  const temp=`${path}.${randomUUID()}.tmp`;
  try{const handle=await open(temp,'wx',0o600);try{await handle.writeFile(contents);await handle.sync();}finally{await handle.close();}await rename(temp,path);}finally{await rm(temp,{force:true});}
}
/** Creates settings in the requested variant; an existing guarded file of the other variant is rewritten atomically (trusted workspaces kept). Anything else is refused, never clobbered. */
async function ensurePrivateSettings(path:string,home:string,unsupervised:boolean){
  try{
    const handle=await open(path,'wx',0o600);
    try{await handle.writeFile(settingsText(unsupervised));await handle.sync();}finally{await handle.close();}
    return;
  }catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||(info.mode&0o777)!==0o600)throw new Error('Antigravity settings contain unsafe or changed policy');
  const contents=await readFile(path,'utf8');
  if(safeSettings(contents,home,unsupervised))return;
  if(!safeSettings(contents,home,!unsupervised))throw new Error('Antigravity settings contain unsafe or changed policy');
  const trusted=JSON.parse(contents).trustedWorkspaces as string[]|undefined;
  await writeSettingsAtomically(path,settingsText(unsupervised,trusted));
}

/** Read-only live guard used before the UI exposes the native login command. */
export function agyProfileIsReady(dataDir:string,home:string,unsupervised=false){
  try{
    const root=realpathSync(dataDir),expected=join(root,'antigravity-profile');
    if(resolve(home)!==expected||realpathSync(home)!==expected)return false;
    for(const path of ownedDirectories(home)){const info=lstatSync(path);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o777)!==0o700)return false;}
    for(const [path,contents] of ownedFiles(home)){const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||(info.mode&0o777)!==0o600||!readFileSync(path).equals(Buffer.from(contents)))return false;}
    const settingsInfo=lstatSync(settingsPath(home));if(!settingsInfo.isFile()||settingsInfo.isSymbolicLink()||settingsInfo.nlink!==1||(settingsInfo.mode&0o777)!==0o600||!safeSettings(readFileSync(settingsPath(home),'utf8'),home,unsupervised))return false;
    return true;
  }catch{return false;}
}

async function ensurePrivateDirectory(path:string,root:string){
  const absolute=resolve(path),rel=absolute===root?'':relative(root,absolute);
  if(rel==='..'||rel.startsWith(`..${sep}`))throw new Error('Antigravity profile path escaped its owner');
  let current=root;
  for(const component of rel?rel.split(sep):[]){
    current=join(current,component);
    try{await mkdir(current,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    const info=await lstat(current);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Antigravity profile path contains an unsafe directory');
    await chmod(current,0o700);
  }
  if(await realpath(absolute)!==absolute)throw new Error('Antigravity profile path resolves outside its owner');
}

async function ensurePrivateFile(path:string,contents:string){
  const bytes=Buffer.from(contents);
  try{
    const handle=await open(path,'wx',0o600);
    try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  }catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||!(await readFile(path)).equals(bytes))throw new Error('Antigravity owned profile file has drifted');
    await chmod(path,0o600);
  }
}

/** Removes only the exact legacy agent file Sigma once created (regular file, single link, no symlink); anything else is left alone. */
async function removeLegacyUnsupervisedAgent(home:string){
  const path=join(home,'.gemini','config','agents',`${AGY_LEGACY_UNSUPERVISED_AGENT_NAME}.md`);
  try{const info=await lstat(path);if(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1)await rm(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}

/** Create only Sigma's private Antigravity profile; never read or alter the user's global CLI config. */
export async function prepareAgyProfile(dataDir:string,unsupervised=false){
  const root=await realpath(dataDir),home=join(root,'antigravity-profile'),gemini=join(home,'.gemini'),config=join(gemini,'config');
  await ensurePrivateDirectory(home,root);await ensurePrivateDirectory(gemini,root);await ensurePrivateDirectory(config,root);
  await ensurePrivateDirectory(join(config,'agents'),root);await ensurePrivateDirectory(join(gemini,'antigravity-cli'),root);await ensurePrivateDirectory(join(home,'.agents'),root);
  await removeLegacyUnsupervisedAgent(home);
  for(const [path,contents] of ownedFiles(home))await ensurePrivateFile(path,contents);
  await ensurePrivateSettings(settingsPath(home),home,unsupervised);
  return home;
}
