export type RunStatus = "idle" | "running" | "settled" | "interrupted" | "error";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";
export const READ_ONLY_PROFILE = {
  execution: "host", tools: ["read", "ls"], approval: "per-call",
  // rootTotalChildren is not a count limit: 0 means this profile cannot delegate, any positive value means unlimited.
  rootTotalChildren: 4, maxDepth: 1, childTimeoutMs: 300_000,
} as const;
export const CODE_PROFILE={...READ_ONLY_PROFILE,tools:["read","ls","edit","write"],rootTotalChildren:0,maxDepth:0} as const;
export const VERIFIED_CODE_PROFILE={...CODE_PROFILE,verification:"node-test"} as const;
export const DIRECT_CODE_PROFILE={...VERIFIED_CODE_PROFILE,typecheck:true} as const;
export const REPOSITORY_CODE_PROFILE={...VERIFIED_CODE_PROFILE,sourceApply:true,typecheck:true} as const;
export const DIRECT_PARALLEL_CODE_PROFILE={...DIRECT_CODE_PROFILE,rootTotalChildren:2,maxDepth:1} as const;
export const PARALLEL_CODE_PROFILE={...REPOSITORY_CODE_PROFILE,rootTotalChildren:2,maxDepth:1} as const;
export const MULTI_REPO_PROFILE={...READ_ONLY_PROFILE,tools:[],rootTotalChildren:0,maxDepth:0} as const;
// Existing snapshots keep their original limits. Only newly created roots use these bounds.
export const NESTED_READ_PROFILE={...READ_ONLY_PROFILE,maxDepth:2} as const;
export const NESTED_CODE_PROFILE={...DIRECT_CODE_PROFILE,rootTotalChildren:4} as const;
export const NESTED_REPOSITORY_PROFILE={...REPOSITORY_CODE_PROFILE,rootTotalChildren:4} as const;
export const NESTED_PARALLEL_PROFILE={...DIRECT_PARALLEL_CODE_PROFILE,rootTotalChildren:4,maxDepth:2} as const;
export const NESTED_PARALLEL_WORKTREE_PROFILE={...PARALLEL_CODE_PROFILE,rootTotalChildren:4,maxDepth:2} as const;
export const NESTED_WORKER_PROFILE={...CODE_PROFILE,rootTotalChildren:4,maxDepth:2} as const;
export const REVIEW_PROFILE={...READ_ONLY_PROFILE,rootTotalChildren:0,maxDepth:0} as const;
export type SessionMode="read"|"code"|"parallel"|"multi";
export type WorkspaceMode="direct"|"worktree";
export type WorkspaceSetupPhase="reserved"|"allocating"|"allocated"|"registered"|"opened"|"dispatching"|"unknown"|"ready";
export interface WorkspaceSetup {
  version:1;kind:"session"|"task-repository"|"task-coordinator"|"nested"|"review";phase:WorkspaceSetupPhase;
  id:string;commandId:string;sessionId:string;managerId:string;managerDir:string;cwd:string;sessionMode?:SessionMode;cwdDev?:number;cwdIno?:number;
  sourceCwd?:string;sourceDev?:number;sourceIno?:number;sourceHead?:string;sourceBaseline?:string;gitDir?:string;gitDev?:number;gitIno?:number;commonDir?:string;commonDev?:number;commonIno?:number;workspaceGitDir?:string;workspaceGitDev?:number;workspaceGitIno?:number;workspaceDev?:number;workspaceIno?:number;baseCommit?:string;workspaceMode?:WorkspaceMode;inPlace?:boolean;
  model:string;role?:SessionRole;profile?:Record<string,unknown>;taskId?:string;repositoryId?:string;parentId?:string;rootId?:string;
  policyVersion?:1|2;requested?:SessionPolicy["requested"];agentRole?:string;observedRevision?:string;
}
export interface WorkspaceRecoveryItem {observedRevision?:string;id:string;kind:string;setup?:WorkspaceSetup|null;status:"unknown"|"inspect-only";canContinue:boolean;cwd?:string;workspaceGitDir?:string|null;worktreeRegistered?:boolean;cwdExists:boolean;registered:boolean;head:string|null;managerFile:string|null;reason?:string;}
export const ROLE_TYPES=["root","coordinator","planner","researcher","worker","reviewer","qa"] as const;
export type RoleType=typeof ROLE_TYPES[number];
/** Delegated agents whose model the Agents page maps; root and coordinator always use the chat's model. */
export const AGENT_ROLES=["planner","researcher","worker","reviewer","qa"] as const;
export type AgentRole=typeof AGENT_ROLES[number];
export type RoleReasoning="off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max";
export interface RoleAssignment {role:AgentRole;model:string|null;reasoning:RoleReasoning|null;}
/** Role to model mapping. Catalogs saved before 0.4.0 used groups with reasoning and instructions; they are normalized on read. */
export interface RoleCatalog {revision:number;roles:RoleAssignment[];}
export interface SessionRole {type:RoleType;groupId?:string;catalog:RoleCatalog;requestedReasoning:RoleReasoning|null;instructions:string;}
export interface CodeWorkspace {sourceCwd:string;baseCommit:string;kind?:WorkspaceMode;}
export interface SessionPolicy {
  readonly version: 1|2;
  readonly requested: { readonly cwd: string; readonly model: string; readonly mode?:SessionMode; readonly workspaceMode?:WorkspaceMode };
  readonly effective: { readonly cwd: string; readonly model: string; readonly profile: typeof READ_ONLY_PROFILE|typeof CODE_PROFILE|typeof VERIFIED_CODE_PROFILE|typeof DIRECT_CODE_PROFILE|typeof REPOSITORY_CODE_PROFILE|typeof DIRECT_PARALLEL_CODE_PROFILE|typeof PARALLEL_CODE_PROFILE|typeof MULTI_REPO_PROFILE|typeof NESTED_READ_PROFILE|typeof NESTED_CODE_PROFILE|typeof NESTED_REPOSITORY_PROFILE|typeof NESTED_PARALLEL_PROFILE|typeof NESTED_PARALLEL_WORKTREE_PROFILE|typeof NESTED_WORKER_PROFILE|typeof REVIEW_PROFILE };
  readonly workspace?:CodeWorkspace;
  readonly role?:SessionRole;
  readonly task?:{readonly id:string;readonly repositoryId?:string};
  readonly setup?:WorkspaceSetup;
  /** AGY runs its own tools in this session; they never pass through Pi approvals. */
  readonly unsupervised?:true;
}
export interface AgentView { id: string; parentId: string | null; role: string; status: RunStatus; model: string; cwd: string; revisionReviewer?:boolean; }
export interface FileChange {path:string;diff:string;beforeHash:string;afterHash:string;beforeMode?:number|null;afterMode?:number;}
export type WriteOutcome="applying"|"applied"|"failed"|"unknown"|"reconciled";
export type WriteRecoveryState="before"|"after"|"diverged";
export interface WriteRecoveryView {id:string;sessionId:string;path:string;beforeHash:string;afterHash:string;beforeMode:number|null;afterMode:number;observedHash:string;observedMode:number|null;state:WriteRecoveryState;reconciledAt?:number;}
export interface GitApproval { message:string;diff:string;tree:string;parent:string;files:string[]; }
export interface ApprovalView { git?:GitApproval|null;commandId?:string|null; id: string; agentId: string; tool: string; preview: string; status: ApprovalStatus; createdAt: number; change?:FileChange|null; outcome?:WriteOutcome|null; needsReconciliation?:boolean; reconciliation?:{state:WriteRecoveryState;observedHash:string;observedMode:number|null;at:number}|null; }
export interface ChangesView {cwd:string;sourceCwd:string;baseCommit:string;files:string[];diff:string;omitted:number;revision:string;}
export interface CheckInput {path:string;hash:string;mode:number;}
export type CheckStatus="pending"|"approved"|"running"|"passed"|"failed"|"timed_out"|"invalidated"|"denied"|"expired"|"cancelled"|"unknown";
export interface CheckView {id:string;sessionId:string;requestHash:string;revision:string;current:boolean;status:CheckStatus;kind?:"node_test"|"typescript";argv:string[];cwd:string;inputs:CheckInput[];inputDigest:string;dependencyDigest?:string;timeoutMs:number;outputLimit:number;output:string;exitCode:number|null;signal:string|null;truncated:boolean;inputChanged:boolean;createdAt:number;startedAt:number|null;endedAt:number|null;}
export type ReviewStatus="running"|"completed"|"interrupted"|"error"|"unknown";
export interface ReviewView {id:string;sessionId:string;checkId:string;agentId:string;revision:string;inputDigest:string;current:boolean;status:ReviewStatus;findings:string;createdAt:number;endedAt:number|null;}
export interface EvidenceView {revision:string|null;checks:CheckView[];reviews:ReviewView[];qaRuns:QaRunView[];qaFindings:QaFindingView[];error?:string;}
/** Browser QA. The user's POST is the run approval; every state-changing browser action is approved separately. "unknown" blocks the run (no replay). */
export type QaStatus="starting"|"running"|"cancelled"|"failed"|"unknown";
export type QaActionKind="navigate"|"click"|"type"|"screenshot"|"assert";
export type QaActionStatus="proposed"|"approved"|"dispatched"|"done"|"failed"|"denied"|"refused"|"cancelled"|"unknown";
export interface QaViewport {width:number;height:number;}
export interface QaManifestEntry {path:string;sha256:string;size:number;}
export interface QaRunView {id:string;sessionId:string;revision:string;current:boolean;manifestHash:string;manifest:QaManifestEntry[];entry:string;origin:string;viewport:QaViewport;isolation:"outer";chromiumSha256:string;status:QaStatus;error?:string;createdAt:number;endedAt:number|null;}
export interface QaActionView {id:string;runId:string;sessionId:string;agentId:string;seq:number;kind:QaActionKind;target:string;text?:string;revision:string;manifestHash:string;observationId:string|null;actionHash:string;status:QaActionStatus;detail:string;outcome?:"pass"|"fail";artifactId?:string;createdAt:number;endedAt:number|null;}
export interface QaArtifactView {id:string;runId:string;sessionId:string;mime:"image/png";width:number;height:number;sha256:string;bytes:number;revision:string;manifestHash:string;viewport:QaViewport;observationId:string;createdAt:number;}
export interface QaView {runs:QaRunView[];actions:QaActionView[];artifacts:QaArtifactView[];}
export type BrowserUseActionKind="screenshot"|"click"|"type"|"scroll"|"key"|"navigate";
export type BrowserUseActionStatus="proposed"|"approved"|"dispatched"|"done"|"failed"|"denied"|"cancelled"|"unknown";
export type BrowserUseMode="chrome"|"internal";
export interface BrowserModeCommandView {id:string;mode:BrowserUseMode;status:string;createdAt:number;}
export interface BrowserUseTargetView {id:string;label:string;host:string;origin:string;}
export interface BrowserUseActionView {id:string;sessionId:string;kind:BrowserUseActionKind;mode?:BrowserUseMode;target:string;status:BrowserUseActionStatus;detail:string;artifactId?:string;observationId?:string;createdAt:number;endedAt:number|null;}
export interface BrowserUseArtifactView {id:string;sessionId:string;mime:"image/png";width:number;height:number;sha256:string;bytes:number;createdAt:number;}
export interface BrowserUseView {status:"disconnected"|"connecting"|"connected"|"selected"|"unknown";mode:BrowserUseMode|null;targets:BrowserUseTargetView[];selected:BrowserUseTargetView|null;actions:BrowserUseActionView[];artifacts:BrowserUseArtifactView[];modeCommands:BrowserModeCommandView[];}
/** Read-only QA finding recorded by a qa agent; `current` only while its revision equals the session's current Code revision. */
export type QaSeverity="low"|"medium"|"high"|"critical";
export interface QaFindingView {id:string;runId:string;sessionId:string;agentId:string;revision:string;manifestHash:string;summary:string;severity:QaSeverity;artifactIds:string[];actionIds:string[];current:boolean;createdAt:number;}
/** QA gate: R1 failure, finding, caller receipt, approved fix, R1 stale, fresh R2 pass, independent review, final receipt. Every step is derived from durable facts; "unknown" blocks and is never replayed. */
export const QA_GATE_STEPS=["r1_failed","finding_recorded","caller_receipt","fix_approved","r1_stale","r2_passed","reviewed","final_receipt"] as const;
export type QaGateStep=typeof QA_GATE_STEPS[number];
export type QaGateStepStatus="done"|"pending"|"unknown"|"stale";
export interface QaGateStepView {step:QaGateStep;status:QaGateStepStatus;detail:string;at:number|null;refs:Record<string,string>;}
export interface QaGateView {sessionId:string;revision:string|null;state:QaGateStep|"none";blocked:string|null;steps:QaGateStepView[];}
export type SourceApplyStatus="pending"|"approved"|"running"|"applied"|"partial"|"conflict"|"denied"|"expired"|"cancelled"|"unknown"|"reconciled";
export type SourceFileStatus="waiting"|"applying"|"applied"|"conflict"|"unknown";
export type SourceApplyObservation="before"|"after"|"diverged";
export interface SourceApplyFile {path:string;beforeHash:string;afterHash:string;beforeMode:number|null;baseOid:string|null;afterMode:number;status:SourceFileStatus;observedHash?:string;observedMode?:number|null;observation?:SourceApplyObservation;recoveryPath?:string;error?:string;}
export interface SourceApplyView {id:string;sessionId:string;requestHash:string;revision:string;current:boolean;status:SourceApplyStatus;sourceCwd:string;gitDir:string;gitCommonDir:string;gitIdentity:string;head:string;branch:string|null;diff:string;files:SourceApplyFile[];createdAt:number;startedAt:number|null;endedAt:number|null;error?:string;/** Whether a current passed check and a completed independent review exist for this revision; Apply no longer requires them. */verified?:{check:boolean;review:boolean};}
export type WorkerMergeStatus="pending"|"conflict"|"denied"|"expired"|"cancelled"|"running"|"applied"|"partial"|"unknown"|"reconciled";
export interface WorkerMergeFile {path:string;status:"ready"|"conflict"|"waiting"|"applying"|"applied"|"unknown";preview:string;beforeHash:string;afterHash:string|null;observedHash?:string;observation?:"before"|"after"|"diverged";recoveryPath?:string;error?:string;}
export interface WorkerMergeView {id:string;rootId:string;workerId:string;rootRevision:string;workerRevision:string;status:WorkerMergeStatus;current:boolean;files:WorkerMergeFile[];diff:string;createdAt:number;endedAt:number|null;error?:string;auto?:boolean;}
export interface RecoveryInput { id:string; text:string; behavior:"steer"|"followUp"|null; status:string; createdAt:number; }
export interface RecoveryAction { id:string; kind:"delegate"|"edit"|"write"; status:"unknown"; text:string|null; role:string|null; agentId:string|null; createdAt:number; }
export type WorkStep={kind:"note";text:string}|{kind:"thinking";text:string}|{kind:"tool";tool:string;detail?:string;status:"done"|"error"|"running"};
export interface WorkView {startedAt:number;endedAt:number;steps:WorkStep[]}
export interface SessionView { archivedAt?:number|null; id: string; cwd: string; model: string; policy: SessionPolicy | null; status: RunStatus; cursor: number; agents: AgentView[]; approvals: ApprovalView[]; recoveryInputs: RecoveryInput[]; recoveryActions: RecoveryAction[]; messages: Array<{ role: string; text: string; id: string; at?: number; images?: number; interim?: true; work?: WorkView }>; }
export interface JournalEvent { seq: number; sessionId: string; type: string; payload: unknown; at: number; }

