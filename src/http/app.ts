import { Elysia, t } from "elysia";
import { ControlPlane, DomainError } from "../application/control-plane.ts";

const actor = { actor: t.Optional(t.String()) };
const workItemType = t.Union([t.Literal("milestone"), t.Literal("epic"), t.Literal("issue"), t.Literal("task")]);
const meetingSynthesis = t.Object({
  featureBrief: t.String(),
  decisions: t.Array(t.String(), { minItems: 1 }),
  openQuestions: t.Array(t.String()),
  milestones: t.Array(t.Object({ title: t.String(), outcome: t.String() }), { minItems: 1 }),
  epics: t.Array(t.Object({ title: t.String(), outcome: t.String(), milestone: t.String() }), { minItems: 1 }),
  issues: t.Array(t.Object({ title: t.String(), outcome: t.String(), epic: t.String(), ownerRoleKey: t.String(), acceptanceGates: t.Array(t.String(), { minItems: 1 }) }), { minItems: 1 }),
});

export function createHttpApp(controlPlane: ControlPlane) {
  return new Elysia({ name: "linear-crew" })
    .error(DomainError, ({ error, status }) => {
      const code = error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : 400;
      return status(code, { error: error.code, message: error.message });
    })
    .get("/health", () => ({ status: "ok" }))
    .get("/projects", () => controlPlane.listProjects())
    .get("/projects/:projectId/guide", ({ params }) => controlPlane.projectGuide(params.projectId))
    .post("/projects", { body: t.Object({ name: t.String(), description: t.Optional(t.String()), rootPath: t.Optional(t.String()), topology: t.Optional(t.Union([t.Literal("single-repo"), t.Literal("monorepo"), t.Literal("multi-repo")])), ...actor }) },
      ({ body, status }) => status(201, controlPlane.createProject(body)))
    .get("/projects/:projectId/roles", ({ params }) => controlPlane.listRoles(params.projectId))
    .post("/projects/:projectId/roles", { body: t.Object({ key: t.String(), name: t.String(), instructions: t.Optional(t.String()), capabilities: t.Optional(t.Array(t.String())), workspaceKeys: t.Optional(t.Array(t.String())), model: t.Optional(t.Object({ providerId: t.String(), modelId: t.String(), variant: t.Optional(t.String()) })), ...actor }) },
      ({ params, body, status }) => status(201, controlPlane.createRole(params.projectId, body)))
    .get("/projects/:projectId/workflows", ({ params }) => controlPlane.listWorkflows(params.projectId))
    .post("/projects/:projectId/workflows", { body: t.Object({ name: t.String(), stages: t.Array(t.Object({ key: t.String(), name: t.String(), roleKey: t.String() })), ...actor }) },
      ({ params, body, status }) => status(201, controlPlane.createWorkflow(params.projectId, body)))
    .get("/projects/:projectId/repositories", ({ params }) => controlPlane.listRepositories(params.projectId))
    .post("/projects/:projectId/repositories", { body: t.Object({ key: t.String(), name: t.String(), path: t.String(), relationship: t.Optional(t.Union([t.Literal("root"), t.Literal("directory"), t.Literal("submodule"), t.Literal("external")])), ...actor }) },
      ({ params, body, status }) => status(201, controlPlane.createRepository(params.projectId, body)))
    .get("/projects/:projectId/workspaces", ({ params }) => controlPlane.listWorkspaces(params.projectId))
    .post("/projects/:projectId/workspaces", { body: t.Object({ repositoryId: t.String(), key: t.Optional(t.String()), name: t.String(), path: t.String(), shared: t.Optional(t.Boolean()), contextRoot: t.Optional(t.Boolean()), inheritRootContext: t.Optional(t.Boolean()), requireLocalAgent: t.Optional(t.Boolean()), ...actor }) },
      ({ params, body, status }) => status(201, controlPlane.createWorkspace(params.projectId, body)))
    .get("/projects/:projectId/work-items", ({ params }) => controlPlane.listWorkItems(params.projectId))
    .post("/projects/:projectId/work-items", { body: t.Object({ parentId: t.Optional(t.String()), type: workItemType, title: t.String(), outcome: t.String(), description: t.Optional(t.String()), assigneeRoleKey: t.Optional(t.String()), workflowId: t.Optional(t.String()), ...actor }) },
      ({ params, body, status }) => status(201, controlPlane.createWorkItem(params.projectId, body)))
    .post("/work-items/:workItemId/advance", { body: t.Object({ actor: t.Optional(t.String()) }) },
      ({ params, body }) => controlPlane.advanceWorkItem(params.workItemId, body.actor))
    .get("/projects/:projectId/delegations", ({ params }) => controlPlane.listDelegations(params.projectId))
    .post("/projects/:projectId/delegations", { body: t.Object({ workItemId: t.String(), workspaceId: t.String(), roleKey: t.String(), intent: t.Union([t.Literal("implementation"), t.Literal("diagnosis"), t.Literal("review")]), instructions: t.String(), ...actor }) },
      ({ params, body, status }) => status(201, controlPlane.createDelegation(params.projectId, body)))
    .get("/projects/:projectId/sessions", { query: t.Object({ roleKey: t.Optional(t.String()) }) },
      ({ params, query }) => controlPlane.listSessions(params.projectId, query.roleKey))
    .post("/projects/:projectId/sessions", { body: t.Object({ roleKey: t.String(), agent: t.String(), coordinatorId: t.Optional(t.String()), workspaceId: t.Optional(t.String()), delegationId: t.Optional(t.String()), meetingId: t.Optional(t.String()), runtimeSessionId: t.Optional(t.String()), ...actor }) },
      ({ params, body, status }) => status(201, controlPlane.startSession(params.projectId, body)))
    .post("/sessions/:sessionId/adopt", { body: t.Object({ coordinatorId: t.String(), actor: t.Optional(t.String()) }) },
      ({ params, body }) => controlPlane.adoptSession(params.sessionId, body.coordinatorId, body.actor))
    .get("/projects/:projectId/leases", ({ params }) => controlPlane.listLeases(params.projectId))
    .post("/delegations/:delegationId/leases", { body: t.Object({ sessionId: t.String(), ttlMinutes: t.Optional(t.Integer()), ...actor }) },
      ({ params, body, status }) => status(201, controlPlane.requestLease(params.delegationId, body)))
    .post("/leases/:leaseId/grant", { body: t.Object({ actorSessionId: t.Optional(t.String()), ...actor }) },
      ({ params, body }) => controlPlane.grantLease(params.leaseId, body))
    .post("/leases/:leaseId/release", { body: t.Object({ sessionId: t.String(), ...actor }) },
      ({ params, body }) => controlPlane.releaseLease(params.leaseId, body))
    .get("/projects/:projectId/handoffs", ({ params }) => controlPlane.listHandoffs(params.projectId))
    .post("/projects/:projectId/handoffs", { body: t.Object({ delegationId: t.String(), fromSessionId: t.String(), toRoleKey: t.String(), continuationSessionId: t.Optional(t.String()), context: t.String(), impact: t.String(), nextAction: t.String(), blockingCondition: t.Optional(t.String()), evidenceIds: t.Optional(t.Array(t.String())), ...actor }) },
      ({ params, body, status }) => status(201, controlPlane.offerHandoff(params.projectId, body)))
    .post("/handoffs/:handoffId/acknowledge", { body: t.Object({ sessionId: t.String(), ...actor }) },
      ({ params, body }) => controlPlane.acknowledgeHandoff(params.handoffId, body))
    .post("/handoffs/:handoffId/reject", { body: t.Object({ sessionId: t.String(), reason: t.String(), ...actor }) },
      ({ params, body }) => controlPlane.rejectHandoff(params.handoffId, body))
    .post("/projects/:projectId/evidence", { body: t.Object({ workItemId: t.String(), sessionId: t.String(), kind: t.Union([t.Literal("test"), t.Literal("review"), t.Literal("artifact"), t.Literal("commit"), t.Literal("note")]), summary: t.String(), reference: t.Optional(t.String()), ...actor }) },
      ({ params, body, status }) => status(201, controlPlane.attachEvidence(params.projectId, body)))
    .post("/projects/:projectId/deliveries", { body: t.Object({ workItemId: t.String(), sessionId: t.String(), evidenceIds: t.Array(t.String()), summary: t.String(), ...actor }) },
      ({ params, body, status }) => status(201, controlPlane.completeDelivery(params.projectId, body)))
    .get("/projects/:projectId/acceptances", ({ params }) => controlPlane.listAcceptances(params.projectId))
    .post("/deliveries/:deliveryId/acceptance", { body: t.Object({ reviewerSessionId: t.String(), ...actor }) },
      ({ params, body, status }) => status(201, controlPlane.requestAcceptance(params.deliveryId, body)))
    .post("/acceptances/:acceptanceId/review", { body: t.Object({ reviewerSessionId: t.String(), verdict: t.Union([t.Literal("accepted"), t.Literal("rejected"), t.Literal("inconclusive")]), rationale: t.String(), ...actor }) },
      ({ params, body }) => controlPlane.reviewAcceptance(params.acceptanceId, body))
    .get("/projects/:projectId/meetings", ({ params }) => controlPlane.listMeetings(params.projectId))
    .post("/projects/:projectId/meetings", { body: t.Object({ objective: t.String(), facilitatorSessionId: t.String(), workItemId: t.Optional(t.String()), participants: t.Array(t.Object({ roleKey: t.String(), workspaceId: t.String() }), { minItems: 2 }), maxRounds: t.Optional(t.Integer({ minimum: 1, maximum: 5 })), ...actor }) },
      ({ params, body, status }) => status(201, controlPlane.createMeeting(params.projectId, body)))
    .post("/meetings/:meetingId/start", { body: t.Object({ bindings: t.Array(t.Object({ roleKey: t.String(), workspaceId: t.String(), sessionId: t.String() })), ...actor }) },
      ({ params, body }) => controlPlane.startMeeting(params.meetingId, body.bindings, body.actor))
    .get("/projects/:projectId/meeting-contributions", { query: t.Object({ meetingId: t.Optional(t.String()), round: t.Optional(t.Numeric()) }) },
      ({ params, query }) => controlPlane.listMeetingContributions(params.projectId, query.meetingId, query.round))
    .post("/meetings/:meetingId/contributions", { body: t.Object({ sessionId: t.String(), kind: t.Union([t.Literal("proposal"), t.Literal("critique"), t.Literal("question"), t.Literal("decision")]), content: t.String(), ...actor }) },
      ({ params, body, status }) => status(201, controlPlane.contributeToMeeting(params.meetingId, body)))
    .post("/meetings/:meetingId/advance", { body: t.Object({ actor: t.Optional(t.String()) }) },
      ({ params, body }) => controlPlane.advanceMeeting(params.meetingId, body.actor))
    .post("/meetings/:meetingId/complete", { body: t.Object({ facilitatorSessionId: t.String(), synthesis: meetingSynthesis, ...actor }) },
      ({ params, body }) => controlPlane.completeMeeting(params.meetingId, body))
    .get("/projects/:projectId/messages", { query: t.Object({ sessionId: t.Optional(t.String()) }) },
      ({ params, query }) => controlPlane.listMessages(params.projectId, query.sessionId))
    .post("/projects/:projectId/messages", { body: t.Object({ fromSessionId: t.String(), toSessionId: t.String(), content: t.String(), ...actor }) },
      ({ params, body, status }) => status(201, controlPlane.sendMessage(params.projectId, body)))
    .get("/projects/:projectId/context-notes", { query: t.Object({ sessionId: t.Optional(t.String()), workItemId: t.Optional(t.String()), meetingId: t.Optional(t.String()) }) },
      ({ params, query }) => controlPlane.listContextNotes(params.projectId, query))
    .post("/projects/:projectId/context-notes", { body: t.Object({ sessionId: t.Optional(t.String()), workItemId: t.Optional(t.String()), meetingId: t.Optional(t.String()), kind: t.Optional(t.Union([t.Literal("context"), t.Literal("decision"), t.Literal("constraint")])), author: t.Optional(t.String()), content: t.String() }) },
      ({ params, body, status }) => status(201, controlPlane.addContextNote(params.projectId, body)))
    .get("/projects/:projectId/interventions", { query: t.Object({ status: t.Optional(t.Union([t.Literal("open"), t.Literal("resolved")])) }) },
      ({ params, query }) => controlPlane.listInterventions(params.projectId, query.status))
    .post("/projects/:projectId/interventions", { body: t.Object({ requesterSessionId: t.String(), target: t.Union([t.Literal("human"), t.Literal("role")]), targetRoleKey: t.Optional(t.String()), message: t.String(), ...actor }) },
      ({ params, body, status }) => status(201, controlPlane.openIntervention(params.projectId, body)))
    .post("/interventions/:interventionId/assign", { body: t.Object({ sessionId: t.String(), ...actor }) },
      ({ params, body }) => controlPlane.assignIntervention(params.interventionId, body))
    .post("/interventions/:interventionId/resolve", { body: t.Object({ resolution: t.String(), assignedSessionId: t.Optional(t.String()), ...actor }) },
      ({ params, body }) => controlPlane.resolveIntervention(params.interventionId, body))
    .get("/projects/:projectId/events", { query: t.Object({ after: t.Optional(t.Numeric()) }) },
      ({ params, query }) => controlPlane.events(params.projectId, query.after ?? 0));
}
