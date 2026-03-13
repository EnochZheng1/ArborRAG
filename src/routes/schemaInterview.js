/**
 * Schema Interview Routes
 *
 * AI-guided schema generation via adaptive interview.
 * Mounted at /schema/interview in server.js.
 */
import express from "express";
import { createSession, getSession, deleteSession } from "../schema/interviewSession.js";
import { generateNextQuestion, generateSchema, refineSchema, countSchemaNodes, getSchemaDepth, MAX_QUESTIONS } from "../schema/interviewEngine.js";
import { importSchemaNodes } from "./schema.js";
import { DatasetConfigRepo } from "../db/repositories/DatasetConfigRepo.js";
import { SchemaTemplateRepo } from "../db/repositories/SchemaTemplateRepo.js";
import { getRootNodes, getChildren } from "../kg/graphTraversal.js";
import { apiLogger as logger } from "../utils/logger.js";
import { db } from "../db/db.js";

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildTreeSummary(maxNodes = 30) {
  try {
    const roots = getRootNodes();
    if (!roots.length) return null;

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
    return null;
  }
}

function getDatasetStats() {
  try {
    const nodes = db.prepare("SELECT COUNT(*) as c FROM nodes").get()?.c || 0;
    const documents = db.prepare("SELECT COUNT(*) as c FROM documents").get()?.c || 0;
    const chunks = db.prepare("SELECT COUNT(*) as c FROM chunks").get()?.c || 0;
    return { nodes, documents, chunks };
  } catch {
    return { nodes: 0, documents: 0, chunks: 0 };
  }
}

// ── POST /schema/interview/start ─────────────────────────────────────────────

