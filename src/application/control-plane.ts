import type {
  AgentSession,
  AcceptanceReview,
  ContextNote,
  Delegation,
  DeliveryRevision,
  DomainEvent,
  Evidence,
  Handoff,
  Intervention,
  Lease,
  MeetingContribution,
  MeetingSynthesis,
  PlanningMeeting,
  Project,
  Repository,
  Role,
  SessionMessage,
  Workflow,
  WorkflowStage,
  Workspace,
  WorkItem,
  WorkIntent,
  ProjectTopology,
  WorkItemType,
} from "../domain/types.ts";
import { SqliteStore } from "../infrastructure/sqlite-store.ts";

export class DomainError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "CONFLICT" | "VALIDATION_ERROR",
    message: string,
  ) {
    super(message);
  }
}

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

export class ControlPlane {
  constructor(readonly store: SqliteStore) {}

  createProject(input: { name: string; description?: string; rootPath?: string; topology?: ProjectTopology; actor?: string }): Project {
    this.#required(input.name, "Project name");
    const project: Project = { id: id(), name: input.name, description: input.description, rootPath: input.rootPath ?? ".", topology: input.topology ?? "single-repo", createdAt: now() };
    return this.store.create("project", project.id, project, {
      projectId: project.id,
      type: "project.created",
      aggregateKind: "project",
      aggregateId: project.id,
      actor: input.actor ?? "human",
      payload: { name: project.name },
    });
  }

  listProjects(): Project[] {
    return this.store.list("project");
  }

