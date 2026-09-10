import { describe, expect, test } from "bun:test";
import { ControlPlane, DomainError } from "../src/application/control-plane.ts";
import { createHttpApp } from "../src/http/app.ts";
import { SqliteStore } from "../src/infrastructure/sqlite-store.ts";
import { assertSessionCanWrite, createLinearCrewTools } from "../src/integrations/opencode-plugin.ts";
import { dashboardSnapshot } from "../src/tui/dashboard.ts";
import type { ToolContext } from "@opencode-ai/plugin";
import { OpenCodeScheduler, type AgentRuntime, type RuntimeSession } from "../src/scheduler/opencode-scheduler.ts";
import { resolveDirectory } from "../src/config/local-config.ts";

class FakeAgentRuntime implements AgentRuntime {
  readonly sessions: RuntimeSession[] = [];
  readonly prompts: Array<{ sessionId: string; directory: string; prompt: string }> = [];
  readonly states: Record<string, "idle" | "busy" | "retry"> = {};

  async create(input: Parameters<AgentRuntime["create"]>[0]): Promise<RuntimeSession> {
    const session = { id: `runtime-${this.sessions.length + 1}`, directory: input.directory };
    this.sessions.push(session);
    this.states[session.id] = "idle";
    return session;
  }

  async promptAsync(input: Parameters<AgentRuntime["promptAsync"]>[0]): Promise<void> {
    this.prompts.push({ sessionId: input.sessionId, directory: input.directory, prompt: input.prompt });
    if (!input.noReply) this.states[input.sessionId] = "busy";
  }

  async statuses(): Promise<Record<string, "idle" | "busy" | "retry">> {
    return { ...this.states };
  }

  async abort(sessionId: string): Promise<void> {
    delete this.states[sessionId];
  }
}

function setup() {
  const store = new SqliteStore(":memory:");
  const cp = new ControlPlane(store);
  const project = cp.createProject({ name: "Test crew" });
  cp.createRole(project.id, { key: "po", name: "Product Owner", capabilities: ["grant-lease"] });
  cp.createRole(project.id, { key: "backend", name: "Backend" });
  cp.createRole(project.id, { key: "qa", name: "QA", capabilities: ["accept-delivery"] });
  const repository = cp.createRepository(project.id, { key: "api", name: "API", path: "C:/project/api" });
  const workspace = cp.createWorkspace(project.id, { repositoryId: repository.id, name: "main", path: "C:/project/api", shared: true });
  const workItem = cp.createWorkItem(project.id, { type: "issue", title: "Add endpoint", outcome: "Endpoint is observable and verified" });
  return { store, cp, project, workspace, workItem };
}

