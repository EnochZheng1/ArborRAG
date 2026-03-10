import { db } from "../db.js";

const VALID_LANGUAGES = new Set(['auto', 'en', 'zh-CN', 'zh-TW']);

export const DatasetConfigRepo = {
  getLanguage() {
    return db.prepare("SELECT value FROM dataset_config WHERE key = 'language'").get()?.value ?? 'auto';
  },

  setLanguage(language) {
    if (!VALID_LANGUAGES.has(language))
      throw Object.assign(new Error(`Invalid language '${language}'`), { status: 400 });
    const current = DatasetConfigRepo.getLanguage();
    if (current !== 'auto')
      throw Object.assign(
        new Error(`Dataset language is already locked to '${current}' and cannot be changed`),
        { status: 403 }
      );
    db.prepare(
      `INSERT INTO dataset_config (key, value) VALUES ('language', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(language);
  },

  isLocked() {
    return DatasetConfigRepo.getLanguage() !== 'auto';
  },

  /** Generic key read — returns value string or null if not set. */
  get(key) {
    return db.prepare("SELECT value FROM dataset_config WHERE key = ?").get(key)?.value ?? null;
  },

  /** Generic key write — upsert. */
  set(key, value) {
    db.prepare(
      `INSERT INTO dataset_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, String(value));
  },

  /** Delete a single key. */
  delete(key) {
    return db.prepare("DELETE FROM dataset_config WHERE key = ?").run(key);
  },

  /** Delete all keys matching a prefix (e.g. "prompt:"). */
  deleteByPrefix(prefix) {
    return db.prepare("DELETE FROM dataset_config WHERE key LIKE ?").run(`${prefix}%`);
  }
};
