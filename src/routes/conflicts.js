import express from "express";

// Conflict detection has been disabled. Routes return empty data for compatibility.
const router = express.Router();

router.get("/conflicts", (_req, res) => {
  res.json({ conflicts: [], stats: { total: 0, unresolved: 0, resolved: 0 } });
});

router.post("/conflicts/:id/resolve", (_req, res) => {
  res.status(404).json({ error: "Conflict detection is disabled" });
});

export default router;
