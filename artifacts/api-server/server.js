import express from "express";
import { runScan, cacheStats, cacheClear } from "./index.js";

const app  = express();
const PORT = process.env.PORT ?? 3000;

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Health — includes live cache stats ────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({
    status:    "ok",
    timestamp: new Date().toISOString(),
    cache:     cacheStats(),
  });
});

// ── Cache management ──────────────────────────────────────────────────────
// GET  /api/cache  → current stats
// DELETE /api/cache → flush everything (useful during development)
app.get("/api/cache", (_req, res) => {
  res.json(cacheStats());
});

app.delete("/api/cache", (_req, res) => {
  const before = cacheStats();
  cacheClear();
  res.json({ cleared: before.entries, cache: cacheStats() });
});

// ── Main scan endpoint ─────────────────────────────────────────────────────
// GET /api/scan/:mintAddress?top=20&depth=6
// Long-running (~60-90s cold, much faster on repeat within the same day).
app.get("/api/scan/:mintAddress", async (req, res) => {
  const { mintAddress } = req.params;
  const topN  = Math.min(50, Math.max(1, parseInt(req.query.top   ?? "20")));
  const depth = Math.min(10, Math.max(1, parseInt(req.query.depth ?? "6")));

  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mintAddress)) {
    return res.status(400).json({ error: "Invalid mint address format." });
  }

  if (!process.env.HELIUS_API_KEY) {
    return res.status(500).json({ error: "HELIUS_API_KEY environment variable is not set." });
  }

  const statsBefore = cacheStats();
  console.log(`[scan] ${mintAddress}  top=${topN}  depth=${depth}  cache_entries=${statsBefore.entries}`);

  try {
    const report = await runScan(mintAddress, { topN, depth, silent: true });

    const statsAfter = cacheStats();
    const newEntries = statsAfter.entries - statsBefore.entries;
    console.log(`[scan] done in ${report.scanDurationSeconds}s  +${newEntries} cache entries  total=${statsAfter.entries}`);

    res.json(report);
  } catch (err) {
    console.error(`[scan] error for ${mintAddress}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 404 fallback ───────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({
    error: "Not found",
    endpoints: [
      "GET  /api/health",
      "GET  /api/cache",
      "DELETE /api/cache",
      "GET  /api/scan/:mintAddress?top=20&depth=6",
    ],
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🔍 Forensic Scanner API  port=${PORT}`);
  console.log(`   Health : GET /api/health`);
  console.log(`   Cache  : GET /api/cache  |  DELETE /api/cache`);
  console.log(`   Scan   : GET /api/scan/<MINT_ADDRESS>`);
});
