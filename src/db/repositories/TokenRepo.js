/**
 * Token usage repository — token_usage table.
 */

import { db } from "../db.js";

export const TokenRepo = {
  record({ model, operation, inputTokens, outputTokens, totalTokens, cachedTokens, costEstimate, metadata }) {
    db.prepare(`
      INSERT INTO token_usage
        (model, operation, input_tokens, output_tokens, total_tokens, cached_tokens, cost_estimate, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      model, operation,
      inputTokens, outputTokens, totalTokens, cachedTokens, costEstimate,
      JSON.stringify(metadata ?? {})
    );
  },

  getStats({ since, operation, model } = {}) {
    let where = "1=1";
    const params = [];
    if (since)     { where += " AND timestamp >= ?"; params.push(since); }
    if (operation) { where += " AND operation = ?";  params.push(operation); }
    if (model)     { where += " AND model = ?";      params.push(model); }

    const totals = db.prepare(`
      SELECT COUNT(*) as total_calls,
             SUM(input_tokens)  as total_input_tokens,
             SUM(output_tokens) as total_output_tokens,
             SUM(total_tokens)  as total_tokens,
             SUM(cached_tokens) as total_cached_tokens,
             SUM(cost_estimate) as total_cost
      FROM token_usage WHERE ${where}
    `).get(...params);

    const byOperation = db.prepare(`
      SELECT operation, COUNT(*) as calls,
             SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
             SUM(total_tokens) as total_tokens, SUM(cost_estimate) as cost
      FROM token_usage WHERE ${where}
      GROUP BY operation ORDER BY total_tokens DESC
    `).all(...params);

    const byModel = db.prepare(`
      SELECT model, COUNT(*) as calls,
             SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
             SUM(total_tokens) as total_tokens, SUM(cost_estimate) as cost
      FROM token_usage WHERE ${where}
      GROUP BY model ORDER BY total_tokens DESC
    `).all(...params);

    const recentUsage = db.prepare(`
      SELECT strftime('%Y-%m-%d %H:00', timestamp) as hour,
             SUM(total_tokens) as tokens, SUM(cost_estimate) as cost, COUNT(*) as calls
      FROM token_usage
      WHERE timestamp >= datetime('now', '-24 hours')
      GROUP BY hour ORDER BY hour DESC LIMIT 24
    `).all();

    const today = db.prepare(`
      SELECT SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
             SUM(total_tokens) as total_tokens, SUM(cost_estimate) as cost, COUNT(*) as calls
      FROM token_usage WHERE date(timestamp) = date('now')
    `).get();

    return { totals, byOperation, byModel, recentUsage, today };
  },

  cleanup(daysToKeep = 30) {
    return db.prepare(
      `DELETE FROM token_usage WHERE timestamp < datetime('now', '-' || ? || ' days')`
    ).run(daysToKeep).changes;
  }
};
