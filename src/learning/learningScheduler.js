/**
 * Learning Scheduler
 *
 * Runs the learning cycle across all active datasets.
 * Used by the setInterval in server.js.
 */

import { getAllConnections } from "../db/datasetManager.js";
import { runWithDb } from "../db/activeDb.js";
import { runLearningCycle } from "./learningJob.js";
import { logger } from "../utils/logger.js";

/**
 * Run a learning cycle for every active dataset.
 * Each dataset is scoped via runWithDb so the Proxy-based `db` resolves correctly.
 */
export function runLearningCycleAllDatasets() {
  const connections = getAllConnections();
  if (connections.length === 0) return;

  logger.info(`[learning] Starting learning cycle for ${connections.length} dataset(s)`);

  for (const { id, connection } of connections) {
    try {
      runWithDb(connection, () => {
        const result = runLearningCycle();
        if (result.changes.length > 0) {
          logger.info(`[learning] Dataset ${id}: ${result.changes.length} parameter(s) updated`);
        }
      }, id);
    } catch (err) {
      logger.warn(`[learning] Dataset ${id} failed: ${err.message}`);
    }
  }

  logger.info(`[learning] Learning cycle completed for all datasets`);
}
