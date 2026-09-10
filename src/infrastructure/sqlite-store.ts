import { Database } from "bun:sqlite";
import type { DomainEvent, EntityKind, NewEvent } from "../domain/types.ts";

interface EntityRow {
  payload: string;
}

interface EventRow {
  sequence: number;
  id: string;
  project_id: string;
  type: string;
  aggregate_kind: EntityKind;
  aggregate_id: string;
  actor: string;
  payload: string;
  occurred_at: string;
}

export class SqliteStore {
  readonly #db: Database;

  constructor(filename = Bun.env.LINEAR_CREW_DB ?? "linear-crew.sqlite") {
    this.#db = new Database(filename, { create: true, strict: true });
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        payload TEXT NOT NULL CHECK(json_valid(payload)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      );
      CREATE INDEX IF NOT EXISTS entities_project_kind
        ON entities(project_id, kind, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_lease_per_workspace
        ON entities(json_extract(payload, '$.workspaceId'))
        WHERE kind = 'lease' AND json_extract(payload, '$.status') = 'active';
      CREATE UNIQUE INDEX IF NOT EXISTS one_live_session_per_delegation
        ON entities(json_extract(payload, '$.delegationId'))
        WHERE kind = 'session'
          AND json_extract(payload, '$.delegationId') IS NOT NULL
          AND json_extract(payload, '$.status') IN ('active', 'waiting', 'unknown');
      CREATE UNIQUE INDEX IF NOT EXISTS one_live_session_per_meeting_participant
        ON entities(
          json_extract(payload, '$.meetingId'),
          json_extract(payload, '$.roleKey'),
          json_extract(payload, '$.workspaceId')
        )
        WHERE kind = 'session'
          AND json_extract(payload, '$.meetingId') IS NOT NULL
          AND json_extract(payload, '$.status') IN ('active', 'waiting', 'unknown');
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL,
        aggregate_kind TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload TEXT NOT NULL CHECK(json_valid(payload)),
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_project_sequence
        ON events(project_id, sequence);
    `);
  }

  close(): void {
    this.#db.close();
  }

  get<T>(kind: EntityKind, id: string): T | null {
    const row = this.#db
      .query<EntityRow, [EntityKind, string]>(
        "SELECT payload FROM entities WHERE kind = ? AND id = ?",
      )
      .get(kind, id);
    return row ? (JSON.parse(row.payload) as T) : null;
  }

  list<T>(kind: EntityKind, projectId?: string): T[] {
    const rows = projectId
      ? this.#db
          .query<EntityRow, [EntityKind, string]>(
            "SELECT payload FROM entities WHERE kind = ? AND project_id = ? ORDER BY created_at",
          )
          .all(kind, projectId)
      : this.#db
          .query<EntityRow, [EntityKind]>(
            "SELECT payload FROM entities WHERE kind = ? ORDER BY created_at",
          )
          .all(kind);
    return rows.map((row) => JSON.parse(row.payload) as T);
  }

  create<T extends { id: string; createdAt: string }>(
    kind: EntityKind,
    projectId: string,
    entity: T,
    event: NewEvent,
  ): T {
    const transaction = this.#db.transaction(() => {
      this.#db
        .query(
          "INSERT INTO entities(kind, id, project_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(kind, entity.id, projectId, JSON.stringify(entity), entity.createdAt, entity.createdAt);
      this.#appendEvent(event);
    });
    transaction();
    return entity;
  }

  update<T extends { id: string }>(
    kind: EntityKind,
    projectId: string,
    entity: T,
    event: NewEvent,
  ): T {
    const now = new Date().toISOString();
    const transaction = this.#db.transaction(() => {
      const result = this.#db
        .query("UPDATE entities SET payload = ?, updated_at = ? WHERE kind = ? AND id = ?")
        .run(JSON.stringify(entity), now, kind, entity.id);
      if (result.changes !== 1) throw new Error(`Cannot update missing ${kind} ${entity.id}`);
      this.#appendEvent(event);
    });
    transaction();
    return entity;
  }

  events(projectId: string, after = 0): DomainEvent[] {
    const rows = this.#db
      .query<EventRow, [string, number]>(
        "SELECT * FROM events WHERE project_id = ? AND sequence > ? ORDER BY sequence",
      )
      .all(projectId, after);
    return rows.map((row) => ({
      sequence: row.sequence,
      id: row.id,
      projectId: row.project_id,
      type: row.type,
      aggregateKind: row.aggregate_kind,
      aggregateId: row.aggregate_id,
      actor: row.actor,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      occurredAt: row.occurred_at,
    }));
  }

  #appendEvent(event: NewEvent): void {
    this.#db
      .query(
        "INSERT INTO events(id, project_id, type, aggregate_kind, aggregate_id, actor, payload, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        crypto.randomUUID(),
        event.projectId,
        event.type,
        event.aggregateKind,
        event.aggregateId,
        event.actor,
        JSON.stringify(event.payload ?? {}),
        new Date().toISOString(),
      );
  }
}
