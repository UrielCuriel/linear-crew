import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { Session as OpenCodeSession, SessionStatus as OpenCodeSessionStatus } from "@opencode-ai/sdk/v2/client";
import { ControlPlane, DomainError } from "../application/control-plane.ts";
import type { AgentSession, Delegation, MeetingContribution, MeetingSynthesis, PlanningMeeting, Role, WorkItem, Workspace } from "../domain/types.ts";
import { resolveDirectory } from "../config/local-config.ts";

export interface RuntimeSession {
  id: string;
  directory: string;
}

export interface AgentRuntime {
  create(input: { directory: string; title: string; agent: string; model?: Role["model"]; metadata: Record<string, unknown> }): Promise<RuntimeSession>;
  promptAsync(input: { sessionId: string; directory: string; agent: string; model?: Role["model"]; prompt: string; noReply?: boolean }): Promise<void>;
  statuses(directory: string): Promise<Record<string, "idle" | "busy" | "retry">>;
  abort(sessionId: string, directory: string): Promise<void>;
}

async function responseData<T>(request: Promise<unknown>): Promise<T> {
  const response = await request as { data?: T; error?: unknown };
  if (response.error) throw new Error(`OpenCode rejected the operation: ${JSON.stringify(response.error)}`);
  if (response.data === undefined) throw new Error("OpenCode returned no data");
  return response.data;
}

export class OpenCodeSdkRuntime implements AgentRuntime {
  readonly #client: ReturnType<typeof createOpencodeClient>;

  constructor(baseUrl: string) {
    const password = Bun.env.OPENCODE_SERVER_PASSWORD;
    const username = Bun.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    const credentials = password ? new TextEncoder().encode(`${username}:${password}`) : undefined;
    const authorization = credentials ? `Basic ${btoa(Array.from(credentials, (byte) => String.fromCharCode(byte)).join(""))}` : undefined;
    this.#client = createOpencodeClient({ baseUrl, headers: authorization ? { authorization } : undefined });
  }

  async create(input: { directory: string; title: string; agent: string; model?: Role["model"]; metadata: Record<string, unknown> }): Promise<RuntimeSession> {
    const session = await responseData<OpenCodeSession>(this.#client.session.create({
      directory: input.directory,
      title: input.title,
      agent: input.agent,
      model: input.model ? { providerID: input.model.providerId, id: input.model.modelId, variant: input.model.variant } : undefined,
      metadata: input.metadata,
    }));
    return { id: session.id, directory: session.directory };
  }

  async promptAsync(input: { sessionId: string; directory: string; agent: string; model?: Role["model"]; prompt: string; noReply?: boolean }): Promise<void> {
    const response = await this.#client.session.promptAsync({
      sessionID: input.sessionId,
      directory: input.directory,
      agent: input.agent,
      model: input.model ? { providerID: input.model.providerId, modelID: input.model.modelId } : undefined,
      variant: input.model?.variant,
      noReply: input.noReply,
      parts: [{ type: "text", text: input.prompt }],
    });
    if (response.error) throw new Error(`OpenCode rejected the prompt: ${JSON.stringify(response.error)}`);
  }

  async statuses(directory: string): Promise<Record<string, "idle" | "busy" | "retry">> {
    const statuses = await responseData<Record<string, OpenCodeSessionStatus>>(this.#client.session.status({ directory }));
    return Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, status.type]));
  }

  async abort(sessionId: string, directory: string): Promise<void> {
    const response = await this.#client.session.abort({ sessionID: sessionId, directory });
    if (response.error) throw new Error(`OpenCode rejected the abort: ${JSON.stringify(response.error)}`);
  }
}

export interface ScheduledSession {
  delegation: Delegation;
  session: AgentSession;
  directory: string;
}

export class OpenCodeScheduler {
  constructor(
    readonly controlPlane: ControlPlane,
    readonly runtime: AgentRuntime,
    readonly rootDirectory: string,
  ) {}

