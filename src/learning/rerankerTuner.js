/**
 * Reranker Tuner
 *
 * Learns optimal reranker weights (keyword, BM25-rank, embedding) from feedback.
 * For feedback entries with chunk_ids, replays the 3 scoring signals and uses
 * coordinate descent: hold 2 weights fixed, try ±0.05 on the third, keep the
 * variant that best predicts positive feedback. Normalize to sum=1.0.
 *
 * Requires >= 20 feedback entries with chunk data.
 */

import { db } from "../db/db.js";
import { logger } from "../utils/logger.js";
import { getLearnedParam } from "./learningJob.js";

/**
 * Tune reranker weights based on feedback correlation.
 * @returns {{ weights: { keyword: number, bm25: number, embedding: number }, sampleCount: number, improved: boolean }}
 */
export function tuneRerankerWeights() {
  try {
    // Gather feedback entries with chunk IDs
    const feedbackRows = db.prepare(`
      SELECT f.rating, f.chunk_ids_json
      FROM feedback f
      WHERE f.chunk_ids_json IS NOT NULL
        AND f.chunk_ids_json != '[]'
        AND f.created_at > datetime('now', '-30 days')
      ORDER BY f.created_at DESC
      LIMIT 200
    `).all();

    // Build training samples: for each feedback entry, get chunk feedback_score and similarity
    const samples = [];
    for (const row of feedbackRows) {
      let chunkIds;
      try { chunkIds = JSON.parse(row.chunk_ids_json); } catch { continue; }
      if (!Array.isArray(chunkIds) || chunkIds.length === 0) continue;

      // Get the chunk's stored scores
      for (const cid of chunkIds.slice(0, 3)) { // sample up to 3 chunks per feedback
        const chunk = db.prepare(`
          SELECT c.feedback_score,
                 e.embedding_json IS NOT NULL as has_embedding
          FROM chunks c
          LEFT JOIN embeddings e ON e.ref_type = 'chunk' AND e.ref_id = CAST(c.id AS TEXT)
          WHERE c.id = ?
        `).get(cid);
        if (!chunk) continue;

        samples.push({
          rating: row.rating,
          isPositive: row.rating >= 4,
          feedbackScore: chunk.feedback_score || 0,
          hasEmbedding: chunk.has_embedding ? 1 : 0
        });
      }
    }

    if (samples.length < 20) {
      return {
        weights: {
          keyword: getLearnedParam('learning:reranker_w_keyword'),
          bm25: getLearnedParam('learning:reranker_w_bm25'),
          embedding: getLearnedParam('learning:reranker_w_embedding')
        },
        sampleCount: samples.length,
        improved: false,
        reason: 'Insufficient samples (need >= 20)'
      };
    }

    // Current weights
    let wKey = getLearnedParam('learning:reranker_w_keyword');
    let wBm25 = getLearnedParam('learning:reranker_w_bm25');
    let wEmb = getLearnedParam('learning:reranker_w_embedding');

    // Compute baseline score: correlation between positive feedback and having embeddings
    const baseScore = evaluateWeights(samples, wKey, wBm25, wEmb);
    let bestScore = baseScore;
    let bestWeights = { keyword: wKey, bm25: wBm25, embedding: wEmb };
    const step = 0.05;

    // Coordinate descent: try adjusting each weight
    for (const [idx, name] of [[0, 'keyword'], [1, 'bm25'], [2, 'embedding']]) {
      for (const direction of [-step, step]) {
        const trial = [wKey, wBm25, wEmb];
        trial[idx] += direction;

        // Clamp to [0.10, 0.70]
        trial[idx] = Math.max(0.10, Math.min(0.70, trial[idx]));

        // Normalize to sum=1.0, then re-clamp to enforce floors after normalization
        const sum = trial[0] + trial[1] + trial[2];
        let norm = [trial[0] / sum, trial[1] / sum, trial[2] / sum];
        // Re-clamp: if normalization pushed any weight below 0.10, clamp and re-normalize
        norm = norm.map(w => Math.max(0.10, Math.min(0.70, w)));
        const sum2 = norm[0] + norm[1] + norm[2];
        norm = norm.map(w => w / sum2);

        const score = evaluateWeights(samples, norm[0], norm[1], norm[2]);
        if (score > bestScore) {
          bestScore = score;
          bestWeights = {
            keyword: Math.round(norm[0] * 100) / 100,
            bm25: Math.round(norm[1] * 100) / 100,
            embedding: Math.round(norm[2] * 100) / 100
          };
        }
      }
    }

    const improved = bestScore > baseScore;
    return { weights: bestWeights, sampleCount: samples.length, improved, baseScore, bestScore };
  } catch (err) {
    logger.warn(`tuneRerankerWeights failed: ${err.message}`);
    return {
      weights: {
        keyword: getLearnedParam('learning:reranker_w_keyword'),
        bm25: getLearnedParam('learning:reranker_w_bm25'),
        embedding: getLearnedParam('learning:reranker_w_embedding')
      },
      sampleCount: 0,
      improved: false,
      error: err.message
    };
  }
}

/**
 * Evaluate how well a set of weights predicts positive feedback.
 * Higher score = better prediction.
 * Simulates the 3-signal scoring using available proxy data.
 */
function evaluateWeights(samples, wKey, wBm25, wEmb) {
  let correct = 0;
  for (const s of samples) {
    // Proxy signals for the 3 reranker dimensions:
    // - keyword overlap proxy: positive feedback_score suggests good keyword match
    // - BM25 rank proxy: use feedbackScore sign as rank quality indicator
    // - embedding proxy: hasEmbedding indicates vector similarity was available
    const keySignal = Math.max(0, s.feedbackScore);
    const bm25Signal = s.feedbackScore > 0 ? 0.5 : (s.feedbackScore < 0 ? -0.3 : 0);
    const embSignal = s.hasEmbedding;

    const simScore = wKey * keySignal + wBm25 * bm25Signal + wEmb * embSignal;
    const predicted = simScore > 0.15;
    if (predicted === s.isPositive) correct++;
  }
  return correct / samples.length;
}
