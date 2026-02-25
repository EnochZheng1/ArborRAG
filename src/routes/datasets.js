import express from "express";
import fs from "fs";
import {
  createDataset,
  renameDataset,
  deleteDataset,
  duplicateDataset,
  exportDataset,
  getDatasetStats
} from "../db/datasetManager.js";
import { listDatasets } from "../db/registry.js";
import { getConnection } from "../db/datasetManager.js";
import { runWithDb } from "../db/activeDb.js";
import { DatasetConfigRepo } from "../db/repositories/DatasetConfigRepo.js";
import { apiLogger } from "../utils/logger.js";

const router = express.Router();

// List all datasets (omit internal db_path)
router.get("/", (req, res) => {
  try {
    const datasets = listDatasets().map(({ db_path: _omit, ...rest }) => rest);
    res.json({ datasets, count: datasets.length });
  } catch (err) {
    apiLogger.error("List datasets error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create a new dataset
router.post("/", (req, res) => {
  try {
    const { name, description, language } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: "name is required" });
    const dataset = createDataset(name.trim(), description || "");

    if (language && language !== 'auto') {
      try {
        const conn = getConnection(dataset.id);
        runWithDb(conn, () => DatasetConfigRepo.setLanguage(language));
      } catch (langErr) {
        apiLogger.warn(`Could not set language on new dataset: ${langErr.message}`);
      }
    }

    const { db_path: _omit, ...safe } = dataset;
    res.status(201).json({ dataset: safe });
  } catch (err) {
    apiLogger.error("Create dataset error:", err.message);
    const status = err.status || (err.message.includes("already exists") ? 409 : 500);
    res.status(status).json({ error: err.message });
  }
});

// Rename / update description
router.put("/:id", (req, res) => {
  try {
    const { name, description } = req.body || {};
    if (name === undefined && description === undefined) {
      return res.status(400).json({ error: "Provide name and/or description to update" });
    }
    const dataset = renameDataset(req.params.id, name, description);
    if (!dataset) return res.status(404).json({ error: "Dataset not found" });
    const { db_path: _omit, ...safe } = dataset;
    res.json({ dataset: safe });
  } catch (err) {
    apiLogger.error("Rename dataset error:", err.message);
    const status = err.status || (err.message.includes("already exists") ? 409 : 500);
    res.status(status).json({ error: err.message });
  }
});

// Delete a dataset
router.delete("/:id", (req, res) => {
  try {
    if (req.query.confirm !== "yes") {
      return res.status(400).json({ error: "Add ?confirm=yes to confirm deletion" });
    }
    deleteDataset(req.params.id);
    res.json({ success: true, deleted_id: req.params.id });
  } catch (err) {
    apiLogger.error("Delete dataset error:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Duplicate a dataset
router.post("/:id/duplicate", async (req, res) => {
  try {
    const { name } = req.body || {};
    const dataset = await duplicateDataset(req.params.id, name);
    const { db_path: _omit, ...safe } = dataset;
    res.status(201).json({ dataset: safe });
  } catch (err) {
    apiLogger.error("Duplicate dataset error:", err.message);
    const status = err.status || (err.message.includes("already exists") ? 409 : 500);
    res.status(status).json({ error: err.message });
  }
});

// Export a dataset as a downloadable .db file
router.get("/:id/export", async (req, res) => {
  try {
    const { tempPath, name } = await exportDataset(req.params.id);
    const safeName = name.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, "_");
    res.download(tempPath, `${safeName}.db`, (err) => {
      try { fs.unlinkSync(tempPath); } catch (_) {}
      if (err && !res.headersSent) {
        apiLogger.error("Export dataset stream error:", err.message);
      }
    });
  } catch (err) {
    apiLogger.error("Export dataset error:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Dataset stats (node count, doc count, etc.)
router.get("/:id/stats", (req, res) => {
  try {
    res.json(getDatasetStats(req.params.id));
  } catch (err) {
    apiLogger.error("Dataset stats error:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /datasets/:id/config/language
router.get("/:id/config/language", (req, res) => {
  try {
    const conn = getConnection(req.params.id);
    let language = 'auto';
    runWithDb(conn, () => { language = DatasetConfigRepo.getLanguage(); });
    res.json({ language, locked: language !== 'auto' });
  } catch (err) {
    apiLogger.error("Get dataset language error:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /datasets/:id/config/language — one-time lock, 403 if already locked
router.post("/:id/config/language", (req, res) => {
  try {
    const { language } = req.body || {};
    if (!language) return res.status(400).json({ error: "language is required" });
    const conn = getConnection(req.params.id);
    let result;
    runWithDb(conn, () => {
      DatasetConfigRepo.setLanguage(language);
      result = { language, locked: language !== 'auto' };
    });
    res.json(result);
  } catch (err) {
    apiLogger.error("Set dataset language error:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
