import { db } from "../db.js";

const VALID_ASSERTION_TYPES = new Set([
  'answer_contains',
  'answer_not_empty',
  'confidence_gte',
  'query_type_is',
  'has_citations'
]);

export { VALID_ASSERTION_TYPES };

export const TestCaseRepo = {
  getAll() {
    return db.prepare("SELECT * FROM test_cases ORDER BY id").all();
  },

  getById(id) {
    return db.prepare("SELECT * FROM test_cases WHERE id = ?").get(id);
  },

  insert({ name, description = '', query, assertion_type, assertion_value = '' }) {
    if (!VALID_ASSERTION_TYPES.has(assertion_type))
      throw Object.assign(new Error(`Invalid assertion_type '${assertion_type}'`), { status: 400 });
    const r = db.prepare(
      `INSERT INTO test_cases (name, description, query, assertion_type, assertion_value)
       VALUES (?, ?, ?, ?, ?)`
    ).run(name, description, query, assertion_type, assertion_value);
    return TestCaseRepo.getById(r.lastInsertRowid);
  },

  update(id, fields) {
    if (fields.assertion_type && !VALID_ASSERTION_TYPES.has(fields.assertion_type))
      throw Object.assign(new Error(`Invalid assertion_type '${fields.assertion_type}'`), { status: 400 });
    const { name, description, query, assertion_type, assertion_value, enabled } = fields;
    db.prepare(
      `UPDATE test_cases
       SET name           = COALESCE(?, name),
           description    = COALESCE(?, description),
           query          = COALESCE(?, query),
           assertion_type  = COALESCE(?, assertion_type),
           assertion_value = COALESCE(?, assertion_value),
           enabled        = COALESCE(?, enabled),
           updated_at     = datetime('now')
       WHERE id = ?`
    ).run(
      name          ?? null,
      description   ?? null,
      query         ?? null,
      assertion_type  ?? null,
      assertion_value ?? null,
      enabled        != null ? (enabled ? 1 : 0) : null,
      id
    );
    return TestCaseRepo.getById(id);
  },

  delete(id) {
    return db.prepare("DELETE FROM test_cases WHERE id = ?").run(id);
  }
};
