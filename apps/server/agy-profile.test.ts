import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { agyProfileIsReady, prepareAgyProfile } from './agy-profile.js';
import { NativeCli, AGY_PROVIDER_ID } from './native-cli.js';

const guardNames=['command(*)','read_file(*)','write_file(*)','read_url(*)','execute_url(*)','mcp(*)'];
async function scratch(name:string){const parent=resolve(import.meta.dirname,'../../.scratch');await mkdir(parent,{recursive:true,mode:0o700});return mkdtemp(join(parent,`${name}-`));}

test('Antigravity preparation creates a private fail-closed profile without touching CLI auth files',async()=>{
  const root=await scratch('agy-profile');
  try{
    const home=join(root,'antigravity-profile');await mkdir(home,{mode:0o700});
    const auth=join(home,'.gemini','antigravity-cli');await mkdir(join(home,'.gemini'),{mode:0o700});await mkdir(auth,{mode:0o700});
    const authFile=join(auth,'auth_tokens.json');await writeFile(authFile,'native-auth-sentinel',{mode:0o600});
    assert.equal(await prepareAgyProfile(root),home);assert.equal(await prepareAgyProfile(root),home);
    assert.equal(await readFile(authFile,'utf8'),'native-auth-sentinel');
    const settings=JSON.parse(await readFile(join(auth,'settings.json'),'utf8'));
    assert.deepEqual(settings,{permissions:{deny:guardNames},hooks:{},useG1Credits:false});
    assert.equal(await readFile(join(home,'.gemini','config','hooks.json'),'utf8'),'{}\n');
    assert.equal(await readFile(join(home,'.agents','hooks.json'),'utf8'),'{}\n');
    const agent=await readFile(join(home,'.gemini','config','agents','sigma-antigravity.md'),'utf8');
    for(const field of ['mainAgent: true','subagent: false','excludeDefaultComponents: true','inheritCustomizations: false','tools: []','mcpServers: []','skills: []','plugins: []','rules: []','hooks: []','commandExecutionPolicy: off'])assert.ok(agent.includes(field),field);
    await assert.rejects(lstat(join(home,'.gemini','config','agents','sigma-antigravity-unsupervised.md')),{code:'ENOENT'},'No custom unsupervised agent (restricts tools)');
    for(const path of [home,join(home,'.gemini'),join(home,'.gemini','config'),join(home,'.gemini','config','agents'),auth,join(home,'.agents')])assert.equal((await lstat(path)).mode&0o777,0o700,path);
    for(const path of [join(auth,'settings.json'),join(home,'.gemini','config','hooks.json'),join(home,'.gemini','config','agents','sigma-antigravity.md'),join(home,'.agents','hooks.json')])assert.equal((await lstat(path)).mode&0o777,0o600,path);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Antigravity preparation removes only the exact legacy unsupervised agent file',async()=>{
  const root=await scratch('agy-legacy');
  try{
    await prepareAgyProfile(root);
    const agents=join(root,'antigravity-profile','.gemini','config','agents'),legacy=join(agents,'sigma-antigravity-unsupervised.md'),outside=join(root,'outside.md');
    await writeFile(legacy,'legacy',{mode:0o600});await prepareAgyProfile(root,true);
    await assert.rejects(lstat(legacy),{code:'ENOENT'});
    await writeFile(outside,'keep',{mode:0o644});await symlink(outside,legacy);await prepareAgyProfile(root,true);
    assert.equal(await readFile(outside,'utf8'),'keep');assert.ok((await lstat(legacy)).isSymbolicLink());
    await assert.ok(await readFile(join(agents,'sigma-antigravity.md'),'utf8'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Antigravity preparation refuses settings drift and symlinked owned files without changing their targets',async()=>{
  const root=await scratch('agy-drift');
  try{
    await prepareAgyProfile(root);
    const settings=join(root,'antigravity-profile','.gemini','antigravity-cli','settings.json');
    await writeFile(settings,'customized settings',{mode:0o600});
    await assert.rejects(prepareAgyProfile(root),/unsafe or changed policy/);
    assert.equal(await readFile(settings,'utf8'),'customized settings');
    await writeFile(settings,JSON.stringify({permissions:{deny:guardNames},hooks:{},useG1Credits:false},null,2)+'\n');
    const hooks=join(root,'antigravity-profile','.gemini','config','hooks.json'),outside=join(root,'outside-hooks.json');
    await writeFile(outside,'{}\n',{mode:0o644});await rm(hooks);await symlink(outside,hooks);
    await assert.rejects(prepareAgyProfile(root),/drifted/);
    assert.equal((await lstat(outside)).mode&0o777,0o644);
    assert.equal(await readFile(outside,'utf8'),'{}\n');
    await rm(hooks,{force:true});await rm(join(root,'antigravity-profile','.agents'),{recursive:true});
    const outsideDirectory=join(root,'outside-directory');await mkdir(outsideDirectory,{mode:0o755});await symlink(outsideDirectory,join(root,'antigravity-profile','.agents'));
    await assert.rejects(prepareAgyProfile(root),/unsafe directory/);
    assert.equal((await lstat(outsideDirectory)).mode&0o777,0o755);
    await rm(join(root,'antigravity-profile','.agents'));await mkdir(join(root,'antigravity-profile','.agents'),{mode:0o700});
    await rm(hooks,{force:true});await writeFile(hooks,'{}\n',{mode:0o600});
    assert.equal((await lstat(settings)).mode&0o777,0o600);const hardlink=join(root,'outside-hardlink.json');await link(settings,hardlink);
    await assert.rejects(prepareAgyProfile(root),/unsafe or changed policy/);
    assert.equal((await lstat(hardlink)).mode&0o777,0o600);
    assert.equal(await readFile(hardlink,'utf8'),await readFile(settings,'utf8'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Antigravity preparation accepts and preserves native sparse trusted-home settings while rejecting unsafe policy additions',async()=>{
  const root=await scratch('agy-native-settings');
  try{
    const home=await prepareAgyProfile(root),path=join(home,'.gemini','antigravity-cli','settings.json');
    const native=JSON.stringify({hooks:{},permissions:{deny:guardNames},trustedWorkspaces:[home]});
    await writeFile(path,native,{mode:0o600});
    assert.equal(agyProfileIsReady(root,home),true,'Native omitted false useG1Credits while preserving the owned trusted workspace');
    await prepareAgyProfile(root);
    assert.equal(await readFile(path,'utf8'),native,'Refresh must preserve native-owned serialization byte for byte');
    const unsafe=[
      {hooks:{},permissions:{deny:guardNames},trustedWorkspaces:[home],useG1Credits:true},
      {hooks:{BeforeTool:[{}]},permissions:{deny:guardNames},trustedWorkspaces:[home]},
      {hooks:{},permissions:{deny:guardNames,allow:['command(*)']},trustedWorkspaces:[home]},
      {hooks:{},permissions:{deny:guardNames},trustedWorkspaces:[home,'/other-workspace']},
      {hooks:{},permissions:{deny:guardNames},trustedWorkspaces:[home],modelProvider:'proxy'}
    ];
    for(const value of unsafe){const bytes=JSON.stringify(value);await writeFile(path,bytes,{mode:0o600});assert.equal(agyProfileIsReady(root,home),false);await assert.rejects(prepareAgyProfile(root),/unsafe or changed policy/);assert.equal(await readFile(path,'utf8'),bytes,'Unsafe native state remains untouched for inspection');}
    const duplicates=[
      `{"hooks":{"Stop":[{"command":"unsafe"}]},"permissions":{"deny":${JSON.stringify(guardNames)}},"trustedWorkspaces":[${JSON.stringify(home)}],"\\u0068ooks":{}}`,
      `{"hooks":{},"permissions":{"deny":${JSON.stringify(guardNames.slice(0,5))},"den\\u0079":${JSON.stringify(guardNames)}},"trustedWorkspaces":[${JSON.stringify(home)}]}`
    ];
    for(const bytes of duplicates){await writeFile(path,bytes,{mode:0o600});assert.equal(agyProfileIsReady(root,home),false);await assert.rejects(prepareAgyProfile(root),/unsafe or changed policy/);assert.equal(await readFile(path,'utf8'),bytes,'Ambiguous JSON remains untouched for inspection');}
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Antigravity profile accepts semantically equivalent sparse settings after sign-in but rejects any weakening',async()=>{
  const root=await scratch('agy-sparse');
  try{
    const home=await prepareAgyProfile(root),path=join(home,'.gemini','antigravity-cli','settings.json'),reordered=[...guardNames].reverse();
    const safe=[{permissions:{deny:guardNames}},{permissions:{deny:reordered},useG1Credits:false},{permissions:{deny:reordered,allow:[],ask:[]},hooks:{},trustedWorkspaces:[]},{permissions:{deny:guardNames},trustedWorkspaces:[home]}];
    for(const value of safe){const bytes=JSON.stringify(value);await writeFile(path,bytes,{mode:0o600});assert.equal(agyProfileIsReady(root,home),true,bytes);assert.equal(await prepareAgyProfile(root),home);assert.equal(await readFile(path,'utf8'),bytes,'Native sparse serialization is preserved');}
    const unsafe=[{hooks:{},useG1Credits:false},{permissions:{deny:guardNames.slice(1)}},{permissions:{deny:[...guardNames.slice(1),'command(x)']}},{permissions:{deny:[...guardNames,7]}},{permissions:{deny:guardNames},hooks:{Stop:[]}},{permissions:{deny:guardNames,ask:['command(*)']}},{permissions:{deny:guardNames},useG1Credits:true},{permissions:{deny:guardNames},trustedWorkspaces:['/']}];
    for(const value of unsafe){const bytes=JSON.stringify(value);await writeFile(path,bytes,{mode:0o600});assert.equal(agyProfileIsReady(root,home),false,bytes);await assert.rejects(prepareAgyProfile(root),/unsafe or changed policy/);}
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Antigravity login command waits for preparation and runs with only its private HOME and allowlisted environment',async()=>{
  const oldHome=process.env.HOME,oldPath=process.env.PATH,oldUser=process.env.USER,oldSecret=process.env.AGY_ACCESS_TOKEN,oldOffline=process.env.PI_OFFLINE,oldDemo=process.env.SIGMA_DEMO,oldPiDemo=process.env.PI_ORCH_DEMO;
  const root=await scratch('agy-command-quote'),home=join(root,"cli'home"),data=join(root,"app' data");
  try{
    process.env.HOME=home;await mkdir(join(home,'.local','bin'),{recursive:true,mode:0o700});
    const binary=join(home,'.local','bin','agy'),observed=join(root,'observed.json');
    const script=`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(observed)},JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),home:process.env.HOME,keys:Object.keys(process.env)}));\n`;
    await writeFile(binary,script,{mode:0o700});await chmod(binary,0o700);process.env.AGY_ACCESS_TOKEN='must-not-reach-cli';
    await mkdir(data,{recursive:true,mode:0o700});process.env.PI_OFFLINE='0';delete process.env.SIGMA_DEMO;delete process.env.PI_ORCH_DEMO;
    const owner=new NativeCli(data);await owner.init();assert.equal(owner.list()[1].loginCommand,undefined);
    await owner.refresh(AGY_PROVIDER_ID);const view=owner.list()[1];assert.ok(view.loginCommand);assert.equal(view.profileReady,true);
    assert.equal(agyProfileIsReady(data,join(data,'antigravity-profile')),true);
    execFileSync('/bin/sh',['-c',view.loginCommand],{stdio:'ignore'});
    const result=JSON.parse(await readFile(observed,'utf8'));
    assert.deepEqual(result.argv,['--agent','sigma-antigravity']);assert.equal(result.cwd,join(data,'antigravity-profile'));assert.equal(result.home,join(data,'antigravity-profile'));
    assert.ok(result.keys.includes('AGY_CLI_DISABLE_AUTO_UPDATE'));assert.ok(!result.keys.includes('AGY_ACCESS_TOKEN'));assert.ok(!result.keys.some((key:string)=>/API_KEY|OAUTH|TOKEN/.test(key)));
    const before=await readFile(observed,'utf8');await assert.rejects(owner.connect(AGY_PROVIDER_ID),/blocked/);assert.equal(await readFile(observed,'utf8'),before);
    const offlineData=join(root,'offline-data');await mkdir(offlineData,{mode:0o700});process.env.SIGMA_DEMO='1';
    const offlineOwner=new NativeCli(offlineData);await offlineOwner.init();await offlineOwner.refresh(AGY_PROVIDER_ID);
    assert.equal(offlineOwner.list()[1].profileReady,false);assert.equal(offlineOwner.list()[1].loginCommand,undefined);
    await assert.rejects(stat(join(offlineData,'antigravity-profile')));await offlineOwner.close();delete process.env.SIGMA_DEMO;
    await chmod(join(data,'antigravity-profile','.gemini','antigravity-cli','settings.json'),0o644);
    const drifted=owner.list()[1];assert.equal(drifted.state,'error');assert.equal(drifted.loginCommand,undefined);assert.equal(drifted.profileReady,false);
    await owner.close();
  }finally{
    if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;
    if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;
    if(oldUser===undefined)delete process.env.USER;else process.env.USER=oldUser;
    if(oldSecret===undefined)delete process.env.AGY_ACCESS_TOKEN;else process.env.AGY_ACCESS_TOKEN=oldSecret;
    if(oldOffline===undefined)delete process.env.PI_OFFLINE;else process.env.PI_OFFLINE=oldOffline;
    if(oldDemo===undefined)delete process.env.SIGMA_DEMO;else process.env.SIGMA_DEMO=oldDemo;
    if(oldPiDemo===undefined)delete process.env.PI_ORCH_DEMO;else process.env.PI_ORCH_DEMO=oldPiDemo;
    await rm(root,{recursive:true,force:true});
  }
});

test('profile readiness accepts exactly the strict and unsupervised variants and the flag must match; tampering fails closed in both modes',async()=>{
  const root=await scratch('agy-variants');
  try{
    const home=await prepareAgyProfile(root),path=join(home,'.gemini','antigravity-cli','settings.json'),auth=join(home,'.gemini','antigravity-cli','auth_tokens.json'),open=['mcp(*)'];
    await writeFile(auth,'auth-sentinel',{mode:0o600});await chmod(auth,0o000);
    try{
      assert.equal(agyProfileIsReady(root,home,false),true);assert.equal(agyProfileIsReady(root,home,true),false,'strict file with flag on');
      assert.equal(await prepareAgyProfile(root,true),home);assert.deepEqual(JSON.parse(await readFile(path,'utf8')),{permissions:{deny:open},hooks:{},useG1Credits:false});
      assert.equal(agyProfileIsReady(root,home,true),true);assert.equal(agyProfileIsReady(root,home,false),false,'unsupervised file with flag off');
      // Sparse native rewrites stay accepted for both variants.
      for(const [deny,flag] of [[open,true],[guardNames.slice().reverse(),false]] as const){await writeFile(path,JSON.stringify({permissions:{deny},trustedWorkspaces:[home]}),{mode:0o600});assert.equal(agyProfileIsReady(root,home,flag),true);}
      // Trusted workspace survives a variant switch.
      await writeFile(path,JSON.stringify({permissions:{deny:open},hooks:{},trustedWorkspaces:[home]}),{mode:0o600});await prepareAgyProfile(root,false);
      assert.deepEqual(JSON.parse(await readFile(path,'utf8')),{permissions:{deny:guardNames},hooks:{},useG1Credits:false,trustedWorkspaces:[home]});
      for(const flag of [false,true]){
        const deny=flag?open:guardNames;
        const tampered=[{permissions:{deny},hooks:{Stop:[{}]}},{permissions:{deny,allow:['command(*)']}},{permissions:{deny:deny.filter(entry=>entry!=='mcp(*)')}},{permissions:{deny},useG1Credits:true},{permissions:{deny},extra:1},{permissions:{deny:[...deny,'command(x)']}},{permissions:{deny:[]}}];
        for(const value of tampered){const bytes=JSON.stringify(value);await writeFile(path,bytes,{mode:0o600});assert.equal(agyProfileIsReady(root,home,flag),false,bytes);await assert.rejects(prepareAgyProfile(root,flag),/unsafe or changed policy/);assert.equal(await readFile(path,'utf8'),bytes,'Refusal never clobbers');}
      }
      // A weakened strict file is not a valid unsupervised file either (no silent upgrade of tampered content).
      await writeFile(path,JSON.stringify({permissions:{deny:['command(*)','mcp(*)']}}),{mode:0o600});assert.equal(agyProfileIsReady(root,home,true),false);assert.equal(agyProfileIsReady(root,home,false),false);
    }finally{await chmod(auth,0o600);}
    assert.equal(await readFile(auth,'utf8'),'auth-sentinel');
  }finally{await rm(root,{recursive:true,force:true});}
});