  projectGuide(projectId: string) {
    const project = this.#project(projectId);
    const roles = this.listRoles(projectId);
    const repositories = this.listRepositories(projectId);
    const workspaces = this.listWorkspaces(projectId);
    const workflows = this.listWorkflows(projectId);
    return {
      purpose: "Linear Crew is the durable local control plane for planning, delegating, coordinating and independently accepting AI-agent work.",
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        topology: project.topology,
        rootPath: project.rootPath,
      },
      configuration: {
        bindingFile: ".linear-crew.json",
        roles: roles.map((role) => ({ key: role.key, name: role.name, instructions: role.instructions, capabilities: role.capabilities, workspaceKeys: role.workspaceKeys, model: role.model })),
        repositories: repositories.map((repository) => ({ id: repository.id, key: repository.key, path: repository.path, relationship: repository.relationship })),
        workspaces: workspaces.map((workspace) => ({ id: workspace.id, key: workspace.key, repositoryId: workspace.repositoryId, path: workspace.path, inheritRootContext: workspace.inheritRootContext, requireLocalAgent: workspace.requireLocalAgent })),
        workflows: workflows.map((workflow) => ({ id: workflow.id, name: workflow.name, stages: workflow.stages })),
        missing: [
          ...(!roles.length ? ["roles"] : []),
          ...(!repositories.length ? ["repositories"] : []),
          ...(!workspaces.length ? ["workspaces"] : []),
        ],
        notices: !workflows.length ? ["No workflow is configured; simple work items remain valid."] : [],
      },
      invariants: [
        "Use one Linear Crew project for the global work graph, even with multiple repositories or context roots.",
        "Every delegated responsibility is anchored to a work-item outcome revision, role and workspace.",
        "Implementation requires an active exclusive workspace lease; diagnosis, review and planning meetings are read-only.",
        "Use direct messages, interventions and handoffs instead of relaying all communication through the Product Owner.",
        "Complete work with immutable evidence and a delivery revision; a different capable session performs acceptance.",
        "Use crew_context for curated product context. Query history or operational telemetry only when explicitly needed.",
      ],
      setupFlow: [
        "Create the global graph with: linear-crew project-create --name <name> --topology <single-repo|monorepo|multi-repo> --root <path>.",
        "Register every repository and context root with repository-add and workspace-add; use one workspace per effective OpenCode directory.",
        "Define roles with role-add, including allowed workspace keys, capabilities and optional provider/model selection.",
        "Add workflows when work requires ordered role transitions; simple work items can omit a workflow.",
        "Generate the local binding with: linear-crew opencode-configure --project <project-id>.",
        "Run linear-crew runtime --project <project-id> from the configured root, or run an external OpenCode server plus the scheduler command.",
        "Use linear-crew tui --project <project-id> for monitoring and durable human decisions or constraints.",
      ],
      implementationFlow: [
        "Call crew_guide to understand this project, then crew_register_session if the runtime session is not already bound.",
        "Call crew_context and verify the delegation outcome, intent, role and exact workspace before acting.",
        "For implementation, call crew_request_lease and do not edit until the lease is active.",
        "Implement only the delegated outcome in the configured context root; raise authority questions with crew_open_intervention.",
        "Coordinate cross-role work with crew_send_message or a structured crew_offer_handoff.",
        "Attach verifiable results with crew_attach_evidence and create a delivery with crew_complete_delivery.",
        "Request independent review with crew_request_acceptance; only accepted evidence closes the work item.",
      ],
      capabilities: {
        discovery: ["crew_guide", "crew_context", "crew_context_history", "crew_operational_context"],
        work: ["crew_create_work", "crew_create_delegation", "crew_start_delegation", "crew_start_delegations", "crew_continue_delegation"],
        coordination: ["crew_send_message", "crew_open_intervention", "crew_assign_intervention", "crew_resolve_intervention", "crew_offer_handoff", "crew_respond_handoff"],
        safety: ["crew_request_lease", "crew_grant_lease", "crew_release_lease"],
        delivery: ["crew_attach_evidence", "crew_complete_delivery", "crew_request_acceptance", "crew_review_acceptance"],
        planning: ["crew_meeting_create", "crew_meeting_start", "crew_meeting_contribute", "crew_meeting_complete"],
        runtime: ["crew_reconcile_sessions"],
      },
    };
  }

  createRole(projectId: string, input: { key: string; name: string; instructions?: string; capabilities?: string[]; workspaceKeys?: string[]; model?: Role["model"]; actor?: string }): Role {
    this.#project(projectId);
    this.#required(input.key, "Role key");
    this.#required(input.name, "Role name");
    if (this.store.list<Role>("role", projectId).some((role) => role.key === input.key)) {
      throw new DomainError("CONFLICT", `Role key '${input.key}' already exists`);
    }
    const role: Role = { id: id(), projectId, key: input.key, name: input.name, instructions: input.instructions, capabilities: input.capabilities ?? [], workspaceKeys: input.workspaceKeys ?? ["*"], model: input.model, createdAt: now() };
    return this.store.create("role", projectId, role, this.#event(projectId, "role.created", "role", role.id, input.actor, { key: role.key }));
  }

  listRoles(projectId: string): Role[] {
    this.#project(projectId);
    return this.store.list("role", projectId);
  }

  createWorkflow(projectId: string, input: { name: string; stages: WorkflowStage[]; actor?: string }): Workflow {
    this.#project(projectId);
    this.#required(input.name, "Workflow name");
    if (input.stages.length === 0) throw new DomainError("VALIDATION_ERROR", "A workflow needs at least one stage");
    const roles = new Set(this.store.list<Role>("role", projectId).map((role) => role.key));
    const keys = new Set<string>();
    for (const stage of input.stages) {
      this.#required(stage.key, "Stage key");
      this.#required(stage.name, "Stage name");
      if (keys.has(stage.key)) throw new DomainError("CONFLICT", `Duplicate stage key '${stage.key}'`);
      if (!roles.has(stage.roleKey)) throw new DomainError("NOT_FOUND", `Role '${stage.roleKey}' does not exist`);
      keys.add(stage.key);
    }
    const workflow: Workflow = { id: id(), projectId, name: input.name, stages: input.stages, createdAt: now() };
    return this.store.create("workflow", projectId, workflow, this.#event(projectId, "workflow.created", "workflow", workflow.id, input.actor, { stages: workflow.stages.length }));
  }

  listWorkflows(projectId: string): Workflow[] {
    this.#project(projectId);
    return this.store.list("workflow", projectId);
  }

  createWorkItem(projectId: string, input: {
    parentId?: string;
    type: WorkItemType;
    title: string;
    outcome: string;
    description?: string;
    assigneeRoleKey?: string;
    workflowId?: string;
    actor?: string;
  }): WorkItem {
    this.#project(projectId);
    this.#required(input.title, "Work item title");
    this.#required(input.outcome, "Work item outcome");
    if (input.parentId) this.#inProject<WorkItem>("work-item", input.parentId, projectId);
    if (input.assigneeRoleKey) this.#role(projectId, input.assigneeRoleKey);
    let workflow: Workflow | null = null;
    if (input.workflowId) workflow = this.#inProject("workflow", input.workflowId, projectId);
    const timestamp = now();
    const workItem: WorkItem = {
      id: id(), projectId, parentId: input.parentId, type: input.type, title: input.title,
      outcome: input.outcome, outcomeRevision: 1,
      description: input.description, assigneeRoleKey: input.assigneeRoleKey,
      workflowId: workflow?.id, stageIndex: workflow ? 0 : undefined,
      status: workflow ? "active" : "planned", createdAt: timestamp, updatedAt: timestamp,
    };
    return this.store.create("work-item", projectId, workItem, this.#event(projectId, "work-item.created", "work-item", workItem.id, input.actor, { type: workItem.type, workflowId: workflow?.id }));
  }

  listWorkItems(projectId: string): WorkItem[] {
    this.#project(projectId);
    return this.store.list("work-item", projectId);
  }

  createRepository(projectId: string, input: { key: string; name: string; path: string; relationship?: Repository["relationship"]; actor?: string }): Repository {
    this.#project(projectId);
    this.#required(input.key, "Repository key");
    this.#required(input.name, "Repository name");
    this.#required(input.path, "Repository path");
    if (this.store.list<Repository>("repository", projectId).some((repository) => repository.key === input.key)) {
      throw new DomainError("CONFLICT", `Repository key '${input.key}' already exists`);
    }
    const repository: Repository = { id: id(), projectId, key: input.key, name: input.name, path: input.path, relationship: input.relationship ?? (input.path === "." ? "root" : "directory"), createdAt: now() };
    return this.store.create("repository", projectId, repository, this.#event(projectId, "repository.created", "repository", repository.id, input.actor, { key: repository.key }));
  }

  createWorkspace(projectId: string, input: { repositoryId: string; key?: string; name: string; path: string; shared?: boolean; contextRoot?: boolean; inheritRootContext?: boolean; requireLocalAgent?: boolean; actor?: string }): Workspace {
    this.#project(projectId);
    this.#inProject<Repository>("repository", input.repositoryId, projectId);
    this.#required(input.name, "Workspace name");
    this.#required(input.path, "Workspace path");
    const key = input.key ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    this.#required(key, "Workspace key");
    if (this.store.list<Workspace>("workspace", projectId).some((workspace) => workspace.key === key)) {
      throw new DomainError("CONFLICT", `Workspace key '${key}' already exists`);
    }
    const workspace: Workspace = { id: id(), projectId, repositoryId: input.repositoryId, key, name: input.name, path: input.path, shared: input.shared ?? true, contextRoot: input.contextRoot ?? true, inheritRootContext: input.inheritRootContext ?? input.path !== ".", requireLocalAgent: input.requireLocalAgent ?? true, createdAt: now() };
    return this.store.create("workspace", projectId, workspace, this.#event(projectId, "workspace.created", "workspace", workspace.id, input.actor));
  }

  listRepositories(projectId: string): Repository[] {
    this.#project(projectId);
    return this.store.list("repository", projectId);
  }

  listWorkspaces(projectId: string): Workspace[] {
    this.#project(projectId);
    return this.store.list("workspace", projectId);
  }

  createDelegation(projectId: string, input: {
    workItemId: string;
    workspaceId: string;
    roleKey: string;
    intent: WorkIntent;
    instructions: string;
    actor?: string;
  }): Delegation {
    this.#project(projectId);
    const item = this.#inProject<WorkItem>("work-item", input.workItemId, projectId);
    this.#inProject<Workspace>("workspace", input.workspaceId, projectId);
    this.#role(projectId, input.roleKey);
    this.#required(input.instructions, "Delegation instructions");
    const role = this.#role(projectId, input.roleKey);
    const workspace = this.#inProject<Workspace>("workspace", input.workspaceId, projectId);
    if (!role.workspaceKeys.includes("*") && !role.workspaceKeys.includes(workspace.key)) {
      throw new DomainError("CONFLICT", `Role '${role.key}' cannot work in workspace '${workspace.key}'`);
    }
    const timestamp = now();
    const delegation: Delegation = {
      id: id(), projectId, workItemId: item.id, workspaceId: input.workspaceId,
      roleKey: input.roleKey, intent: input.intent, outcomeRevision: item.outcomeRevision,
      instructions: input.instructions, status: "planned", createdAt: timestamp, updatedAt: timestamp,
    };
    return this.store.create("delegation", projectId, delegation, this.#event(projectId, "delegation.created", "delegation", delegation.id, input.actor, { workItemId: item.id, roleKey: input.roleKey, outcomeRevision: item.outcomeRevision }));
  }

  listDelegations(projectId: string): Delegation[] {
    this.#project(projectId);
    return this.store.list("delegation", projectId);
  }

  advanceWorkItem(workItemId: string, actor = "human"): WorkItem {
    const item = this.#entity<WorkItem>("work-item", workItemId);
    if (!item.workflowId || item.stageIndex === undefined) {
      throw new DomainError("CONFLICT", "Work item has no workflow");
    }
    if (item.status === "done") throw new DomainError("CONFLICT", "Work item is already done");
    const workflow = this.#inProject<Workflow>("workflow", item.workflowId, item.projectId);
    const nextIndex = item.stageIndex + 1;
    const updated: WorkItem = {
      ...item,
      stageIndex: nextIndex < workflow.stages.length ? nextIndex : item.stageIndex,
      status: nextIndex < workflow.stages.length ? "active" : "awaiting-acceptance",
      updatedAt: now(),
    };
    return this.store.update("work-item", item.projectId, updated, this.#event(item.projectId, "work-item.advanced", "work-item", item.id, actor, { stageIndex: updated.stageIndex, status: updated.status }));
  }

  startSession(projectId: string, input: { roleKey: string; agent: string; coordinatorId?: string; workspaceId?: string; delegationId?: string; meetingId?: string; runtimeSessionId?: string; actor?: string }): AgentSession {
    this.#project(projectId);
    this.#role(projectId, input.roleKey);
    this.#required(input.agent, "Agent name");
    if (input.workspaceId) this.#inProject<Workspace>("workspace", input.workspaceId, projectId);
    if (input.meetingId) {
      const meeting = this.#inProject<PlanningMeeting>("meeting", input.meetingId, projectId);
      if (meeting.status === "completed" || meeting.status === "cancelled") throw new DomainError("CONFLICT", "Cannot start a session for a closed meeting");
    }
    let delegation: Delegation | null = null;
    if (input.delegationId) {
      delegation = this.#inProject<Delegation>("delegation", input.delegationId, projectId);
      if (delegation.roleKey !== input.roleKey) throw new DomainError("CONFLICT", "Session role does not match delegation role");
      if (input.workspaceId && delegation.workspaceId !== input.workspaceId) throw new DomainError("CONFLICT", "Session workspace does not match delegation workspace");
    }
    const timestamp = now();
    const session: AgentSession = { id: id(), projectId, roleKey: input.roleKey, agent: input.agent, coordinatorId: input.coordinatorId ?? "default", workspaceId: input.workspaceId ?? delegation?.workspaceId, delegationId: delegation?.id, meetingId: input.meetingId, runtimeSessionId: input.runtimeSessionId, status: "active", createdAt: timestamp, updatedAt: timestamp };
    const created = this.store.create("session", projectId, session, this.#event(projectId, "session.started", "session", session.id, input.actor, { roleKey: session.roleKey, agent: session.agent, coordinatorId: session.coordinatorId }));
    if (delegation) {
      const active: Delegation = { ...delegation, sessionId: session.id, status: "active", updatedAt: now() };
      this.store.update("delegation", projectId, active, this.#event(projectId, "delegation.started", "delegation", delegation.id, input.actor, { sessionId: session.id }));
    }
    return created;
  }

  adoptSession(sessionId: string, coordinatorId: string, actor = "human"): AgentSession {
    const session = this.#entity<AgentSession>("session", sessionId);
    this.#required(coordinatorId, "Coordinator id");
    const updated: AgentSession = { ...session, coordinatorId, updatedAt: now() };
    return this.store.update("session", session.projectId, updated, this.#event(session.projectId, "session.adopted", "session", session.id, actor, { previousCoordinatorId: session.coordinatorId, coordinatorId }));
  }

  listSessions(projectId: string, roleKey?: string): AgentSession[] {
    this.#project(projectId);
    const sessions = this.store.list<AgentSession>("session", projectId);
    return roleKey ? sessions.filter((session) => session.roleKey === roleKey) : sessions;
  }

  getProject(projectId: string): Project {
    return this.#project(projectId);
  }

  getWorkspace(workspaceId: string): Workspace {
    return this.#entity("workspace", workspaceId);
  }

  getDelegation(delegationId: string): Delegation {
    return this.#entity("delegation", delegationId);
  }

  getWorkItem(workItemId: string): WorkItem {
    return this.#entity("work-item", workItemId);
  }

  getMeeting(meetingId: string): PlanningMeeting {
    return this.#entity("meeting", meetingId);
  }

  getRole(projectId: string, roleKey: string): Role {
    return this.#role(projectId, roleKey);
  }

  updateSessionStatus(sessionId: string, status: AgentSession["status"], actor = "scheduler"): AgentSession {
    const session = this.#entity<AgentSession>("session", sessionId);
    if (session.status === status) return session;
    const updated: AgentSession = { ...session, status, updatedAt: now() };
    return this.store.update("session", session.projectId, updated, this.#event(session.projectId, "session.status-changed", "session", session.id, actor, { previous: session.status, status }));
  }

  requestLease(delegationId: string, input: { sessionId: string; ttlMinutes?: number; actor?: string }): Lease {
    const delegation = this.#entity<Delegation>("delegation", delegationId);
    const session = this.#inProject<AgentSession>("session", input.sessionId, delegation.projectId);
    if (delegation.sessionId !== session.id) throw new DomainError("CONFLICT", "Session is not bound to this delegation");
    if (delegation.intent !== "implementation") throw new DomainError("CONFLICT", "Only implementation delegations require a write lease");
    const ttlMinutes = input.ttlMinutes ?? 60;
    if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) {
      throw new DomainError("VALIDATION_ERROR", "Lease TTL must be between 1 and 1440 minutes");
    }
    const timestamp = now();
    const lease: Lease = {
      id: id(), projectId: delegation.projectId, delegationId, workspaceId: delegation.workspaceId,
      sessionId: session.id, roleKey: delegation.roleKey, status: "requested",
      requestedAt: timestamp, expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(), createdAt: timestamp,
    };
    return this.store.create("lease", lease.projectId, lease, this.#event(lease.projectId, "lease.requested", "lease", lease.id, input.actor ?? session.id, { workspaceId: lease.workspaceId, expiresAt: lease.expiresAt }));
  }

  grantLease(leaseId: string, input: { actorSessionId?: string; actor?: string }): Lease {
    const lease = this.#entity<Lease>("lease", leaseId);
    if (lease.status !== "requested") throw new DomainError("CONFLICT", "Only a requested lease can be granted");
    if (Date.parse(lease.expiresAt) <= Date.now()) throw new DomainError("CONFLICT", "Lease request has expired");
    this.#authorize(lease.projectId, input.actorSessionId, "grant-lease");
    for (const candidate of this.store.list<Lease>("lease", lease.projectId)) {
      if (candidate.workspaceId !== lease.workspaceId || candidate.status !== "active" || Date.parse(candidate.expiresAt) > Date.now()) continue;
      this.store.update("lease", candidate.projectId, { ...candidate, status: "expired", endedAt: now() }, this.#event(candidate.projectId, "lease.expired", "lease", candidate.id, input.actor ?? input.actorSessionId));
    }
    const fencingToken = this.store.list<Lease>("lease", lease.projectId)
      .filter((candidate) => candidate.workspaceId === lease.workspaceId && candidate.fencingToken !== undefined)
      .reduce((highest, candidate) => Math.max(highest, candidate.fencingToken ?? 0), 0) + 1;
    const active: Lease = { ...lease, status: "active", fencingToken, grantedAt: now() };
    try {
      return this.store.update("lease", lease.projectId, active, this.#event(lease.projectId, "lease.granted", "lease", lease.id, input.actor ?? input.actorSessionId, { workspaceId: lease.workspaceId, fencingToken }));
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint")) {
        throw new DomainError("CONFLICT", "Workspace already has an active write lease");
      }
      throw error;
    }
  }

  releaseLease(leaseId: string, input: { sessionId: string; actor?: string }): Lease {
    const lease = this.#entity<Lease>("lease", leaseId);
    if (lease.status !== "active") throw new DomainError("CONFLICT", "Only an active lease can be released");
    if (lease.sessionId !== input.sessionId) throw new DomainError("CONFLICT", "Only the lease holder can release it");
    const released: Lease = { ...lease, status: "released", endedAt: now() };
    return this.store.update("lease", lease.projectId, released, this.#event(lease.projectId, "lease.released", "lease", lease.id, input.actor ?? input.sessionId));
  }

  listLeases(projectId: string): Lease[] {
    this.#project(projectId);
    return this.store.list("lease", projectId);
  }

  offerHandoff(projectId: string, input: {
    delegationId: string;
    fromSessionId: string;
    toRoleKey: string;
    continuationSessionId?: string;
    context: string;
    impact: string;
    nextAction: string;
    blockingCondition?: string;
    evidenceIds?: string[];
    actor?: string;
  }): Handoff {
    this.#project(projectId);
    const delegation = this.#inProject<Delegation>("delegation", input.delegationId, projectId);
    if (delegation.sessionId !== input.fromSessionId) throw new DomainError("CONFLICT", "Handoff must come from the delegated session");
    this.#inProject<AgentSession>("session", input.fromSessionId, projectId);
    this.#role(projectId, input.toRoleKey);
    this.#required(input.context, "Handoff context");
    this.#required(input.nextAction, "Handoff next action");
    for (const evidenceId of input.evidenceIds ?? []) this.#inProject<Evidence>("evidence", evidenceId, projectId);
    const timestamp = now();
    const handoff: Handoff = {
      id: id(), projectId, workItemId: delegation.workItemId, delegationId: delegation.id,
      fromSessionId: input.fromSessionId, toRoleKey: input.toRoleKey,
      continuationSessionId: input.continuationSessionId, context: input.context, impact: input.impact,
      nextAction: input.nextAction, blockingCondition: input.blockingCondition,
      evidenceIds: input.evidenceIds ?? [], status: "offered", createdAt: timestamp, updatedAt: timestamp,
    };
    return this.store.create("handoff", projectId, handoff, this.#event(projectId, "handoff.offered", "handoff", handoff.id, input.actor ?? input.fromSessionId, { toRoleKey: handoff.toRoleKey, continuationSessionId: handoff.continuationSessionId }));
  }

  acknowledgeHandoff(handoffId: string, input: { sessionId: string; actor?: string }): Handoff {
    const handoff = this.#entity<Handoff>("handoff", handoffId);
    if (handoff.status !== "offered") throw new DomainError("CONFLICT", "Only an offered handoff can be acknowledged");
    const session = this.#inProject<AgentSession>("session", input.sessionId, handoff.projectId);
    if (session.roleKey !== handoff.toRoleKey) throw new DomainError("CONFLICT", "Session role does not match handoff target role");
    const acknowledged: Handoff = { ...handoff, status: "acknowledged", acknowledgedBySessionId: session.id, updatedAt: now() };
    return this.store.update("handoff", handoff.projectId, acknowledged, this.#event(handoff.projectId, "handoff.acknowledged", "handoff", handoff.id, input.actor ?? session.id, { sessionId: session.id }));
  }

  rejectHandoff(handoffId: string, input: { sessionId: string; reason: string; actor?: string }): Handoff {
    const handoff = this.#entity<Handoff>("handoff", handoffId);
    if (handoff.status !== "offered") throw new DomainError("CONFLICT", "Only an offered handoff can be rejected");
    const session = this.#inProject<AgentSession>("session", input.sessionId, handoff.projectId);
    if (session.roleKey !== handoff.toRoleKey) throw new DomainError("CONFLICT", "Session role does not match handoff target role");
    this.#required(input.reason, "Rejection reason");
    const rejected: Handoff = { ...handoff, status: "rejected", acknowledgedBySessionId: session.id, updatedAt: now() };
    return this.store.update("handoff", handoff.projectId, rejected, this.#event(handoff.projectId, "handoff.rejected", "handoff", handoff.id, input.actor ?? session.id, { reason: input.reason }));
  }

  listHandoffs(projectId: string): Handoff[] {
    this.#project(projectId);
    return this.store.list("handoff", projectId);
  }

  attachEvidence(projectId: string, input: { workItemId: string; sessionId: string; kind: Evidence["kind"]; summary: string; reference?: string; actor?: string }): Evidence {
    this.#project(projectId);
    this.#inProject<WorkItem>("work-item", input.workItemId, projectId);
    this.#inProject<AgentSession>("session", input.sessionId, projectId);
    this.#required(input.summary, "Evidence summary");
    const evidence: Evidence = { id: id(), projectId, workItemId: input.workItemId, sessionId: input.sessionId, kind: input.kind, summary: input.summary, reference: input.reference, valid: true, createdAt: now() };
    return this.store.create("evidence", projectId, evidence, this.#event(projectId, "evidence.attached", "evidence", evidence.id, input.actor ?? input.sessionId, { workItemId: input.workItemId, kind: input.kind }));
  }

  completeDelivery(projectId: string, input: { workItemId: string; sessionId: string; evidenceIds: string[]; summary: string; actor?: string }): DeliveryRevision {
    this.#project(projectId);
    const item = this.#inProject<WorkItem>("work-item", input.workItemId, projectId);
    this.#inProject<AgentSession>("session", input.sessionId, projectId);
    this.#required(input.summary, "Delivery summary");
    if (input.evidenceIds.length === 0) throw new DomainError("VALIDATION_ERROR", "A delivery needs evidence");
    for (const evidenceId of input.evidenceIds) {
      const evidence = this.#inProject<Evidence>("evidence", evidenceId, projectId);
      if (evidence.workItemId !== item.id || !evidence.valid) throw new DomainError("CONFLICT", "Delivery evidence is invalid or belongs to another work item");
    }
    const revision = this.store.list<DeliveryRevision>("delivery", projectId).filter((delivery) => delivery.workItemId === item.id).length + 1;
    const delivery: DeliveryRevision = { id: id(), projectId, workItemId: item.id, revision, producedBySessionId: input.sessionId, evidenceIds: input.evidenceIds, summary: input.summary, createdAt: now() };
    this.store.create("delivery", projectId, delivery, this.#event(projectId, "delivery.completed", "delivery", delivery.id, input.actor ?? input.sessionId, { workItemId: item.id, revision }));
    if (item.status !== "awaiting-acceptance") {
      const pending: WorkItem = { ...item, status: "awaiting-acceptance", updatedAt: now() };
      this.store.update("work-item", projectId, pending, this.#event(projectId, "acceptance.required", "work-item", item.id, input.actor ?? input.sessionId, { deliveryId: delivery.id }));
    }
    return delivery;
  }

  requestAcceptance(deliveryId: string, input: { reviewerSessionId: string; actor?: string }): AcceptanceReview {
    const delivery = this.#entity<DeliveryRevision>("delivery", deliveryId);
    const reviewer = this.#inProject<AgentSession>("session", input.reviewerSessionId, delivery.projectId);
    this.#authorize(delivery.projectId, reviewer.id, "accept-delivery");
    if (reviewer.id === delivery.producedBySessionId) throw new DomainError("CONFLICT", "Acceptance must use a session independent from implementation");
    const review: AcceptanceReview = { id: id(), projectId: delivery.projectId, workItemId: delivery.workItemId, deliveryId, reviewerSessionId: reviewer.id, status: "requested", createdAt: now() };
    return this.store.create("acceptance", delivery.projectId, review, this.#event(delivery.projectId, "acceptance.requested", "acceptance", review.id, input.actor ?? reviewer.id, { deliveryId }));
  }

  reviewAcceptance(acceptanceId: string, input: { reviewerSessionId: string; verdict: "accepted" | "rejected" | "inconclusive"; rationale: string; actor?: string }): AcceptanceReview {
    const review = this.#entity<AcceptanceReview>("acceptance", acceptanceId);
    if (review.status !== "requested") throw new DomainError("CONFLICT", "Acceptance review already has a verdict");
    if (review.reviewerSessionId !== input.reviewerSessionId) throw new DomainError("CONFLICT", "Only the assigned reviewer session can submit a verdict");
    this.#authorize(review.projectId, input.reviewerSessionId, "accept-delivery");
    this.#required(input.rationale, "Acceptance rationale");
    const decided: AcceptanceReview = { ...review, status: input.verdict, verdict: input.rationale, reviewedAt: now() };
    this.store.update("acceptance", review.projectId, decided, this.#event(review.projectId, `delivery.${input.verdict}`, "acceptance", review.id, input.actor ?? input.reviewerSessionId, { deliveryId: review.deliveryId }));
    const item = this.#inProject<WorkItem>("work-item", review.workItemId, review.projectId);
    const status = input.verdict === "accepted" ? "done" : input.verdict === "rejected" ? "active" : "blocked";
    this.store.update("work-item", review.projectId, { ...item, status, updatedAt: now() }, this.#event(review.projectId, "work-item.acceptance-updated", "work-item", item.id, input.actor ?? input.reviewerSessionId, { verdict: input.verdict }));
    return decided;
  }

  listAcceptances(projectId: string): AcceptanceReview[] {
    this.#project(projectId);
    return this.store.list("acceptance", projectId);
  }

  createMeeting(projectId: string, input: {
    objective: string;
    facilitatorSessionId: string;
    workItemId?: string;
    participants: Array<{ roleKey: string; workspaceId: string }>;
    maxRounds?: number;
    actor?: string;
  }): PlanningMeeting {
    this.#project(projectId);
    this.#required(input.objective, "Meeting objective");
    this.#inProject<AgentSession>("session", input.facilitatorSessionId, projectId);
    if (input.workItemId) this.#inProject<WorkItem>("work-item", input.workItemId, projectId);
    if (input.participants.length < 2) throw new DomainError("VALIDATION_ERROR", "A planning meeting needs at least two participants");
    const unique = new Set<string>();
    for (const participant of input.participants) {
      const workspace = this.#inProject<Workspace>("workspace", participant.workspaceId, projectId);
      const role = this.#role(projectId, participant.roleKey);
      const key = `${role.key}:${workspace.id}`;
      if (unique.has(key)) throw new DomainError("CONFLICT", `Duplicate meeting participant '${key}'`);
      if (!role.workspaceKeys.includes("*") && !role.workspaceKeys.includes(workspace.key)) {
        throw new DomainError("CONFLICT", `Role '${role.key}' cannot meet in workspace '${workspace.key}'`);
      }
      unique.add(key);
    }
    const maxRounds = input.maxRounds ?? 2;
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 5) throw new DomainError("VALIDATION_ERROR", "Meeting maxRounds must be between 1 and 5");
    const timestamp = now();
    const meeting: PlanningMeeting = {
      id: id(), projectId, objective: input.objective, facilitatorSessionId: input.facilitatorSessionId,
      workItemId: input.workItemId, participants: input.participants, status: "planned", round: 0,
      maxRounds, createdAt: timestamp, updatedAt: timestamp,
    };
    return this.store.create("meeting", projectId, meeting, this.#event(projectId, "meeting.created", "meeting", meeting.id, input.actor ?? input.facilitatorSessionId, { participants: meeting.participants.length, maxRounds }));
  }

  startMeeting(meetingId: string, bindings: Array<{ roleKey: string; workspaceId: string; sessionId: string }>, actor = "scheduler"): PlanningMeeting {
    const meeting = this.#entity<PlanningMeeting>("meeting", meetingId);
    if (meeting.status !== "planned") throw new DomainError("CONFLICT", "Only a planned meeting can be started");
    const participants = meeting.participants.map((participant) => {
      const binding = bindings.find((candidate) => candidate.roleKey === participant.roleKey && candidate.workspaceId === participant.workspaceId);
      if (!binding) throw new DomainError("VALIDATION_ERROR", `Missing session binding for '${participant.roleKey}'`);
      const session = this.#inProject<AgentSession>("session", binding.sessionId, meeting.projectId);
      if (session.roleKey !== participant.roleKey || session.workspaceId !== participant.workspaceId) throw new DomainError("CONFLICT", "Meeting session does not match participant role and workspace");
      return { ...participant, sessionId: session.id };
    });
    const active: PlanningMeeting = { ...meeting, participants, status: "active", round: 1, updatedAt: now() };
    return this.store.update("meeting", meeting.projectId, active, this.#event(meeting.projectId, "meeting.started", "meeting", meeting.id, actor, { round: 1 }));
  }

  contributeToMeeting(meetingId: string, input: { sessionId: string; kind: MeetingContribution["kind"]; content: string; actor?: string }): MeetingContribution {
    const meeting = this.#entity<PlanningMeeting>("meeting", meetingId);
    if (meeting.status !== "active") throw new DomainError("CONFLICT", "Meeting is not accepting contributions");
    const participant = meeting.participants.find((candidate) => candidate.sessionId === input.sessionId);
    if (!participant) throw new DomainError("CONFLICT", "Session is not a participant in this meeting");
    this.#required(input.content, "Meeting contribution");
    if (this.store.list<MeetingContribution>("meeting-contribution", meeting.projectId).some((candidate) => candidate.meetingId === meeting.id && candidate.round === meeting.round && candidate.sessionId === input.sessionId)) {
      throw new DomainError("CONFLICT", "Session already contributed in this meeting round");
    }
    const contribution: MeetingContribution = { id: id(), projectId: meeting.projectId, meetingId: meeting.id, round: meeting.round, sessionId: input.sessionId, roleKey: participant.roleKey, kind: input.kind, content: input.content, createdAt: now() };
    return this.store.create("meeting-contribution", meeting.projectId, contribution, this.#event(meeting.projectId, "meeting.contribution-added", "meeting-contribution", contribution.id, input.actor ?? input.sessionId, { meetingId, round: meeting.round, kind: input.kind }));
  }

  advanceMeeting(meetingId: string, actor = "scheduler"): PlanningMeeting {
    const meeting = this.#entity<PlanningMeeting>("meeting", meetingId);
    if (meeting.status !== "active") throw new DomainError("CONFLICT", "Meeting is not active");
    const contributions = this.listMeetingContributions(meeting.projectId, meeting.id, meeting.round);
    const contributed = new Set(contributions.map((item) => item.sessionId));
    if (meeting.participants.some((participant) => !participant.sessionId || !contributed.has(participant.sessionId))) {
      throw new DomainError("CONFLICT", "Every participant must contribute before advancing the meeting");
    }
    const next: PlanningMeeting = meeting.round >= meeting.maxRounds
      ? { ...meeting, status: "synthesizing", updatedAt: now() }
      : { ...meeting, round: meeting.round + 1, updatedAt: now() };
    return this.store.update("meeting", meeting.projectId, next, this.#event(meeting.projectId, next.status === "synthesizing" ? "meeting.synthesis-requested" : "meeting.round-advanced", "meeting", meeting.id, actor, { round: next.round }));
  }

  completeMeeting(meetingId: string, input: { facilitatorSessionId: string; synthesis: MeetingSynthesis; actor?: string }): PlanningMeeting {
    const meeting = this.#entity<PlanningMeeting>("meeting", meetingId);
    if (meeting.status !== "synthesizing") throw new DomainError("CONFLICT", "Meeting is not ready for synthesis");
    if (meeting.facilitatorSessionId !== input.facilitatorSessionId) throw new DomainError("CONFLICT", "Only the meeting facilitator can complete it");
    this.#validateMeetingSynthesis(meeting, input.synthesis);
    const completed: PlanningMeeting = { ...meeting, status: "completed", synthesis: input.synthesis, completedAt: now(), updatedAt: now() };
    return this.store.update("meeting", meeting.projectId, completed, this.#event(meeting.projectId, "meeting.completed", "meeting", meeting.id, input.actor ?? input.facilitatorSessionId));
  }

  cancelMeeting(meetingId: string, actor = "scheduler"): PlanningMeeting {
    const meeting = this.#entity<PlanningMeeting>("meeting", meetingId);
    if (meeting.status === "completed" || meeting.status === "cancelled") return meeting;
    const cancelled: PlanningMeeting = { ...meeting, status: "cancelled", updatedAt: now() };
    return this.store.update("meeting", meeting.projectId, cancelled, this.#event(meeting.projectId, "meeting.cancelled", "meeting", meeting.id, actor));
  }

  listMeetings(projectId: string): PlanningMeeting[] {
    this.#project(projectId);
    return this.store.list("meeting", projectId);
  }

  listMeetingContributions(projectId: string, meetingId?: string, round?: number): MeetingContribution[] {
    this.#project(projectId);
    return this.store.list<MeetingContribution>("meeting-contribution", projectId).filter((item) =>
      (!meetingId || item.meetingId === meetingId) && (round === undefined || item.round === round));
  }

  sendMessage(projectId: string, input: { fromSessionId: string; toSessionId: string; content: string; actor?: string }): SessionMessage {
    this.#project(projectId);
    this.#inProject<AgentSession>("session", input.fromSessionId, projectId);
    this.#inProject<AgentSession>("session", input.toSessionId, projectId);
    this.#required(input.content, "Message content");
    const message: SessionMessage = { id: id(), projectId, fromSessionId: input.fromSessionId, toSessionId: input.toSessionId, content: input.content, createdAt: now() };
    return this.store.create("message", projectId, message, this.#event(projectId, "message.sent", "message", message.id, input.actor ?? input.fromSessionId, { fromSessionId: message.fromSessionId, toSessionId: message.toSessionId }));
  }

  listMessages(projectId: string, sessionId?: string): SessionMessage[] {
    this.#project(projectId);
    const messages = this.store.list<SessionMessage>("message", projectId);
    return sessionId ? messages.filter((message) => message.fromSessionId === sessionId || message.toSessionId === sessionId) : messages;
  }

  addContextNote(projectId: string, input: { sessionId?: string; workItemId?: string; meetingId?: string; kind?: ContextNote["kind"]; author?: string; content: string }): ContextNote {
    this.#project(projectId);
    if (!input.sessionId && !input.workItemId && !input.meetingId) throw new DomainError("VALIDATION_ERROR", "A context note needs a sessionId, workItemId or meetingId target");
    if (input.sessionId) this.#inProject<AgentSession>("session", input.sessionId, projectId);
    if (input.workItemId) this.#inProject<WorkItem>("work-item", input.workItemId, projectId);
    if (input.meetingId) {
      const meeting = this.#inProject<PlanningMeeting>("meeting", input.meetingId, projectId);
      if (meeting.status === "completed" || meeting.status === "cancelled") throw new DomainError("CONFLICT", "Cannot add context to a closed meeting");
    }
    this.#required(input.content, "Context note content");
    const note: ContextNote = { id: id(), projectId, sessionId: input.sessionId, workItemId: input.workItemId, meetingId: input.meetingId, kind: input.kind ?? "context", author: input.author ?? "human", content: input.content, createdAt: now() };
    return this.store.create("context-note", projectId, note, this.#event(projectId, "context-note.added", "context-note", note.id, note.author, { sessionId: note.sessionId, workItemId: note.workItemId, meetingId: note.meetingId }));
  }

  listContextNotes(projectId: string, input: { sessionId?: string; workItemId?: string; meetingId?: string } = {}): ContextNote[] {
    this.#project(projectId);
    return this.store.list<ContextNote>("context-note", projectId).filter((note) =>
      (!input.sessionId || note.sessionId === input.sessionId) && (!input.workItemId || note.workItemId === input.workItemId) && (!input.meetingId || note.meetingId === input.meetingId));
  }

  contextForSession(projectId: string, sessionId: string) {
    const session = this.#inProject<AgentSession>("session", sessionId, projectId);
    const allSessions = this.listSessions(projectId);
    const allWorkItems = this.listWorkItems(projectId);
    const allDelegations = this.listDelegations(projectId);
    const meetings = this.listMeetings(projectId).filter((meeting) =>
      meeting.status !== "completed" && meeting.status !== "cancelled" &&
      (meeting.facilitatorSessionId === session.id || meeting.participants.some((participant) => participant.sessionId === session.id)));
    const activeMeetingIds = new Set(meetings.map((meeting) => meeting.id));
    const meetingIds = new Set(meetings.map((meeting) => meeting.id));
    const relatedSessionIds = new Set<string>([
      session.id,
      ...allSessions.filter((candidate) => candidate.coordinatorId === session.id && ["active", "waiting", "unknown"].includes(candidate.status)).map((candidate) => candidate.id),
      ...meetings.flatMap((meeting) => [meeting.facilitatorSessionId, ...meeting.participants.flatMap((participant) => participant.sessionId ? [participant.sessionId] : [])]),
    ]);
    const delegations = allDelegations.filter((delegation) =>
      delegation.id === session.delegationId || (delegation.sessionId && relatedSessionIds.has(delegation.sessionId)));
    const workItemIds = new Set<string>([
      ...delegations.map((delegation) => delegation.workItemId),
      ...meetings.flatMap((meeting) => meeting.workItemId ? [meeting.workItemId] : []),
    ]);
    if (!session.delegationId && !session.meetingId) {
      for (const item of allWorkItems) if (item.status !== "done") workItemIds.add(item.id);
    }
    const workById = new Map(allWorkItems.map((item) => [item.id, item]));
    for (const workItemId of [...workItemIds]) {
      let parentId = workById.get(workItemId)?.parentId;
      while (parentId) {
        workItemIds.add(parentId);
        parentId = workById.get(parentId)?.parentId;
      }
    }
    const archivedMeetings = this.listMeetings(projectId).filter((meeting) =>
      meeting.status === "completed" && meeting.workItemId && workItemIds.has(meeting.workItemId)).slice(-3);
    meetings.push(...archivedMeetings);
    for (const meeting of archivedMeetings) meetingIds.add(meeting.id);
    const contextNotes = this.listContextNotes(projectId).filter((note) =>
      note.sessionId === session.id || (note.workItemId && workItemIds.has(note.workItemId)) || (note.meetingId && meetingIds.has(note.meetingId)));
    const messages = this.listMessages(projectId, session.id);
    const contributionList = this.listMeetingContributions(projectId).filter((contribution) => activeMeetingIds.has(contribution.meetingId));
    return {
      currentSession: session,
      workItems: allWorkItems.filter((item) => workItemIds.has(item.id)),
      delegations,
      sessions: allSessions.filter((candidate) => relatedSessionIds.has(candidate.id)),
      activeLeases: this.listLeases(projectId).filter((lease) => delegations.some((delegation) => delegation.id === lease.delegationId) && (lease.status === "requested" || lease.status === "active")),
      handoffs: this.listHandoffs(projectId).filter((handoff) => (handoff.status === "offered" || handoff.status === "acknowledged") && (delegations.some((delegation) => delegation.id === handoff.delegationId) || handoff.fromSessionId === session.id || handoff.toRoleKey === session.roleKey)),
      interventions: this.listInterventions(projectId, "open").filter((intervention) => intervention.requesterSessionId === session.id || intervention.assignedSessionId === session.id || intervention.targetRoleKey === session.roleKey),
      acceptances: this.listAcceptances(projectId).filter((acceptance) => workItemIds.has(acceptance.workItemId)),
      messages: messages.slice(-20),
      omittedMessages: Math.max(0, messages.length - 20),
      contextNotes: contextNotes.slice(-20),
      omittedContextNotes: Math.max(0, contextNotes.length - 20),
      meetings,
      meetingContributions: contributionList,
    };
  }

  markContextNoteDelivered(noteId: string, actor = "scheduler"): ContextNote {
    const note = this.#entity<ContextNote>("context-note", noteId);
    if (note.deliveredAt) return note;
    const delivered: ContextNote = { ...note, deliveredAt: now() };
    return this.store.update("context-note", note.projectId, delivered, this.#event(note.projectId, "context-note.delivered", "context-note", note.id, actor, { sessionId: note.sessionId }));
  }

  openIntervention(projectId: string, input: {
    requesterSessionId: string;
    target: "human" | "role";
    targetRoleKey?: string;
    message: string;
    actor?: string;
  }): Intervention {
    this.#project(projectId);
    this.#inProject<AgentSession>("session", input.requesterSessionId, projectId);
    this.#required(input.message, "Intervention message");
    if (input.target === "role" && !input.targetRoleKey) throw new DomainError("VALIDATION_ERROR", "targetRoleKey is required for a role intervention");
    if (input.target === "human" && input.targetRoleKey) throw new DomainError("VALIDATION_ERROR", "targetRoleKey is only valid for a role intervention");
    if (input.targetRoleKey) this.#role(projectId, input.targetRoleKey);
    const intervention: Intervention = { id: id(), projectId, requesterSessionId: input.requesterSessionId, target: input.target, targetRoleKey: input.targetRoleKey, message: input.message, status: "open", createdAt: now() };
    return this.store.create("intervention", projectId, intervention, this.#event(projectId, "intervention.opened", "intervention", intervention.id, input.actor ?? input.requesterSessionId, { target: intervention.target, targetRoleKey: intervention.targetRoleKey }));
  }

  listInterventions(projectId: string, status?: "open" | "resolved"): Intervention[] {
    this.#project(projectId);
    const interventions = this.store.list<Intervention>("intervention", projectId);
    return status ? interventions.filter((intervention) => intervention.status === status) : interventions;
  }

  assignIntervention(interventionId: string, input: { sessionId: string; actor?: string }): Intervention {
    const intervention = this.#entity<Intervention>("intervention", interventionId);
    if (intervention.status !== "open") throw new DomainError("CONFLICT", "Only an open intervention can be assigned");
    const session = this.#inProject<AgentSession>("session", input.sessionId, intervention.projectId);
    if (intervention.target === "human") throw new DomainError("CONFLICT", "A human intervention cannot be assigned to an agent session");
    if (session.roleKey !== intervention.targetRoleKey) throw new DomainError("CONFLICT", "Session role does not match intervention target role");
    const assigned: Intervention = { ...intervention, assignedSessionId: session.id };
    return this.store.update("intervention", intervention.projectId, assigned, this.#event(intervention.projectId, "intervention.assigned", "intervention", intervention.id, input.actor, { sessionId: session.id }));
  }

  resolveIntervention(interventionId: string, input: { resolution: string; assignedSessionId?: string; actor?: string }): Intervention {
    const intervention = this.#entity<Intervention>("intervention", interventionId);
    if (intervention.status === "resolved") throw new DomainError("CONFLICT", "Intervention is already resolved");
    this.#required(input.resolution, "Resolution");
    if (input.assignedSessionId && intervention.assignedSessionId && input.assignedSessionId !== intervention.assignedSessionId) {
      throw new DomainError("CONFLICT", "Intervention is assigned to another session");
    }
    if (input.assignedSessionId) this.#inProject<AgentSession>("session", input.assignedSessionId, intervention.projectId);
    const updated: Intervention = { ...intervention, assignedSessionId: intervention.assignedSessionId ?? input.assignedSessionId, resolution: input.resolution, status: "resolved", resolvedAt: now() };
    return this.store.update("intervention", intervention.projectId, updated, this.#event(intervention.projectId, "intervention.resolved", "intervention", intervention.id, input.actor, { assignedSessionId: input.assignedSessionId }));
  }

  events(projectId: string, after = 0): DomainEvent[] {
    this.#project(projectId);
    return this.store.events(projectId, after);
  }

  #project(projectId: string): Project {
    return this.#entity("project", projectId);
  }

  #role(projectId: string, key: string): Role {
    const role = this.store.list<Role>("role", projectId).find((candidate) => candidate.key === key);
    if (!role) throw new DomainError("NOT_FOUND", `Role '${key}' does not exist`);
    return role;
  }

  #entity<T>(kind: Parameters<SqliteStore["get"]>[0], entityId: string): T {
    const entity = this.store.get<T>(kind, entityId);
    if (!entity) throw new DomainError("NOT_FOUND", `${kind} '${entityId}' does not exist`);
    return entity;
  }

  #inProject<T extends { projectId: string }>(kind: Parameters<SqliteStore["get"]>[0], entityId: string, projectId: string): T {
    const entity = this.#entity<T>(kind, entityId);
    if (entity.projectId !== projectId) throw new DomainError("NOT_FOUND", `${kind} '${entityId}' does not exist in project`);
    return entity;
  }

  #validateMeetingSynthesis(meeting: PlanningMeeting, synthesis: MeetingSynthesis): void {
    this.#required(synthesis.featureBrief, "Feature brief");
    if (!synthesis.decisions.length || !synthesis.milestones.length || !synthesis.epics.length || !synthesis.issues.length) {
      throw new DomainError("VALIDATION_ERROR", "Meeting synthesis needs decisions, milestones, epics and issues");
    }
    for (const decision of synthesis.decisions) this.#required(decision, "Meeting decision");
    for (const question of synthesis.openQuestions) this.#required(question, "Open question");
    const milestones = new Set(synthesis.milestones.map((item) => item.title));
    const epics = new Set(synthesis.epics.map((item) => item.title));
    if (milestones.size !== synthesis.milestones.length) throw new DomainError("VALIDATION_ERROR", "Milestone titles must be unique");
    if (epics.size !== synthesis.epics.length) throw new DomainError("VALIDATION_ERROR", "Epic titles must be unique");
    if (new Set(synthesis.issues.map((item) => item.title)).size !== synthesis.issues.length) throw new DomainError("VALIDATION_ERROR", "Issue titles must be unique");
    for (const item of synthesis.milestones) {
      this.#required(item.title, "Milestone title");
      this.#required(item.outcome, "Milestone outcome");
    }
    for (const item of synthesis.epics) {
      this.#required(item.title, "Epic title");
      this.#required(item.outcome, "Epic outcome");
      if (!milestones.has(item.milestone)) throw new DomainError("VALIDATION_ERROR", `Epic '${item.title}' references an unknown milestone`);
    }
    for (const item of synthesis.issues) {
      this.#required(item.title, "Issue title");
      this.#required(item.outcome, "Issue outcome");
      if (!epics.has(item.epic)) throw new DomainError("VALIDATION_ERROR", `Issue '${item.title}' references an unknown epic`);
      this.#role(meeting.projectId, item.ownerRoleKey);
      if (!item.acceptanceGates.length || item.acceptanceGates.some((gate) => !gate.trim())) throw new DomainError("VALIDATION_ERROR", `Issue '${item.title}' needs concrete acceptance gates`);
    }
  }

  #required(value: string, label: string): void {
    if (!value.trim()) throw new DomainError("VALIDATION_ERROR", `${label} cannot be empty`);
  }

  #authorize(projectId: string, sessionId: string | undefined, capability: string): void {
    if (!sessionId) return;
    const session = this.#inProject<AgentSession>("session", sessionId, projectId);
    const role = this.#role(projectId, session.roleKey);
    if (!role.capabilities.includes(capability)) {
      throw new DomainError("CONFLICT", `Role '${role.key}' lacks capability '${capability}'`);
    }
  }

  #event(projectId: string, type: string, aggregateKind: Parameters<SqliteStore["get"]>[0], aggregateId: string, actor = "human", payload: Record<string, unknown> = {}) {
    return { projectId, type, aggregateKind, aggregateId, actor, payload };
  }
}
