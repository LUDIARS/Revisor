// @implements spec/feature/approved-push-handoff.md — durable single-attempt ledger
import { openRevisorDatabase } from "./revisor-db.mjs";

export class PushHandoffStore {
  constructor(path) {
    this.db = openRevisorDatabase(path);
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS push_handoffs (
        id TEXT PRIMARY KEY, digest TEXT NOT NULL, document TEXT NOT NULL,
        session_id TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL,
        updated_at TEXT NOT NULL)`);
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  find(id) {
    const row = this.db.prepare("SELECT * FROM push_handoffs WHERE id=?").get(id);
    return row ? { ...row, document: JSON.parse(row.document), detail: JSON.parse(row.detail) } : null;
  }
  create(handoff, sessionId, digest, now) {
    const result = this.db.prepare(`INSERT OR IGNORE INTO push_handoffs
      (id,digest,document,session_id,status,detail,updated_at) VALUES(?,?,?,?,'awaiting_approval','{}',?)`)
      .run(handoff.id, digest, JSON.stringify(handoff), sessionId, now);
    return result.changes === 1;
  }
  transition(id, from, to, detail, now) {
    const result = this.db.prepare("UPDATE push_handoffs SET status=?,detail=?,updated_at=? WHERE id=? AND status=?")
      .run(to, JSON.stringify(detail), now, id, from);
    if (result.changes !== 1) throw new Error("Handoff ownership changed; refusing publication");
  }
}
