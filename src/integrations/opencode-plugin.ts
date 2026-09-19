import { type Plugin, tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin";
import { ControlPlane } from "../application/control-plane.ts";
import type { AgentSession } from "../domain/types.ts";
import { SqliteStore } from "../infrastructure/sqlite-store.ts";
import { readLocalConfig, resolveDatabase } from "../config/local-config.ts";
import { OpenCodeScheduler, OpenCodeSdkRuntime } from "../scheduler/opencode-scheduler.ts";

interface ToolDefaults {
  projectId?: string;
  directory: string;
  rootDirectory?: string;
}

const projectArg = { projectId: tool.schema.string().optional().describe("Control plane project id; defaults to .linear-crew.json") };

function json(value: unknown, title = "Linear Crew"): { title: string; output: string; metadata: { linearCrew: boolean } } {
  return { title, output: JSON.stringify(value, null, 2), metadata: { linearCrew: true } };
}

function projectId(input: { projectId?: string }, defaults: ToolDefaults): string {
  const value = input.projectId ?? defaults.projectId;
  if (!value) throw new Error("projectId is required; configure it in .linear-crew.json or pass it to the tool");
  return value;
}

function runtimeSession(controlPlane: ControlPlane, project: string, context: ToolContext): AgentSession {
  const session = controlPlane.listSessions(project).find((candidate) => candidate.runtimeSessionId === context.sessionID);
  if (!session) throw new Error("Current OpenCode session is not registered; call crew_register_session first");
  return session;
}

export function assertSessionCanWrite(controlPlane: ControlPlane, project: string, runtimeSessionId: string): void {
  const session = controlPlane.listSessions(project).find((candidate) => candidate.runtimeSessionId === runtimeSessionId);
  if (session?.meetingId) throw new Error(`Planning meeting ${session.meetingId} is analysis-only and cannot modify files`);
  if (!session?.delegationId) return;
  const delegation = controlPlane.getDelegation(session.delegationId);
  if (delegation.intent !== "implementation") {
    throw new Error(`Delegation ${delegation.id} is ${delegation.intent} and cannot modify files`);
  }
  const lease = controlPlane.listLeases(project).find((candidate) =>
    candidate.sessionId === session.id && candidate.workspaceId === delegation.workspaceId && candidate.status === "active" && Date.parse(candidate.expiresAt) > Date.now());
  if (!lease) throw new Error(`Delegation ${delegation.id} needs an active write lease before modifying files`);
}

export function createLinearCrewTools(controlPlane: ControlPlane, defaults: ToolDefaults, scheduler?: OpenCodeScheduler): Record<string, ToolDefinition> {
  const tools: Record<string, ToolDefinition> = {
    crew_guide: tool({
      description: "Learn what Linear Crew does, how this project is configured, which tools exist and the required implementation workflow. Call this first when unfamiliar with the project.",
      args: { ...projectArg },
      async execute(args) {
        return json(controlPlane.projectGuide(projectId(args, defaults)), "Linear Crew project guide");
      },
    }),
    crew_context: tool({
      description: "Read curated product context scoped to this session's delegation or planning meeting. Operational telemetry is intentionally excluded.",
      args: { ...projectArg },
      async execute(args, context) {
        const project = projectId(args, defaults);
        const session = controlPlane.listSessions(project).find((candidate) => candidate.runtimeSessionId === context.sessionID);
        if (!session) return json({ currentSession: null, roles: controlPlane.listRoles(project), workspaces: controlPlane.listWorkspaces(project), instruction: "Call crew_register_session before requesting scoped context." }, "Crew bootstrap context");
        return json(controlPlane.contextForSession(project, session.id), "Curated crew context");
      },
    }),
    crew_context_history: tool({
      description: "Explicitly inspect older durable product context for one session, work item or planning meeting without adding it to the default prompt.",
      args: {
        ...projectArg,
        sessionId: tool.schema.string().optional(),
        workItemId: tool.schema.string().optional(),
        meetingId: tool.schema.string().optional(),
        offset: tool.schema.number().int().min(0).default(0),
        limit: tool.schema.number().int().min(1).max(100).default(20),
      },
      async execute(args) {
        const project = projectId(args, defaults);
        const targets = [args.sessionId, args.workItemId, args.meetingId].filter(Boolean);
        if (targets.length !== 1) throw new Error("Choose exactly one sessionId, workItemId or meetingId");
        const notes = controlPlane.listContextNotes(project, { sessionId: args.sessionId, workItemId: args.workItemId, meetingId: args.meetingId });
        const messages = args.sessionId ? controlPlane.listMessages(project, args.sessionId) : [];
        return json({
          totalNotes: notes.length,
          notes: notes.slice(args.offset, args.offset + args.limit),
          totalMessages: messages.length,
          messages: messages.slice(args.offset, args.offset + args.limit),
          meeting: args.meetingId ? controlPlane.getMeeting(args.meetingId) : undefined,
          meetingContributions: args.meetingId ? controlPlane.listMeetingContributions(project, args.meetingId) : undefined,
        }, "Crew context history");
      },
    }),
    crew_operational_context: tool({
      description: "Inspect recent session, lease, intervention and event telemetry explicitly. Use for runtime diagnosis, not product decisions.",
      args: { ...projectArg, limit: tool.schema.number().int().min(1).max(100).default(30) },
      async execute(args, context) {
        const project = projectId(args, defaults);
        const session = runtimeSession(controlPlane, project, context);
        const sessions = controlPlane.listSessions(project).filter((candidate) => candidate.id === session.id || candidate.coordinatorId === session.id);
        const sessionIds = new Set(sessions.map((candidate) => candidate.id));
        return json({
          sessions,
          leases: controlPlane.listLeases(project).filter((lease) => sessionIds.has(lease.sessionId)),
          interventions: controlPlane.listInterventions(project).filter((intervention) => sessionIds.has(intervention.requesterSessionId) || (intervention.assignedSessionId && sessionIds.has(intervention.assignedSessionId))),
          recentEvents: controlPlane.events(project).slice(-args.limit),
        }, "Crew operational context");
      },
    }),
    crew_register_session: tool({
      description: "Register the current OpenCode session as a durable Linear Crew session. Reuses an existing runtime binding when present.",
      args: {
        ...projectArg,
        roleKey: tool.schema.string().min(1),
        coordinatorId: tool.schema.string().optional(),
        workspaceId: tool.schema.string().optional().describe("Workspace UUID or stable key"),
        delegationId: tool.schema.string().optional(),
      },
      async execute(args, context) {
        const project = projectId(args, defaults);
        const existing = controlPlane.listSessions(project).find((candidate) => candidate.runtimeSessionId === context.sessionID);
        if (existing) return json(existing, "Session already registered");
        const workspaces = controlPlane.listWorkspaces(project);
        const requestedWorkspace = args.workspaceId
          ? workspaces.find((workspace) => workspace.id === args.workspaceId || workspace.key === args.workspaceId)
          : undefined;
        if (args.workspaceId && !requestedWorkspace) throw new Error(`Workspace '${args.workspaceId}' does not exist in project '${project}'`);
        const inferredWorkspace = workspaces.find((workspace) => {
          if (!defaults.rootDirectory) return false;
          const expected = `${defaults.rootDirectory.replace(/[\\/]$/, "")}/${workspace.path === "." ? "" : workspace.path}`.replaceAll("\\", "/").replace(/\/$/, "");
          return expected.toLowerCase() === context.directory.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
        });
        return json(controlPlane.startSession(project, {
          roleKey: args.roleKey,
          agent: context.agent,
          coordinatorId: args.coordinatorId,
          workspaceId: requestedWorkspace?.id ?? inferredWorkspace?.id,
          delegationId: args.delegationId,
          runtimeSessionId: context.sessionID,
          actor: `opencode:${context.sessionID}`,
        }), "Session registered");
      },
    }),
    crew_create_work: tool({
      description: "Create a durable milestone, epic, issue or task. Use one work item per outcome; role changes use delegations or handoffs.",
      args: {
        ...projectArg,
        type: tool.schema.enum(["milestone", "epic", "issue", "task"]),
        title: tool.schema.string().min(1),
        outcome: tool.schema.string().min(1),
        description: tool.schema.string().optional(),
        parentId: tool.schema.string().optional(),
        assigneeRoleKey: tool.schema.string().optional(),
        workflowId: tool.schema.string().optional(),
      },
      async execute(args, context) {
        const project = projectId(args, defaults);
        return json(controlPlane.createWorkItem(project, { ...args, actor: `opencode:${context.sessionID}` }), "Work item created");
      },
    }),
    crew_create_delegation: tool({
      description: "Delegate one bounded responsibility, anchored to a work outcome revision, workspace and role.",
      args: {
        ...projectArg,
        workItemId: tool.schema.string(),
        workspaceId: tool.schema.string(),
        roleKey: tool.schema.string(),
        intent: tool.schema.enum(["implementation", "diagnosis", "review"]),
        instructions: tool.schema.string().min(1),
      },
      async execute(args, context) {
        const project = projectId(args, defaults);
        return json(controlPlane.createDelegation(project, { ...args, actor: `opencode:${context.sessionID}` }), "Delegation created");
      },
    }),
    crew_request_lease: tool({
      description: "Request an exclusive write lease for the workspace of the current implementation delegation.",
      args: { ...projectArg, delegationId: tool.schema.string(), ttlMinutes: tool.schema.number().int().min(1).max(1440).optional() },
      async execute(args, context) {
        const project = projectId(args, defaults);
        const session = runtimeSession(controlPlane, project, context);
        return json(controlPlane.requestLease(args.delegationId, { sessionId: session.id, ttlMinutes: args.ttlMinutes, actor: session.id }), "Lease requested");
      },
    }),
    crew_grant_lease: tool({
      description: "Grant a requested write lease. The current session role must have the grant-lease capability.",
      args: { ...projectArg, leaseId: tool.schema.string() },
      async execute(args, context) {
        const project = projectId(args, defaults);
        const session = runtimeSession(controlPlane, project, context);
        return json(controlPlane.grantLease(args.leaseId, { actorSessionId: session.id, actor: session.id }), "Lease granted");
      },
    }),
    crew_release_lease: tool({
      description: "Release a write lease held by the current OpenCode session.",
      args: { ...projectArg, leaseId: tool.schema.string() },
      async execute(args, context) {
        const project = projectId(args, defaults);
        const session = runtimeSession(controlPlane, project, context);
        return json(controlPlane.releaseLease(args.leaseId, { sessionId: session.id, actor: session.id }), "Lease released");
      },
    }),
    crew_send_message: tool({
      description: "Send context directly from the current OpenCode session to another durable agent session without PO relay.",
      args: { ...projectArg, toSessionId: tool.schema.string(), content: tool.schema.string().min(1) },
      async execute(args, context) {
        const project = projectId(args, defaults);
        const session = runtimeSession(controlPlane, project, context);
        const message = controlPlane.sendMessage(project, { fromSessionId: session.id, toSessionId: args.toSessionId, content: args.content, actor: session.id });
        if (scheduler) await scheduler.notifySession(args.toSessionId, `Linear Crew message from session ${session.id}: ${args.content}\nCall crew_context before responding.`);
        return json(message, "Message sent");
      },
    }),
    crew_open_intervention: tool({
      description: "Request human or role intervention without ending the current OpenCode session.",
      args: { ...projectArg, target: tool.schema.enum(["human", "role"]), targetRoleKey: tool.schema.string().optional(), message: tool.schema.string().min(1) },
      async execute(args, context) {
        const project = projectId(args, defaults);
        const session = runtimeSession(controlPlane, project, context);
        return json(controlPlane.openIntervention(project, { requesterSessionId: session.id, target: args.target, targetRoleKey: args.targetRoleKey, message: args.message, actor: session.id }), "Intervention opened");
      },
    }),
    crew_assign_intervention: tool({
      description: "Assign a pending role intervention to a compatible active session.",
      args: { ...projectArg, interventionId: tool.schema.string(), sessionId: tool.schema.string() },
      async execute(args, context) {
        projectId(args, defaults);
        const intervention = controlPlane.assignIntervention(args.interventionId, { sessionId: args.sessionId, actor: `opencode:${context.sessionID}` });
        if (scheduler) await scheduler.notifySession(args.sessionId, `Linear Crew intervention assigned: ${intervention.message}\nCall crew_context and respond directly to requester session ${intervention.requesterSessionId}.`);
        return json(intervention, "Intervention assigned");
      },
    }),
    crew_resolve_intervention: tool({
      description: "Resolve an intervention after the answer has been communicated to its requester.",
      args: { ...projectArg, interventionId: tool.schema.string(), resolution: tool.schema.string().min(1) },
      async execute(args, context) {
        const project = projectId(args, defaults);
        const session = runtimeSession(controlPlane, project, context);
        return json(controlPlane.resolveIntervention(args.interventionId, { resolution: args.resolution, assignedSessionId: session.id, actor: session.id }), "Intervention resolved");
      },
    }),
    crew_offer_handoff: tool({
      description: "Offer a structured handoff from the current delegated session to another role.",
      args: {
        ...projectArg,
        delegationId: tool.schema.string(),
        toRoleKey: tool.schema.string(),
        continuationSessionId: tool.schema.string().optional(),
        context: tool.schema.string().min(1),
        impact: tool.schema.string(),
        nextAction: tool.schema.string().min(1),
        blockingCondition: tool.schema.string().optional(),
        evidenceIds: tool.schema.array(tool.schema.string()).optional(),
      },
      async execute(args, context) {
        const project = projectId(args, defaults);
        const session = runtimeSession(controlPlane, project, context);
        return json(controlPlane.offerHandoff(project, { ...args, fromSessionId: session.id, actor: session.id }), "Handoff offered");
      },
    }),
    crew_respond_handoff: tool({
      description: "Acknowledge or reject a handoff addressed to the current session role.",
      args: { ...projectArg, handoffId: tool.schema.string(), response: tool.schema.enum(["acknowledge", "reject"]), reason: tool.schema.string().optional() },
      async execute(args, context) {
        const project = projectId(args, defaults);
        const session = runtimeSession(controlPlane, project, context);
        const handoff = args.response === "acknowledge"
          ? controlPlane.acknowledgeHandoff(args.handoffId, { sessionId: session.id, actor: session.id })
          : controlPlane.rejectHandoff(args.handoffId, { sessionId: session.id, reason: args.reason ?? "Handoff rejected", actor: session.id });
        return json(handoff, `Handoff ${args.response}d`);
      },
    }),
    crew_attach_evidence: tool({
      description: "Attach verifiable evidence produced by the current session to a work item.",
      args: { ...projectArg, workItemId: tool.schema.string(), kind: tool.schema.enum(["test", "review", "artifact", "commit", "note"]), summary: tool.schema.string().min(1), reference: tool.schema.string().optional() },
      async execute(args, context) {
        const project = projectId(args, defaults);
        const session = runtimeSession(controlPlane, project, context);
        return json(controlPlane.attachEvidence(project, { ...args, sessionId: session.id, actor: session.id }), "Evidence attached");
      },
    }),
    crew_complete_delivery: tool({
      description: "Create an immutable delivery revision from evidence produced for a work item.",
      args: { ...projectArg, workItemId: tool.schema.string(), evidenceIds: tool.schema.array(tool.schema.string()).min(1), summary: tool.schema.string().min(1) },
      async execute(args, context) {
        const project = projectId(args, defaults);
        const session = runtimeSession(controlPlane, project, context);
        return json(controlPlane.completeDelivery(project, { ...args, sessionId: session.id, actor: session.id }), "Delivery completed");
      },
    }),
    crew_request_acceptance: tool({
      description: "Request independent acceptance of a concrete delivery revision by a reviewer session.",
      args: { ...projectArg, deliveryId: tool.schema.string(), reviewerSessionId: tool.schema.string() },
      async execute(args, context) {
        projectId(args, defaults);
        return json(controlPlane.requestAcceptance(args.deliveryId, { reviewerSessionId: args.reviewerSessionId, actor: `opencode:${context.sessionID}` }), "Acceptance requested");
      },
    }),
    crew_review_acceptance: tool({
      description: "Submit the independent acceptance verdict assigned to the current reviewer session.",
      args: { ...projectArg, acceptanceId: tool.schema.string(), verdict: tool.schema.enum(["accepted", "rejected", "inconclusive"]), rationale: tool.schema.string().min(1) },
      async execute(args, context) {
        const project = projectId(args, defaults);
        const session = runtimeSession(controlPlane, project, context);
        return json(controlPlane.reviewAcceptance(args.acceptanceId, { reviewerSessionId: session.id, verdict: args.verdict, rationale: args.rationale, actor: session.id }), "Acceptance reviewed");
      },
    }),
  };
  if (scheduler) {
    tools.crew_meeting_create = tool({
      description: "Create a durable multi-role planning meeting with explicit role and context-root participants.",
      args: {
        ...projectArg,
        objective: tool.schema.string().min(1),
        workItemId: tool.schema.string().optional(),
        maxRounds: tool.schema.number().int().min(1).max(5).optional(),
        participants: tool.schema.array(tool.schema.object({ roleKey: tool.schema.string(), workspaceId: tool.schema.string() })).min(2).max(10),
      },
      async execute(args, context) {
        const project = projectId(args, defaults);
        const facilitator = runtimeSession(controlPlane, project, context);
        return json(controlPlane.createMeeting(project, { ...args, facilitatorSessionId: facilitator.id, actor: facilitator.id }), "Planning meeting created");
      },
    });
    tools.crew_meeting_start = tool({
      description: "Start all participant sessions for a planning meeting concurrently in their own context roots.",
      args: { ...projectArg, meetingId: tool.schema.string() },
      async execute(args) {
        projectId(args, defaults);
        return json(await scheduler.startMeeting(args.meetingId), "Planning meeting started");
      },
    });
    tools.crew_meeting_contribute = tool({
      description: "Submit this participant's proposal, critique, question or decision for the active meeting round.",
      args: { ...projectArg, meetingId: tool.schema.string(), kind: tool.schema.enum(["proposal", "critique", "question", "decision"]), content: tool.schema.string().min(1) },
      async execute(args, context) {
        const project = projectId(args, defaults);
        const session = runtimeSession(controlPlane, project, context);
        return json(await scheduler.contributeToMeeting(args.meetingId, { sessionId: session.id, kind: args.kind, content: args.content }), "Meeting contribution recorded");
      },
    });
    tools.crew_meeting_complete = tool({
      description: "Complete a synthesized planning meeting. Only its facilitator can publish the final feature brief.",
      args: {
        ...projectArg,
        meetingId: tool.schema.string(),
        synthesis: tool.schema.object({
          featureBrief: tool.schema.string().min(1),
          decisions: tool.schema.array(tool.schema.string().min(1)).min(1),
          openQuestions: tool.schema.array(tool.schema.string().min(1)),
          milestones: tool.schema.array(tool.schema.object({ title: tool.schema.string().min(1), outcome: tool.schema.string().min(1) })).min(1),
          epics: tool.schema.array(tool.schema.object({ title: tool.schema.string().min(1), outcome: tool.schema.string().min(1), milestone: tool.schema.string().min(1) })).min(1),
          issues: tool.schema.array(tool.schema.object({ title: tool.schema.string().min(1), outcome: tool.schema.string().min(1), epic: tool.schema.string().min(1), ownerRoleKey: tool.schema.string().min(1), acceptanceGates: tool.schema.array(tool.schema.string().min(1)).min(1) })).min(1),
        }),
      },
      async execute(args, context) {
        const project = projectId(args, defaults);
        const facilitator = runtimeSession(controlPlane, project, context);
        return json(await scheduler.completeMeeting(args.meetingId, { facilitatorSessionId: facilitator.id, synthesis: args.synthesis }), "Planning meeting completed");
      },
    });
    tools.crew_start_delegation = tool({
      description: "Start a primary OpenCode session in the exact context root configured for a delegation.",
      args: { ...projectArg, delegationId: tool.schema.string() },
      async execute(args, context) {
        const project = projectId(args, defaults);
        const coordinator = runtimeSession(controlPlane, project, context);
        return json(await scheduler.startDelegation(args.delegationId, coordinator.id), "Delegation started");
      },
    });
    tools.crew_continue_delegation = tool({
      description: "Continue the durable OpenCode session already bound to a delegation with a delta prompt.",
      args: { ...projectArg, delegationId: tool.schema.string(), prompt: tool.schema.string().min(1) },
      async execute(args) {
        projectId(args, defaults);
        return json(await scheduler.continueDelegation(args.delegationId, args.prompt), "Delegation continued");
      },
    });
    tools.crew_start_delegations = tool({
      description: "Start between 2 and 10 independent delegated sessions concurrently in their configured context roots. Write access remains serialized by workspace leases.",
      args: { ...projectArg, delegationIds: tool.schema.array(tool.schema.string()).min(2).max(10) },
      async execute(args, context) {
        const project = projectId(args, defaults);
        const coordinator = runtimeSession(controlPlane, project, context);
        const unique = [...new Set(args.delegationIds)];
        if (unique.length !== args.delegationIds.length) throw new Error("delegationIds must be unique");
        return json(await Promise.all(unique.map((delegationId) => scheduler.startDelegation(delegationId, coordinator.id))), "Delegations started");
      },
    });
    tools.crew_reconcile_sessions = tool({
      description: "Reconcile OpenCode runtime states and notify coordinators when delegated sessions become idle.",
      args: { ...projectArg },
      async execute(args) {
        return json(await scheduler.reconcile(projectId(args, defaults)), "Sessions reconciled");
      },
    });
  }
  return tools;
}

export const LinearCrewPlugin: Plugin = async ({ worktree, directory, serverUrl }) => {
  const config = await readLocalConfig(worktree);
  const rootDirectory = config?.rootDirectory ?? worktree;
  const absoluteDatabase = config ? resolveDatabase(config) : (Bun.env.LINEAR_CREW_DB ?? `${worktree.replace(/[\\/]$/, "")}/linear-crew.sqlite`);
  const store = new SqliteStore(absoluteDatabase);
  const controlPlane = new ControlPlane(store);
  const defaults = { projectId: config?.projectId ?? Bun.env.LINEAR_CREW_PROJECT_ID, directory, rootDirectory };
  const scheduler = new OpenCodeScheduler(controlPlane, new OpenCodeSdkRuntime(serverUrl.toString()), rootDirectory);

  return {
    tool: createLinearCrewTools(controlPlane, defaults, scheduler),
    "tool.execute.before": async (input) => {
      if (!defaults.projectId || !["edit", "write", "apply_patch"].includes(input.tool)) return;
      assertSessionCanWrite(controlPlane, defaults.projectId, input.sessionID);
    },
    "experimental.session.compacting": async ({ sessionID }, output) => {
      if (!defaults.projectId) return;
      const session = controlPlane.listSessions(defaults.projectId).find((candidate) => candidate.runtimeSessionId === sessionID);
      if (!session) return;
      output.context.push(`Linear Crew curated durable context:\n${JSON.stringify(controlPlane.contextForSession(defaults.projectId, session.id), null, 2)}`);
    },
    dispose: async () => store.close(),
  };
};

export default LinearCrewPlugin;
