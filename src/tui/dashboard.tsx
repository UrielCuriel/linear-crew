import { useRuntime } from "@bunli/runtime/app";
import { Stack, useKeyboard } from "@bunli/tui";
import { createElement, useEffect, useState, type ReactNode } from "react";
import { ControlPlane } from "../application/control-plane.ts";
import type { DomainEvent } from "../domain/types.ts";
import { SqliteStore } from "../infrastructure/sqlite-store.ts";

export interface DashboardSnapshot {
  work: string;
  sessions: string;
  meetings: string;
  attention: string;
  events: string;
}

const short = (id: string) => id.slice(0, 8);

function Box({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) {
  return createElement("box" as never, props, children);
}

function Text({ content, fg }: { content: string; fg?: string }) {
  return createElement("text" as never, { content, fg });
}

function Input(props: { value: string; placeholder: string; onInput: (value: string) => void; onSubmit: () => void }) {
  return createElement("input" as never, { ...props, focused: true, style: { flexGrow: 1, focusedBackgroundColor: "#171c26" } });
}

export function dashboardSnapshot(controlPlane: ControlPlane, projectId: string): DashboardSnapshot {
  const workItems = controlPlane.listWorkItems(projectId);
  const sessions = controlPlane.listSessions(projectId);
  const interventions = controlPlane.listInterventions(projectId, "open");
  const meetings = controlPlane.listMeetings(projectId).filter((meeting) => meeting.status !== "completed" && meeting.status !== "cancelled");
  const handoffs = controlPlane.listHandoffs(projectId).filter((item) => item.status === "offered" || item.status === "acknowledged");
  const leases = controlPlane.listLeases(projectId).filter((item) => item.status === "active" || item.status === "requested");

  return {
    work: workItems.length ? workItems.map((item) => `${short(item.id)}  ${item.status.padEnd(19)} ${item.type.padEnd(9)} ${item.title}`).join("\n") : "No work items",
    sessions: sessions.length ? sessions.map((session) => `${short(session.id)}  ${session.status.padEnd(9)} ${session.roleKey.padEnd(16)} ${session.agent}`).join("\n") : "No sessions",
    meetings: meetings.length ? meetings.map((meeting) => `${short(meeting.id)}  ${meeting.status.padEnd(12)} R${meeting.round}/${meeting.maxRounds}  ${meeting.objective}`).join("\n") : "No active meetings",
    attention: [
      ...interventions.map((item) => `INTERVENTION ${short(item.id)} -> ${item.targetRoleKey ?? "human"}\n  ${item.message}`),
      ...handoffs.map((item) => `HANDOFF ${short(item.id)} ${item.status} -> ${item.toRoleKey}\n  ${item.nextAction}`),
      ...leases.map((item) => `LEASE ${short(item.id)} ${item.status} workspace:${short(item.workspaceId)}`),
    ].join("\n") || "Nothing needs attention",
    events: formatEvents(controlPlane.events(projectId).slice(-12)),
  };
}

function formatEvents(events: DomainEvent[]): string {
  if (!events.length) return "No events";
  return events.map((event) => `${String(event.sequence).padStart(4)}  ${event.type.padEnd(29)} ${short(event.aggregateId)}`).join("\n");
}

function Dashboard({ database, projectId, refreshMilliseconds }: { database: string; projectId: string; refreshMilliseconds: number }) {
  const runtime = useRuntime();
  const [store] = useState(() => new SqliteStore(database));
  const [controlPlane] = useState(() => new ControlPlane(store));
  const [snapshot, setSnapshot] = useState(() => dashboardSnapshot(controlPlane, projectId));
  const [status, setStatus] = useState("Ctrl+R refresh  Ctrl+Q quit  Enter submit");
  const [command, setCommand] = useState("");
  const [clock, setClock] = useState(() => new Date().toLocaleTimeString());

  const refresh = () => {
    try {
      setSnapshot(dashboardSnapshot(controlPlane, projectId));
      setClock(new Date().toLocaleTimeString());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    const timer = setInterval(refresh, refreshMilliseconds);
    return () => {
      clearInterval(timer);
      store.close();
    };
  }, [controlPlane, projectId, refreshMilliseconds, store]);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "q") runtime.exit();
    if (key.ctrl && key.name === "r") refresh();
  });

  const submit = () => {
    const note = /^\/note\s+(\S+)\s+(.+)$/.exec(command);
    const meetingNote = /^\/meeting\s+(\S+)\s+(.+)$/.exec(command);
    const workNote = /^\/(work|decision|constraint)\s+(\S+)\s+(.+)$/.exec(command);
    if ((!note?.[1] || !note[2]) && (!meetingNote?.[1] || !meetingNote[2]) && (!workNote?.[1] || !workNote[2] || !workNote[3])) {
      setStatus("Use /note, /meeting, /work, /decision or /constraint with a full target id");
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
      setCommand("");
      setStatus(`Product context queued for ${short((meetingNote?.[1] ?? workNote?.[2] ?? note?.[1])!)}`);
      refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Stack gap={1} style={{ width: "100%", height: "100%", backgroundColor: "#0a0d12" }}>
      <Box height={3} paddingX={2} style={{ justifyContent: "center", backgroundColor: "#d7ff4f" }}>
        <Text content={`LINEAR CREW  /  ${projectId}  /  ${clock}`} fg="#11150a" />
      </Box>
      <Box style={{ flexGrow: 1, flexDirection: "row", gap: 1, padding: 1 }}>
        <Box width="50%" border title=" WORK GRAPH " padding={1} style={{ borderColor: "#6272a4" }}>
          <Text content={snapshot.work} fg="#d6deeb" />
        </Box>
        <Stack gap={1} style={{ width: "50%" }}>
          <Box height="30%" border title=" ACTIVE SESSIONS " padding={1} style={{ borderColor: "#55d6be" }}>
            <Text content={snapshot.sessions} fg="#b8f2e6" />
          </Box>
          <Box height="24%" border title=" PLANNING MEETINGS " padding={1} style={{ borderColor: "#bd93f9" }}>
            <Text content={snapshot.meetings} fg="#e3d3ff" />
          </Box>
          <Box height="26%" border title=" ATTENTION QUEUE " padding={1} style={{ borderColor: "#ff6b6b" }}>
            <Text content={snapshot.attention} fg="#ffd6d6" />
          </Box>
          <Box border title=" EVENT STREAM " padding={1} style={{ flexGrow: 1, borderColor: "#ffb86c" }}>
            <Text content={snapshot.events} fg="#ffe0b2" />
          </Box>
        </Stack>
      </Box>
      <Box height={3} border title=" HUMAN INPUT " paddingX={1} style={{ borderColor: "#d7ff4f" }}>
        <Input value={command} onInput={setCommand} onSubmit={submit} placeholder="/note <session-id> ... | /meeting <id> ... | /decision <work-id> ..." />
      </Box>
      <Box height={1} paddingX={2} style={{ backgroundColor: "#171c26" }}>
        <Text content={status} fg="#8996a8" />
      </Box>
    </Stack>
  );
}

export function dashboardView(database: string, projectId: string, refreshMilliseconds = 1000) {
  return <Dashboard database={database} projectId={projectId} refreshMilliseconds={refreshMilliseconds} />;
}
