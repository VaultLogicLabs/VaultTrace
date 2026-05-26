import express from "express";
import { runScan } from "./index.js";

const app  = express();
const PORT = process.env.PORT ?? 3000;

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());

// Basic CORS so a browser frontend can call us
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Health check ───────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Main scan endpoint ─────────────────────────────────────────────────────
// GET /api/scan/:mintAddress
// Optional query params: ?top=20&depth=6
//
// Returns the full JSON forensic report.
// Long-running (~60-90s for top=20). Streams status via chunked response
// so the browser connection stays alive.
app.get("/api/scan/:mintAddress", async (req, res) => {
  const { mintAddress } = req.params;
  const topN  = Math.min(50, Math.max(1, parseInt(req.query.top   ?? "20")));
  const depth = Math.min(10, Math.max(1, parseInt(req.query.depth ?? "6")));

  // Basic Solana address validation (32–44 base58 chars)
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mintAddress)) {
    return res.status(400).json({ error: "Invalid mint address format." });
  }

  if (!process.env.HELIUS_API_KEY) {
    return res.status(500).json({ error: "HELIUS_API_KEY environment variable is not set." });
  }

  console.log(`[scan] ${mintAddress}  top=${topN}  depth=${depth}`);

  try {
    const report = await runScan(mintAddress, { topN, depth, silent: true });
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
      "GET /api/health",
      "GET /api/scan/:mintAddress?top=20&depth=6",
    ],
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🔍 Forensic Scanner API listening on port ${PORT}`);
  console.log(`   Health : /api/health`);
  console.log(`   Scan   : /api/scan/<MINT_ADDRESS>`);
});