describe("control plane", () => {
  test("serializes implementation leases per workspace", () => {
    const { store, cp, project, workspace, workItem } = setup();
    try {
      const po = cp.startSession(project.id, { roleKey: "po", agent: "opencode" });
      const firstDelegation = cp.createDelegation(project.id, { workItemId: workItem.id, workspaceId: workspace.id, roleKey: "backend", intent: "implementation", instructions: "Implement endpoint" });
      const first = cp.startSession(project.id, { roleKey: "backend", agent: "opencode", delegationId: firstDelegation.id });
      const firstLease = cp.requestLease(firstDelegation.id, { sessionId: first.id });
      expect(cp.grantLease(firstLease.id, { actorSessionId: po.id }).fencingToken).toBe(1);

      const secondDelegation = cp.createDelegation(project.id, { workItemId: workItem.id, workspaceId: workspace.id, roleKey: "backend", intent: "implementation", instructions: "Implement another part" });
      const second = cp.startSession(project.id, { roleKey: "backend", agent: "opencode", delegationId: secondDelegation.id });
      const secondLease = cp.requestLease(secondDelegation.id, { sessionId: second.id });
      expect(() => cp.grantLease(secondLease.id, { actorSessionId: po.id })).toThrow(DomainError);

      cp.releaseLease(firstLease.id, { sessionId: first.id });
      expect(cp.grantLease(secondLease.id, { actorSessionId: po.id }).fencingToken).toBe(2);
    } finally {
      store.close();
    }
  });

  test("offers and acknowledges a structured handoff", () => {
    const { store, cp, project, workspace, workItem } = setup();
    try {
      const delegation = cp.createDelegation(project.id, { workItemId: workItem.id, workspaceId: workspace.id, roleKey: "backend", intent: "diagnosis", instructions: "Find the contract" });
      const backend = cp.startSession(project.id, { roleKey: "backend", agent: "opencode", delegationId: delegation.id });
      const qa = cp.startSession(project.id, { roleKey: "qa", agent: "opencode" });
      const handoff = cp.offerHandoff(project.id, {
        delegationId: delegation.id,
        fromSessionId: backend.id,
        toRoleKey: "qa",
        context: "Endpoint implemented",
        impact: "New response contract",
        nextAction: "Verify contract and failure cases",
      });
      const acknowledged = cp.acknowledgeHandoff(handoff.id, { sessionId: qa.id });
      expect(acknowledged.status).toBe("acknowledged");
      expect(acknowledged.acknowledgedBySessionId).toBe(qa.id);
    } finally {
      store.close();
    }
  });

  test("accepts only a concrete delivery from an independent capable session", () => {
    const { store, cp, project, workItem } = setup();
    try {
      const backend = cp.startSession(project.id, { roleKey: "backend", agent: "opencode" });
      const qa = cp.startSession(project.id, { roleKey: "qa", agent: "opencode" });
      const evidence = cp.attachEvidence(project.id, { workItemId: workItem.id, sessionId: backend.id, kind: "test", summary: "Integration test passes" });
      const delivery = cp.completeDelivery(project.id, { workItemId: workItem.id, sessionId: backend.id, evidenceIds: [evidence.id], summary: "Endpoint complete" });
      expect(() => cp.requestAcceptance(delivery.id, { reviewerSessionId: backend.id })).toThrow(DomainError);
      const review = cp.requestAcceptance(delivery.id, { reviewerSessionId: qa.id });
      expect(cp.reviewAcceptance(review.id, { reviewerSessionId: qa.id, verdict: "accepted", rationale: "Contract and tests verified" }).status).toBe("accepted");
      expect(cp.listWorkItems(project.id)[0]?.status).toBe("done");
      expect(cp.events(project.id).some((event) => event.type === "delivery.accepted")).toBe(true);
    } finally {
      store.close();
    }
  });

  test("allows durable sessions to be adopted by another coordinator", () => {
    const { store, cp, project } = setup();
    try {
      const session = cp.startSession(project.id, { roleKey: "backend", agent: "opencode", coordinatorId: "po-session-1", runtimeSessionId: "runtime-1" });
      const adopted = cp.adoptSession(session.id, "po-session-2");
      expect(adopted.coordinatorId).toBe("po-session-2");
      expect(adopted.runtimeSessionId).toBe("runtime-1");
    } finally {
      store.close();
    }
  });

  test("routes an intervention directly to an active session of the requested role", () => {
    const { store, cp, project } = setup();
    try {
      const requester = cp.startSession(project.id, { roleKey: "backend", agent: "opencode" });
      const qa = cp.startSession(project.id, { roleKey: "qa", agent: "opencode" });
      const intervention = cp.openIntervention(project.id, {
        requesterSessionId: requester.id,
        target: "role",
        targetRoleKey: "qa",
        message: "Confirm the expected failure response",
      });
      expect(cp.assignIntervention(intervention.id, { sessionId: qa.id }).assignedSessionId).toBe(qa.id);
      expect(cp.resolveIntervention(intervention.id, { resolution: "Use problem details" }).status).toBe("resolved");
    } finally {
      store.close();
    }
  });
});

test("HTTP adapter exposes the control plane", async () => {
  const store = new SqliteStore(":memory:");
  try {
    const app = createHttpApp(new ControlPlane(store));
    const response = await app.handle(new Request("http://localhost/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "HTTP crew" }),
    }));
    expect(response.status).toBe(201);
    const project = await response.json() as { id: string; name: string };
    expect(project).toMatchObject({ name: "HTTP crew" });
    const guide = await app.handle(new Request(`http://localhost/projects/${project.id}/guide`));
    expect(guide.status).toBe(200);
    expect((await guide.json()) as { capabilities: { discovery: string[] } }).toMatchObject({ capabilities: { discovery: expect.arrayContaining(["crew_guide"]) } });
  } finally {
    store.close();
  }
});

