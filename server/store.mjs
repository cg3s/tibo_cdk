import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const RECONCILE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

export function openStore(filename) {
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS redemptions (
      reference TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      recovery_hash TEXT NOT NULL UNIQUE,
      product_name TEXT NOT NULL,
      target_plan TEXT,
      task TEXT
    );
    CREATE TABLE IF NOT EXISTS browser_sessions (
      token_hash TEXT PRIMARY KEY,
      reference TEXT NOT NULL REFERENCES redemptions(reference),
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS code_claims (
      code_hash TEXT PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE REFERENCES redemptions(reference)
    );
    CREATE TABLE IF NOT EXISTS submissions (
      revision INTEGER PRIMARY KEY,
      reference TEXT NOT NULL REFERENCES redemptions(reference),
      business_key TEXT NOT NULL UNIQUE,
      body_hash TEXT NOT NULL,
      first_sent_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','unknown','accepted','rejected')),
      request_id TEXT
    );
    CREATE INDEX IF NOT EXISTS submissions_by_reference ON submissions(reference, revision DESC);
    CREATE INDEX IF NOT EXISTS redemptions_by_order
      ON redemptions(json_extract(task, '$.orderId')) WHERE task IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS open_submission
      ON submissions(reference) WHERE state IN ('pending','unknown');
    CREATE TABLE IF NOT EXISTS webhook_receipts (
      event_id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS webhook_checks (
      order_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      retries INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS webhook_checks_due ON webhook_checks(next_attempt_at);
    UPDATE submissions SET state = 'unknown' WHERE state = 'pending';
    DELETE FROM browser_sessions WHERE expires_at <= unixepoch('subsec') * 1000;
  `);

  const byReference = db.prepare("SELECT * FROM redemptions WHERE reference = ?");
  const latest = db.prepare("SELECT * FROM submissions WHERE reference = ? ORDER BY revision DESC LIMIT 1");
  const claim = db.prepare("SELECT reference FROM code_claims WHERE code_hash = ?");
  const setTask = db.prepare("UPDATE redemptions SET task = ? WHERE reference = ?");

  function read(reference) {
    const row = byReference.get(reference);
    if (!row) return null;
    return {
      ...row,
      task: row.task ? JSON.parse(row.task) : null,
      submission: latest.get(reference),
    };
  }

  function transaction(work) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    read,
    close: () => db.close(),
    recordsForOrder(orderId) {
      return db.prepare(`
        SELECT reference FROM redemptions WHERE task IS NOT NULL AND json_extract(task, '$.orderId') = ?
      `).all(orderId).map(({ reference }) => read(reference));
    },
    markOrderRefunded(orderId) {
      db.prepare(`
        UPDATE redemptions SET task = json_set(task, '$.orderRefunded', json('true'))
        WHERE task IS NOT NULL AND json_extract(task, '$.orderId') = ?
      `).run(orderId);
    },
    receiveWebhook({ id, orderId }) {
      return transaction(() => {
        const receipt = db.prepare("INSERT INTO webhook_receipts VALUES (?) ON CONFLICT DO NOTHING").run(id);
        if (!receipt.changes || !orderId) return false;
        const now = Date.now();
        db.prepare(`
          INSERT INTO webhook_checks (order_id, generation, received_at, next_attempt_at)
          VALUES (?, 1, ?, ?)
          ON CONFLICT(order_id) DO UPDATE SET generation = generation + 1, received_at = excluded.received_at
        `).run(orderId, now, now);
        return true;
      });
    },
    dueWebhookChecks(now) {
      return db.prepare("SELECT * FROM webhook_checks WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 10").all(now);
    },
    finishWebhookCheck(check, retryInMs) {
      if (retryInMs === undefined) {
        db.prepare("DELETE FROM webhook_checks WHERE order_id = ? AND generation = ?")
          .run(check.order_id, check.generation);
        return;
      }
      db.prepare(`
        UPDATE webhook_checks SET next_attempt_at = ?, retries = retries + 1 WHERE order_id = ?
      `).run(Date.now() + retryInMs, check.order_id);
    },
    claimed: (codeHash) => claim.get(codeHash)?.reference,
    create({ reference, codeHash, recoveryHash, productName, targetPlan }) {
      db.prepare("INSERT INTO redemptions VALUES (?, ?, ?, ?, ?, NULL)")
        .run(reference, codeHash, recoveryHash, productName, targetPlan);
    },
    attach(reference, tokenHash) {
      db.prepare("INSERT INTO browser_sessions VALUES (?, ?, ?)")
        .run(tokenHash, reference, Date.now() + SESSION_MAX_AGE * 1000);
    },
    detach(tokenHash) {
      db.prepare("DELETE FROM browser_sessions WHERE token_hash = ?").run(tokenHash);
    },
    browserRecord(tokenHash) {
      const session = db.prepare("SELECT reference FROM browser_sessions WHERE token_hash = ? AND expires_at > ?")
        .get(tokenHash, Date.now());
      return session ? read(session.reference) : null;
    },
    recover(codeHash, recoveryHash) {
      return db.prepare("SELECT reference FROM redemptions WHERE code_hash = ? AND recovery_hash = ?")
        .get(codeHash, recoveryHash)?.reference;
    },
    startSubmission({ reference, expectedRevision, businessKey, bodyHash, reconcile }) {
      return transaction(() => {
        const record = read(reference);
        const previous = record.submission;
        if ((previous?.revision ?? 0) !== expectedRevision || previous?.state === "pending") {
          return { reason: "changed" };
        }
        if (reconcile) {
          if (previous?.state !== "unknown" || previous.body_hash !== bodyHash ||
              Date.now() - previous.first_sent_at >= RECONCILE_WINDOW_MS) {
            return { reason: "cannot_reconcile" };
          }
          db.prepare("UPDATE submissions SET state = 'pending' WHERE revision = ?").run(previous.revision);
          return { revision: previous.revision, businessKey: previous.business_key };
        }
        if (previous?.state === "unknown") return { reason: "changed" };
        const existing = claim.get(record.code_hash);
        if (existing && existing.reference !== reference) return { reason: "already_claimed" };
        if (!existing) {
          db.prepare("INSERT INTO code_claims VALUES (?, ?)").run(record.code_hash, reference);
        }
        const inserted = db.prepare(`
          INSERT INTO submissions (reference, business_key, body_hash, first_sent_at, state)
          VALUES (?, ?, ?, ?, 'pending')
        `).run(reference, businessKey, bodyHash, Date.now());
        return { revision: Number(inserted.lastInsertRowid), businessKey };
      });
    },
    finishSubmission(reference, revision, state, requestId = null, task = null) {
      return transaction(() => {
        const result = db.prepare(`
          UPDATE submissions SET state = ?, request_id = COALESCE(?, request_id)
          WHERE reference = ? AND revision = ? AND state = 'pending'
        `).run(state, requestId, reference, revision);
        if (!result.changes) return;
        if (task) {
          const oldTask = read(reference).task;
          if (oldTask?.orderId === task.orderId && oldTask.orderRefunded) task.orderRefunded = true;
          setTask.run(JSON.stringify(task), reference);
        }
        if (state === "rejected" && !read(reference).task) {
          db.prepare("DELETE FROM code_claims WHERE reference = ?").run(reference);
        }
      });
    },
    applyStatus(reference, previousTaskId, task) {
      return transaction(() => {
        const record = read(reference);
        if (record.task?.id !== previousTaskId || record.submission?.state === "pending") return;
        if (record.task.attempt !== null && task.attempt !== null && task.attempt < record.task.attempt) return;
        const sameTask = task.id === previousTaskId;
        if (sameTask && record.task.version !== null && task.version !== null &&
            task.version < record.task.version) return;
        if (sameTask && task.version === null && record.task.version !== null) return;
        if (sameTask && record.task.version !== null && task.version === record.task.version &&
            task.status !== record.task.status) return;
        if (sameTask && ["succeeded", "failed", "cancelled"].includes(record.task.status) &&
            ["queued", "running"].includes(task.status) &&
            !(task.version !== null && task.version > (record.task.version ?? -1))) return;
        if (record.task.orderRefunded) task.orderRefunded = true;
        setTask.run(JSON.stringify(task), reference);
        if (!sameTask && record.submission?.state === "unknown") {
          db.prepare("UPDATE submissions SET state = 'accepted' WHERE revision = ?")
            .run(record.submission.revision);
        }
        return true;
      });
    },
  };
}
