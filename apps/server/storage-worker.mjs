import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(workerData.path);
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, cwd TEXT NOT NULL, file TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, parent_id TEXT, role TEXT NOT NULL DEFAULT 'root');
CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, tool TEXT NOT NULL, preview TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, request_hash TEXT NOT NULL, input_text TEXT, behavior TEXT);
CREATE TABLE IF NOT EXISTS git_commands(id TEXT PRIMARY KEY, cwd TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, folders TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(name TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS project_tasks(id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checks(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS source_applies(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, source_cwd TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS worker_merges(id TEXT PRIMARY KEY, root_id TEXT NOT NULL, worker_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS qa_runs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS qa_actions(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS qa_artifacts(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS qa_findings(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS qa_views(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS qa_gates(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS browser_actions(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS browser_artifacts(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_session_seq ON events(session_id,seq);
UPDATE sessions SET status='interrupted' WHERE status='running';
UPDATE approvals SET status='expired' WHERE status='pending';`);
if(!db.prepare("PRAGMA table_info(approvals)").all().some(x=>x.name==="preview"))db.exec("ALTER TABLE approvals ADD COLUMN preview TEXT NOT NULL DEFAULT 'Details unavailable'");
if(!db.prepare("PRAGMA table_info(approvals)").all().some(x=>x.name==="git"))db.exec("ALTER TABLE approvals ADD COLUMN git TEXT");
if(!db.prepare("PRAGMA table_info(approvals)").all().some(x=>x.name==="change"))db.exec("ALTER TABLE approvals ADD COLUMN change TEXT");
if(!db.prepare("PRAGMA table_info(approvals)").all().some(x=>x.name==="outcome"))db.exec("ALTER TABLE approvals ADD COLUMN outcome TEXT");
if(!db.prepare("PRAGMA table_info(approvals)").all().some(x=>x.name==="command_id"))db.exec("ALTER TABLE approvals ADD COLUMN command_id TEXT");
if(!db.prepare("PRAGMA table_info(approvals)").all().some(x=>x.name==="reconciliation"))db.exec("ALTER TABLE approvals ADD COLUMN reconciliation TEXT");
db.exec("UPDATE approvals SET outcome='unknown' WHERE outcome='applying'");
if(!db.prepare("PRAGMA table_info(sessions)").all().some(x=>x.name==="parent_id"))db.exec("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
if(!db.prepare("PRAGMA table_info(sessions)").all().some(x=>x.name==="role"))db.exec("ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'root'");
if(!db.prepare("PRAGMA table_info(sessions)").all().some(x=>x.name==="policy"))db.exec("ALTER TABLE sessions ADD COLUMN policy TEXT");
if(!db.prepare("PRAGMA table_info(sessions)").all().some(x=>x.name==="archived_at"))db.exec("ALTER TABLE sessions ADD COLUMN archived_at INTEGER");
if(!db.prepare("PRAGMA table_info(sessions)").all().some(x=>x.name==="manager_id"))db.exec("ALTER TABLE sessions ADD COLUMN manager_id TEXT");
if(!db.prepare("PRAGMA table_info(sessions)").all().some(x=>x.name==="dispatch_started"))db.exec("ALTER TABLE sessions ADD COLUMN dispatch_started INTEGER NOT NULL DEFAULT 0");
if(!db.prepare("PRAGMA table_info(projects)").all().some(x=>x.name==="archived_at"))db.exec("ALTER TABLE projects ADD COLUMN archived_at INTEGER");
if(!db.prepare("PRAGMA table_info(browser_actions)").all().some(x=>x.name==="request_hash"))db.exec("ALTER TABLE browser_actions ADD COLUMN request_hash TEXT NOT NULL DEFAULT ''");
db.exec("UPDATE sessions SET status='interrupted' WHERE parent_id IS NOT NULL AND status='idle'");
if(!db.prepare("PRAGMA table_info(commands)").all().some(x=>x.name==="request_hash"))db.exec("ALTER TABLE commands ADD COLUMN request_hash TEXT NOT NULL DEFAULT ''");
if(!db.prepare("PRAGMA table_info(commands)").all().some(x=>x.name==="input_text"))db.exec("ALTER TABLE commands ADD COLUMN input_text TEXT");
if(!db.prepare("PRAGMA table_info(commands)").all().some(x=>x.name==="behavior"))db.exec("ALTER TABLE commands ADD COLUMN behavior TEXT");
if(!db.prepare("PRAGMA table_info(commands)").all().some(x=>x.name==="agent_id"))db.exec("ALTER TABLE commands ADD COLUMN agent_id TEXT");
if(!db.prepare("PRAGMA table_info(commands)").all().some(x=>x.name==="reserved"))db.exec("ALTER TABLE commands ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0");
if(!db.prepare("PRAGMA table_info(commands)").all().some(x=>x.name==="setup"))db.exec("ALTER TABLE commands ADD COLUMN setup TEXT");
db.exec("UPDATE commands SET status='unknown' WHERE status IN ('accepted','dispatched','queued','continuing')");
for(const row of db.prepare("SELECT c.id,c.session_id AS sessionId,s.policy FROM commands c JOIN sessions s ON s.id=c.session_id WHERE c.status='unknown' AND c.kind IN ('edit','write')").all()){
  if(JSON.parse(row.policy||'null')?.workspace?.kind!=='direct')continue;
  const approved=db.prepare("SELECT id,outcome FROM approvals WHERE command_id=? AND status='approved'").all(row.id);
  if(!approved.length){db.prepare("UPDATE commands SET status='rejected' WHERE id=? AND status='unknown'").run(row.id);continue;}
  // No replacement starts before the durable 'applying' outcome; a null/failed receipt proves no write began.
  if(approved.every(item=>item.outcome===null||item.outcome==='failed')){
    db.prepare("UPDATE approvals SET outcome='failed' WHERE command_id=? AND status='approved' AND outcome IS NULL").run(row.id);
    db.prepare("UPDATE commands SET status='failed' WHERE id=? AND status='unknown'").run(row.id);
  }
}
db.exec("UPDATE checks SET status='expired' WHERE status='pending'; UPDATE checks SET status='unknown' WHERE status IN ('approved','running'); UPDATE reviews SET status='unknown' WHERE status='running'");
// The Chrome socket/grant is process-local. Never resume a proposed or dispatched action after restart.
for(const row of db.prepare("SELECT id,status,data FROM browser_actions WHERE status IN ('proposed','approved','dispatched')").all()){
  const status=row.status==='dispatched'?'unknown':'cancelled';
  db.prepare("UPDATE browser_actions SET status=?,data=? WHERE id=?").run(status,JSON.stringify({...JSON.parse(row.data),status,endedAt:Date.now(),detail:status==='unknown'?'Server stopped after dispatch; outcome unknown and never replayed':'Server stopped before dispatch; nothing was sent'}),row.id);
}
// QA: the browser group died with the server. A dispatched action may or may not have had an effect: unknown, never replayed. Undispatched actions provably did nothing.
for(const row of db.prepare("SELECT id,status,data FROM qa_runs WHERE status IN ('starting','running')").all())db.prepare("UPDATE qa_runs SET status='unknown',data=? WHERE id=?").run(JSON.stringify({...JSON.parse(row.data),status:'unknown',endedAt:Date.now(),error:'Server stopped while the QA run was active; start a new run'}),row.id);
for(const row of db.prepare("SELECT id,status,data FROM qa_actions WHERE status IN ('proposed','approved','dispatched')").all()){
  const status=row.status==='dispatched'?'unknown':'cancelled';
  db.prepare("UPDATE qa_actions SET status=?,data=? WHERE id=?").run(status,JSON.stringify({...JSON.parse(row.data),status,endedAt:Date.now(),detail:status==='unknown'?'Server stopped after dispatch; the effect is unknown and the action is never replayed':'Server stopped before dispatch; nothing was sent'}),row.id);
}
for(const row of db.prepare("SELECT id,data FROM project_tasks WHERE status IN ('creating','continuing')").all()){
  db.prepare("UPDATE project_tasks SET status='unknown',data=? WHERE id=?").run(JSON.stringify({...JSON.parse(row.data),status:"unknown"}),row.id);
}
for(const row of db.prepare("SELECT id,status,data FROM source_applies WHERE status IN ('pending','approved','running')").all()){
  const prior=JSON.parse(row.data),status=row.status==='pending'?'expired':'unknown';
  const files=prior.files.map(file=>file.status==='applying'?{...file,status:'unknown'}:file);
  db.prepare("UPDATE source_applies SET status=?,data=? WHERE id=?").run(status,JSON.stringify({...prior,status,files,endedAt:Date.now()}),row.id);
}
for(const row of db.prepare("SELECT id,status,data FROM worker_merges WHERE status IN ('pending','running')").all()){
  const prior=JSON.parse(row.data),status=row.status==='pending'?'expired':'unknown';
  const files=prior.files.map(file=>file.status==='applying'?{...file,status:'unknown'}:file);
  db.prepare("UPDATE worker_merges SET status=?,data=? WHERE id=?").run(status,JSON.stringify({...prior,status,files,endedAt:Date.now()}),row.id);
}

if(!db.prepare("PRAGMA table_info(sessions)").all().some(x=>x.name==="graph_metadata"))db.exec("ALTER TABLE sessions ADD COLUMN graph_metadata TEXT");
function graphEvent(sessionId,type,payload){
  const at=Date.now(),result=db.prepare("INSERT INTO events(session_id,type,payload,at) VALUES(?,?,?,?)").run(sessionId,type,JSON.stringify(payload),at);
  return {seq:Number(result.lastInsertRowid),sessionId,type,payload,at};
}
// Preserve an uncertain dispatch after a crash; never replay it to obtain a receipt.
for(const row of db.prepare("SELECT session_id,payload FROM events WHERE type='graph_fact' ORDER BY seq").all()){
  const fact=JSON.parse(row.payload);
  if(fact.outcome==='pending'&&db.prepare("SELECT status FROM commands WHERE id=?").get(fact.commandId)?.status==='unknown'){
    const latest=db.prepare("SELECT payload FROM events WHERE type='graph_fact' AND json_extract(payload,'$.id')=? ORDER BY seq DESC LIMIT 1").get(fact.id);
    if(JSON.parse(latest.payload).outcome==='pending')graphEvent(row.session_id,'graph_fact',{...fact,outcome:'unknown'});
  }
}
function lineage(id){
  const rows=[];const seen=new Set();
  while(id){
    if(seen.has(id))throw new Error("Invalid session ancestry");seen.add(id);
    const row=queries.session({id});if(!row)throw new Error("Session ancestry unavailable");rows.push(row);id=row.parentId;
  }
  return rows;
}
function archivedOwner(id){
  const parents=lineage(id),root=parents.at(-1);
  if(root.archivedAt)return true;
  return !!root.policy?.task&&!!projectTask(root.policy.task.id)?.archivedAt;
}
function assertQuiescent(ids){
  if(!ids.length)return;
  const marks=ids.map(()=>'?').join(',');
  if(db.prepare(`SELECT 1 FROM sessions WHERE id IN (${marks}) AND status='running' LIMIT 1`).get(...ids))throw new Error("Stop every session in this owner tree before archiving");
  if(db.prepare(`SELECT 1 FROM commands WHERE session_id IN (${marks}) AND status IN ('accepted','dispatched','queued','unknown','continuing') LIMIT 1`).get(...ids))throw new Error("Resolve active or unknown commands before archiving");
  for(const [table,statuses] of [["checks","'pending','approved','running','unknown'"],["reviews","'running','unknown'"],["source_applies","'pending','approved','running','unknown','partial'"],["qa_runs","'starting','running'"]])if(db.prepare(`SELECT 1 FROM ${table} WHERE session_id IN (${marks}) AND status IN (${statuses}) LIMIT 1`).get(...ids))throw new Error("Resolve active or unknown work before archiving");
  if(db.prepare(`SELECT 1 FROM approvals WHERE (session_id IN (${marks}) OR agent_id IN (${marks})) AND (status='pending' OR outcome IN ('applying','unknown')) LIMIT 1`).get(...ids,...ids))throw new Error("Resolve pending or unknown approvals before archiving");
  if(db.prepare(`SELECT 1 FROM worker_merges WHERE (root_id IN (${marks}) OR worker_id IN (${marks})) AND status IN ('pending','running','unknown','partial') LIMIT 1`).get(...ids,...ids))throw new Error("Resolve active or unknown merges before archiving");
  if(db.prepare(`SELECT 1 FROM commands c WHERE c.session_id IN (${marks}) AND c.reserved=1 AND c.status NOT IN ('rejected','failed','completed','cancelled','reconciled') AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id=c.agent_id) LIMIT 1`).get(...ids))throw new Error("Resolve reserved child setup before archiving");
}
function descendants(id){
  return db.prepare("WITH RECURSIVE tree(id) AS (SELECT id FROM sessions WHERE id=? UNION SELECT s.id FROM sessions s JOIN tree t ON s.parent_id=t.id) SELECT s.id,s.cwd,s.model,s.status,s.parent_id AS parentId,s.role FROM sessions s JOIN tree ON s.id=tree.id ORDER BY s.created_at,s.rowid").all(id);
}
function delegationContext(id){
  const parents=lineage(id),parent=parents[0],root=parents.at(-1),depth=parents.length-1;
  if(parents.some(row=>row.policy?.version===2&&JSON.stringify(row.policy.task??null)!==JSON.stringify(root.policy?.task??null)))throw new Error("Session differs from saved task ancestry");
  const limit=Math.min(root.policy?.effective.profile.maxDepth??1,parent.policy?.effective.profile.maxDepth??1,root.policy?.version===2?2:1);
  const reviewer=queries.reviewAgent({agentId:id});
  return {root,depth,ancestors:parents.slice(1).map(row=>row.id),canDelegate:!reviewer&&depth<limit};
}
function descendantMember(rootId,agentId){
  const parents=lineage(agentId),root=parents.at(-1);
  if(root.id!==rootId||agentId===rootId||root.parentId)throw new Error("Child does not belong to this root session");
  return delegationContext(agentId);
}
function reserveChild({parentId,agentId,commandId,reviewer=false,setup=null}){
  db.exec("BEGIN IMMEDIATE");
  try{
    const context=delegationContext(parentId),root=context.root;
    if(archivedOwner(parentId))throw new Error("Archived session or task cannot admit child work");
    const command=db.prepare("SELECT session_id,agent_id,status,reserved FROM commands WHERE id=?").get(commandId);
    if(!command||command.session_id!==parentId||command.agent_id!==agentId||command.status!=='accepted'||command.reserved)throw new Error("Child admission is no longer current");
    if(!reviewer&&!context.canDelegate)throw new Error("Maximum delegation depth reached");
    if(reviewer&&(parentId!==root.id||queries.reviewAgent({agentId:parentId})))throw new Error("Review owner unavailable");
    // No agent-count limit: only profiles that cannot delegate at all (rootTotalChildren 0) refuse children. Any positive number from an older policy means unlimited.
    if(!reviewer&&root.policy?.effective.profile.rootTotalChildren===0)throw new Error("Delegation is not available for this session");
    db.prepare("UPDATE commands SET reserved=1,setup=coalesce(setup,?) WHERE id=?").run(setup?JSON.stringify(setup):null,commandId);
    db.exec("COMMIT");return context;
  }catch(error){db.exec("ROLLBACK");throw error;}
}
function graphScope(scopeId){
  const rows=db.prepare("SELECT id,cwd,model,status,parent_id AS parentId,role,policy,graph_metadata AS metadata FROM sessions ORDER BY created_at,id").all().map(row=>({...row,policy:JSON.parse(row.policy||'null'),metadata:JSON.parse(row.metadata||'null')}));
  const scope=rows.find(row=>row.id===scopeId);
  if(!scope||scope.parentId)throw new Error("Graph root unavailable");
  let roots=[scope],rootId=scope.id,taskId=scope.policy?.task?.id??null;
  if(taskId){
    const task=projectTask(taskId);
    if(!task)throw new Error("Graph task unavailable");
    const coordinator=rows.find(row=>row.id===task.coordinatorId);
    if(coordinator&&(coordinator.parentId||coordinator.policy?.task?.id!==taskId||coordinator.policy.task.repositoryId||coordinator.policy.requested.mode!=="multi"))throw new Error("Graph coordinator differs from task snapshot");
    roots=coordinator?[coordinator]:[];rootId=task.coordinatorId;
    for(const repo of task.repositories){
      const member=rows.find(row=>row.id===repo.sessionId);
      if(!member)continue; // An interrupted setup can leave a repository session absent.
      if(member.parentId||member.policy?.task?.id!==taskId||member.policy.task.repositoryId!==repo.id||member.policy.workspace?.sourceCwd!==repo.sourceCwd||member.policy.workspace.baseCommit!==repo.baseCommit)throw new Error("Graph repository differs from task snapshot");
      roots.push(member);
    }
    if(!roots.some(row=>row.id===scopeId))throw new Error("Session is outside graph task");
  }
  const rootIds=new Set(roots.map(row=>row.id));
  const ids=new Set(roots.flatMap(row=>descendants(row.id).map(member=>member.id)));
  const members=[...roots.filter(row=>row.id===rootId),...roots.filter(row=>row.id!==rootId),...rows.filter(row=>ids.has(row.id)&&!rootIds.has(row.id))];
  for(const member of members){const owner=lineage(member.id).at(-1);if(!rootIds.has(owner.id))throw new Error("Invalid graph ancestry");if(member.parentId&&member.policy?.version===2&&JSON.stringify(member.policy.task??null)!==JSON.stringify(owner.policy?.task??null))throw new Error("Graph descendant differs from task snapshot");}
  return {rootId,taskId,members};
}
function graphSnapshot({scopeId,after}){
  const {rootId,taskId,members}=graphScope(scopeId),ids=members.map(row=>row.id);
  const placeholders=ids.map(()=>'?').join(',');
  const where=`session_id IN (${placeholders}) AND type IN ('graph_fact','graph_run')`;
  const all=db.prepare(`SELECT seq,session_id AS sessionId,type,payload,at FROM events WHERE ${where} ORDER BY seq`).all(...ids).map(row=>({...row,payload:JSON.parse(row.payload)}));
  const highWater=all.at(-1)?.seq??0;
  if(after!==undefined&&(!Number.isSafeInteger(after)||after<0||after>highWater))throw new Error("Invalid graph cursor");
  // ponytail: bounded graph window; explicit truncation until paged historical browsing is needed.
  const selected=after===undefined?all.slice(-2000):all.filter(row=>row.seq>after).slice(0,500);
  const cursor=after===undefined?highWater:selected.at(-1)?.seq??after;
  const created=new Set(all.filter(row=>row.type==='graph_fact'&&row.payload.kind==='creation').map(row=>row.payload.target));
  const nodes=members.map(row=>{
    const metadata=row.metadata??{runId:null,model:row.model,reasoning:null,reasoningAvailability:'unavailable',title:null};
    const title=metadata.title||db.prepare("SELECT substr(input_text,1,120) AS title FROM commands WHERE session_id=? AND kind IN ('prompt','child_prompt') AND status<>'rejected' AND input_text IS NOT NULL ORDER BY rowid LIMIT 1").get(row.id)?.title||`${row.role} ${row.id.slice(0,8)}`;
    return {id:row.id,parentId:row.parentId,role:row.role,status:row.status,model:metadata.model,cwd:row.cwd,title,metadata,creationAvailable:created.has(row.id),repositoryId:row.policy?.task?.repositoryId??lineage(row.id).at(-1).policy?.task?.repositoryId??null};
  });
  return {rootId,taskId,nodes,events:selected,cursor,highWater,hasMore:cursor<highWater,truncated:after===undefined&&all.length>selected.length,totalEvents:all.length};
}

function evidence(table,id){const row=db.prepare(`SELECT status,data FROM ${table} WHERE id=?`).get(id);return row?{...JSON.parse(row.data),status:row.status}:undefined;}
function evidenceList(table,sessionId){return db.prepare(`SELECT status,data FROM ${table} WHERE session_id=? ORDER BY rowid DESC LIMIT 30`).all(sessionId).map(row=>({...JSON.parse(row.data),status:row.status}));}
function projectTask(id){const row=db.prepare("SELECT status,data FROM project_tasks WHERE id=?").get(id);return row?{...JSON.parse(row.data),status:row.status}:undefined;}
function transition(table,{id,from,to,patch={}}){
  const current=evidence(table,id);if(!current||current.status!==from)return undefined;
  const updated={...current,...patch,status:to};
  const result=db.prepare(`UPDATE ${table} SET status=?,data=? WHERE id=? AND status=?`).run(to,JSON.stringify(updated),id,from);
  return result.changes?updated:undefined;
}

function projectRow({archived_at,...row}){return {...row,folders:JSON.parse(row.folders),archivedAt:archived_at??null};}
const queries = {
  roles: () => {const row=db.prepare("SELECT data FROM settings WHERE name='roles'").get();return row?JSON.parse(row.data):null;},
  saveRoles: ({catalog}) => {
    const revision=catalog.revision+1,data=JSON.stringify({...catalog,revision});
    const result=catalog.revision===0?db.prepare("INSERT OR IGNORE INTO settings(name,revision,data) VALUES('roles',?,?)").run(revision,data):db.prepare("UPDATE settings SET revision=?,data=? WHERE name='roles' AND revision=?").run(revision,data,catalog.revision);
    if(!result.changes)throw new Error("Role settings changed; reload before saving");
    return JSON.parse(data);
  },
  delegationContext: ({id})=>delegationContext(id),
  descendantMember: ({rootId,agentId})=>descendantMember(rootId,agentId),
  reserveChild,
  graphSnapshot,
  graphMessageRun: ({id,messageIndex}) => {const row=db.prepare("SELECT payload FROM events WHERE session_id=? AND type='graph_message' AND json_extract(payload,'$.messageIndex')=? ORDER BY seq DESC LIMIT 1").get(id,messageIndex);return row?JSON.parse(row.payload):null;},
  // Durable "first input" test: any earlier non-rejected fact that delivered input to this agent (including legacy followUp/user_prompt).
  graphHasPriorInput: ({id,excludeFactId}) => !!db.prepare("SELECT 1 FROM events e WHERE e.type='graph_fact' AND json_extract(e.payload,'$.target')=? AND json_extract(e.payload,'$.kind') IN ('prompt','followUp','steer','delegation') AND json_extract(e.payload,'$.id')<>? AND NOT EXISTS(SELECT 1 FROM events r WHERE r.type='graph_fact' AND json_extract(r.payload,'$.id')=json_extract(e.payload,'$.id') AND json_extract(r.payload,'$.outcome')='rejected') LIMIT 1").get(id,excludeFactId),
  graphMetadataFor: ({id}) => JSON.parse(db.prepare("SELECT graph_metadata FROM sessions WHERE id=?").get(id)?.graph_metadata||"null"),
  graphMember: ({scopeId,nodeId}) => {const scope=graphScope(scopeId);if(!scope.members.some(row=>row.id===nodeId))throw new Error("Node is outside graph scope");return {id:nodeId};},
  graphMetadata: ({id,metadata}) => {db.prepare("UPDATE sessions SET graph_metadata=? WHERE id=?").run(JSON.stringify(metadata),id);return graphEvent(id,"graph_run",metadata);},
  addCheck: row => {
    if(archivedOwner(row.sessionId))throw new Error("Archived session or task cannot start checks");
    if(db.prepare("SELECT 1 FROM checks WHERE session_id=? AND status IN ('pending','approved','running') LIMIT 1").get(row.sessionId))throw new Error("Finish or stop the current check first");
    return db.prepare("INSERT INTO checks(id,session_id,status,data) VALUES(?,?,?,?)").run(row.id,row.sessionId,row.status,JSON.stringify(row));
  },
  check: ({id}) => evidence("checks",id),
  checks: ({sessionId}) => evidenceList("checks",sessionId),
  activeChecks: ({sessionId}) => db.prepare("SELECT status,data FROM checks WHERE session_id=? AND status IN ('pending','approved','running')").all(sessionId).map(row=>({...JSON.parse(row.data),status:row.status})),
  checkTransition: args => transition("checks",args),
  addReview: row => {
    if(archivedOwner(row.sessionId))throw new Error("Archived session or task cannot start reviews");
    if(db.prepare("SELECT 1 FROM reviews WHERE session_id=? AND status='running' LIMIT 1").get(row.sessionId))throw new Error("Finish or stop the current reviewer first");
    return db.prepare("INSERT INTO reviews(id,session_id,status,data) VALUES(?,?,?,?)").run(row.id,row.sessionId,row.status,JSON.stringify(row));
  },
  review: ({id}) => evidence("reviews",id),
  reviews: ({sessionId}) => evidenceList("reviews",sessionId),
  activeReviews: ({sessionId}) => db.prepare("SELECT status,data FROM reviews WHERE session_id=? AND status='running'").all(sessionId).map(row=>({...JSON.parse(row.data),status:row.status})),
  reviewTransition: args => transition("reviews",args),
  addQaRun: row => {
    if(archivedOwner(row.sessionId))throw new Error("Archived session or task cannot start QA");
    if(db.prepare("SELECT 1 FROM qa_runs WHERE session_id=? AND status IN ('starting','running') LIMIT 1").get(row.sessionId))throw new Error("Finish or cancel the current QA run first");
    return db.prepare("INSERT INTO qa_runs(id,session_id,status,data) VALUES(?,?,?,?)").run(row.id,row.sessionId,row.status,JSON.stringify(row));
  },
  qaRun: ({id}) => evidence("qa_runs",id),
  qaRuns: ({sessionId}) => evidenceList("qa_runs",sessionId),
  qaActiveRun: ({sessionId}) => db.prepare("SELECT status,data FROM qa_runs WHERE session_id=? AND status IN ('starting','running') ORDER BY rowid DESC LIMIT 1").all(sessionId).map(row=>({...JSON.parse(row.data),status:row.status}))[0],
  qaRunTransition: args => transition("qa_runs",args),
  addBrowserAction: row => {const {requestHash="",...data}=row;return db.prepare("INSERT INTO browser_actions(id,session_id,status,data,request_hash) VALUES(?,?,?,?,?)").run(data.id,data.sessionId,data.status,JSON.stringify(data),requestHash);},
  browserAction: ({id}) => {const row=db.prepare("SELECT status,data,request_hash AS requestHash FROM browser_actions WHERE id=?").get(id);return row?{...JSON.parse(row.data),status:row.status,requestHash:row.requestHash}:undefined;},
  browserActions: ({sessionId}) => db.prepare("SELECT status,data FROM browser_actions WHERE session_id=? ORDER BY rowid DESC LIMIT 100").all(sessionId).map(row=>({...JSON.parse(row.data),status:row.status})).reverse(),
  browserActionTransition: args => transition("browser_actions",args),
  browserModeCommands: ({sessionId}) => db.prepare("SELECT id,status,behavior,created_at AS createdAt FROM commands WHERE session_id=? AND kind='browser_mode' ORDER BY rowid DESC LIMIT 20").all(sessionId).map(row=>({id:row.id,mode:row.behavior,status:row.status,createdAt:row.createdAt})).reverse(),
  addBrowserArtifact: row => db.prepare("INSERT INTO browser_artifacts(id,session_id,status,data) VALUES(?,?,?,?)").run(row.id,row.sessionId,"stored",JSON.stringify(row)),
  browserArtifact: ({id}) => evidence("browser_artifacts",id),
  browserArtifacts: ({sessionId}) => db.prepare("SELECT data FROM browser_artifacts WHERE session_id=? ORDER BY rowid DESC LIMIT 100").all(sessionId).map(row=>JSON.parse(row.data)).reverse(),
  addQaAction: row => db.prepare("INSERT INTO qa_actions(id,session_id,status,data) VALUES(?,?,?,?)").run(row.id,row.sessionId,row.status,JSON.stringify(row)),
  qaAction: ({id}) => evidence("qa_actions",id),
  qaActions: ({runId}) => db.prepare("SELECT status,data FROM qa_actions WHERE json_extract(data,'$.runId')=? ORDER BY rowid ASC").all(runId).map(row=>({...JSON.parse(row.data),status:row.status})),
  qaSessionActions: ({sessionId}) => db.prepare("SELECT status,data FROM qa_actions WHERE session_id=? ORDER BY rowid DESC LIMIT 200").all(sessionId).map(row=>({...JSON.parse(row.data),status:row.status})).reverse(),
  qaActionTransition: args => transition("qa_actions",args),
  addQaArtifact: row => db.prepare("INSERT INTO qa_artifacts(id,session_id,status,data) VALUES(?,?,?,?)").run(row.id,row.sessionId,"stored",JSON.stringify(row)),
  qaArtifact: ({id}) => evidence("qa_artifacts",id),
  // Findings are insert-once (idempotent per tool call): a replayed record is ignored, never duplicated.
  addQaFinding: row => ({inserted:db.prepare("INSERT OR IGNORE INTO qa_findings(id,session_id,status,data) VALUES(?,?,?,?)").run(row.id,row.sessionId,"recorded",JSON.stringify(row)).changes>0}),
  qaFinding: ({id}) => evidence("qa_findings",id),
  qaFindings: ({sessionId}) => db.prepare("SELECT status,data FROM qa_findings WHERE session_id=? ORDER BY rowid ASC").all(sessionId).map(row=>({...JSON.parse(row.data),status:undefined})),
  addQaView: row => ({inserted:db.prepare("INSERT OR IGNORE INTO qa_views(id,session_id,status,data) VALUES(?,?,?,?)").run(row.id,row.sessionId,"viewed",JSON.stringify(row)).changes>0}),
  qaViews: ({sessionId}) => db.prepare("SELECT data FROM qa_views WHERE session_id=? ORDER BY rowid ASC").all(sessionId).map(row=>JSON.parse(row.data)),
  qaRunsAsc: ({sessionId}) => db.prepare("SELECT status,data FROM qa_runs WHERE session_id=? ORDER BY rowid ASC").all(sessionId).map(row=>({...JSON.parse(row.data),status:row.status})),
  qaArtifactsAsc: ({sessionId}) => db.prepare("SELECT data FROM qa_artifacts WHERE session_id=? ORDER BY rowid ASC").all(sessionId).map(row=>JSON.parse(row.data)),
  qaGate: ({sessionId}) => {const row=db.prepare("SELECT data FROM qa_gates WHERE id=?").get(sessionId);return row?JSON.parse(row.data):null;},
  // Monotonic milestone merge: an existing milestone is never replaced, so a re-evaluation (or restart) cannot duplicate or rewrite recorded facts.
  saveQaGate: ({sessionId,patch}) => {
    db.exec("BEGIN IMMEDIATE");try{
      const row=db.prepare("SELECT data FROM qa_gates WHERE id=?").get(sessionId),prior=row?JSON.parse(row.data):{};
      const next={...prior};for(const [key,value] of Object.entries(patch))if(next[key]===undefined)next[key]=value;
      if(JSON.stringify(next)!==JSON.stringify(prior))db.prepare("INSERT INTO qa_gates(id,session_id,status,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(sessionId,sessionId,"active",JSON.stringify(next));
      db.exec("COMMIT");return next;
    }catch(error){db.exec("ROLLBACK");throw error;}
  },
  // Latest state of every graph fact matching one durable field; `at` is when that state was persisted.
  qaFacts: ({field,value}) => {
    if(!["source","reviewId"].includes(field))throw new Error("Unsupported fact field");
    const latest=new Map();
    for(const row of db.prepare(`SELECT seq,session_id AS sessionId,payload,at FROM events WHERE type='graph_fact' AND json_extract(payload,'$.${field}')=? ORDER BY seq`).all(value)){const payload=JSON.parse(row.payload);latest.set(payload.id,{seq:row.seq,sessionId:row.sessionId,at:row.at,payload});}
    return [...latest.values()];
  },
  // Approved write paths that can produce a new Code revision: the root agent's own approved file writes and worker merges into the root.
  qaFixApprovals: ({sessionId,after}) => [
    ...db.prepare("SELECT id,'write' AS kind,outcome,created_at AS createdAt FROM approvals WHERE session_id=? AND agent_id=? AND change IS NOT NULL AND status='approved' AND created_at>=? ORDER BY created_at ASC").all(sessionId,sessionId,after),
    ...db.prepare("SELECT id,status,data FROM worker_merges WHERE root_id=? AND status IN ('applied','running','partial','unknown')").all(sessionId).map(row=>({id:row.id,kind:"merge",outcome:row.status==='applied'?'applied':row.status==='running'?'applying':'unknown',createdAt:JSON.parse(row.data).createdAt})).filter(row=>row.createdAt>=after),
  ].sort((a,b)=>a.createdAt-b.createdAt),
  qaArtifacts: ({sessionId}) => db.prepare("SELECT status,data FROM qa_artifacts WHERE session_id=? ORDER BY rowid DESC LIMIT 100").all(sessionId).map(row=>({...JSON.parse(row.data),status:undefined})),
  addSourceApply: row => {
    if(archivedOwner(row.sessionId))throw new Error("Archived session or task cannot start Source Apply");
    if(db.prepare("SELECT 1 FROM source_applies WHERE source_cwd=? AND status IN ('pending','approved','running','unknown','partial') LIMIT 1").get(row.sourceCwd))throw new Error("Resolve the existing source Apply before preparing another");
    if(db.prepare("SELECT 1 FROM worker_merges WHERE root_id=? AND status IN ('pending','running','unknown','partial') LIMIT 1").get(row.sessionId))throw new Error("Resolve the worker merge before Source Apply");
    if(db.prepare("SELECT 1 FROM worker_merges m JOIN sessions s ON s.id=m.root_id WHERE s.cwd=? AND m.status IN ('pending','running','unknown','partial') AND json_extract(s.policy,'$.workspace.kind')='direct' LIMIT 1").get(row.sourceCwd))throw new Error("Resolve the direct workspace merge before Source Apply");
    return db.prepare("INSERT INTO source_applies(id,session_id,source_cwd,status,data) VALUES(?,?,?,?,?)").run(row.id,row.sessionId,row.sourceCwd,row.status,JSON.stringify(row));
  },
  sourceApply: ({id}) => evidence("source_applies",id),
  sourceApplies: ({sessionId}) => evidenceList("source_applies",sessionId),
  activeSourceApplies: ({sessionId}) => db.prepare("SELECT status,data FROM source_applies WHERE session_id=? AND status IN ('pending','approved','running')").all(sessionId).map(row=>({...JSON.parse(row.data),status:row.status})),
  sourceApplyTransition: args => transition("source_applies",args),
  sourceApplyFile: ({id,path,from,to,patch={}}) => {
    const row=evidence("source_applies",id);if(!row)return undefined;
    const index=row.files.findIndex(file=>file.path===path&&file.status===from);if(index<0)return undefined;
    const files=[...row.files];files[index]={...files[index],...patch,status:to};
    return transition("source_applies",{id,from:row.status,to:row.status,patch:{files}});
  },
  addWorkerMerge: row => {
    if(archivedOwner(row.rootId)||archivedOwner(row.workerId))throw new Error("Archived session or task cannot start a worker merge");
    if(db.prepare("SELECT 1 FROM worker_merges WHERE root_id=? AND status IN ('pending','running','unknown','partial') LIMIT 1").get(row.rootId))throw new Error("Resolve the current worker merge first");
    if(db.prepare("SELECT 1 FROM source_applies WHERE session_id=? AND status IN ('pending','approved','running') LIMIT 1").get(row.rootId))throw new Error("Finish Source Apply before merging workers");
    const root=db.prepare("SELECT cwd,policy FROM sessions WHERE id=?").get(row.rootId);
    if(JSON.parse(root?.policy||'null')?.workspace?.kind==='direct'){
      if(db.prepare("SELECT 1 FROM worker_merges m JOIN sessions s ON s.id=m.root_id WHERE s.cwd=? AND m.status IN ('pending','running','unknown','partial') LIMIT 1").get(root.cwd))throw new Error("Resolve the direct workspace merge before preparing another");
      if(db.prepare("SELECT 1 FROM source_applies WHERE source_cwd=? AND status IN ('pending','approved','running','unknown','partial') LIMIT 1").get(root.cwd))throw new Error("Resolve Source Apply before merging into the direct workspace");
    }
    for(const id of [row.rootId,row.workerId]){
      {const status=db.prepare("SELECT status FROM sessions WHERE id=?").get(id)?.status;if(status!=='settled'&&!(row.auto&&id===row.rootId&&status==='running'))throw new Error("Root and worker must be settled before merge preview");}
      if(db.prepare("SELECT 1 FROM approvals WHERE agent_id=? AND (status='pending' OR outcome IN ('applying','unknown')) LIMIT 1").get(id))throw new Error("Resolve pending or uncertain file writes before merging");
      if(db.prepare("SELECT 1 FROM commands WHERE session_id=? AND kind IN ('edit','write') AND status='unknown' LIMIT 1").get(id))throw new Error("Resolve uncertain tool calls before merging");
    }
    return db.prepare("INSERT INTO worker_merges(id,root_id,worker_id,status,data) VALUES(?,?,?,?,?)").run(row.id,row.rootId,row.workerId,row.status,JSON.stringify(row));
  },
  workerMerge: ({id}) => evidence("worker_merges",id),
  workerMerges: ({rootId}) => db.prepare("SELECT status,data FROM worker_merges WHERE root_id=? ORDER BY rowid DESC LIMIT 30").all(rootId).map(row=>({...JSON.parse(row.data),status:row.status})),
  workerMergeTransition: args => transition("worker_merges",args),
  workerMergeFile: ({id,path,from,to,patch={}}) => {
    const row=evidence("worker_merges",id);if(!row)return undefined;
    const index=row.files.findIndex(file=>file.path===path&&file.status===from);if(index<0)return undefined;
    const files=[...row.files];files[index]={...files[index],...patch,status:to};
    return transition("worker_merges",{id,from:row.status,to:row.status,patch:{files}});
  },
  workerMergeBusy: ({id}) => !!db.prepare("SELECT 1 FROM worker_merges WHERE (root_id=? OR worker_id=?) AND status IN ('pending','running') LIMIT 1").get(id,id),
  projects: () => db.prepare("SELECT * FROM projects ORDER BY name COLLATE NOCASE,id").all().map(projectRow),
  project: ({id}) => {const row=db.prepare("SELECT * FROM projects WHERE id=?").get(id);return row?projectRow(row):undefined;},
  saveProject: ({id,name,folders}) => db.prepare("INSERT INTO projects(id,name,folders) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,folders=excluded.folders").run(id,name,JSON.stringify(folders)),
  archiveProject: ({id,archived}) => db.prepare("UPDATE projects SET archived_at=? WHERE id=?").run(archived?Date.now():null,id),
  deleteProject: ({id}) => db.prepare("DELETE FROM projects WHERE id=?").run(id),
  addProjectTask: row => {
    if(row.status!=="creating")throw new Error("New project task must start in creating state");
    const result=db.prepare("INSERT OR IGNORE INTO project_tasks(id,status,data) VALUES(?,?,?)").run(row.id,"creating",JSON.stringify(row));
    const current=projectTask(row.id);
    if(current.requestHash!==row.requestHash)throw new Error("Task ID conflict");
    return {fresh:result.changes===1,task:current};
  },
  projectTask: ({id}) => projectTask(id),
  projectTaskByCoordinator: ({id}) => {const row=db.prepare("SELECT status,data FROM project_tasks WHERE json_extract(data,'$.coordinatorId')=?").get(id);return row?{...JSON.parse(row.data),status:row.status}:undefined;},
  projectTasks: () => db.prepare("SELECT status,data FROM project_tasks ORDER BY rowid DESC").all().map(row=>({...JSON.parse(row.data),status:row.status})),
  projectTaskStatus: ({id,status}) => {
    if(status!=="running"&&status!=="unknown")throw new Error("Invalid project task status");
    const prior=projectTask(id);if(prior?.status!=="creating")return undefined;
    const updated={...prior,status};
    const result=db.prepare("UPDATE project_tasks SET status=?,data=? WHERE id=? AND status='creating'").run(status,JSON.stringify(updated),id);
    return result.changes?updated:undefined;
  },
  // title: first accepted prompt text, so the sidebar can tell sessions in the same workspace apart.
  sessions: () => db.prepare("SELECT s.*,(SELECT substr(c.input_text,1,120) FROM commands c WHERE c.session_id=s.id AND c.kind='prompt' AND c.status<>'rejected' AND c.input_text IS NOT NULL ORDER BY c.rowid LIMIT 1) AS title FROM sessions s WHERE s.parent_id IS NULL ORDER BY s.created_at DESC").all().map(row=>({...row,sourceCwd:row.policy?JSON.parse(row.policy).workspace?.sourceCwd??row.cwd:row.cwd})),
  switchModel: ({id,model,reasoning}) => {
    db.exec("BEGIN IMMEDIATE");
    try{
      const row=queries.session({id});
      if(!row||row.parentId)throw new Error("Only root sessions can switch models");
      if(row.status==='running')throw new Error("Session is running");
      if(archivedOwner(id))throw new Error("Archived sessions cannot accept commands");
      if(row.policy?.task)throw new Error("Task sessions keep the task model");
      const policy=row.policy?{...row.policy,effective:{...row.policy.effective,model},...(row.policy.role?{role:{...row.policy.role,requestedReasoning:reasoning??null}}:{})}:null;
      db.prepare("UPDATE sessions SET model=?,policy=? WHERE id=?").run(model,policy?JSON.stringify(policy):null,id);
      db.exec("COMMIT");return {...row,model,policy};
    }catch(error){db.exec("ROLLBACK");throw error;}
  },
  ownerArchivedAt: ({id}) => {const root=lineage(id).at(-1);return root.archivedAt??(root.policy?.task?projectTask(root.policy.task.id)?.archivedAt:null)??null;},
  assertOwnerAvailable: ({id}) => {if(projectTask(id)?.archivedAt||db.prepare("SELECT 1 FROM sessions WHERE id=?").get(id)&&archivedOwner(id))throw new Error("Archived session or task cannot admit work");return true;},
  archiveSession: ({ id, archived }) => {
    db.exec("BEGIN IMMEDIATE");try{
    const row=db.prepare("SELECT status,policy FROM sessions WHERE id=? AND parent_id IS NULL").get(id);
    if(!row)throw new Error("Session unavailable");
    if(archived&&JSON.parse(row.policy||'null')?.task)throw new Error("Archive the complete task from its task card");
    if(archived){const ids=descendants(id).map(item=>item.id);assertQuiescent(ids);}
    db.prepare("UPDATE sessions SET archived_at=? WHERE id=?").run(archived?Date.now():null,id);
    db.exec("COMMIT");return {id,archived:!!archived};
    }catch(error){db.exec("ROLLBACK");throw error;}
  },
  archiveProjectTask: ({id,archived}) => {
    db.exec("BEGIN IMMEDIATE");try{const task=projectTask(id);if(!task)throw new Error("Task unavailable");
      const sessionIds=[task.coordinatorId,...task.repositories.map(repo=>repo.sessionId)],rows=sessionIds.map(sessionId=>db.prepare("SELECT id FROM sessions WHERE id=?").get(sessionId));if(archived&&rows.some(row=>!row))throw new Error("Task setup is incomplete; inspect or continue it before archiving");const tree=[...new Set(rows.filter(Boolean).flatMap(row=>descendants(row.id).map(member=>member.id)))];
      if(archived){if(task.status!=="running")throw new Error("Resolve task setup before archiving");assertQuiescent(tree);}
      const updated={...task,archivedAt:archived?Date.now():null};db.prepare("UPDATE project_tasks SET data=? WHERE id=?").run(JSON.stringify(updated),id);db.exec("COMMIT");return updated;
    }catch(error){db.exec("ROLLBACK");throw error;}
  },
  session: ({ id }) => {const row=db.prepare("SELECT id,cwd,file,model,status,parent_id AS parentId,role,policy,archived_at AS archivedAt,manager_id AS managerId,dispatch_started AS dispatchStarted FROM sessions WHERE id=?").get(id);return row?{...row,policy:row.policy?JSON.parse(row.policy):null}:undefined;},
  agents: ({ rootId }) => descendants(rootId).map(row=>({...row,revisionReviewer:queries.reviewAgent({agentId:row.id})})),
  reviewAgent: ({ agentId }) => !!db.prepare("SELECT 1 FROM reviews WHERE json_extract(data,'$.agentId')=? LIMIT 1").get(agentId),
  addSession: ({ id, cwd, file, model, managerId=null, parentId=null, role="root", policy=null, childLimit, admissionId, recoveryAdmission=false, creation }) => {
    db.exec("BEGIN IMMEDIATE");
    try{
      if(parentId){
        if(delegationContext(parentId).root.policy?.version===2&&!admissionId)throw new Error("Durable child admission required");
        if(admissionId){const command=db.prepare("SELECT agent_id,session_id,status,reserved,setup FROM commands WHERE id=?").get(admissionId);if(!command||command.agent_id!==id||command.session_id!==parentId||command.reserved!==1||!(command.status==='accepted'||recoveryAdmission&&['unknown','continuing'].includes(command.status)&&JSON.parse(command.setup||'null')?.sessionId===id))throw new Error("Child admission is no longer current");}
        if(archivedOwner(parentId))throw new Error("Archived session or task cannot admit child work");
      }
      if(policy?.task?.id&&projectTask(policy.task.id)?.archivedAt)throw new Error("Archived task cannot add sessions");
      db.prepare("INSERT INTO sessions(id,cwd,file,model,status,created_at,parent_id,role,policy,manager_id) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id,cwd,file,model,"idle",Date.now(),parentId,role,policy?JSON.stringify(policy):null,managerId);
      if(creation)graphEvent(id,"graph_fact",{id:`creation:${id}`,kind:"creation",target:id,outcome:"created",run:null,...creation});
      db.exec("COMMIT");
    }catch(error){db.exec("ROLLBACK");throw error;}
  },
  status: ({ id, status }) => {
    if(status==='running'&&db.prepare("SELECT 1 FROM worker_merges WHERE (root_id=? OR worker_id=?) AND status IN ('pending','running') LIMIT 1").get(id,id))throw new Error("Worker merge is awaiting a decision or being applied");
    return db.prepare("UPDATE sessions SET status=? WHERE id=?").run(status,id);
  },
  event: ({ sessionId, type, payload }) => {
    const at=Date.now(); const result=db.prepare("INSERT INTO events(session_id,type,payload,at) VALUES(?,?,?,?)").run(sessionId,type,JSON.stringify(payload),at);
    return {seq:Number(result.lastInsertRowid),sessionId,type,payload,at};
  },
  events: ({ sessionId, after=0, before=Number.MAX_SAFE_INTEGER }) => db.prepare("SELECT * FROM events WHERE session_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT 500").all(sessionId,after,before).map(x=>({...x,sessionId:x.session_id,payload:JSON.parse(x.payload)})),
  latest: ({ sessionId }) => Number(db.prepare("SELECT coalesce(max(seq),0) AS seq FROM events WHERE session_id=?").get(sessionId).seq),
  approval: ({ id, sessionId, agentId, tool, preview, change, git, commandId=null }) => {if(archivedOwner(agentId))throw new Error("Archived session or task cannot request approvals");return db.prepare("INSERT INTO approvals(id,session_id,agent_id,tool,preview,status,created_at,change,command_id,git) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id,sessionId,agentId,tool,preview,"pending",Date.now(),change?JSON.stringify(change):null,commandId,git?JSON.stringify(git):null);},
  writeOutcome: ({id,outcome}) => db.prepare("UPDATE approvals SET outcome=? WHERE id=? AND status='approved' AND change IS NOT NULL").run(outcome,id),
  approvalStatus: ({ id, status }) => db.prepare("UPDATE approvals SET status=? WHERE id=? AND status='pending'").run(status,id),
  writeApproval: ({id}) => {const row=db.prepare("SELECT a.id,a.session_id AS sessionId,a.agent_id AS agentId,a.tool,a.status,a.change,a.outcome,a.command_id AS commandId,a.reconciliation,c.status AS commandStatus FROM approvals a LEFT JOIN commands c ON c.id=a.command_id WHERE a.id=?").get(id);return row?{...row,change:row.change?JSON.parse(row.change):null,reconciliation:row.reconciliation?JSON.parse(row.reconciliation):null}:undefined;},
  approvals: ({ sessionId }) => db.prepare("WITH recent AS (SELECT id FROM approvals WHERE session_id=? ORDER BY created_at DESC LIMIT 100) SELECT a.id,a.agent_id AS agentId,a.tool,a.preview,a.status,a.created_at AS createdAt,a.change,a.git,a.command_id AS commandId,a.outcome,a.reconciliation,CASE WHEN a.status='approved' AND a.outcome IN ('unknown','applied') AND c.status='unknown' THEN 1 ELSE 0 END AS needsReconciliation FROM approvals a LEFT JOIN commands c ON c.id=a.command_id WHERE a.session_id=? AND (a.id IN (SELECT id FROM recent) OR a.status='approved' AND a.outcome IN ('unknown','applied') AND c.status='unknown') ORDER BY needsReconciliation DESC,a.created_at DESC").all(sessionId,sessionId).map(row=>({...row,needsReconciliation:!!row.needsReconciliation,git:row.git?JSON.parse(row.git):null,change:row.change?JSON.parse(row.change):null,reconciliation:row.reconciliation?JSON.parse(row.reconciliation):null})),
  reconcileDirectWrite: ({sessionId,id,reconciliation,outcome}) => {
    db.exec("BEGIN IMMEDIATE");
    try{
      const row=db.prepare("SELECT session_id,agent_id,status,outcome,change,command_id FROM approvals WHERE id=?").get(id);
      const session=db.prepare("SELECT policy FROM sessions WHERE id=?").get(sessionId);
      if(!row||row.session_id!==sessionId||row.agent_id!==sessionId||row.status!=='approved'||!['unknown','applied'].includes(row.outcome)||!row.change||!row.command_id||JSON.parse(session?.policy||'null')?.workspace?.kind!=='direct')throw new Error("Direct write is not awaiting reconciliation");
      const command=db.prepare("SELECT status,kind,session_id FROM commands WHERE id=?").get(row.command_id);
      if(!command||command.session_id!==sessionId||!['edit','write'].includes(command.kind)||command.status!=='unknown')throw new Error("Write command is not awaiting reconciliation");
      if(!['applied','reconciled'].includes(outcome)||row.outcome==='applied'&&outcome!=='applied'||row.outcome==='unknown'&&outcome!=='reconciled')throw new Error("Invalid write reconciliation outcome");
      const updated=db.prepare("UPDATE approvals SET outcome=?,reconciliation=? WHERE id=? AND outcome=?").run(outcome,JSON.stringify(reconciliation),id,row.outcome);
      const commandUpdated=db.prepare("UPDATE commands SET status='reconciled' WHERE id=? AND status='unknown'").run(row.command_id);
      if(updated.changes!==1||commandUpdated.changes!==1)throw new Error("Write reconciliation changed concurrently");
      db.exec("COMMIT");return true;
    }catch(error){db.exec("ROLLBACK");throw error;}
  },
  unresolvedWrite: ({ sessionId }) => !!db.prepare("SELECT 1 FROM approvals WHERE session_id=? AND change IS NOT NULL AND outcome IN ('applying','unknown') LIMIT 1").get(sessionId),
  // A Sigma-made commit, pull or branch switch moves HEAD; direct sessions on that folder follow it.
  gitSave: ({id,intent}) => {const command=db.prepare("SELECT status FROM commands WHERE id=?").get(id);if(!command||!['accepted','dispatched','unknown'].includes(command.status))throw new Error("Git command is no longer writable");db.prepare("INSERT INTO git_commands(id,cwd,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(id,intent.identity.cwd,JSON.stringify(intent));return true;},
  gitFailure: ({id,status}) => db.prepare("UPDATE commands SET status=? WHERE id=? AND status IN ('accepted','dispatched')").run(status,id),
  gitGet: ({id}) => {const row=db.prepare("SELECT g.data,c.session_id AS sessionId,c.status FROM git_commands g JOIN commands c ON c.id=g.id WHERE g.id=?").get(id);return row?{...JSON.parse(row.data),sessionId:row.sessionId,status:row.status}:null;},
  gitRecoveries: ({cwd}) => db.prepare("SELECT g.data,c.session_id AS sessionId,c.status FROM git_commands g JOIN commands c ON c.id=g.id WHERE g.cwd=? AND c.status='unknown'").all(cwd).map(row=>({...JSON.parse(row.data),sessionId:row.sessionId,status:row.status})),
  gitBlocked: ({cwd,exceptId=null}) => !!db.prepare("SELECT 1 FROM git_commands g JOIN commands c ON c.id=g.id WHERE g.cwd=? AND g.id<>coalesce(?, '') AND c.status IN ('accepted','dispatched','unknown') LIMIT 1").get(cwd,exceptId),
  gitComplete: ({id,from,to,reconciled=false,receipt}) => {
    db.exec("BEGIN IMMEDIATE");try{
      const row=db.prepare("SELECT g.cwd,g.data,c.status FROM git_commands g JOIN commands c ON c.id=g.id WHERE g.id=?").get(id);
      if(!row||!(reconciled?row.status==='unknown':['accepted','dispatched'].includes(row.status)))throw new Error("Git command changed before receipt");
      const intent=JSON.parse(row.data);if(intent.kind==='commit'&&receipt?.state!=='before'&&to!==intent.sha)throw new Error("Git receipt SHA differs from frozen commit");if(from!==intent.identity.head||!to)throw new Error("Git receipt does not match admitted parent");
      for(const session of db.prepare("SELECT id,policy FROM sessions WHERE cwd=?").all(row.cwd)){const policy=JSON.parse(session.policy||'null');if(policy?.workspace?.kind==='direct'&&policy.workspace.baseCommit===from){policy.workspace.baseCommit=to;db.prepare("UPDATE sessions SET policy=? WHERE id=?").run(JSON.stringify(policy),session.id);}}
      db.prepare("UPDATE git_commands SET data=? WHERE id=?").run(JSON.stringify({...intent,receipt}),id);db.prepare("UPDATE commands SET status=? WHERE id=?").run(reconciled?'reconciled':'completed',id);db.exec("COMMIT");return true;
    }catch(error){db.exec("ROLLBACK");throw error;}
  },
  repinDirect: ({cwd,from,to}) => {
    let count=0;
    for(const row of db.prepare("SELECT id,policy FROM sessions WHERE cwd=?").all(cwd)){
      const policy=JSON.parse(row.policy||'null');
      if(policy?.workspace?.kind!=='direct'||policy.workspace.baseCommit!==from)continue;
      policy.workspace.baseCommit=to;db.prepare("UPDATE sessions SET policy=? WHERE id=?").run(JSON.stringify(policy),row.id);count++;
    }
    return count;
  },
  unresolvedDirectWrite: ({cwd,exceptApprovalId=null,includeMerges=false}) => {
    const sessions=db.prepare("SELECT id,policy FROM sessions WHERE cwd=?").all(cwd).filter(row=>row.policy&&JSON.parse(row.policy).workspace?.kind==='direct');
    for(const session of sessions){
      if(db.prepare("SELECT 1 FROM approvals WHERE agent_id=? AND id<>coalesce(?, '') AND change IS NOT NULL AND outcome IN ('applying','unknown') LIMIT 1").get(session.id,exceptApprovalId))return true;
      if(db.prepare("SELECT 1 FROM commands WHERE session_id=? AND kind IN ('edit','write') AND status='unknown' LIMIT 1").get(session.id))return true;
      if(includeMerges&&db.prepare("SELECT 1 FROM worker_merges WHERE root_id=? AND status IN ('pending','running','unknown','partial') LIMIT 1").get(session.id))return true;
    }
    return includeMerges&&!!db.prepare("SELECT 1 FROM source_applies WHERE source_cwd=? AND status IN ('pending','approved','running','unknown','partial') LIMIT 1").get(cwd);
  },
  // Read-only facts for guarded cleanup: one consistent snapshot of session ownership, evidence rows and unresolved work.
  cleanupFacts: () => {
    const sessions=db.prepare("SELECT id,cwd,parent_id AS parentId,role,status,policy FROM sessions").all().map(row=>{
      let archived=null,rootId=null,taskStatus=null;
      try{const chain=lineage(row.id),root=chain.at(-1);rootId=root.id;archived=archivedOwner(row.id);const task=root.policy?.task?projectTask(root.policy.task.id):undefined;taskStatus=task?task.status:null;}catch{}
      return {...row,policy:row.policy?JSON.parse(row.policy):null,archived,rootId,taskStatus};
    });
    const evidence=table=>db.prepare(`SELECT id,session_id AS sessionId,status,json_extract(data,'$.cwd') AS cwd FROM ${table}`).all();
    const busy=[];
    for(const row of db.prepare("SELECT session_id AS sessionId,kind,status FROM commands WHERE kind<>'cleanup' AND status IN ('accepted','dispatched','queued','unknown','continuing')").all())busy.push({sessionId:row.sessionId,reason:`${row.kind} command is ${row.status}`});
    for(const [table,statuses] of [["checks","'pending','approved','running','unknown'"],["reviews","'running','unknown'"],["source_applies","'pending','approved','running','unknown','partial'"],["qa_runs","'starting','running'"]])for(const row of db.prepare(`SELECT session_id AS sessionId,status FROM ${table} WHERE status IN (${statuses})`).all())busy.push({sessionId:row.sessionId,reason:`${table} row is ${row.status}`});
    for(const row of db.prepare("SELECT root_id AS rootId,worker_id AS workerId,status FROM worker_merges WHERE status IN ('pending','running','unknown','partial')").all())busy.push({sessionId:row.rootId,reason:`worker merge is ${row.status}`},{sessionId:row.workerId,reason:`worker merge is ${row.status}`});
    for(const row of db.prepare("SELECT session_id AS sessionId,agent_id AS agentId,status,outcome FROM approvals WHERE status='pending' OR outcome IN ('applying','unknown')").all())busy.push({sessionId:row.sessionId,reason:"approval is pending or uncertain"},{sessionId:row.agentId,reason:"approval is pending or uncertain"});
    for(const row of db.prepare("SELECT cwd,data FROM git_commands g JOIN commands c ON c.id=g.id WHERE c.status IN ('accepted','dispatched','unknown')").all())busy.push({cwd:row.cwd,reason:"Git command is unresolved"});
    return {sessions,checks:evidence("checks"),reviews:evidence("reviews"),busy,cleanups:db.prepare("SELECT id,status,input_text AS targets FROM commands WHERE kind='cleanup'").all()};
  },
  command: ({ id, sessionId, kind, requestHash, inputText=null, behavior=null, agentId=null, setup=null, gitIntent=null }) => {
    db.exec("BEGIN IMMEDIATE");try{
    if(db.prepare("SELECT 1 FROM sessions WHERE id=?").get(sessionId)&&archivedOwner(sessionId))throw new Error("Archived session or task cannot accept commands");
    const result=db.prepare("INSERT OR IGNORE INTO commands(id,session_id,kind,status,created_at,request_hash,input_text,behavior,agent_id,setup) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id,sessionId,kind,"accepted",Date.now(),requestHash,inputText,behavior,agentId,setup?JSON.stringify(setup):null);
    const row=db.prepare("SELECT * FROM commands WHERE id=?").get(id);
    if(row.session_id!==sessionId||row.kind!==kind||row.request_hash!==requestHash)throw new Error("Command ID conflict");
    if(result.changes===1&&gitIntent)db.prepare("INSERT INTO git_commands(id,cwd,data) VALUES(?,?,?)").run(id,gitIntent.identity.cwd,JSON.stringify(gitIntent));
    db.exec("COMMIT");return {fresh:result.changes===1,status:row.status,setup:row.setup?JSON.parse(row.setup):null};
    }catch(error){db.exec("ROLLBACK");throw error;}
  },
  commandSetup: ({id,setup,fromStatus="accepted"}) => {
    const row=db.prepare("SELECT status,setup FROM commands WHERE id=?").get(id);if(!row)return false;if(row.status!==fromStatus||row.setup!==null)throw new Error("Setup descriptor admission is no longer current");
    return db.prepare("UPDATE commands SET setup=? WHERE id=? AND status=? AND setup IS NULL").run(JSON.stringify(setup),id,fromStatus).changes===1;
  },
  claimSetupContinuation: ({id,setup}) => db.prepare("UPDATE commands SET status='continuing' WHERE id=? AND status='unknown' AND setup=?").run(id,JSON.stringify(setup)).changes===1,
  claimTaskContinuation: ({id,task}) => db.prepare("UPDATE project_tasks SET status='continuing',data=json_set(data,'$.status','continuing') WHERE id=? AND status='unknown' AND data=?").run(id,JSON.stringify(task)).changes===1,
  releaseTaskContinuation: ({id}) => {const row=db.prepare("SELECT data FROM project_tasks WHERE id=? AND status='continuing'").get(id);if(row)db.prepare("UPDATE project_tasks SET status='unknown',data=? WHERE id=? AND status='continuing'").run(JSON.stringify({...JSON.parse(row.data),status:'unknown'}),id);},
  commandSetupUpdate: ({id,from,to}) => db.prepare("UPDATE commands SET setup=? WHERE id=? AND setup=?").run(JSON.stringify(to),id,JSON.stringify(from)).changes===1,
  commandSetupIdentity: ({id,identity}) => {const row=db.prepare("SELECT setup FROM commands WHERE id=?").get(id);const setup=JSON.parse(row?.setup||'null');if(!setup||setup.phase!=="allocating")throw new Error("Setup phase changed; inspect before continuing");Object.assign(setup,identity,{phase:"allocated"});const result=db.prepare("UPDATE commands SET setup=? WHERE id=? AND setup=?").run(JSON.stringify(setup),id,row.setup);return result.changes===1?setup:undefined;},
  commandSetupPhase: ({id,from,to}) => {
    const row=db.prepare("SELECT setup FROM commands WHERE id=?").get(id);const setup=JSON.parse(row?.setup||'null');if(!setup||setup.phase!==from)throw new Error("Setup phase changed; inspect before continuing");
    setup.phase=to;const result=db.prepare("UPDATE commands SET setup=? WHERE id=? AND setup=?").run(JSON.stringify(setup),id,row.setup);return result.changes===1?setup:undefined;
  },
  commandSetupRecovery: () => db.prepare("SELECT id,session_id AS sessionId,kind,status,setup FROM commands WHERE (setup IS NOT NULL OR kind IN ('create','delegate','review_spawn')) AND status IN ('unknown','continuing') ORDER BY created_at DESC LIMIT 100").all().map(row=>({...row,setup:row.setup?JSON.parse(row.setup):null})),
  commandSetupGet: ({id}) => {const row=db.prepare("SELECT id,session_id AS sessionId,kind,status,setup FROM commands WHERE id=?").get(id);return row?{...row,setup:row.setup?JSON.parse(row.setup):null}:undefined;},
  taskSetup: ({id,setup}) => {const row=db.prepare("SELECT status,data FROM project_tasks WHERE id=?").get(id);if(!row||row.status!=="creating")throw new Error("Task setup is no longer editable");const data=JSON.parse(row.data);if(data.setupVersion)throw new Error("Task setup is already captured");const updated={...data,...setup};return db.prepare("UPDATE project_tasks SET data=? WHERE id=? AND status='creating' AND data=?").run(JSON.stringify(updated),id,row.data).changes===1;},
  taskSetupUpdate: ({id,from,to}) => db.prepare("UPDATE project_tasks SET data=? WHERE id=? AND status IN ('creating','unknown','continuing') AND data=?").run(JSON.stringify(to),id,JSON.stringify(from)).changes===1,
  taskSetupPhase: ({id,sessionId,from,to}) => {const row=db.prepare("SELECT status,data FROM project_tasks WHERE id=?").get(id);if(!row||!['creating','unknown','continuing'].includes(row.status))throw new Error("Task setup cannot continue");const data=JSON.parse(row.data),repo=data.repositories.find(item=>item.sessionId===sessionId),setup=repo?.setup??(data.coordinatorId===sessionId?data.coordinatorSetup:undefined);if(!setup||setup.phase!==from)throw new Error("Task member setup phase changed");setup.phase=to;const next=JSON.stringify(data);return db.prepare("UPDATE project_tasks SET data=? WHERE id=? AND status=? AND data=?").run(next,id,row.status,row.data).changes===1?data:undefined;},
  taskSetupGet: ({id}) => projectTask(id),
  taskSetupRecovery: () => db.prepare("SELECT status,data FROM project_tasks ORDER BY rowid DESC").all().map(row=>({...JSON.parse(row.data),status:row.status})).filter(task=>task.setupVersion&&task.status!=='running'),
  taskSetupMemberIdentity: ({id,sessionId,identity}) => {const row=db.prepare("SELECT status,data FROM project_tasks WHERE id=?").get(id);if(!row||!['creating','unknown','continuing'].includes(row.status))throw new Error("Task setup cannot continue");const data=JSON.parse(row.data),repo=data.repositories.find(item=>item.sessionId===sessionId);if(!repo||repo.setup?.phase!=="allocating")throw new Error("Task member setup phase changed");repo.setup={...repo.setup,...identity,phase:"allocated"};const next=JSON.stringify(data);return db.prepare("UPDATE project_tasks SET data=? WHERE id=? AND status=? AND data=?").run(next,id,row.status,row.data).changes===1?data:undefined;},
  taskSetupCoordinatorIdentity: ({id,identity}) => {const row=db.prepare("SELECT status,data FROM project_tasks WHERE id=?").get(id);if(!row||!['creating','unknown','continuing'].includes(row.status))throw new Error("Task setup cannot continue");const data=JSON.parse(row.data),setup=data.coordinatorSetup;if(!setup||setup.phase!=="allocating")throw new Error("Task coordinator setup phase changed");data.coordinatorSetup={...setup,...identity,phase:"allocated"};const next=JSON.stringify(data);return db.prepare("UPDATE project_tasks SET data=? WHERE id=? AND status=? AND data=?").run(next,id,row.status,row.data).changes===1?data:undefined;},
  continueProjectTask: ({id}) => db.prepare("UPDATE project_tasks SET status='running',data=json_set(data,'$.status','running') WHERE id=? AND status='continuing'").run(id).changes===1,
  sessionFile: ({id,managerId,file}) => db.prepare("UPDATE sessions SET file=? WHERE id=? AND manager_id=?").run(file,id,managerId).changes===1,
  sessionManager: ({id,managerId}) => db.prepare("UPDATE sessions SET manager_id=?,dispatch_started=1 WHERE id=? AND manager_id IS NULL").run(managerId,id).changes===1,
  markSessionDispatch: ({id}) => {
    if(archivedOwner(id))throw new Error("Archived session or task cannot dispatch prompts");
    return db.prepare("UPDATE sessions SET dispatch_started=1 WHERE id=?").run(id).changes===1;
  },
  commandStatus: ({ id, status }) => db.prepare("UPDATE commands SET status=? WHERE id=?").run(status,id),
  commandInput: ({id,text}) => {if(db.prepare("UPDATE commands SET input_text=? WHERE id=? AND kind IN ('edit','write') AND status='accepted'").run(text,id).changes!==1)throw new Error("Tool admission is no longer current");},
  commandTransition: ({id,from,to}) => db.prepare("UPDATE commands SET status=? WHERE id=? AND status=?").run(to,id,from).changes===1,
  // ponytail: 100 recent recovery rows; paginate only if real sessions reach this ceiling.
  recoveryInputs: ({ sessionId }) => db.prepare("SELECT id,input_text AS text,behavior,status,created_at AS createdAt FROM commands WHERE session_id=? AND kind IN ('prompt','child_prompt') AND status='unknown' AND input_text IS NOT NULL ORDER BY rowid DESC LIMIT 100").all(sessionId),
  recoveryActions: ({sessionId}) => db.prepare("SELECT id,CASE WHEN kind='review_spawn' THEN 'delegate' ELSE kind END AS kind,status,input_text AS text,behavior AS role,agent_id AS agentId,created_at AS createdAt FROM commands WHERE session_id=? AND kind IN ('delegate','edit','write','review_spawn') AND status='unknown' ORDER BY rowid DESC LIMIT 100").all(sessionId),
};
parentPort.on("message", ({ id, op, args }) => {
  try { parentPort.postMessage({ id, value: queries[op](args) }); }
  catch (error) { parentPort.postMessage({ id, error: String(error) }); }
});
