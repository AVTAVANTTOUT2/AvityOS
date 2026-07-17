import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Thin wrapper over the built-in node:sqlite driver (zero native
 * dependencies, ADR-0003). Provides a better-sqlite3-style `transaction()`
 * helper with join-outer semantics for nested calls.
 */
export class DB {
  private txDepth = 0;

  constructor(readonly raw: DatabaseSync) {}

  prepare(sql: string): StatementSync {
    return this.raw.prepare(sql);
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  pragma(setting: string): void {
    this.raw.exec(`PRAGMA ${setting}`);
  }

  transaction<T>(fn: () => T): () => T {
    return () => {
      if (this.txDepth > 0) {
        this.txDepth += 1;
        try {
          return fn();
        } finally {
          this.txDepth -= 1;
        }
      }
      this.raw.exec("BEGIN IMMEDIATE");
      this.txDepth = 1;
      try {
        const result = fn();
        this.raw.exec("COMMIT");
        return result;
      } catch (err) {
        this.raw.exec("ROLLBACK");
        throw err;
      } finally {
        this.txDepth = 0;
      }
    };
  }

  close(): void {
    this.raw.close();
  }
}

/**
 * Ordered, transactional migrations. Never edit an applied migration —
 * append a new one. Versions are recorded in schema_migrations.
 */
const MIGRATIONS: readonly { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        repo_path TEXT,
        repo_remote_url TEXT,
        default_branch TEXT NOT NULL DEFAULT 'main',
        autonomy_profile TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE idempotency_keys (
        key TEXT PRIMARY KEY,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE objectives (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        revision INTEGER NOT NULL,
        text TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL DEFAULT '[]',
        analysis_summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE clarifications (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        objective_id TEXT NOT NULL REFERENCES objectives(id),
        status TEXT NOT NULL,
        questions TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE brain_entries (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        sources TEXT NOT NULL DEFAULT '[]',
        superseded_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE plans (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        version INTEGER NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        milestones TEXT NOT NULL DEFAULT '[]',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        plan_id TEXT,
        milestone_id TEXT,
        title TEXT NOT NULL,
        role TEXT NOT NULL,
        state TEXT NOT NULL,
        contract TEXT NOT NULL,
        branch_name TEXT,
        worktree_path TEXT,
        correction_attempts INTEGER NOT NULL DEFAULT 0,
        max_correction_attempts INTEGER NOT NULL DEFAULT 3,
        priority INTEGER NOT NULL DEFAULT 50,
        state_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_missions_project_state ON missions(project_id, state);

      CREATE TABLE mission_deps (
        mission_id TEXT NOT NULL REFERENCES missions(id),
        depends_on_mission_id TEXT NOT NULL REFERENCES missions(id),
        PRIMARY KEY (mission_id, depends_on_mission_id)
      );

      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        mission_id TEXT NOT NULL REFERENCES missions(id),
        agent_profile_id TEXT,
        worker_id TEXT,
        provider_id TEXT,
        model TEXT,
        state TEXT NOT NULL,
        exit_reason TEXT,
        error_category TEXT,
        started_at TEXT,
        ended_at TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_runs_mission ON runs(mission_id);

      CREATE TABLE run_logs (
        run_id TEXT NOT NULL REFERENCES runs(id),
        seq INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );

      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        project_id TEXT,
        mission_id TEXT,
        run_id TEXT,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_events_project ON events(project_id, seq);

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        mission_id TEXT,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        decision TEXT,
        decided_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE checkpoints (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        mission_id TEXT NOT NULL REFERENCES missions(id),
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        evidence_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE usage_records (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        run_id TEXT,
        provider_id TEXT,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE budgets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
        limit_usd REAL NOT NULL,
        spent_usd REAL NOT NULL DEFAULT 0,
        warn_at_fraction REAL NOT NULL DEFAULT 0.8,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE audit_entries (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        project_id TEXT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        entry_hash TEXT NOT NULL,
        previous_hash TEXT
      );

      CREATE TABLE providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        adapter TEXT NOT NULL,
        base_url TEXT,
        auth_method TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        models TEXT NOT NULL DEFAULT '[]',
        default_model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE workers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        capabilities TEXT NOT NULL DEFAULT '[]',
        last_heartbeat_at TEXT,
        max_concurrent_runs INTEGER NOT NULL DEFAULT 4,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
];

export function openDatabase(dbPath: string): DB {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DB(new DatabaseSync(dbPath));
  if (dbPath !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        new Date().toISOString(),
      );
    });
    apply();
  }
}
