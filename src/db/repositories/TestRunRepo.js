/**
 * TestRunRepo — CRUD for test_runs + test_run_items tables.
 *
 * Each test execution creates a persistent run with item-level results,
 * enabling run history, regression detection, and baseline comparison.
 */

import { db } from "../db.js";

export const TestRunRepo = {
  // ── Stale run reconciliation ──────────────────────────────────────────────

  /**
   * Auto-cancel runs stuck in 'running' for > 30 minutes.
   * Called lazily from getAll() and getById().
   */
  reconcileStaleRuns() {
    const staleRunIds = db.prepare(`
      SELECT id FROM test_runs
      WHERE status = 'running'
        AND started_at < datetime('now', '-30 minutes')
    `).all().map(r => r.id);

    if (!staleRunIds.length) return;

    const placeholders = staleRunIds.map(() => '?').join(',');

    db.prepare(`
      UPDATE test_runs
      SET status = 'cancelled', finished_at = datetime('now'),
          cancel_reason = 'auto: stale run reconciliation'
      WHERE id IN (${placeholders})
    `).run(...staleRunIds);

    db.prepare(`
      UPDATE test_run_items
      SET status = 'skipped'
      WHERE status IN ('pending', 'running')
        AND run_id IN (${placeholders})
    `).run(...staleRunIds);

    // Recompute summary counts from actual item statuses
    for (const runId of staleRunIds) {
      const counts = db.prepare(`
        SELECT
          COUNT(*) AS test_count,
          SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) AS passed_count,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
          SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count
        FROM test_run_items WHERE run_id = ?
      `).get(runId);

      db.prepare(`
        UPDATE test_runs
        SET test_count = ?, passed_count = ?, failed_count = ?,
            skipped_count = ?, error_count = ?
        WHERE id = ?
      `).run(counts.test_count, counts.passed_count, counts.failed_count,
             counts.skipped_count, counts.error_count, runId);
    }
  },

  // ── Run lifecycle ─────────────────────────────────────────────────────────

  createRun({ name = '', triggerType = 'manual', mode = 'isolated', testCount = 0, envJson = '{}' }) {
    const r = db.prepare(`
      INSERT INTO test_runs (name, trigger_type, mode, test_count, env_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, triggerType, mode, testCount, typeof envJson === 'string' ? envJson : JSON.stringify(envJson));
    return TestRunRepo.getById(r.lastInsertRowid);
  },

  finishRun(id, { status = 'completed', passedCount = 0, failedCount = 0, skippedCount = 0, errorCount = 0, durationMs = 0 }) {
    db.prepare(`
      UPDATE test_runs
      SET status = ?, passed_count = ?, failed_count = ?, skipped_count = ?,
          error_count = ?, duration_ms = ?, finished_at = datetime('now')
      WHERE id = ?
    `).run(status, passedCount, failedCount, skippedCount, errorCount, durationMs, id);
    return TestRunRepo.getById(id);
  },

  cancelRun(id) {
    db.prepare(`
      UPDATE test_runs
      SET status = 'cancelled', finished_at = datetime('now'),
          cancel_reason = 'user cancelled'
      WHERE id = ?
    `).run(id);

    // Mark remaining pending/running items as skipped
    db.prepare(`
      UPDATE test_run_items
      SET status = 'skipped'
      WHERE run_id = ? AND status IN ('pending', 'running')
    `).run(id);

    return TestRunRepo.getById(id);
  },

  getById(id) {
    TestRunRepo.reconcileStaleRuns();
    const row = db.prepare("SELECT * FROM test_runs WHERE id = ?").get(id);
    if (!row) return null;
    row.pass_rate = row.test_count > 0 ? +(row.passed_count / row.test_count).toFixed(4) : 0;
    return row;
  },

  // ── Listing ───────────────────────────────────────────────────────────────

  getAll({ limit = 50, offset = 0 } = {}) {
    TestRunRepo.reconcileStaleRuns();
    const rows = db.prepare(`
      SELECT * FROM test_runs
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(Math.max(1, Number(limit)), Math.max(0, Number(offset)));

    for (const row of rows) {
      row.pass_rate = row.test_count > 0 ? +(row.passed_count / row.test_count).toFixed(4) : 0;
    }
    return rows;
  },

  // ── Items ─────────────────────────────────────────────────────────────────

  insertItem({ runId, testId, testName, category = '', assertionType = '', assertionValue = '', query = '', runOrder = 0 }) {
    const r = db.prepare(`
      INSERT INTO test_run_items (run_id, test_id, test_name, category, assertion_type, assertion_value, query, run_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(runId, testId, testName, category, assertionType, assertionValue, query, runOrder);
    return { id: Number(r.lastInsertRowid), runId, testId, testName };
  },

  insertItems(items) {
    const stmt = db.prepare(`
      INSERT INTO test_run_items (run_id, test_id, test_name, category, assertion_type, assertion_value, query, run_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const results = [];
    for (const item of items) {
      const r = stmt.run(
        item.runId, item.testId, item.testName, item.category || '',
        item.assertionType || '', item.assertionValue || '', item.query || '', item.runOrder || 0
      );
      results.push({ id: Number(r.lastInsertRowid), testId: item.testId });
    }
    return results;
  },

  updateItem(itemId, fields) {
    const sets = [];
    const params = [];

    const mapping = {
      status: 'status', detail: 'detail', confidence: 'confidence',
      retrievalConfidence: 'retrieval_confidence', answerGroundedness: 'answer_groundedness',
      queryType: 'query_type', citationsCount: 'citations_count', chunksUsed: 'chunks_used',
      durationMs: 'duration_ms', responseJson: 'response_json'
    };

    for (const [jsKey, dbCol] of Object.entries(mapping)) {
      if (fields[jsKey] !== undefined) {
        sets.push(`${dbCol} = ?`);
        params.push(fields[jsKey]);
      }
    }

    if (sets.length === 0) return;
    params.push(itemId);
    db.prepare(`UPDATE test_run_items SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  },

  getItemsByRunId(runId) {
    return db.prepare(
      "SELECT * FROM test_run_items WHERE run_id = ? ORDER BY run_order, id"
    ).all(runId);
  },

  // ── Baseline ──────────────────────────────────────────────────────────────

  setBaseline(runId) {
    db.prepare("UPDATE test_runs SET is_baseline = 0 WHERE is_baseline = 1").run();
    db.prepare("UPDATE test_runs SET is_baseline = 1 WHERE id = ?").run(runId);
    return TestRunRepo.getById(runId);
  },

  getBaseline() {
    const row = db.prepare("SELECT * FROM test_runs WHERE is_baseline = 1 LIMIT 1").get();
    if (!row) return null;
    row.pass_rate = row.test_count > 0 ? +(row.passed_count / row.test_count).toFixed(4) : 0;
    return row;
  },

  clearBaseline() {
    db.prepare("UPDATE test_runs SET is_baseline = 0 WHERE is_baseline = 1").run();
  },

  // ── Cleanup ───────────────────────────────────────────────────────────────

  deleteRun(id) {
    return db.prepare("DELETE FROM test_runs WHERE id = ?").run(id);
  }
};
