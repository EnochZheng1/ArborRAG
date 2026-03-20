/**
 * Centralized scoring configuration.
 *
 * All magic numbers used in the retrieval scoring pipeline live here.
 * Consuming modules import from this file so constants are discoverable,
 * documented, and tunable from a single place.
 */

// ── Reranker defaults (overridden by learning system) ────────────────────────
export const RERANKER_W_KEYWORD  = 0.30; // keyword overlap weight
export const RERANKER_W_BM25     = 0.20; // BM25 recall-rank weight
export const RERANKER_W_EMBEDDING = 0.50; // embedding cosine similarity weight

// ── Reranker query-type boosting ─────────────────────────────────────────────
export const NUMERIC_CHUNK_BOOST     = 0.05; // boost for chunks containing numbers on numeric queries
export const NUMERIC_UNIT_BOOST      = 0.05; // extra boost if chunk has percentages/units
export const ENTITY_MATCH_BOOST      = 0.08; // boost for chunks matching query named entities
export const NEGATION_PENALTY_FACTOR = 0.4;  // multiply score by this for negated-term chunks

// ── Retrieval caps ───────────────────────────────────────────────────────────
export const RETRIEVAL_MAX_HIERARCHICAL = parseInt(process.env.RETRIEVAL_MAX_HIERARCHICAL, 10) || 15;
export const RETRIEVAL_MAX_DIRECT       = parseInt(process.env.RETRIEVAL_MAX_DIRECT, 10) || 15;
export const RETRIEVAL_RERANKER_POOL    = parseInt(process.env.RETRIEVAL_RERANKER_POOL, 10) || 30;

// ── Document-scope reranker signal (4th heuristic on merged pool) ────────────
export const DOC_MATCH_BOOST   = 0.1;   // boost for chunks whose doc_title matches query terms
export const DOC_MISMATCH_PENALTY = -0.05; // penalty for non-matching doc titles

// ── BM25 normalization ───────────────────────────────────────────────────────
export const MAX_EXPECTED_BM25 = 15.0;  // absolute normalisation ceiling for direct BM25 scores

// ── Numeric-fact post-boost (direct chunk search) ────────────────────────────
export const NUMERIC_EXACT_MATCH_BOOST = 0.15; // boost when query number appears verbatim in chunk
export const NUMERIC_ANY_DIGIT_BOOST   = 0.08; // boost when chunk contains any digit on numeric query

// ── Confidence scorer weights ────────────────────────────────────────────────
export const CONFIDENCE_LINEAR_SCALE   = 0.92; // linear scaling factor (replaces sqrt dampening)
export const CONFIDENCE_RECENCY_WEIGHT = 0.15; // blend weight for recency factor
export const CONFIDENCE_FEW_CHUNKS_PENALTY = 0.85; // multiplier when < 3 chunks
export const CONFIDENCE_SINGLE_NODE_PENALTY = 0.9; // multiplier when <= 1 node

// ── Confidence level defaults (overridden by learning system) ────────────────
export const CONFIDENCE_HIGH_DEFAULT   = 0.75;
export const CONFIDENCE_MEDIUM_DEFAULT = 0.55;
export const CONFIDENCE_LOW_DEFAULT    = 0.35;

// ── Feedback ─────────────────────────────────────────────────────────────────
export const FEEDBACK_BOOST_CAP        = 0.3;  // max ±adjustment from feedback score
export const FEEDBACK_SCORE_FLOOR      = -1.0; // minimum cached feedback_score
export const FEEDBACK_SCORE_CEILING    = 1.0;  // maximum cached feedback_score
export const FEEDBACK_DECAY_HALFLIFE   = 60;   // days — score halves every N days
export const FEEDBACK_DECAY_WINDOW     = 90;   // days — events older than this are ignored
export const KNOWN_ISSUE_NEG_RATE      = 0.4;  // negative rate threshold for known-issue flagging
export const KNOWN_ISSUE_MIN_NEG_COUNT = 5;    // minimum negative count for known-issue flagging

// ── Hallucination detection ──────────────────────────────────────────────────
export const GROUNDEDNESS_HALLUCINATION_CAP = 0.25; // max groundedness when answer values not in sources
export const NO_ANSWER_FLOOR = 0.10; // confidence floor when answer contains "not found" phrases

// ── Aggregation ──────────────────────────────────────────────────────────────
export const AGGREGATION_TOP_N = 20; // max nodes for aggregation queries
