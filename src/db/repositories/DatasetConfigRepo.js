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
  }
};
