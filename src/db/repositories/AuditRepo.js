/**
 * AuditRepo — Read access to the audit_log table.
 * Write operations use logAudit() from db.js.
 */

import { db, safeJson } from "../db.js";

function parseRow(row) {
  if (!row) return null;
  return {
    ...row,
    old_value: safeJson(row.old_value_json, null),
    new_value: safeJson(row.new_value_json, null)
  };
}

export const AuditRepo = {
  getRecent(limit = 20) {
    return db.prepare(`
      SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?
    `).all(Math.max(1, limit)).map(parseRow);
  },

  getById(id) {
    return parseRow(
      db.prepare("SELECT * FROM audit_log WHERE id = ?").get(id)
    );
  },

  getChatbotChanges(limit = 20) {
    return db.prepare(`
      SELECT * FROM audit_log
      WHERE action LIKE 'chatbot_%'
      ORDER BY created_at DESC LIMIT ?
    `).all(Math.max(1, limit)).map(parseRow);
  },

  getByRecordId(recordId, tableName) {
    return db.prepare(`
      SELECT * FROM audit_log
      WHERE record_id = ? AND table_name = ?
      ORDER BY created_at DESC
    `).all(String(recordId), tableName).map(parseRow);
  }
};