test("OpenCode tools bind the runtime session and expose durable context", async () => {
  const { store, cp, project } = setup();
  try {
    const tools = createLinearCrewTools(cp, { projectId: project.id, directory: "C:/project" });
    const context = {
      sessionID: "opencode-session-1",
      messageID: "message-1",
      agent: "backend",
      directory: "C:/project",
      worktree: "C:/project",
      abort: new AbortController().signal,
      metadata: () => undefined,
      ask: async () => undefined,
    } satisfies ToolContext;
    const guide = await tools.crew_guide!.execute({}, context);
    const guideOutput = typeof guide === "string" ? guide : guide.output;
    expect(guideOutput).toContain("crew_request_lease");
    expect(guideOutput).toContain("backend");
    expect(guideOutput).toContain("C:/project/api");
    const registered = await tools.crew_register_session!.execute({ roleKey: "backend" }, context);
    expect(typeof registered === "string" ? registered : registered.output).toContain("opencode-session-1");
    const session = cp.listSessions(project.id)[0]!;
    cp.addContextNote(project.id, { sessionId: session.id, content: "Human clarification" });
    for (let index = 0; index < 25; index++) cp.addContextNote(project.id, { sessionId: session.id, kind: index === 24 ? "decision" : "context", content: `Relevant product note ${index}` });
    const unrelated = cp.startSession(project.id, { roleKey: "qa", agent: "opencode" });
    cp.addContextNote(project.id, { sessionId: unrelated.id, content: "Unrelated runtime noise" });
    const snapshot = await tools.crew_context!.execute({}, context);
    const snapshotOutput = typeof snapshot === "string" ? snapshot : snapshot.output;
    expect(snapshotOutput).toContain("Relevant product note 24");
    expect(snapshotOutput).not.toContain("Unrelated runtime noise");
    expect(snapshotOutput).toContain('"omittedContextNotes": 6');
    expect(snapshotOutput).not.toContain("recentEvents");

    const history = await tools.crew_context_history!.execute({ sessionId: session.id, offset: 0, limit: 5 }, context);
    expect(typeof history === "string" ? history : history.output).toContain("Human clarification");
    const operational = await tools.crew_operational_context!.execute({ limit: 10 }, context);
    expect(typeof operational === "string" ? operational : operational.output).toContain("recentEvents");
  } finally {
    store.close();
  }
});

test("dashboard snapshot highlights pending human and agent attention", () => {
  const { store, cp, project } = setup();
  try {
    const session = cp.startSession(project.id, { roleKey: "backend", agent: "opencode" });
    cp.openIntervention(project.id, { requesterSessionId: session.id, target: "human", message: "Choose the public contract" });
    const snapshot = dashboardSnapshot(cp, project.id);
    expect(snapshot.sessions).toContain("backend");
    expect(snapshot.attention).toContain("Choose the public contract");
    expect(snapshot.events).toContain("intervention.opened");
  } finally {
    store.close();
  }
});

