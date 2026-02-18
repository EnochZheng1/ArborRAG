/**
 * db.js — Request-scoped database access via Proxy + AsyncLocalStorage.
 *
 * All 23+ modules that `import { db } from '../db/db.js'` continue to work
 * unchanged. The Proxy transparently forwards every property access and method
 * call to whichever dataset connection is active for the current HTTP request
 * (set by the middleware in server.js via runWithDb).
 *
 * Outside a request context (e.g. the background job pump) the Proxy falls
 * back to the default dataset connection set by setDefaultDb().
 */
import { getActiveDb } from "./activeDb.js";
import { initDatasetManager } from "./datasetManager.js";
import { dbLogger as logger } from "../utils/logger.js";

/**
 * A Proxy that forwards all property accesses to the currently active
 * better-sqlite3 connection. Symbols and 'then' are guarded to prevent
 * the object from accidentally being treated as a Promise.
 */
export const db = new Proxy(
  {},
  {
    get(_target, prop) {
      // Prevent accidentally making this look like a thenable / iterable
      if (prop === "then" || typeof prop === "symbol") return undefined;

      const active = getActiveDb();
      if (!active) {
        throw new Error(
          "No active database connection. initDb() must be called before any DB access."
        );
      }

      const val = active[prop];
      return typeof val === "function" ? val.bind(active) : val;
    }
  }
);

/** Initialize all datasets and the connection pool. Called once at startup. */
export function initDb() {
  logger.info("Initializing dataset manager...");
  initDatasetManager();
  logger.info("Database initialization complete");
}

// ── Utility helpers ─────────────────────────────────────────────────────────
// These are kept here for backward-compatibility with all importing modules.

/** Safely parse JSON, returning fallback on failure. */
export function safeJson(s, fallback = null) {
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

/** Insert a row into audit_log for the active dataset. */
export function logAudit(action, tableName, recordId, oldValue = null, newValue = null) {
  db.prepare(`
    INSERT INTO audit_log (action, table_name, record_id, old_value_json, new_value_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    action,
    tableName,
    String(recordId),
    oldValue ? JSON.stringify(oldValue) : null,
    newValue ? JSON.stringify(newValue) : null
  );
}

/** Run fn() inside a SQLite transaction on the active dataset connection. */
export function runTransaction(fn) {
  return db.transaction(fn)();
}
