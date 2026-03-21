/**
 * Tests API — manage user-defined test cases + persistent test runs.
 *
 * Test Cases (existing):
 *   GET    /tests            — list all test cases for current dataset
 *   POST   /tests            — create a new test case
 *   PUT    /tests/:id        — update an existing test case
 *   DELETE /tests/:id        — delete a test case
 *
 * Test Runs (new — Phase 1):
 *   GET    /tests/env                     — current environment metadata snapshot
 *   GET    /tests/runs                    — list runs (paginated)
 *   POST   /tests/runs                    — create a new run
 *   GET    /tests/runs/:id                — run + items
 *   PUT    /tests/runs/:id/finish         — finalize run
 *   DELETE /tests/runs/:id                — delete run + cascade items
 *   POST   /tests/runs/:id/items          — batch-insert item shells
 *   PUT    /tests/runs/:id/items/:itemId  — update single item result
 *   PUT    /tests/runs/:id/baseline       — mark as baseline
 */

import express from "express";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { TestCaseRepo } from "../db/repositories/TestCaseRepo.js";
import { TestRunRepo } from "../db/repositories/TestRunRepo.js";
import { DatasetConfigRepo } from "../db/repositories/DatasetConfigRepo.js";
import { llmConfig } from "../utils/llm.js";
import { getActiveDatasetId } from "../db/activeDb.js";
import { getDataset } from "../db/registry.js";
import { apiLogger as logger } from "../utils/logger.js";
import { ApiError } from "../utils/apiError.js";
import { requireBody } from "../utils/validate.js";

const router = express.Router();

// ── Cached startup values ────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let _appVersion = '0.0.0';
let _gitCommit = 'unknown';

try {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf-8'));
  _appVersion = pkg.version || '0.0.0';
} catch (_) { /* deploy-safe */ }

try {
  _gitCommit = process.env.GIT_COMMIT || execSync('git rev-parse --short HEAD', { encoding: 'utf-8', timeout: 3000 }).trim();
} catch (_) { _gitCommit = 'unknown'; }

// ══════════════════════════════════════════════════════════════════════════════
// Test Cases (existing CRUD — unchanged)
// ══════════════════════════════════════════════════════════════════════════════