test("scheduler starts a primary session in its configured context root and wakes the coordinator", async () => {
  const store = new SqliteStore(":memory:");
  try {
    const cp = new ControlPlane(store);
    const project = cp.createProject({ name: "Multi repo", topology: "multi-repo", rootPath: import.meta.dir });
    cp.createRole(project.id, { key: "po", name: "PO", workspaceKeys: ["knowledge"] });
    cp.createRole(project.id, { key: "backend", name: "Backend", workspaceKeys: ["api"] });
    const rootRepository = cp.createRepository(project.id, { key: "knowledge", name: "Knowledge", path: ".", relationship: "root" });
    const apiRepository = cp.createRepository(project.id, { key: "api", name: "API", path: "api", relationship: "submodule" });
    const rootWorkspace = cp.createWorkspace(project.id, { repositoryId: rootRepository.id, key: "knowledge", name: "Knowledge", path: ".", requireLocalAgent: false });
    const apiWorkspace = cp.createWorkspace(project.id, { repositoryId: apiRepository.id, key: "api", name: "API", path: "api", requireLocalAgent: false });
    const work = cp.createWorkItem(project.id, { type: "issue", title: "API change", outcome: "API behavior verified" });
    const delegation = cp.createDelegation(project.id, { workItemId: work.id, workspaceId: apiWorkspace.id, roleKey: "backend", intent: "implementation", instructions: "Implement the change" });
    const coordinator = cp.startSession(project.id, { roleKey: "po", agent: "opencode", workspaceId: rootWorkspace.id, runtimeSessionId: "po-runtime" });
    const runtime = new FakeAgentRuntime();
    runtime.states["po-runtime"] = "idle";
    const scheduler = new OpenCodeScheduler(cp, runtime, import.meta.dir);

    const started = await scheduler.startDelegation(delegation.id, coordinator.id);
    expect(started.directory).toBe(`${import.meta.dir.replaceAll("\\", "/")}/api`);
    expect(runtime.prompts[0]?.prompt).toContain("request a write lease");
    expect(started.session.coordinatorId).toBe(coordinator.id);

    runtime.states[started.session.runtimeSessionId!] = "idle";
    const reconciled = await scheduler.reconcile(project.id);
    expect(reconciled.notified).toBe(1);
    expect(cp.listSessions(project.id).find((session) => session.id === started.session.id)?.status).toBe("waiting");
    expect(runtime.prompts.at(-1)?.sessionId).toBe("po-runtime");

    cp.addContextNote(project.id, { sessionId: started.session.id, author: "human:tui", content: "Use the versioned endpoint" });
    const delivered = await scheduler.reconcile(project.id);
    expect(delivered.notified).toBe(1);
    expect(cp.listContextNotes(project.id, { sessionId: started.session.id })[0]?.deliveredAt).toBeDefined();
    expect(runtime.prompts.at(-1)?.prompt).toContain("Use the versioned endpoint");

    delete runtime.states[started.session.runtimeSessionId!];
    const unknown = await scheduler.reconcile(project.id);
    expect(unknown.unknown).toBe(1);
    expect(cp.listSessions(project.id).find((session) => session.id === started.session.id)?.status).toBe("unknown");
  } finally {
    store.close();
  }
});