export interface ProjectView { id:string; name:string; folders:string[]; archivedAt?:number|null; }
export interface ProjectTaskView {
  id:string;projectId:string;projectName:string;coordinatorId:string;model:string;requestHash:string;
  workspaceMode?:WorkspaceMode;
  roleCatalog?:RoleCatalog;
  reasoning?:RoleReasoning;
  status:"creating"|"running"|"unknown";
  repositories:Array<{id:string;sourceCwd:string;baseCommit:string;sessionId:string;setup?:WorkspaceSetup}>;
  coordinatorSetup?:WorkspaceSetup;
  setupVersion?:1;
  archivedAt?:number|null;
  createdAt:number;
}
export interface FolderStatus {
  path:string;
  state:"git"|"folder"|"missing"|"error";
  error?:string;
  repository?:string;
  branch?:string|null;
  oid?:string|null;
  upstream?:string|null;
  ahead?:number|null;
  behind?:number|null;
  staged?:number;
  unstaged?:number;
  untracked?:number;
  conflicts?:number;
}
export interface ProjectStatus { id:string; checkedAt:number; folders:FolderStatus[]; }
export interface SessionGitActions { enabled:boolean; reason?:string; commit:boolean; branches:string[]; }
export interface SessionRepositoryView { checkedAt:number; source:FolderStatus; workspace:FolderStatus|null; git:SessionGitActions; }

