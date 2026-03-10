/**
 * Prompt Manager
 *
 * Reads/writes prompt overrides from dataset_config (per-dataset).
 * Provides template rendering with {{variable}} substitution.
 */

import { DatasetConfigRepo } from "../db/repositories/DatasetConfigRepo.js";
import { PROMPT_CATALOG, getPromptDefault } from "./promptDefaults.js";
import { registerCustomPromptFn } from "../utils/langDetect.js";

const PROMPT_PREFIX = "prompt:";

/**
 * Render a template string by replacing {{var}} placeholders with values.
 * Unmatched placeholders are left as-is.
 */
export function renderTemplate(template, vars = {}) {
  if (!template) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    vars[name] !== undefined ? String(vars[name]) : match
  );
}

/**
 * Get custom prompt override for a key, rendered with variables.
 * Returns null if no override is set (caller should use hardcoded default).
 */
export function getCustomPrompt(key, vars = {}) {
  try {
    const override = DatasetConfigRepo.get(`${PROMPT_PREFIX}${key}`);
    if (!override) return null;
    return renderTemplate(override, vars);
  } catch {
    return null;
  }
}

/**
 * Get raw override text (unrendered) for a key, or null if not set.
 */
export function getPromptOverride(key) {
  try {
    return DatasetConfigRepo.get(`${PROMPT_PREFIX}${key}`) ?? null;
  } catch {
    return null;
  }
}

/**
 * Save a prompt override for the current dataset.
 */
export function setPromptOverride(key, text) {
  if (!PROMPT_CATALOG[key]) throw new Error(`Unknown prompt key: ${key}`);
  DatasetConfigRepo.set(`${PROMPT_PREFIX}${key}`, text);
}

/**
 * Delete a prompt override, reverting to default.
 */
export function deletePromptOverride(key) {
  DatasetConfigRepo.delete(`${PROMPT_PREFIX}${key}`);
}

/**
 * Delete all prompt overrides for the current dataset.
 */
export function deleteAllPromptOverrides() {
  DatasetConfigRepo.deleteByPrefix(PROMPT_PREFIX);
}

/**
 * Get all prompts with metadata, defaults, and any overrides.
 * Used by the API to list all prompts for the frontend.
 */
export function getAllPromptsWithStatus() {
  const result = [];
  for (const [key, entry] of Object.entries(PROMPT_CATALOG)) {
    let override = null;
    try {
      override = DatasetConfigRepo.get(`${PROMPT_PREFIX}${key}`) ?? null;
    } catch { /* no active db context — return without overrides */ }
    result.push({
      key,
      label: entry.label,
      category: entry.category,
      description: entry.description,
      variables: entry.variables,
      default_text: entry.default,
      current_text: override ?? entry.default,
      is_custom: override !== null
    });
  }
  return result;
}

// Register the override hook into langDetect so getPrompt() checks custom prompts.
registerCustomPromptFn(getCustomPrompt);