router.get("/tests", (req, res) => {
  try {
    res.json({ test_cases: TestCaseRepo.getAll() });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error("GET /tests error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

router.post("/tests", (req, res) => {
  try {
    requireBody(req.body, 'name', 'query', 'assertion_type');
    const { name, description, query, assertion_type, assertion_value } = req.body;

    const tc = TestCaseRepo.insert({
      name: name.trim(),
      description: description?.trim() || '',
      query: query.trim(),
      assertion_type: assertion_type.trim(),
      assertion_value: assertion_value?.trim() || ''
    });
    res.status(201).json({ test_case: tc });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error("POST /tests error:", err.message);
    res.status(err.status || 500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

router.put("/tests/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = TestCaseRepo.getById(id);
    if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: "Test case not found" } });

    const { name, description, query, assertion_type, assertion_value, enabled } = req.body || {};
    const tc = TestCaseRepo.update(id, {
      name:            name?.trim()           || undefined,
      description:     description?.trim()    ?? undefined,
      query:           query?.trim()          || undefined,
      assertion_type:  assertion_type?.trim() || undefined,
      assertion_value: assertion_value?.trim() ?? undefined,
      enabled
    });
    res.json({ test_case: tc });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error("PUT /tests/:id error:", err.message);
    res.status(err.status || 500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

router.delete("/tests/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = TestCaseRepo.getById(id);
    if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: "Test case not found" } });
    TestCaseRepo.delete(id);
    res.json({ success: true });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error("DELETE /tests/:id error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// Environment Snapshot
// ══════════════════════════════════════════════════════════════════════════════

router.get("/tests/env", (req, res) => {
  try {
    const datasetId = getActiveDatasetId();
    const dataset = datasetId ? getDataset(datasetId) : null;
    const p = llmConfig.provider;

    res.json({
      app_version: _appVersion,
      git_commit: _gitCommit,
      dataset_id: datasetId || 'unknown',
      dataset_name: dataset?.name || 'Unknown',
      provider: p,
      llm_model: llmConfig[p]?.model || 'unknown',
      embedding_model: llmConfig[p]?.embeddingModel || 'unknown',
      tree_routing_mode: DatasetConfigRepo.get('tree_routing_mode') || 'keyword',
      mapping_mode: DatasetConfigRepo.get('mapping_mode') || 'free',
      schema_version: parseInt(DatasetConfigRepo.get('schema_version') || '0', 10),
      ingest_auto_embed: process.env.INGEST_AUTO_EMBED === 'true'
    });
  } catch (err) {
    logger.error("GET /tests/env error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// Test Runs
// ══════════════════════════════════════════════════════════════════════════════

// ── List runs ────────────────────────────────────────────────────────────────

router.get("/tests/runs", (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = parseInt(req.query.offset, 10) || 0;
    const runs = TestRunRepo.getAll({ limit, offset });
    res.json({ runs });
  } catch (err) {
    logger.error("GET /tests/runs error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── Create run ───────────────────────────────────────────────────────────────

router.post("/tests/runs", (req, res) => {
  try {
    const { name, trigger_type, mode, test_count, env_json } = req.body || {};
    const run = TestRunRepo.createRun({
      name: name || '',
      triggerType: trigger_type || 'manual',
      mode: mode || 'isolated',
      testCount: parseInt(test_count, 10) || 0,
      envJson: env_json || '{}'
    });
    res.status(201).json({ run });
  } catch (err) {
    logger.error("POST /tests/runs error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── Get run + items ──────────────────────────────────────────────────────────

router.get("/tests/runs/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const run = TestRunRepo.getById(id);
    if (!run) return res.status(404).json({ error: { code: 'NOT_FOUND', message: "Test run not found" } });
    const items = TestRunRepo.getItemsByRunId(id);
    res.json({ run, items });
  } catch (err) {
    logger.error("GET /tests/runs/:id error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── Finish run ───────────────────────────────────────────────────────────────

router.put("/tests/runs/:id/finish", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = TestRunRepo.getById(id);
    if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: "Test run not found" } });

    const { status, passed_count, failed_count, skipped_count, error_count, duration_ms } = req.body || {};
    const run = TestRunRepo.finishRun(id, {
      status: status || 'completed',
      passedCount: parseInt(passed_count, 10) || 0,
      failedCount: parseInt(failed_count, 10) || 0,
      skippedCount: parseInt(skipped_count, 10) || 0,
      errorCount: parseInt(error_count, 10) || 0,
      durationMs: parseInt(duration_ms, 10) || 0
    });
    res.json({ run });
  } catch (err) {
    logger.error("PUT /tests/runs/:id/finish error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── Delete run ───────────────────────────────────────────────────────────────

router.delete("/tests/runs/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = TestRunRepo.getById(id);
    if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: "Test run not found" } });
    TestRunRepo.deleteRun(id);
    res.json({ success: true });
  } catch (err) {
    logger.error("DELETE /tests/runs/:id error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── Batch-insert item shells ─────────────────────────────────────────────────

router.post("/tests/runs/:id/items", (req, res) => {
  try {
    const runId = parseInt(req.params.id, 10);
    const existing = TestRunRepo.getById(runId);
    if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: "Test run not found" } });

    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: "items array is required" } });
    }

    const toInsert = items.map((item, i) => ({
      runId,
      testId: item.test_id || `test_${i}`,
      testName: item.test_name || '',
      category: item.category || '',
      assertionType: item.assertion_type || '',
      assertionValue: item.assertion_value || '',
      query: item.query || '',
      runOrder: item.run_order ?? i
    }));

    const results = TestRunRepo.insertItems(toInsert);
    res.status(201).json({ items: results });
  } catch (err) {
    logger.error("POST /tests/runs/:id/items error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── Update single item ───────────────────────────────────────────────────────

router.put("/tests/runs/:id/items/:itemId", (req, res) => {
  try {
    const itemId = parseInt(req.params.itemId, 10);
    const fields = req.body || {};
    TestRunRepo.updateItem(itemId, fields);
    res.json({ success: true });
  } catch (err) {
    logger.error("PUT /tests/runs/:id/items/:itemId error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── Set baseline ─────────────────────────────────────────────────────────────

router.put("/tests/runs/:id/baseline", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = TestRunRepo.getById(id);
    if (!existing) return res.status(404).json({ error: { code: 'NOT_FOUND', message: "Test run not found" } });
    const run = TestRunRepo.setBaseline(id);
    res.json({ run });
  } catch (err) {
    logger.error("PUT /tests/runs/:id/baseline error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

export default router;