// Graph facts are observed execution records, never inferred from status or prose.
export interface RunMetadata {runId:string|null;model:string;reasoning:string|null;reasoningAvailability:"available"|"unsupported"|"unavailable";title:string|null;}
export interface GraphNode extends AgentView {title:string;metadata:RunMetadata;creationAvailable:boolean;repositoryId:string|null;}
export interface GraphFact {
  id:string;kind:"creation"|"delegation"|"result"|"prompt"|"steer"|"followUp"|"review_evidence";
  source:string;target:string;actor:string;cause:string;outcome:string;
  commandId?:string;toolCallId?:string;reviewId?:string;revision?:string;
  run:RunMetadata|null;sourceRun?:RunMetadata|null;receiptEntryId?:string;sourceEntryId?:string;sourceMessageId?:string;
}
export interface GraphEvent extends JournalEvent {type:"graph_fact"|"graph_run";payload:GraphFact|RunMetadata;}
export interface GraphSnapshot {rootId:string;taskId:string|null;nodes:GraphNode[];events:GraphEvent[];cursor:number;highWater:number;hasMore:boolean;truncated:boolean;totalEvents:number;}
/** Transient SDK sign-in metadata. Credentials and answers never enter this contract. */
export type ProviderLoginState = "starting"|"waiting"|"finishing"|"cancelling"|"succeeded"|"cancelled"|"failed"|"sync_pending";
export type ProviderLoginPrompt = {id:string;type:"text"|"secret"|"select"|"manual_code";message:string;placeholder?:string;options?:Array<{id:string;label:string;description?:string}>};
export type ProviderLoginView = {id:string;providerId:string;state:ProviderLoginState;prompt?:ProviderLoginPrompt;authUrl?:string;deviceCode?:string;deviceExpiresAt?:number;message?:string;credentialStored?:boolean;metadataUnavailable?:boolean};
export type ProviderView = {id:string;name:string;owner:"pi_sdk";oauth:boolean;loginLabel?:string;configured:boolean;source?:string;credentialType?:"api_key"|"oauth";operation?:ProviderLoginView};

/** Agent tool approvals: "full" runs tools without asking, "ask" shows Allow/Deny prompts. */
export type ApprovalMode="full"|"ask";
export type NativeProviderView={id:string;name:string;owner:"native_cli";state:"missing"|"disconnected"|"connected"|"login_required"|"blocked"|"error";enabled:boolean;expiresAt:null;account?:string;subscription?:string;message:string;profileReady?:boolean;loginCommand?:string;unsupervised?:boolean;warning?:string};
/** Read-only record of a tool AGY executed itself (never a Pi approval). */
export interface AgyActivity {agentId:string;step:string;tool:string;params:string;status:"running"|"done"|"error";output?:string;}
export type CliproxyView={id:string;name:string;state:"missing"|"disconnected"|"connected"|"blocked"|"error";configured:boolean;connected:boolean;modelCount:number;message:string;proxy?:{state:"not_installed"|"needs_login"|"starting"|"ready"|"degraded"|"stopped"|"borrowed";reason:string;restarts:number}};
