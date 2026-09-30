import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));",
    );
  }
  all<T>(kind: string): T[] {
    return this.db
      .prepare("SELECT body FROM records WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map((r) => JSON.parse(String(r.body)));
  }
  get<T>(kind: string, id: string): T {
    const row = this.db
      .prepare("SELECT body FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    if (!row) throw new Error(`${kind} not found`);
    return JSON.parse(String(row.body));
  }
  put<T extends { id: string }>(kind: string, value: T): T {
    this.db
      .prepare(
        "INSERT INTO records(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
      )
      .run(kind, value.id, JSON.stringify(value));
    return value;
  }
  patch<T extends { id: string }>(
    kind: string,
    id: string,
    patch: Partial<T>,
  ): T {
    return this.put(kind, { ...this.get<T>(kind, id), ...patch });
  }
}