  async startDelegation(delegationId: string, coordinatorSessionId: string): Promise<ScheduledSession> {
    const delegation = this.controlPlane.getDelegation(delegationId);
    if (delegation.sessionId) throw new DomainError("CONFLICT", "Delegation already has a session; continue it instead");
    const workspace = this.controlPlane.getWorkspace(delegation.workspaceId);
    const workItem = this.controlPlane.getWorkItem(delegation.workItemId);
    const role = this.controlPlane.getRole(delegation.projectId, delegation.roleKey);
    const coordinator = this.controlPlane.listSessions(delegation.projectId).find((session) => session.id === coordinatorSessionId);
    if (!coordinator) throw new DomainError("NOT_FOUND", "Coordinator session does not exist in the project");
    const directory = resolveDirectory(this.rootDirectory, workspace.path);
    await this.#preflight(workspace, role, directory);

    const runtimeSession = await this.runtime.create({
      directory,
      title: `${workItem.title} [${role.key}]`,
      agent: role.key,
      model: role.model,
      metadata: { linearCrew: { projectId: delegation.projectId, delegationId: delegation.id, workItemId: workItem.id, workspaceId: workspace.id, roleKey: role.key, outcomeRevision: delegation.outcomeRevision } },
    });
    try {
      const session = this.controlPlane.startSession(delegation.projectId, {
        roleKey: role.key,
        agent: "opencode",
        coordinatorId: coordinator.id,
        workspaceId: workspace.id,
        delegationId: delegation.id,
        runtimeSessionId: runtimeSession.id,
        actor: coordinator.id,
      });
      await this.runtime.promptAsync({ sessionId: runtimeSession.id, directory, agent: role.key, model: role.model, prompt: this.#delegationPrompt(delegation, workItem, workspace, directory) });
      return { delegation: this.controlPlane.getDelegation(delegation.id), session, directory };
    } catch (error) {
      await this.runtime.abort(runtimeSession.id, directory).catch(() => undefined);
      throw error;
    }
  }

  async continueDelegation(delegationId: string, prompt: string): Promise<ScheduledSession> {
    const delegation = this.controlPlane.getDelegation(delegationId);
    if (!delegation.sessionId) throw new DomainError("CONFLICT", "Delegation has no session to continue");
    const session = this.controlPlane.listSessions(delegation.projectId).find((candidate) => candidate.id === delegation.sessionId);
    if (!session?.runtimeSessionId) throw new DomainError("CONFLICT", "Delegation session has no OpenCode binding");
    if (session.status === "active" || session.status === "unknown") throw new DomainError("CONFLICT", `Session cannot be continued while ${session.status}`);
    const workspace = this.controlPlane.getWorkspace(delegation.workspaceId);
    const role = this.controlPlane.getRole(delegation.projectId, delegation.roleKey);
    const directory = resolveDirectory(this.rootDirectory, workspace.path);
    await this.runtime.promptAsync({ sessionId: session.runtimeSessionId, directory, agent: role.key, model: role.model, prompt });
    return { delegation, session: this.controlPlane.updateSessionStatus(session.id, "active"), directory };
  }

  async notifySession(sessionId: string, prompt: string): Promise<void> {
    const session = this.controlPlane.listProjects()
      .flatMap((project) => this.controlPlane.listSessions(project.id))
      .find((candidate) => candidate.id === sessionId);
    if (!session?.runtimeSessionId || !session.workspaceId) throw new DomainError("CONFLICT", "Target session has no routable OpenCode binding");
    if (session.status === "completed" || session.status === "failed") {
      throw new DomainError("CONFLICT", `Target session cannot be notified while ${session.status}`);
    }
    const workspace = this.controlPlane.getWorkspace(session.workspaceId);
    const role = this.controlPlane.getRole(session.projectId, session.roleKey);
    await this.runtime.promptAsync({
      sessionId: session.runtimeSessionId,
      directory: resolveDirectory(this.rootDirectory, workspace.path),
      agent: role.key,
      model: role.model,
      prompt,
    });
    this.controlPlane.updateSessionStatus(session.id, "active");
  }

  async startMeeting(meetingId: string): Promise<PlanningMeeting> {
    const meeting = this.controlPlane.getMeeting(meetingId);
    if (meeting.status !== "planned") throw new DomainError("CONFLICT", "Only a planned meeting can be started");
    const facilitator = this.controlPlane.listSessions(meeting.projectId).find((session) => session.id === meeting.facilitatorSessionId);
    if (!facilitator?.runtimeSessionId || !facilitator.workspaceId) throw new DomainError("CONFLICT", "Meeting facilitator must have a routable OpenCode session");
    const prepared = await Promise.all(meeting.participants.map(async (participant) => {
      const workspace = this.controlPlane.getWorkspace(participant.workspaceId);
      const role = this.controlPlane.getRole(meeting.projectId, participant.roleKey);
      const directory = resolveDirectory(this.rootDirectory, workspace.path);
      await this.#preflight(workspace, role, directory);
      return { participant, workspace, role, directory };
    }));
    const started: Array<{ runtime: RuntimeSession; session: AgentSession; role: Role; directory: string; workspace: Workspace }> = [];
    try {
      await Promise.all(prepared.map(async ({ participant, workspace, role, directory }) => {
        const runtime = await this.runtime.create({
          directory,
          title: `Brainstorm: ${meeting.objective} [${role.key}]`,
          agent: role.key,
          model: role.model,
          metadata: { linearCrew: { projectId: meeting.projectId, meetingId: meeting.id, workspaceId: workspace.id, roleKey: role.key } },
        });
        const session = this.controlPlane.startSession(meeting.projectId, {
          roleKey: role.key,
          agent: "opencode",
          coordinatorId: facilitator.id,
          workspaceId: workspace.id,
          meetingId: meeting.id,
          runtimeSessionId: runtime.id,
          actor: facilitator.id,
        });
        started.push({ runtime, session, role, directory, workspace });
      }));
      const active = this.controlPlane.startMeeting(meeting.id, started.map(({ session }) => ({ roleKey: session.roleKey, workspaceId: session.workspaceId!, sessionId: session.id })), facilitator.id);
      await Promise.all(started.map(({ runtime, role, directory, workspace }) =>
        this.runtime.promptAsync({ sessionId: runtime.id, directory, agent: role.key, model: role.model, prompt: this.#meetingPrompt(active, role, workspace) })));
      return active;
    } catch (error) {
      this.controlPlane.cancelMeeting(meeting.id);
      await Promise.all(started.map(async ({ runtime, session }) => {
        this.controlPlane.updateSessionStatus(session.id, "failed");
        await this.runtime.abort(runtime.id, runtime.directory).catch(() => undefined);
      }));
      throw error;
    }
  }

  async contributeToMeeting(meetingId: string, input: { sessionId: string; kind: MeetingContribution["kind"]; content: string }): Promise<{ contribution: MeetingContribution; meeting: PlanningMeeting }> {
    const contribution = this.controlPlane.contributeToMeeting(meetingId, input);
    let meeting = this.controlPlane.getMeeting(meetingId);
    const roundContributions = this.controlPlane.listMeetingContributions(meeting.projectId, meeting.id, meeting.round);
    if (roundContributions.length < meeting.participants.length) return { contribution, meeting };
    meeting = this.controlPlane.advanceMeeting(meeting.id);
    const transcript = roundContributions.map((item) => `[${item.roleKey} / ${item.kind}] ${item.content}`).join("\n\n");
    if (meeting.status === "active") {
      await Promise.all(meeting.participants.map((participant) => this.notifySession(participant.sessionId!, `Planning meeting ${meeting.id}, round ${meeting.round}. Critique the proposals below, identify conflicts and suggest concrete resolutions.\n\n${transcript}\n\nSubmit exactly one contribution with crew_meeting_contribute.`)));
    } else {
      const allContributions = this.controlPlane.listMeetingContributions(meeting.projectId, meeting.id);
      const fullTranscript = allContributions.map((item) => `Round ${item.round} - ${item.roleKey} (${item.kind}): ${item.content}`).join("\n\n");
      await this.notifySession(meeting.facilitatorSessionId, `Planning meeting ${meeting.id} is ready for synthesis. Produce a feature brief with decisions, open questions, milestones, epics, issues, role ownership and acceptance gates.\n\n${fullTranscript}\n\nComplete it with crew_meeting_complete.`);
    }
    return { contribution, meeting };
  }

  async completeMeeting(meetingId: string, input: { facilitatorSessionId: string; synthesis: MeetingSynthesis }): Promise<PlanningMeeting> {
    const meeting = this.controlPlane.completeMeeting(meetingId, input);
    await Promise.all(meeting.participants.flatMap((participant) => {
      if (!participant.sessionId) return [];
      const session = this.controlPlane.listSessions(meeting.projectId).find((candidate) => candidate.id === participant.sessionId);
      if (!session?.runtimeSessionId || !session.workspaceId) return [];
      this.controlPlane.updateSessionStatus(session.id, "completed");
      const workspace = this.controlPlane.getWorkspace(session.workspaceId);
      return [this.runtime.abort(session.runtimeSessionId, resolveDirectory(this.rootDirectory, workspace.path)).catch(() => undefined)];
    }));
    return meeting;
  }

  async reconcile(projectId: string): Promise<{ updated: number; notified: number; unknown: number }> {
    const sessions = this.controlPlane.listSessions(projectId).filter((session) => session.runtimeSessionId && session.workspaceId && ["active", "waiting", "unknown"].includes(session.status));
    const workspaces = new Map(this.controlPlane.listWorkspaces(projectId).map((workspace) => [workspace.id, workspace]));
    const statusByWorkspace = new Map<string, Record<string, "idle" | "busy" | "retry"> | null>();
    let updated = 0;
    let notified = 0;
    let unknown = 0;

    for (const session of sessions) {
      const workspace = workspaces.get(session.workspaceId!);
      if (!workspace) continue;
      const directory = resolveDirectory(this.rootDirectory, workspace.path);
      let statuses = statusByWorkspace.get(workspace.id);
      if (!statusByWorkspace.has(workspace.id)) {
        try {
          statuses = await this.runtime.statuses(directory);
          statusByWorkspace.set(workspace.id, statuses);
        } catch {
          statuses = null;
          statusByWorkspace.set(workspace.id, null);
        }
      }
      const runtimeStatus = statuses?.[session.runtimeSessionId!];
      const next = statuses == null
        ? "unknown"
        : runtimeStatus === "busy" || runtimeStatus === "retry"
          ? "active"
          : "waiting";
      if (next === "unknown") unknown++;
      const wasActive = session.status === "active";
      if (session.status !== next) {
        this.controlPlane.updateSessionStatus(session.id, next);
        updated++;
      }
      if (wasActive && next === "waiting" && !session.meetingId && await this.#notifyCoordinator(session)) notified++;
    }
    for (const note of this.controlPlane.listContextNotes(projectId).filter((candidate) => candidate.sessionId && !candidate.deliveredAt)) {
      try {
        await this.notifySession(note.sessionId!, `Human context from ${note.author}: ${note.content}\nCall crew_context to include the durable note in your work.`);
        this.controlPlane.markContextNoteDelivered(note.id);
        notified++;
      } catch {
        // Keep the note pending until its target session becomes routable again.
      }
    }
    for (const note of this.controlPlane.listContextNotes(projectId).filter((candidate) => candidate.meetingId && !candidate.deliveredAt)) {
      const meeting = this.controlPlane.getMeeting(note.meetingId!);
      const recipients = new Set([meeting.facilitatorSessionId, ...meeting.participants.flatMap((participant) => participant.sessionId ? [participant.sessionId] : [])]);
      try {
        await Promise.all([...recipients].map((sessionId) => this.notifySession(sessionId, `Human input for planning meeting ${meeting.id}: ${note.content}\nIncorporate it into the current round and call crew_context before responding.`)));
        this.controlPlane.markContextNoteDelivered(note.id);
        notified += recipients.size;
      } catch {
        // Keep the note pending until all meeting sessions become routable.
      }
    }
    return { updated, notified, unknown };
  }

  async #preflight(workspace: Workspace, role: Role, directory: string): Promise<void> {
    if (workspace.requireLocalAgent && !(await Bun.file(`${directory}/.opencode/agents/${role.key}.md`).exists())) {
      throw new DomainError("NOT_FOUND", `Workspace '${workspace.key}' does not define local agent '${role.key}'`);
    }
  }

  #delegationPrompt(delegation: Delegation, workItem: WorkItem, workspace: Workspace, directory: string): string {
    return [
      `Linear Crew delegation: ${delegation.id}`,
      `Work item: ${workItem.id} - ${workItem.title}`,
      `Outcome revision ${delegation.outcomeRevision}: ${workItem.outcome}`,
      `Intent: ${delegation.intent}`,
      `Role: ${delegation.roleKey}`,
      `Effective context root: ${directory}`,
      `Workspace: ${workspace.key}`,
      workspace.inheritRootContext ? `Global context root: ${this.rootDirectory}` : "This workspace does not inherit global context.",
      `Instructions: ${delegation.instructions}`,
      "Call crew_register_session with this delegationId before reporting state.",
      delegation.intent === "implementation" ? "Before editing, request a write lease with crew_request_lease and wait until it is granted." : "This is read-only work; do not request a write lease or modify files.",
      "Use Linear Crew messages, handoffs and interventions instead of relaying context through the Product Owner.",
    ].join("\n");
  }

  #meetingPrompt(meeting: PlanningMeeting, role: Role, workspace: Workspace): string {
    return [
      `Linear Crew planning meeting: ${meeting.id}`,
      `Objective: ${meeting.objective}`,
      `You represent role: ${role.key}`,
      `Context root: ${workspace.key}`,
      workspace.inheritRootContext ? `Global context root: ${this.rootDirectory}` : "Use only this context root.",
      "This is analysis-only. Do not modify files.",
      "Explore the relevant context and produce a concrete proposal from your role's authority.",
      "Raise unresolved authority questions explicitly; do not invent human decisions.",
      "Submit exactly one structured contribution with crew_meeting_contribute when ready.",
    ].join("\n");
  }

  async #notifyCoordinator(session: AgentSession): Promise<boolean> {
    const coordinator = this.controlPlane.listSessions(session.projectId).find((candidate) => candidate.id === session.coordinatorId);
    if (!coordinator?.runtimeSessionId || !coordinator.workspaceId) return false;
    const workspace = this.controlPlane.getWorkspace(coordinator.workspaceId);
    const role = this.controlPlane.getRole(coordinator.projectId, coordinator.roleKey);
    await this.runtime.promptAsync({
      sessionId: coordinator.runtimeSessionId,
      directory: resolveDirectory(this.rootDirectory, workspace.path),
      agent: role.key,
      model: role.model,
      prompt: `Linear Crew notification: session ${session.id} for role ${session.roleKey} is waiting. Call crew_context and process its handoff, message, intervention or delivery state.`,
    });
    return true;
  }
}
