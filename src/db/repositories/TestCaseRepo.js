import { db } from "../db.js";

const VALID_ASSERTION_TYPES = new Set([
  'answer_contains',
  'answer_not_empty',
  'confidence_gte',
  'query_type_is',
  'has_citations',
  // Manage chatbot assertion types — query is sent to /manage/chat.
  // If query starts with "[", it is parsed as a JSON array of messages
  // that run sequentially sharing a session; assertion checks the LAST response.
  'manage_intent_is',          // response.intent === assertion_value
  'manage_response_contains',  // response.response includes assertion_value
  'manage_adds_content',       // response.changes has entries (assertion_value ignored)
  'manage_no_changes',         // response.changes is empty or absent
  'manage_status_ok',          // response is not an error (assertion_value ignored)
]);

export { VALID_ASSERTION_TYPES };

export const TestCaseRepo = {
  getAll() {
    return db.prepare("SELECT * FROM test_cases ORDER BY id").all();
  },

  getEnabled() {
    return db.prepare("SELECT * FROM test_cases WHERE enabled = 1 ORDER BY id").all();
  },

  getById(id) {
    return db.prepare("SELECT * FROM test_cases WHERE id = ?").get(id);
  },

  insert({ name, description = '', query, assertion_type, assertion_value = '', suite = '', tags_json = '[]', priority = 2 }) {
    if (!VALID_ASSERTION_TYPES.has(assertion_type))
      throw Object.assign(new Error(`Invalid assertion_type '${assertion_type}'`), { status: 400 });
    const r = db.prepare(
      `INSERT INTO test_cases (name, description, query, assertion_type, assertion_value, suite, tags_json, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(name, description, query, assertion_type, assertion_value, suite, tags_json, priority);
    return TestCaseRepo.getById(r.lastInsertRowid);
  },

  update(id, fields) {
    if (fields.assertion_type && !VALID_ASSERTION_TYPES.has(fields.assertion_type))
      throw Object.assign(new Error(`Invalid assertion_type '${fields.assertion_type}'`), { status: 400 });
    const { name, description, query, assertion_type, assertion_value, enabled, suite, tags_json, priority } = fields;
    db.prepare(
      `UPDATE test_cases
       SET name           = COALESCE(?, name),
           description    = COALESCE(?, description),
           query          = COALESCE(?, query),
           assertion_type  = COALESCE(?, assertion_type),
           assertion_value = COALESCE(?, assertion_value),
           enabled        = COALESCE(?, enabled),
           suite          = COALESCE(?, suite),
           tags_json      = COALESCE(?, tags_json),
           priority       = COALESCE(?, priority),
           updated_at     = datetime('now')
       WHERE id = ?`
    ).run(
      name            ?? null,
      description     ?? null,
      query           ?? null,
      assertion_type  ?? null,
      assertion_value ?? null,
      enabled        != null ? (enabled ? 1 : 0) : null,
      suite           ?? null,
      tags_json       ?? null,
      priority        ?? null,
      id
    );
    return TestCaseRepo.getById(id);
  },

  delete(id) {
    return db.prepare("DELETE FROM test_cases WHERE id = ?").run(id);
  }
};
