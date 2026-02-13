function normalize01(x, min, max) {
  if (max <= min) return 0;
  return Math.max(0, Math.min(1, (x - min) / (max - min)));
}

function authorityScore(level) {
  const map = { policy: 1.0, sop: 0.8, training: 0.6, personal: 0.4 };
  return map[level] ?? 0.5;
}

function recencyScore(updatedAt, now = Date.now()) {
  const days = Math.max(0, (now - new Date(updatedAt).getTime()) / (1000 * 3600 * 24));
  const halfLife = 30;
  return Math.exp(-Math.log(2) * (days / halfLife));
}

function scopeFitScore(queryScope, nodeScope) {
  if (!queryScope || !nodeScope) return 0;
  let hit = 0, total = 0;
  for (const key of ["product", "region", "business_unit", "channel"]) {
    if (queryScope[key]) {
      total += 1;
      if (nodeScope[key] && nodeScope[key] === queryScope[key]) hit += 1;
    }
  }
  if (total === 0) return 0;
  return hit / total;
}

function conflictRiskScore(conflictScore) {
  return Math.min(1, (conflictScore ?? 0) / 10);
}

export function rankNodes(candidates, queryScope) {
  const bm25Vals = candidates.map(c => c.bm25);
  const min = Math.min(...bm25Vals), max = Math.max(...bm25Vals);

  const scored = candidates.map(c => {
    const sim = normalize01(c.bm25, min, max);
    const scopeFit = scopeFitScore(queryScope, c.node.scope_json);
    const authFit = authorityScore(c.node.authority_level_mode);
    const recent = recencyScore(c.node.updated_at);
    const risk = conflictRiskScore(c.node.conflict_score);

    const score =
      0.60 * sim +
      0.15 * scopeFit +
      0.10 * authFit +
      0.10 * recent -
      0.05 * risk;

    return { ...c, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export function decideNode(scored, thresholds = { good: 0.70, low: 0.55, gap: 0.08 }) {
  const top1 = scored[0];
  const top2 = scored[1] ?? { score: 0 };

  if (!top1) return { action: "propose_new_node", confidence: 0, top: [] };

  const gap = top1.score - top2.score;

  if (top1.score >= thresholds.good && gap >= thresholds.gap) {
    return { action: "answer", chosen: top1, confidence: top1.score, top: scored.slice(0,3) };
  }

  if (top1.score < thresholds.low) {
    return { action: "propose_new_node", chosen: top1, confidence: top1.score, top: scored.slice(0,3) };
  }

  return { action: "ask_clarify", chosen: top1, confidence: top1.score, top: scored.slice(0,3) };
}
