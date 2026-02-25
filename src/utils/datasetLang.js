import { DatasetConfigRepo } from '../db/repositories/DatasetConfigRepo.js';
import { detectLanguage } from './langDetect.js';

/**
 * Returns the dataset-configured language, or 'auto' if not set / outside request context.
 */
export function getDatasetLang() {
  try {
    return DatasetConfigRepo.getLanguage() ?? 'auto';
  } catch {
    return 'auto';
  }
}

/**
 * Returns the effective language for LLM prompt selection.
 * When the dataset has an explicit language set, it overrides per-content detection.
 * Falls back to detectLanguage(contentOrQuery) when the dataset is on 'auto'.
 */
export function getEffectiveLang(contentOrQuery) {
  const dl = getDatasetLang();
  return dl !== 'auto' ? dl : detectLanguage(contentOrQuery);
}
