/**
 * Schema Template Repository
 *
 * Reads and writes schema_templates in the global registry.db.
 * Uses getRegistryDb() directly — NOT the dataset DB Proxy.
 */
import { getRegistryDb } from "../registry.js";
import { randomUUID } from "crypto";

export const SchemaTemplateRepo = {
  getAll() {
    return getRegistryDb()
      .prepare("SELECT * FROM schema_templates ORDER BY created_at ASC")
      .all();
  },

  getById(id) {
    return getRegistryDb()
      .prepare("SELECT * FROM schema_templates WHERE id = ?")
      .get(id) ?? null;
  },

  create({ name, description = "", schemaJson }) {
    const id = randomUUID();
    getRegistryDb()
      .prepare(`
        INSERT INTO schema_templates (id, name, description, schema_json)
        VALUES (?, ?, ?, ?)
      `)
      .run(id, name, description, JSON.stringify(schemaJson));
    return SchemaTemplateRepo.getById(id);
  },

  update(id, { name, description, schemaJson }) {
    const sets = ["updated_at = datetime('now')"];
    const params = [];
    if (name       !== undefined) { sets.push("name = ?");        params.push(name); }
    if (description!== undefined) { sets.push("description = ?"); params.push(description); }
    if (schemaJson !== undefined) { sets.push("schema_json = ?"); params.push(JSON.stringify(schemaJson)); }
    params.push(id);
    getRegistryDb()
      .prepare(`UPDATE schema_templates SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
    return SchemaTemplateRepo.getById(id);
  },

  delete(id) {
    return getRegistryDb()
      .prepare("DELETE FROM schema_templates WHERE id = ?")
      .run(id).changes;
  }
};
