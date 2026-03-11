/**
 * Intent Classifier — determines user intent from natural language
 * and extracts structured data for the action handlers.
 *
 * Single LLM call for both classification and extraction.
 * Fast-path patterns skip LLM for obvious intents (confirm, cancel, undo).
 */

import { callLLM } from "../utils/llm.js";
import { parseLLMJson } from "../utils/parseJSON.js";
import { getCustomPrompt } from "../prompts/promptManager.js";
import { getRootNodes, getChildren } from "../kg/graphTraversal.js";
import { logger } from "../utils/logger.js";

// ── Fast-path pattern matching (skip LLM) ──────────────────────────────────

const CONFIRM_RE = /^(yes|y|是[的]?|确认|confirm|ok|好[的]?|对[的]?|可以|没问题|sure|go ahead)$/i;
const CANCEL_RE  = /^(no|n|否|取消|cancel|算了|不[要了]?|别|stop)$/i;
const UNDO_RE    = /^(undo|撤销|回退|revert|撤回)/i;
const HISTORY_RE = /^(history|历史|记录|changes|变更)/i;
const SYSTEM_CONFIRM = "__confirm__";
const SYSTEM_CANCEL  = "__cancel__";

function tryFastPath(message) {
  if (message === SYSTEM_CONFIRM)      return { intent: "CONFIRM", confidence: 1.0, data: {} };
  if (message === SYSTEM_CANCEL)       return { intent: "CANCEL",  confidence: 1.0, data: {} };
  if (CONFIRM_RE.test(message.trim())) return { intent: "CONFIRM", confidence: 1.0, data: {} };
  if (CANCEL_RE.test(message.trim()))  return { intent: "CANCEL",  confidence: 1.0, data: {} };
  if (UNDO_RE.test(message.trim()))    return { intent: "UNDO",    confidence: 0.95, data: {} };
  if (HISTORY_RE.test(message.trim())) return { intent: "HISTORY", confidence: 0.95, data: {} };
  // Number selection for multi-match disambiguation
  const numMatch = message.trim().match(/^(\d)$/);
  if (numMatch) return { intent: "SELECT", confidence: 1.0, data: { index: parseInt(numMatch[1], 10) } };
  return null;
}

// ── Tree context builder ────────────────────────────────────────────────────

function buildTreeSummary(maxNodes = 30) {
  try {
    const roots = getRootNodes();
    if (!roots.length) return "(empty tree — no nodes exist)";

    const lines = [];
    let count = 0;
    for (const root of roots.slice(0, 10)) {
      lines.push(`- ${root.name}`);
      count++;
      if (count >= maxNodes) break;
      const children = getChildren(root.node_id);
      for (const child of children.slice(0, 5)) {
        lines.push(`  - ${child.name}`);
        count++;
        if (count >= maxNodes) break;
      }
      if (count >= maxNodes) break;
    }
    return lines.join("\n");
  } catch {
    return "(unable to load tree)";
  }
}

// ── LLM-based classification ────────────────────────────────────────────────

const DEFAULT_PROMPT = `You are a knowledge management assistant. Classify the user's intent and extract structured data.

The user is managing a knowledge base. They can:
- ADD new information (stating facts, providing data)
- EDIT existing information (changing values, updating facts)
- DELETE information (removing facts, deleting entries)
- QUERY (asking questions about the knowledge base)

Session context:
{{recentMessages}}
Current focus node: {{focusNode}}
Pending action: {{pendingAction}}

Existing tree structure (top levels):
{{treeStructure}}

User message: "{{message}}"

IMPORTANT for topic_hint:
- topic_hint should describe the SUBJECT of the content, not just an entity name.
- Look at the existing tree structure above. If there is an existing node that PRECISELY matches the topic of the content, reuse that exact node name.
- If no existing node fits, create a SPECIFIC descriptive topic (e.g. "Helport Products" not just "Helport", "Employee Benefits" not just "Company").
- The topic should categorize WHAT the information is about, not WHO it mentions.
- Do NOT reuse an existing node name unless the content truly belongs under that topic.

Return JSON only:
{
  "intent": "ADD|EDIT|DELETE|QUERY",
  "confidence": 0.0-1.0,
  "content": "the knowledge statement (for ADD: the full fact to store; for EDIT: the updated statement)",
  "topic_hint": "specific topic category for tree placement — must match the SUBJECT of the content",
  "subtopic_hint": "optional subtopic (2-5 words or empty string)",
  "target_description": "what existing content to find (for EDIT/DELETE searches)",
  "old_value": "the specific value to change FROM (for EDIT, or empty)",
  "new_value": "the specific value to change TO (for EDIT, or empty)",
  "reasoning": "brief 1-sentence explanation"
}`;

export async function classifyIntent(message, sessionContext = {}) {
  // 1. Try fast-path patterns
  const fast = tryFastPath(message);
  if (fast) return fast;

  // 2. Build context for LLM
  const { recentMessages = [], focusNodeId = null, pendingAction = null } = sessionContext;

  const recentText = recentMessages.length
    ? recentMessages.map(m => `${m.role}: ${m.content}`).join("\n")
    : "(no prior messages)";

  const focusText = focusNodeId || "(none)";
  const pendingText = pendingAction
    ? `${pendingAction.type} pending — awaiting confirmation`
    : "(none)";
  const treeStructure = buildTreeSummary();

  const vars = { message, recentMessages: recentText, focusNode: focusText, pendingAction: pendingText, treeStructure };

  const prompt = getCustomPrompt("manageIntent", vars) ?? DEFAULT_PROMPT
    .replace("{{message}}", message)
    .replace("{{recentMessages}}", recentText)
    .replace("{{focusNode}}", focusText)
    .replace("{{pendingAction}}", pendingText)
    .replace("{{treeStructure}}", treeStructure);

  try {
    const raw = await callLLM({
      prompt,
      temperature: 0.0,
      maxOutputTokens: 512,
      seed: 42,
      taskName: "manage_intent"
    });

    const parsed = await parseLLMJson(raw, "object", {
      fallback: null,
      context: "manage_intent"
    });

    if (!parsed || !parsed.intent) {
      logger.warn("[manage] Intent classification returned no result, falling back to QUERY");
      return { intent: "QUERY", confidence: 0.5, data: { content: message } };
    }

    const intent = String(parsed.intent).toUpperCase();
    const validIntents = ["ADD", "EDIT", "DELETE", "QUERY"];
    if (!validIntents.includes(intent)) {
      return { intent: "QUERY", confidence: 0.5, data: parsed };
    }

    return {
      intent,
      confidence: Number(parsed.confidence) || 0.7,
      data: {
        content: parsed.content || "",
        topic_hint: parsed.topic_hint || "",
        subtopic_hint: parsed.subtopic_hint || "",
        target_description: parsed.target_description || "",
        old_value: parsed.old_value || "",
        new_value: parsed.new_value || "",
        reasoning: parsed.reasoning || ""
      }
    };
  } catch (err) {
    logger.warn(`[manage] Intent classification failed: ${err.message}`);
    return { intent: "QUERY", confidence: 0.3, data: { content: message } };
  }
}