router.post('/start', async (req, res) => {
  try {
    const treeSummary = buildTreeSummary();
    const stats = getDatasetStats();

    const session = createSession(treeSummary, stats);

    // Generate first question (hardcoded, no LLM call)
    const result = await generateNextQuestion(session);
    session.questionCount = 1;
    session.lastQuestion = result.nextQuestion;

    logger.info(`Schema interview started: session=${session.id}, existing=${stats.nodes} nodes`);

    res.json({
      sessionId: session.id,
      question: result.nextQuestion,
      questionNumber: 1,
      phase: session.phase,
      existingDataSummary: treeSummary ? `${stats.nodes} nodes, ${stats.documents} documents` : null
    });
  } catch (err) {
    logger.error("POST /schema/interview/start error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /schema/interview/answer ────────────────────────────────────────────

router.post('/answer', async (req, res) => {
  try {
    const { sessionId, answer, skipToGenerate } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    if (!answer && !skipToGenerate) return res.status(400).json({ error: 'answer is required' });

    const session = getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found or expired' });
    if (session.phase !== 'interviewing') {
      return res.status(400).json({ error: `Session is in '${session.phase}' phase, not interviewing` });
    }

    // Record the answer paired with the question that was asked
    if (answer) {
      session.answers.push({
        questionId: session.questionCount,
        question: session.lastQuestion || `Question ${session.questionCount}`,
        answer,
        timestamp: new Date().toISOString()
      });
    }

    // If skip requested and we have enough context, jump to generation
    if (skipToGenerate && session.questionCount >= MIN_QUESTIONS_SKIP) {
      return await handleGenerate(session, res);
    }

    // If we've hit the max, skip the LLM call and go straight to generation
    if (session.questionCount >= MAX_QUESTIONS) {
      return await handleGenerate(session, res);
    }

    // Generate next question
    const result = await generateNextQuestion(session);

    // Apply context updates
    if (result.contextUpdate) {
      mergeContext(session.context, result.contextUpdate);
    }

    session.questionCount++;
    session.lastQuestion = result.nextQuestion;

    if (result.shouldStop) {
      return await handleGenerate(session, res);
    }

    res.json({
      sessionId: session.id,
      question: result.nextQuestion,
      questionNumber: session.questionCount,
      phase: 'interviewing',
      context: session.context,
      confidence: result.confidence
    });
  } catch (err) {
    logger.error("POST /schema/interview/answer error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const MIN_QUESTIONS_SKIP = 2; // allow skip after at least 2 answered

async function handleGenerate(session, res) {
  session.phase = 'generating';
  try {
    const schema = await generateSchema(session);
    session.generatedSchema = schema;
    session.phase = 'reviewing';

    const totalNodes = countSchemaNodes(schema);
    const depth = getSchemaDepth(schema);

    logger.info(`Schema interview generated: session=${session.id}, ${totalNodes} nodes, ${depth} levels`);

    res.json({
      sessionId: session.id,
      phase: 'reviewing',
      schema,
      summary: `Generated ${totalNodes} nodes in ${depth} levels`
    });
  } catch (err) {
    session.phase = 'interviewing'; // allow retry
    throw err;
  }
}

function mergeContext(ctx, update) {
  if (update.domain && update.domain.trim()) ctx.domain = update.domain;
  if (Array.isArray(update.subdomains) && update.subdomains.length) {
    ctx.subdomains = [...new Set([...ctx.subdomains, ...update.subdomains])];
  }
  if (Array.isArray(update.queryPatterns) && update.queryPatterns.length) {
    ctx.queryPatterns = [...new Set([...ctx.queryPatterns, ...update.queryPatterns])];
  }
  if (update.depthPreference && ['shallow', 'medium', 'deep'].includes(update.depthPreference)) {
    ctx.depthPreference = update.depthPreference;
  }
  if (update.language && update.language.trim()) ctx.language = update.language;
  if (Array.isArray(update.entityTypes) && update.entityTypes.length) {
    ctx.entityTypes = [...new Set([...ctx.entityTypes, ...update.entityTypes])];
  }
  if (update.additionalNotes && update.additionalNotes.trim()) {
    ctx.additionalNotes = ctx.additionalNotes
      ? `${ctx.additionalNotes}; ${update.additionalNotes}`
      : update.additionalNotes;
  }
}

// ── POST /schema/interview/refine ────────────────────────────────────────────

router.post('/refine', async (req, res) => {
  try {
    const { sessionId, instructions } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    if (!instructions?.trim()) return res.status(400).json({ error: 'instructions are required' });

    const session = getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found or expired' });
    if (session.phase !== 'reviewing') {
      return res.status(400).json({ error: `Session must be in 'reviewing' phase` });
    }

    const schema = await refineSchema(session, instructions.trim());
    session.generatedSchema = schema;

    const totalNodes = countSchemaNodes(schema);
    const depth = getSchemaDepth(schema);

    logger.info(`Schema interview refined: session=${session.id}, ${totalNodes} nodes, ${depth} levels`);

    res.json({
      sessionId: session.id,
      phase: 'reviewing',
      schema,
      summary: `Refined to ${totalNodes} nodes in ${depth} levels`
    });
  } catch (err) {
    logger.error("POST /schema/interview/refine error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /schema/interview/apply ─────────────────────────────────────────────

router.post('/apply', (req, res) => {
  try {
    const { sessionId, saveAsTemplate, templateName } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const session = getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found or expired' });
    if (!session.generatedSchema?.length) {
      return res.status(400).json({ error: 'No generated schema to apply' });
    }

    // Import schema nodes (replace mode)
    const result = importSchemaNodes(session.generatedSchema, 'replace');

    // Switch to guided mode
    DatasetConfigRepo.set('mapping_mode', 'guided');

    let templateId = null;
    if (saveAsTemplate && templateName?.trim()) {
      try {
        const template = SchemaTemplateRepo.create({
          name: templateName.trim(),
          description: `AI-generated schema for ${session.context.domain || 'knowledge base'}`,
          schemaJson: session.generatedSchema
        });
        templateId = template.id;
      } catch (templateErr) {
        logger.warn(`Failed to save template: ${templateErr.message}`);
      }
    }

    logger.info(`Schema interview applied: session=${session.id}, ${result.created.length} created, ${result.updated.length} updated`);
    deleteSession(session.id);

    res.json({
      ok: true,
      created: result.created.length,
      updated: result.updated.length,
      mapping_mode: 'guided',
      templateId
    });
  } catch (err) {
    logger.error("POST /schema/interview/apply error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
