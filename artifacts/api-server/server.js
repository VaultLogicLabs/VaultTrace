import express from "express";
import { runScan, cacheStats, cacheClear, getTokenPrice, getTokenChart } from "./index.js";
import {
  loadHistory,
  addReport,
  clearHistory,
  mergeReports,
} from "./history.js";

const app  = express();
const PORT = process.env.PORT ?? 3000;

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
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

// ── SSE stream endpoint ────────────────────────────────────────────────────
// GET /api/scan/:mintAddress/stream?top=20&depth=6
// Server-Sent Events: emits progress events then a final "complete" event.
app.get("/api/scan/:mintAddress/stream", async (req, res) => {
  const { mintAddress } = req.params;
  const topN  = Math.min(50, Math.max(1, parseInt(req.query.top   ?? "20")));
  const depth = Math.min(10, Math.max(1, parseInt(req.query.depth ?? "6")));

  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mintAddress)) {
    return res.status(400).json({ error: "Invalid mint address format." });
  }
  if (!process.env.HELIUS_API_KEY) {
    return res.status(500).json({ error: "HELIUS_API_KEY not set." });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Keep proxies and browsers alive during the long scan
  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 15000);

  console.log(`[stream] ${mintAddress}  top=${topN}  depth=${depth}`);
  try {
    const report = await runScan(mintAddress, { topN, depth, silent: true, onProgress: send });
    send({ type: "complete", report });
    console.log(`[stream] done  ${mintAddress}  score=${report.risk?.score}`);
  } catch (err) {
    console.error(`[stream] error ${mintAddress}:`, err.message);
    send({ type: "error", message: err.message });
  } finally {
    clearInterval(keepalive);
    res.end();
  }
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

// ── Token price endpoint ───────────────────────────────────────────────────
// GET /api/token/:mint/price
// Returns { price, marketCap, volume24h } sourced from DexScreener.
// Fields are null when unavailable. Cached for 5 minutes server-side.
app.get("/api/token/:mint/price", async (req, res) => {
  const { mint } = req.params;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return res.status(400).json({ error: "Invalid mint address format." });
  }
  try {
    const data = await getTokenPrice(mint);
    res.json(data);
  } catch (err) {
    console.error(`[price] error for ${mint}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Token chart endpoint ───────────────────────────────────────────────────
// GET /api/token/:mint/chart
// Returns { candles: [{t,o,h,l,c,v}], direction: "up"|"down"|"flat"|null }
// Candles cover the last 24 h at 1-hour resolution from DexScreener.
app.get("/api/token/:mint/chart", async (req, res) => {
  const { mint } = req.params;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return res.status(400).json({ error: "Invalid mint address format." });
  }
  try {
    const data = await getTokenChart(mint);
    res.json(data);
  } catch (err) {
    console.error(`[chart] error for ${mint}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Scan history endpoints ────────────────────────────────────────────────
// Persistent, cross-device scan history. Backed by a JSON file under data/.
// GET    /api/history           → list of recent scan reports (newest first)
// POST   /api/history           → upsert a single report (dedupes by mint)
// DELETE /api/history           → clear all history
// POST   /api/history/migrate   → merge an array of client-stored reports
app.get("/api/history", async (_req, res) => {
  try {
    const history = await loadHistory();
    res.json(history);
  } catch (err) {
    console.error("[history] load error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/history", async (req, res) => {
  try {
    const next = await addReport(req.body);
    res.json(next);
  } catch (err) {
    const code = err.statusCode ?? 500;
    if (code >= 500) console.error("[history] add error:", err.message);
    res.status(code).json({ error: err.message });
  }
});

app.delete("/api/history", async (_req, res) => {
  try {
    const next = await clearHistory();
    res.json(next);
  } catch (err) {
    console.error("[history] clear error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/history/migrate", async (req, res) => {
  try {
    const next = await mergeReports(req.body);
    res.json(next);
  } catch (err) {
    const code = err.statusCode ?? 500;
    if (code >= 500) console.error("[history] migrate error:", err.message);
    res.status(code).json({ error: err.message });
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
      "GET  /api/token/:mint/price",
      "GET  /api/token/:mint/chart",
      "GET  /api/history",
      "POST /api/history",
      "DELETE /api/history",
      "POST /api/history/migrate",
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
