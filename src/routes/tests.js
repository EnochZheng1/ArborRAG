/**
 * Tests API — manage user-defined test cases.
 *
 * GET    /tests        — list all test cases for current dataset
 * POST   /tests        — create a new test case
 * PUT    /tests/:id    — update an existing test case
 * DELETE /tests/:id    — delete a test case
 */

import express from "express";
import { TestCaseRepo } from "../db/repositories/TestCaseRepo.js";
import { apiLogger as logger } from "../utils/logger.js";
import { ApiError } from "../utils/apiError.js";
import { requireBody } from "../utils/validate.js";

const router = express.Router();

// ── List ──────────────────────────────────────────────────────────────────────

router.get("/tests", (req, res) => {
  try {
    res.json({ test_cases: TestCaseRepo.getAll() });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error("GET /tests error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── Create ────────────────────────────────────────────────────────────────────

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

// ── Update ────────────────────────────────────────────────────────────────────

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

// ── Delete ────────────────────────────────────────────────────────────────────

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

export default router;
