/**
 * Ingestion Tracker
 *
 * Tracks ingestion quality over time: KP count, avg confidence,
 * auto-resolve rate, new node count per document.
 * Detects ingestion drift when auto-resolve rate drops significantly
 * after threshold changes.
 */

import { db } from "../db/db.js";
import { logger } from "../utils/logger.js";

/**
 * Record ingestion metrics for a completed document.
 * @param {number|string} documentId
 * @param {{ kpCount: number, avgKpConfidence: number, decisionsCreated: number, autoResolvedCount: number, newNodeCount: number }} metrics
 */
export function recordIngestionMetrics(documentId, metrics) {
  try {
    db.prepare(`
      INSERT INTO ingestion_metrics (
        document_id, kp_count, avg_kp_confidence,
        decisions_created, auto_resolved_count, new_node_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      documentId,
      metrics.kpCount ?? 0,
      metrics.avgKpConfidence ?? 0,
      metrics.decisionsCreated ?? 0,
      metrics.autoResolvedCount ?? 0,
      metrics.newNodeCount ?? 0
    );
  } catch (err) {
    // Non-fatal — table may not exist on older datasets
    logger.debug(`recordIngestionMetrics skipped: ${err.message}`);
  }
}

/**
 * Get ingestion trend aggregated by day or week.
 * @param {number} days - Look-back window (default 30)
 * @returns {Array<{ date: string, doc_count: number, avg_kps: number, avg_confidence: number, avg_auto_rate: number }>}
 */
export function getIngestionTrend(days = 30) {
  const safeDays = Math.max(1, Math.floor(Number(days)));
  try {
    return db.prepare(`
      SELECT DATE(created_at) as date,
             COUNT(*) as doc_count,
             AVG(kp_count) as avg_kps,
             AVG(avg_kp_confidence) as avg_confidence,
             AVG(CASE WHEN decisions_created > 0
               THEN CAST(auto_resolved_count AS REAL) / decisions_created
               ELSE 1.0 END) as avg_auto_rate,
             AVG(new_node_count) as avg_new_nodes
      FROM ingestion_metrics
      WHERE created_at > datetime('now', '-' || ? || ' days')
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `).all(safeDays);
  } catch (err) {
    logger.debug(`getIngestionTrend skipped: ${err.message}`);
    return [];
  }
}

/**
 * Detect ingestion drift — alerts if auto-resolve rate drops significantly
 * after threshold changes.
 * @returns {{ drifted: boolean, currentRate: number|null, baselineRate: number|null, message: string }}
 */
export function detectIngestionDrift() {
  try {
    // Compare last 7 days vs previous 7 days
    const recent = db.prepare(`
      SELECT AVG(CASE WHEN decisions_created > 0
               THEN CAST(auto_resolved_count AS REAL) / decisions_created
               ELSE 1.0 END) as avg_auto_rate,
             COUNT(*) as doc_count
      FROM ingestion_metrics
      WHERE created_at > datetime('now', '-7 days')
    `).get();

    const baseline = db.prepare(`
      SELECT AVG(CASE WHEN decisions_created > 0
               THEN CAST(auto_resolved_count AS REAL) / decisions_created
               ELSE 1.0 END) as avg_auto_rate,
             COUNT(*) as doc_count
      FROM ingestion_metrics
      WHERE created_at BETWEEN datetime('now', '-14 days') AND datetime('now', '-7 days')
    `).get();

    if (!recent?.doc_count || recent.doc_count < 3 || !baseline?.doc_count || baseline.doc_count < 3) {
      return { drifted: false, currentRate: null, baselineRate: null, message: 'Insufficient data for drift detection' };
    }

    const currentRate = Math.round((recent.avg_auto_rate ?? 0) * 100) / 100;
    const baselineRate = Math.round((baseline.avg_auto_rate ?? 0) * 100) / 100;
    const drop = baselineRate - currentRate;

    // Alert if auto-resolve rate dropped by more than 15 percentage points
    const drifted = drop > 0.15;

    return {
      drifted,
      currentRate,
      baselineRate,
      drop: Math.round(drop * 100) / 100,
      message: drifted
        ? `Auto-resolve rate dropped from ${(baselineRate * 100).toFixed(0)}% to ${(currentRate * 100).toFixed(0)}% — threshold changes may be too aggressive`
        : 'Ingestion quality stable'
    };
  } catch (err) {
    logger.debug(`detectIngestionDrift skipped: ${err.message}`);
    return { drifted: false, currentRate: null, baselineRate: null, message: 'Drift detection unavailable' };
  }
}
