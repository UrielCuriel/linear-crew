import { BoxRenderable, InputRenderable, InputRenderableEvents, TextRenderable, createCliRenderer } from "@opentui/core";
import { ControlPlane } from "../application/control-plane.ts";
import type { DomainEvent } from "../domain/types.ts";

export interface DashboardSnapshot {
  work: string;
  sessions: string;
  meetings: string;
  attention: string;
  events: string;
}

const short = (id: string) => id.slice(0, 8);

export function dashboardSnapshot(controlPlane: ControlPlane, projectId: string): DashboardSnapshot {
  const workItems = controlPlane.listWorkItems(projectId);
  const sessions = controlPlane.listSessions(projectId);
  const interventions = controlPlane.listInterventions(projectId, "open");
  const meetings = controlPlane.listMeetings(projectId).filter((meeting) => meeting.status !== "completed" && meeting.status !== "cancelled");
  const handoffs = controlPlane.listHandoffs(projectId).filter((item) => item.status === "offered" || item.status === "acknowledged");
  const leases = controlPlane.listLeases(projectId).filter((item) => item.status === "active" || item.status === "requested");
  const events = controlPlane.events(projectId).slice(-12);

  return {
    work: workItems.length ? workItems.map((item) => `${short(item.id)}  ${item.status.padEnd(19)} ${item.type.padEnd(9)} ${item.title}`).join("\n") : "No work items",
    sessions: sessions.length ? sessions.map((session) => `${short(session.id)}  ${session.status.padEnd(9)} ${session.roleKey.padEnd(16)} ${session.agent}`).join("\n") : "No sessions",
    meetings: meetings.length ? meetings.map((meeting) => `${short(meeting.id)}  ${meeting.status.padEnd(12)} R${meeting.round}/${meeting.maxRounds}  ${meeting.objective}`).join("\n") : "No active meetings",
    attention: [
      ...interventions.map((item) => `INTERVENTION ${short(item.id)} -> ${item.targetRoleKey ?? "human"}\n  ${item.message}`),
      ...handoffs.map((item) => `HANDOFF ${short(item.id)} ${item.status} -> ${item.toRoleKey}\n  ${item.nextAction}`),
      ...leases.map((item) => `LEASE ${short(item.id)} ${item.status} workspace:${short(item.workspaceId)}`),
    ].join("\n") || "Nothing needs attention",
    events: formatEvents(events),
  };
}

function formatEvents(events: DomainEvent[]): string {
  if (!events.length) return "No events";
  return events.map((event) => `${String(event.sequence).padStart(4)}  ${event.type.padEnd(29)} ${short(event.aggregateId)}`).join("\n");
}