test("scheduler runs a durable multi-role planning meeting with human input and synthesis", async () => {
  const store = new SqliteStore(":memory:");
  try {
    const cp = new ControlPlane(store);
    const project = cp.createProject({ name: "Planning crew", rootPath: import.meta.dir });
    cp.createRole(project.id, { key: "po", name: "PO", workspaceKeys: ["main"] });
    cp.createRole(project.id, { key: "backend", name: "Backend", workspaceKeys: ["main"] });
    cp.createRole(project.id, { key: "qa", name: "QA", workspaceKeys: ["main"] });
    const repository = cp.createRepository(project.id, { key: "main", name: "Main", path: "." });
    const workspace = cp.createWorkspace(project.id, { repositoryId: repository.id, key: "main", name: "Main", path: ".", requireLocalAgent: false });
    const facilitator = cp.startSession(project.id, { roleKey: "po", agent: "opencode", workspaceId: workspace.id, runtimeSessionId: "po-runtime" });
    const meeting = cp.createMeeting(project.id, {
      objective: "Plan observable authentication",
      facilitatorSessionId: facilitator.id,
      participants: [
        { roleKey: "backend", workspaceId: workspace.id },
        { roleKey: "qa", workspaceId: workspace.id },
      ],
      maxRounds: 2,
    });
    const runtime = new FakeAgentRuntime();
    runtime.states["po-runtime"] = "idle";
    const scheduler = new OpenCodeScheduler(cp, runtime, import.meta.dir);

    const active = await scheduler.startMeeting(meeting.id);
    expect(active.status).toBe("active");
    expect(active.participants.every((participant) => participant.sessionId)).toBe(true);
    expect(runtime.prompts.filter((prompt) => prompt.prompt.includes("analysis-only"))).toHaveLength(2);
    const participantSession = cp.listSessions(project.id).find((session) => session.id === active.participants[0]!.sessionId)!;
    expect(() => assertSessionCanWrite(cp, project.id, participantSession.runtimeSessionId!)).toThrow("analysis-only");

    cp.addContextNote(project.id, { meetingId: meeting.id, content: "Prefer incremental rollout" });
    const delivered = await scheduler.reconcile(project.id);
    expect(delivered.notified).toBe(3);
    expect(cp.listContextNotes(project.id, { meetingId: meeting.id })[0]?.deliveredAt).toBeDefined();

    await scheduler.contributeToMeeting(meeting.id, { sessionId: active.participants[0]!.sessionId!, kind: "proposal", content: "Use short-lived tokens" });
    let result = await scheduler.contributeToMeeting(meeting.id, { sessionId: active.participants[1]!.sessionId!, kind: "critique", content: "Add revocation tests" });
    expect(result.meeting.round).toBe(2);
    await scheduler.contributeToMeeting(meeting.id, { sessionId: active.participants[0]!.sessionId!, kind: "decision", content: "Add token rotation" });
    result = await scheduler.contributeToMeeting(meeting.id, { sessionId: active.participants[1]!.sessionId!, kind: "decision", content: "Gate rollout on revocation coverage" });
    expect(result.meeting.status).toBe("synthesizing");
    expect(runtime.prompts.at(-1)?.sessionId).toBe("po-runtime");
    expect(() => cp.completeMeeting(meeting.id, { facilitatorSessionId: facilitator.id, synthesis: {
      featureBrief: "Invalid hierarchy",
      decisions: ["Ship"],
      openQuestions: [],
      milestones: [{ title: "Milestone", outcome: "Outcome" }],
      epics: [{ title: "Epic", outcome: "Outcome", milestone: "Missing" }],
      issues: [{ title: "Issue", outcome: "Outcome", epic: "Epic", ownerRoleKey: "backend", acceptanceGates: ["Test passes"] }],
    } })).toThrow("unknown milestone");

    const completed = await scheduler.completeMeeting(meeting.id, { facilitatorSessionId: facilitator.id, synthesis: {
      featureBrief: "Ship observable token rotation incrementally.",
      decisions: ["Use short-lived rotating tokens"],
      openQuestions: ["Final rollout percentage"],
      milestones: [{ title: "Secure sessions", outcome: "Rotating tokens are production-ready" }],
      epics: [{ title: "Token rotation", outcome: "Tokens rotate without breaking sessions", milestone: "Secure sessions" }],
      issues: [{ title: "Implement rotation", outcome: "Tokens rotate and revoked tokens fail", epic: "Token rotation", ownerRoleKey: "backend", acceptanceGates: ["Revocation integration test passes"] }],
    } });
    expect(completed.status).toBe("completed");
    expect(completed.synthesis?.issues[0]?.acceptanceGates).toEqual(["Revocation integration test passes"]);
    expect(cp.listSessions(project.id).filter((session) => session.meetingId === meeting.id).every((session) => session.status === "completed")).toBe(true);
    expect(() => cp.addContextNote(project.id, { meetingId: meeting.id, content: "Too late" })).toThrow("closed meeting");
    expect(cp.events(project.id).some((event) => event.type === "meeting.completed")).toBe(true);
  } finally {
    store.close();
  }
});

test("topology path resolution rejects context roots outside the configured project", () => {
  expect(resolveDirectory("C:/project", "api_v2")).toBe("C:/project/api_v2");
  expect(() => resolveDirectory("C:/project", "../other")).toThrow("escapes the project root");
});

test("OpenCode write tools require an implementation delegation with an active lease", () => {
  const { store, cp, project, workspace, workItem } = setup();
  try {
    const review = cp.createDelegation(project.id, { workItemId: workItem.id, workspaceId: workspace.id, roleKey: "backend", intent: "review", instructions: "Review only" });
    cp.startSession(project.id, { roleKey: "backend", agent: "opencode", delegationId: review.id, runtimeSessionId: "review-runtime" });
    expect(() => assertSessionCanWrite(cp, project.id, "review-runtime")).toThrow("cannot modify files");

    const implementation = cp.createDelegation(project.id, { workItemId: workItem.id, workspaceId: workspace.id, roleKey: "backend", intent: "implementation", instructions: "Implement" });
    const session = cp.startSession(project.id, { roleKey: "backend", agent: "opencode", delegationId: implementation.id, runtimeSessionId: "implementation-runtime" });
    expect(() => assertSessionCanWrite(cp, project.id, "implementation-runtime")).toThrow("needs an active write lease");
    const lease = cp.requestLease(implementation.id, { sessionId: session.id });
    cp.grantLease(lease.id, {});
    expect(() => assertSessionCanWrite(cp, project.id, "implementation-runtime")).not.toThrow();
  } finally {
    store.close();
  }
});
