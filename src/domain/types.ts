export type EntityKind =
  | "project"
  | "role"
  | "workflow"
  | "work-item"
  | "repository"
  | "workspace"
  | "delegation"
  | "lease"
  | "handoff"
  | "evidence"
  | "delivery"
  | "acceptance"
  | "meeting"
  | "meeting-contribution"
  | "session"
  | "message"
  | "context-note"
  | "intervention";

export type WorkItemType = "milestone" | "epic" | "issue" | "task";
export type WorkItemStatus = "planned" | "active" | "awaiting-acceptance" | "done" | "blocked";
export type SessionStatus = "active" | "waiting" | "unknown" | "completed" | "failed";
export type WorkIntent = "implementation" | "diagnosis" | "review";
export type ProjectTopology = "single-repo" | "monorepo" | "multi-repo";

export interface Project {
  id: string;
  name: string;
  description?: string;
  rootPath: string;
  topology: ProjectTopology;
  createdAt: string;
}

export interface Role {
  id: string;
  projectId: string;
  key: string;
  name: string;
  instructions?: string;
  capabilities: string[];
  workspaceKeys: string[];
  model?: { providerId: string; modelId: string; variant?: string };
  createdAt: string;
}

export interface WorkflowStage {
  key: string;
  name: string;
  roleKey: string;
}

export interface Workflow {
  id: string;
  projectId: string;
  name: string;
  stages: WorkflowStage[];
  createdAt: string;
}

export interface WorkItem {
  id: string;
  projectId: string;
  parentId?: string;
  type: WorkItemType;
  title: string;
  outcome: string;
  outcomeRevision: number;
  description?: string;
  assigneeRoleKey?: string;
  workflowId?: string;
  stageIndex?: number;
  status: WorkItemStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Repository {
  id: string;
  projectId: string;
  key: string;
  name: string;
  path: string;
  relationship: "root" | "directory" | "submodule" | "external";
  createdAt: string;
}

export interface Workspace {
  id: string;
  projectId: string;
  repositoryId: string;
  key: string;
  name: string;
  path: string;
  shared: boolean;
  contextRoot: boolean;
  inheritRootContext: boolean;
  requireLocalAgent: boolean;
  createdAt: string;
}

export interface Delegation {
  id: string;
  projectId: string;
  workItemId: string;
  workspaceId: string;
  roleKey: string;
  intent: WorkIntent;
  outcomeRevision: number;
  instructions: string;
  sessionId?: string;
  status: "planned" | "active" | "handed-off" | "completed" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

export interface Lease {
  id: string;
  projectId: string;
  delegationId: string;
  workspaceId: string;
  sessionId: string;
  roleKey: string;
  status: "requested" | "active" | "released" | "expired" | "revoked";
  fencingToken?: number;
  requestedAt: string;
  grantedAt?: string;
  expiresAt: string;
  endedAt?: string;
  createdAt: string;
}

export interface Handoff {
  id: string;
  projectId: string;
  workItemId: string;
  delegationId: string;
  fromSessionId: string;
  toRoleKey: string;
  continuationSessionId?: string;
  context: string;
  impact: string;
  nextAction: string;
  blockingCondition?: string;
  evidenceIds: string[];
  status: "offered" | "acknowledged" | "rejected" | "consumed" | "superseded";
  acknowledgedBySessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Evidence {
  id: string;
  projectId: string;
  workItemId: string;
  sessionId: string;
  kind: "test" | "review" | "artifact" | "commit" | "note";
  summary: string;
  reference?: string;
  valid: boolean;
  createdAt: string;
}

export interface DeliveryRevision {
  id: string;
  projectId: string;
  workItemId: string;
  revision: number;
  producedBySessionId: string;
  evidenceIds: string[];
  summary: string;
  createdAt: string;
}

export interface AcceptanceReview {
  id: string;
  projectId: string;
  workItemId: string;
  deliveryId: string;
  reviewerSessionId: string;
  status: "requested" | "accepted" | "rejected" | "inconclusive";
  verdict?: string;
  createdAt: string;
  reviewedAt?: string;
}

export interface AgentSession {
  id: string;
  projectId: string;
  roleKey: string;
  agent: string;
  coordinatorId: string;
  workspaceId?: string;
  delegationId?: string;
  meetingId?: string;
  runtimeSessionId?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SessionMessage {
  id: string;
  projectId: string;
  fromSessionId: string;
  toSessionId: string;
  content: string;
  createdAt: string;
}

export interface ContextNote {
  id: string;
  projectId: string;
  sessionId?: string;
  workItemId?: string;
  meetingId?: string;
  kind?: "context" | "decision" | "constraint";
  author: string;
  content: string;
  createdAt: string;
  deliveredAt?: string;
}

export interface MeetingParticipant {
  roleKey: string;
  workspaceId: string;
  sessionId?: string;
}

export interface MeetingSynthesis {
  featureBrief: string;
  decisions: string[];
  openQuestions: string[];
  milestones: Array<{ title: string; outcome: string }>;
  epics: Array<{ title: string; outcome: string; milestone: string }>;
  issues: Array<{ title: string; outcome: string; epic: string; ownerRoleKey: string; acceptanceGates: string[] }>;
}

export interface PlanningMeeting {
  id: string;
  projectId: string;
  objective: string;
  facilitatorSessionId: string;
  workItemId?: string;
  participants: MeetingParticipant[];
  status: "planned" | "active" | "synthesizing" | "completed" | "cancelled";
  round: number;
  maxRounds: number;
  synthesis?: MeetingSynthesis;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface MeetingContribution {
  id: string;
  projectId: string;
  meetingId: string;
  round: number;
  sessionId: string;
  roleKey: string;
  kind: "proposal" | "critique" | "question" | "decision";
  content: string;
  createdAt: string;
}

export interface Intervention {
  id: string;
  projectId: string;
  requesterSessionId: string;
  target: "human" | "role";
  targetRoleKey?: string;
  assignedSessionId?: string;
  message: string;
  resolution?: string;
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt?: string;
}

export interface DomainEvent {
  sequence: number;
  id: string;
  projectId: string;
  type: string;
  aggregateKind: EntityKind;
  aggregateId: string;
  actor: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface NewEvent {
  projectId: string;
  type: string;
  aggregateKind: EntityKind;
  aggregateId: string;
  actor: string;
  payload?: Record<string, unknown>;
}