export async function runDashboard(controlPlane: ControlPlane, projectId: string, refreshMilliseconds = 1000): Promise<void> {
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let finish: () => void = () => undefined;
  const destroyed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    screenMode: "alternate-screen",
    backgroundColor: "#0a0d12",
    onDestroy: () => {
      if (refreshTimer) clearInterval(refreshTimer);
      finish();
    },
  });

  const root = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column", backgroundColor: "#0a0d12" });
  const header = new BoxRenderable(renderer, { height: 3, paddingX: 2, justifyContent: "center", backgroundColor: "#d7ff4f" });
  const headerText = new TextRenderable(renderer, { content: `LINEAR CREW  /  ${projectId}  /  LIVE CONTROL PLANE`, fg: "#11150a" });
  header.add(headerText);

  const body = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "row", gap: 1, padding: 1 });
  const workPanel = new BoxRenderable(renderer, { width: "50%", border: true, borderStyle: "single", borderColor: "#6272a4", title: " WORK GRAPH ", padding: 1 });
  const right = new BoxRenderable(renderer, { width: "50%", flexDirection: "column", gap: 1 });
  const sessionsPanel = new BoxRenderable(renderer, { height: "30%", border: true, borderColor: "#55d6be", title: " ACTIVE SESSIONS ", padding: 1 });
  const meetingsPanel = new BoxRenderable(renderer, { height: "24%", border: true, borderColor: "#bd93f9", title: " PLANNING MEETINGS ", padding: 1 });
  const attentionPanel = new BoxRenderable(renderer, { height: "26%", border: true, borderColor: "#ff6b6b", title: " ATTENTION QUEUE ", padding: 1 });
  const eventsPanel = new BoxRenderable(renderer, { flexGrow: 1, border: true, borderColor: "#ffb86c", title: " EVENT STREAM ", padding: 1 });
  const workText = new TextRenderable(renderer, { content: "Loading...", fg: "#d6deeb" });
  const sessionsText = new TextRenderable(renderer, { content: "Loading...", fg: "#b8f2e6" });
  const meetingsText = new TextRenderable(renderer, { content: "Loading...", fg: "#e3d3ff" });
  const attentionText = new TextRenderable(renderer, { content: "Loading...", fg: "#ffd6d6" });
  const eventsText = new TextRenderable(renderer, { content: "Loading...", fg: "#ffe0b2" });
  workPanel.add(workText);
  sessionsPanel.add(sessionsText);
  meetingsPanel.add(meetingsText);
  attentionPanel.add(attentionText);
  eventsPanel.add(eventsText);
  right.add(sessionsPanel);
  right.add(meetingsPanel);
  right.add(attentionPanel);
  right.add(eventsPanel);
  body.add(workPanel);
  body.add(right);

  const commandBar = new BoxRenderable(renderer, { height: 3, border: true, borderColor: "#d7ff4f", title: " HUMAN INPUT ", paddingX: 1 });
  const input = new InputRenderable(renderer, { width: "100%", placeholder: "/note <session-id> ... | /meeting <id> ... | /decision <work-id> ..." });
  commandBar.add(input);
  const footer = new BoxRenderable(renderer, { height: 1, paddingX: 2, backgroundColor: "#171c26" });
  const statusText = new TextRenderable(renderer, { content: "Ctrl+R refresh  Ctrl+Q quit  Enter submit", fg: "#8996a8" });
  footer.add(statusText);

  root.add(header);
  root.add(body);
  root.add(commandBar);
  root.add(footer);
  renderer.root.add(root);

  const refresh = () => {
    try {
      const snapshot = dashboardSnapshot(controlPlane, projectId);
      workText.content = snapshot.work;
      sessionsText.content = snapshot.sessions;
      meetingsText.content = snapshot.meetings;
      attentionText.content = snapshot.attention;
      eventsText.content = snapshot.events;
      headerText.content = `LINEAR CREW  /  ${projectId}  /  ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      statusText.content = error instanceof Error ? error.message : String(error);
    }
  };

  input.on(InputRenderableEvents.ENTER, () => {
    const command = input.value.trim();
    const note = /^\/note\s+(\S+)\s+(.+)$/.exec(command);
    const meetingNote = /^\/meeting\s+(\S+)\s+(.+)$/.exec(command);
    const workNote = /^\/(work|decision|constraint)\s+(\S+)\s+(.+)$/.exec(command);
    if ((!note?.[1] || !note[2]) && (!meetingNote?.[1] || !meetingNote[2]) && (!workNote?.[1] || !workNote[2] || !workNote[3])) {
      statusText.content = "Use /note, /meeting, /work, /decision or /constraint with a full target id";
      return;
    }
    try {
      if (meetingNote?.[1] && meetingNote[2]) {
        controlPlane.addContextNote(projectId, { meetingId: meetingNote[1], author: "human:tui", content: meetingNote[2] });
      } else if (workNote?.[1] && workNote[2] && workNote[3]) {
        const kind = workNote[1] === "decision" ? "decision" : workNote[1] === "constraint" ? "constraint" : "context";
        controlPlane.addContextNote(projectId, { workItemId: workNote[2], kind, author: "human:tui", content: workNote[3] });
      } else {
        controlPlane.addContextNote(projectId, { sessionId: note![1]!, author: "human:tui", content: note![2]! });
      }
      input.value = "";
      statusText.content = `Product context queued for ${short((meetingNote?.[1] ?? workNote?.[2] ?? note?.[1])!)}`;
      refresh();
    } catch (error) {
      statusText.content = error instanceof Error ? error.message : String(error);
    }
  });

  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "q") renderer.destroy();
    if (key.ctrl && key.name === "r") refresh();
  });

  input.focus();
  refresh();
  refreshTimer = setInterval(refresh, refreshMilliseconds);
  await destroyed;
}
