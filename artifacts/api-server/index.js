#!/usr/bin/env node
/**
 * Solana Token Forensic Scanner
 * Usage: node index.js <MINT_ADDRESS> [--top=N] [--json] [--depth=N]
 */

import { createWriteStream } from "fs";

// ── CLI args ───────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const MINT      = args.find(a => !a.startsWith("--")) ?? "7sGdNQSvUGpahh6qyXB3g5gsdK9FAzZM299KyCXspump";
const TOP_N     = parseInt(args.find(a => a.startsWith("--top="))?.split("=")[1]  ?? "20");
const DEPTH     = parseInt(args.find(a => a.startsWith("--depth="))?.split("=")[1] ?? "6");
const JSON_OUT  = args.includes("--json");
const SAVE      = args.find(a => a.startsWith("--save="))?.split("=")[1];

// ── Config ─────────────────────────────────────────────────────────────────
const API_KEY   = process.env.HELIUS_API_KEY;
const RPC_URL   = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;
const DELAY_MS  = 220;   // ms between requests (free-tier safe)
const SYNC_WIN  = 30;    // seconds — simultaneous buy window
const EARLY_WIN = 300;   // seconds — "early buy" window after launch

// ── Known entities ─────────────────────────────────────────────────────────
const ENTITIES = {
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun Program",
  "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM": "Pump.fun Fee Wallet",
  "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg": "Pump.fun Bundler",
  "BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW": "Pump.fun Launch Authority",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4":  "Jupiter v6",
  "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5":  "Jupiter Aggregator",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8":  "Raydium AMM",
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1":  "Raydium Authority",
  "EhYXq3ANp5nAerUpbSgd7VK2RRcxK1zNuSQ755G5Dbqk":  "Raydium Bundler",
  "BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9VSGQDV":  "Bonkbot",
  "HWEoBxYs7ssKuudEjzjmpileDs9685ykXMkNJsJCcaJo":  "Wormhole",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA":   "SPL Token Program",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS":  "ATA Program",
  "11111111111111111111111111111111":                "System Program",
  "ComputeBudget111111111111111111111111111111111":  "Compute Budget",
};

const BUNDLERS = new Set([
  "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg",
  "EhYXq3ANp5nAerUpbSgd7VK2RRcxK1zNuSQ755G5Dbqk",
  "BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW",
]);

// ── ANSI helpers ───────────────────────────────────────────────────────────
const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  red:    "\x1b[31m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  cyan:   "\x1b[36m",
  white:  "\x1b[37m",
  gray:   "\x1b[90m",
};
const c = (color, str) => JSON_OUT ? str : `${C[color]}${str}${C.reset}`;
const bold = (s) => c("bold", s);
const dim  = (s) => c("dim",  s);

// ── Formatting helpers ─────────────────────────────────────────────────────
const fmt    = (ts) => new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
const fmtN   = (n)  => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
const fmtSOL = (n)  => n.toFixed(4) + " SOL";
const short  = (a, n = 8) => a ? a.slice(0, n) + "…" : "?";

function fmtDelta(s) {
  const abs = Math.abs(s), sign = s < 0 ? "-" : "+";
  if (abs < 60)   return `${sign}${abs}s`;
  if (abs < 3600) return `${sign}${Math.floor(abs / 60)}m ${abs % 60}s`;
  return `${sign}${Math.floor(abs / 3600)}h ${Math.floor((abs % 3600) / 60)}m`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── RPC ────────────────────────────────────────────────────────────────────
async function rpc(method, params) {
  const r = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "scanner", method, params }),
  });
  return (await r.json()).result;
}

// Batched parallel RPC with rate limiting
async function rpcBatch(requests) {
  const results = [];
  for (let i = 0; i < requests.length; i++) {
    if (i > 0) await sleep(DELAY_MS);
    const { method, params } = requests[i];
    results.push(await rpc(method, params));
  }
  return results;
}

// ── Signature paging ───────────────────────────────────────────────────────
async function getOldestSigs(address, maxPages = 8) {
  let before; const all = [];
  for (let p = 0; p < maxPages; p++) {
    const sigs = await rpc("getSignaturesForAddress", [address, { limit: 1000, ...(before ? { before } : {}) }]);
    if (!sigs?.length) break;
    all.push(...sigs);
    if (sigs.length < 1000) break;
    before = sigs[sigs.length - 1].signature;
    await sleep(DELAY_MS);
  }
  return all.reverse(); // oldest first
}

async function getTx(sig) {
  return rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
}

// ── Primitives ─────────────────────────────────────────────────────────────
function getAccounts(tx) {
  return (tx?.transaction?.message?.accountKeys ?? []).map(a => a.pubkey ?? a);
}

function getSolDelta(tx, wallet) {
  const accts = getAccounts(tx), idx = accts.indexOf(wallet);
  if (idx === -1) return null;
  return ((tx.meta?.postBalances?.[idx] ?? 0) - (tx.meta?.preBalances?.[idx] ?? 0)) / 1e9;
}

function getTokenDelta(tx, mint) {
  const pre  = tx?.meta?.preTokenBalances  ?? [];
  const post = tx?.meta?.postTokenBalances ?? [];
  const preAmt  = parseFloat(pre.find(b  => b.mint === mint)?.uiTokenAmount?.uiAmountString  ?? "0");
  const postAmt = parseFloat(post.find(b => b.mint === mint)?.uiTokenAmount?.uiAmountString ?? "0");
  return postAmt - preAmt;
}

function touchesMint(tx, mint) {
  const all = [...(tx?.meta?.preTokenBalances ?? []), ...(tx?.meta?.postTokenBalances ?? [])];
  return all.some(b => b.mint === mint);
}

function getPrograms(tx) {
  return getAccounts(tx).map(a => ENTITIES[a]).filter(Boolean);
}

function isBundler(tx) {
  return getAccounts(tx).some(a => BUNDLERS.has(a));
}

// Find who funded a wallet (SOL sender in its birth tx)
async function getOldestFunder(address) {
  const sigs = await getOldestSigs(address, 8);
  if (!sigs.length) return { birthTime: null, funder: null, sig: null };
  const tx = await getTx(sigs[0].signature);
  if (!tx) return { birthTime: sigs[0].blockTime, funder: null, sig: sigs[0].signature };

  const accts = getAccounts(tx);
  const pre   = tx.meta?.preBalances  ?? [];
  const post  = tx.meta?.postBalances ?? [];
  let funder  = null;

  for (let i = 0; i < accts.length; i++) {
    if (accts[i] === address) continue;
    if ((pre[i] ?? 0) > (post[i] ?? 0)) { funder = accts[i]; break; }
  }
  return { birthTime: sigs[0].blockTime, funder, sig: sigs[0].signature };
}

// Get owner of a SPL token account
async function getTokenAcctOwner(tokenAcct) {
  const info = await rpc("getAccountInfo", [tokenAcct, { encoding: "jsonParsed" }]);
  return info?.value?.data?.parsed?.info?.owner ?? null;
}

// Get token birth time (first tx on the token account = first acquisition)
async function getFirstAcquisition(tokenAcct) {
  const sigs = await getOldestSigs(tokenAcct, 5);
  return sigs[0] ? { sig: sigs[0].signature, blockTime: sigs[0].blockTime } : null;
}

// Trace funding chain upward
async function traceChain(start, maxDepth) {
  const chain = [{ addr: start, label: null, birthTime: null }];
  let current = start;
  const visited = new Set([start]);

  for (let d = 0; d < maxDepth; d++) {
    await sleep(DELAY_MS);
    const { birthTime, funder } = await getOldestFunder(current);
    chain[chain.length - 1].birthTime = birthTime;
    if (!funder || visited.has(funder)) break;

    const label = ENTITIES[funder] ?? null;
    chain.push({ addr: funder, label, birthTime: null });
    visited.add(funder);
    current = funder;
    if (label) break;
  }
  return chain;
}

// ── Output ─────────────────────────────────────────────────────────────────
const lines = [];
function log(s = "") { lines.push(s); process.stdout.write(s + "\n"); }
function section(title) {
  log();
  log(c("cyan", "─".repeat(65)));
  log(c("cyan", `  ${title}`));
  log(c("cyan", "─".repeat(65)));
}
function progress(msg) {
  if (!JSON_OUT) process.stdout.write(c("gray", `  ⟳  ${msg}...\r`));
}
function clearLine() { if (!JSON_OUT) process.stdout.write("\x1b[2K\r"); }

// ── SCANNER ────────────────────────────────────────────────────────────────
async function scan() {
  const startTime = Date.now();
  const report    = { mint: MINT, timestamp: new Date().toISOString(), holders: [], clusters: [], snipers: [], risk: {} };

  // ── Header ────────────────────────────────────────────────────────────────
  log(c("bold", "═".repeat(65)));
  log(c("bold", `  🔍 SOLANA TOKEN FORENSIC SCANNER`));
  log(c("bold", "═".repeat(65)));
  log(`  Mint    : ${c("yellow", MINT)}`);
  log(`  Top N   : ${TOP_N}   Chain depth : ${DEPTH}   Sync window : ${SYNC_WIN}s`);
  log(`  API     : Helius Mainnet`);
  log(c("bold", "═".repeat(65)));

  // ── 1. Top holders ────────────────────────────────────────────────────────
  section("1 / 6  —  TOP HOLDERS");
  progress(`Fetching top ${TOP_N} holders`);
  const largestAccts = await rpc("getTokenLargestAccounts", [MINT]);
  clearLine();

  if (!largestAccts?.value?.length) {
    log(c("red", "  ✗  No holder data. Check the mint address."));
    return;
  }

  const topHolders = largestAccts.value.slice(0, TOP_N);
  const totalInTop = topHolders.reduce((s, h) => s + parseInt(h.amount), 0);
  log(`  Found ${topHolders.length} holders. Top-${TOP_N} combined supply: ${fmtN(totalInTop / 1e6)} tokens`);

  // ── 2. Token launch time ──────────────────────────────────────────────────
  section("2 / 6  —  TOKEN LAUNCH TIME");
  progress("Paging to mint's oldest transaction");

  const mintSigs   = await getOldestSigs(MINT, 10);
  clearLine();

  // True launch = min(mint oldest tx, earliest holder acquisition)
  // We'll update this after we scan holders
  let launchTime = mintSigs[0]?.blockTime ?? null;
  log(`  Mint oldest tx   : ${launchTime ? c("yellow", fmt(launchTime)) : c("red", "not found")}`);

  // ── 3. Holder deep scan ───────────────────────────────────────────────────
  section("3 / 6  —  HOLDER ANALYSIS (funding + timing)");
  log(dim(`  Scanning ${topHolders.length} holders — this takes ~${Math.ceil(topHolders.length * DELAY_MS * 3 / 1000)}s...`));
  log();

  const holderRows = [];
  const funderMap  = {};  // funderAddr -> [{ holderIdx, address, tokens }]

  for (let i = 0; i < topHolders.length; i++) {
    const { address, amount } = topHolders[i];
    const tokens = parseInt(amount) / 1e6;
    const pct    = (tokens / (totalInTop / 1e6) * 100).toFixed(1);

    progress(`Holder ${i + 1}/${topHolders.length}: ${short(address)}`);

    // Parallel: get owner + first acquisition
    const [owner, acq] = await Promise.all([
      getTokenAcctOwner(address),
      getFirstAcquisition(address),
    ]);

    const buyTime     = acq?.blockTime ?? null;
    if (buyTime && launchTime && buyTime < launchTime) launchTime = buyTime;

    // Get funder of the owner wallet
    const { funder, birthTime: ownerBirth } = await getOldestFunder(owner ?? address);

    const row = {
      rank: i + 1,
      tokenAcct: address,
      owner:      owner ?? address,
      tokens,
      pct:        parseFloat(pct),
      buyTime,
      ownerBirth,
      funder,
      funderLabel: funder ? (ENTITIES[funder] ?? null) : null,
    };
    holderRows.push(row);

    // Track funders for cluster detection
    if (funder) {
      if (!funderMap[funder]) funderMap[funder] = [];
      funderMap[funder].push(row);
    }

    await sleep(DELAY_MS);
  }

  clearLine();

  // Update true launch time
  report.launchTime = launchTime;
  log(`  True launch time : ${launchTime ? c("yellow", fmt(launchTime)) : c("red", "unknown")}`);
  log();

  // Print holder table
  log(`  ${"#".padStart(3)}  ${"Token Account".padEnd(14)}  ${"Owner".padEnd(14)}  ${"Tokens".padStart(16)}  ${"% Top"}  ${"First Buy".padEnd(21)}  ${"Funded by".padEnd(14)}`);
  log(`  ${"─".repeat(3)}  ${"─".repeat(14)}  ${"─".repeat(14)}  ${"─".repeat(16)}  ${"─".repeat(5)}  ${"─".repeat(21)}  ${"─".repeat(14)}`);

  for (const r of holderRows) {
    const buyStr    = r.buyTime ? fmt(r.buyTime).slice(0, 19) : "unknown";
    const funderStr = r.funder  ? short(r.funder) : "unknown";
    const flags     = [];
    if (r.funderLabel) flags.push("⚡");
    if (r.buyTime && launchTime && r.buyTime - launchTime <= EARLY_WIN) flags.push("🎯");
    const flag = flags.join("");

    log(
      `  ${String(r.rank).padStart(3)}  ${short(r.tokenAcct, 12).padEnd(14)}  ${short(r.owner, 12).padEnd(14)}  ` +
      `${fmtN(r.tokens).padStart(16)}  ${String(r.pct + "%").padStart(5)}  ${buyStr.padEnd(21)}  ${funderStr.padEnd(14)} ${flag}`
    );
  }

  report.holders = holderRows;

  // ── 4. Cluster detection ──────────────────────────────────────────────────
  section("4 / 6  —  CLUSTER DETECTION");

  const clusters = Object.entries(funderMap)
    .filter(([, rows]) => rows.length > 1)
    .sort((a, b) => b[1].reduce((s, r) => s + r.tokens, 0) - a[1].reduce((s, r) => s + r.tokens, 0));

  if (clusters.length === 0) {
    log(c("green", "  ✅  No funding clusters detected. All holders have distinct funders."));
  } else {
    log(`  Found ${c("yellow", clusters.length)} cluster(s):\n`);
    for (const [parent, rows] of clusters) {
      const totalTokens = rows.reduce((s, r) => s + r.tokens, 0);
      const pct         = (totalTokens / (totalInTop / 1e6) * 100).toFixed(1);
      const label       = ENTITIES[parent] ?? "unknown entity";
      const isBad       = BUNDLERS.has(parent);

      log(c(isBad ? "red" : "yellow", `  ⚠  Cluster parent: ${parent}`));
      log(`     Entity    : ${label}`);
      log(`     Controls  : ${rows.length} wallets — ${fmtN(totalTokens)} tokens (${pct}% of top ${TOP_N})`);
      log(`     Members   :`);
      rows.forEach(r => log(`       #${String(r.rank).padStart(2)}  ${r.tokenAcct}  ${fmtN(r.tokens)} tokens`));

      // Trace the parent's own chain
      progress(`Tracing chain for ${short(parent)}`);
      const chain = await traceChain(parent, DEPTH);
      clearLine();

      log(`     Chain (${chain.length - 1} hop${chain.length !== 2 ? "s" : ""}):`);
      chain.forEach((c2, i) => {
        const lbl = c2.label ? ` ⚡ ${c2.label}` : "";
        const ts  = c2.birthTime ? ` (${fmt(c2.birthTime)})` : "";
        log(`       ${i === 0 ? "Start" : `Hop ${i}`} → ${c2.addr}${lbl}${ts}`);
      });

      const root = chain[chain.length - 1];
      report.clusters.push({ parent, label, rows: rows.map(r => r.rank), totalTokens, pct: parseFloat(pct), chain });
      log();
    }
  }

  // ── 5. Timing analysis ────────────────────────────────────────────────────
  section("5 / 6  —  TIMING ANALYSIS");

  // Early buyers (< EARLY_WIN seconds after launch)
  const withBuyTime = holderRows.filter(r => r.buyTime !== null && launchTime !== null);
  const earlyBuyers = withBuyTime
    .filter(r => r.buyTime - launchTime >= 0 && r.buyTime - launchTime <= EARLY_WIN)
    .sort((a, b) => a.buyTime - b.buyTime);

  log(`  Early buyers (within ${EARLY_WIN / 60}min of launch):`);
  if (earlyBuyers.length === 0) {
    log(c("green", "  ✅  None detected."));
  } else {
    earlyBuyers.forEach(r => {
      const delay = r.buyTime - launchTime;
      const isSameBlock = delay <= 2;
      const color = isSameBlock ? "red" : "yellow";
      log(c(color, `  ⚠  #${String(r.rank).padStart(2)}  ${r.tokenAcct}  ${fmtDelta(delay)} after launch  (${fmtN(r.tokens)} tokens)`));
    });
  }

  // Synchronized buys (within SYNC_WIN seconds of each other)
  log();
  const sorted   = [...withBuyTime].sort((a, b) => a.buyTime - b.buyTime);
  const visited  = new Set();
  const syncGroups = [];

  for (let i = 0; i < sorted.length; i++) {
    if (visited.has(sorted[i].owner)) continue;
    const group = [sorted[i]];
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].buyTime - sorted[i].buyTime <= SYNC_WIN) group.push(sorted[j]);
    }
    if (group.length > 1) {
      group.forEach(r => visited.add(r.owner));
      syncGroups.push(group);
    }
  }

  log(`  Synchronized buys (within ${SYNC_WIN}s of each other):`);
  if (syncGroups.length === 0) {
    log(c("green", "  ✅  None detected."));
  } else {
    syncGroups.forEach((group, i) => {
      const span = group[group.length - 1].buyTime - group[0].buyTime;
      log(c("yellow", `  ⚠  Sync group #${i + 1}: ${group.length} wallets bought within ${span}s`));
      group.forEach(r => log(`     #${String(r.rank).padStart(2)}  ${r.tokenAcct}  ${fmt(r.buyTime)}  (${fmtN(r.tokens)} tokens)`));
    });
  }

  // Wallet creation timing clusters (within 60s of each other)
  log();
  const withBirth = holderRows.filter(r => r.ownerBirth !== null).sort((a, b) => a.ownerBirth - b.ownerBirth);
  const birthVisited = new Set();
  const birthGroups  = [];

  for (let i = 0; i < withBirth.length; i++) {
    if (birthVisited.has(withBirth[i].owner)) continue;
    const group = [withBirth[i]];
    for (let j = i + 1; j < withBirth.length; j++) {
      if (Math.abs(withBirth[j].ownerBirth - withBirth[i].ownerBirth) <= 60) group.push(withBirth[j]);
    }
    if (group.length > 1) {
      group.forEach(r => birthVisited.add(r.owner));
      birthGroups.push(group);
    }
  }

  log(`  Coordinated wallet creation (within 60s of each other):`);
  if (birthGroups.length === 0) {
    log(c("green", "  ✅  None detected."));
  } else {
    birthGroups.forEach((group, i) => {
      const span = group[group.length - 1].ownerBirth - group[0].ownerBirth;
      log(c("yellow", `  ⚠  Creation group #${i + 1}: ${group.length} wallets created within ${span}s`));
      group.forEach(r => log(`     #${String(r.rank).padStart(2)}  ${r.owner}  created ${fmt(r.ownerBirth)}`));
    });
  }

  // ── 6. Sniper detection ───────────────────────────────────────────────────
  section("6 / 6  —  SNIPER DETECTION");

  const snipers = earlyBuyers.filter(r => launchTime && r.buyTime - launchTime <= 2);
  const fastBuyers = earlyBuyers.filter(r => launchTime && r.buyTime - launchTime > 2 && r.buyTime - launchTime <= 60);

  if (snipers.length > 0) {
    log(c("red", `  🚨  ${snipers.length} same-block sniper(s) detected:`));
    snipers.forEach(r => {
      log(c("red", `     #${String(r.rank).padStart(2)}  ${r.tokenAcct}`));
      log(`          Owner : ${r.owner}`);
      log(`          Tokens: ${fmtN(r.tokens)}  (${r.pct}% of top ${TOP_N})`);
      log(`          Funder: ${r.funder ?? "unknown"}  ${r.funderLabel ? `[${r.funderLabel}]` : ""}`);
    });
    report.snipers = snipers.map(r => r.rank);
  } else {
    log(c("green", "  ✅  No same-block snipers detected."));
  }

  if (fastBuyers.length > 0) {
    log();
    log(c("yellow", `  ⚠  ${fastBuyers.length} fast buyer(s) (1–60s after launch):`));
    fastBuyers.forEach(r => {
      const delay = r.buyTime - launchTime;
      log(`     #${String(r.rank).padStart(2)}  ${r.tokenAcct}  +${delay}s  ${fmtN(r.tokens)} tokens`);
    });
  }

  // ── Risk Score ─────────────────────────────────────────────────────────────
  section("RISK SCORE");

  let score = 0;
  const signals = [];

  // Cluster signals
  const clusterTokenPct = clusters.reduce((s, [, rows]) => {
    return s + rows.reduce((t, r) => t + r.tokens, 0) / (totalInTop / 1e6) * 100;
  }, 0);
  if (clusters.length > 0) {
    const pts = Math.min(30, Math.round(clusterTokenPct / 2));
    score += pts;
    signals.push({ label: `Funding clusters (${clusters.length} found, ${clusterTokenPct.toFixed(0)}% of top holders)`, pts });
  }

  // Bundler in chain
  const hasBundler = clusters.some(([, rows]) => {
    return false; // placeholder — would check chain results
  });
  if (report.clusters.some(cl => cl.chain.some(c2 => BUNDLERS.has(c2.addr)))) {
    score += 25;
    signals.push({ label: "Known bundler in funding chain", pts: 25 });
  }

  // Snipers
  if (snipers.length > 0) {
    const pts = Math.min(20, snipers.length * 8);
    score += pts;
    signals.push({ label: `Same-block snipers (${snipers.length})`, pts });
  }

  // Fast buyers
  if (fastBuyers.length > 0) {
    const pts = Math.min(10, fastBuyers.length * 3);
    score += pts;
    signals.push({ label: `Fast buyers <60s (${fastBuyers.length})`, pts });
  }

  // Sync groups
  if (syncGroups.length > 0) {
    score += syncGroups.length * 8;
    signals.push({ label: `Synchronized buy groups (${syncGroups.length})`, pts: syncGroups.length * 8 });
  }

  // Coordinated creation
  if (birthGroups.length > 0) {
    score += birthGroups.length * 6;
    signals.push({ label: `Coordinated wallet creation (${birthGroups.length} groups)`, pts: birthGroups.length * 6 });
  }

  score = Math.min(100, score);

  const riskLabel =
    score >= 75 ? c("red",    "🔴  VERY HIGH") :
    score >= 50 ? c("red",    "🟠  HIGH")       :
    score >= 25 ? c("yellow", "🟡  MODERATE")   :
                  c("green",  "🟢  LOW");

  log();
  log(bold(`  Risk Score : ${score} / 100   ${riskLabel}`));
  log();

  if (signals.length === 0) {
    log(c("green", "  No risk signals detected."));
  } else {
    log("  Signal breakdown:");
    signals.forEach(s => log(`    +${String(s.pts).padStart(2)}  ${s.label}`));
  }

  log();
  log(c("green",  "  Clean signals:"));
  if (clusters.length === 0)    log(c("green", "    ✅  No funding clusters"));
  if (snipers.length === 0)     log(c("green", "    ✅  No same-block snipers"));
  if (syncGroups.length === 0)  log(c("green", "    ✅  No synchronized buys"));
  if (birthGroups.length === 0) log(c("green", "    ✅  No coordinated wallet creation"));

  report.risk = { score, label: riskLabel, signals };

  // ── Footer ─────────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log();
  log(c("bold", "═".repeat(65)));
  log(dim(`  Scan complete in ${elapsed}s  |  ${new Date().toISOString()}`));
  log(c("bold", "═".repeat(65)));

  // ── Optional JSON output ───────────────────────────────────────────────────
  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  }

  // ── Optional save ──────────────────────────────────────────────────────────
  if (SAVE) {
    const stream = createWriteStream(SAVE);
    stream.write(lines.join("\n"));
    stream.end();
    console.error(`Report saved to ${SAVE}`);
  }
}

scan().catch(err => {
  console.error(c("red", `\nFatal error: ${err.message}`));
  process.exit(1);
});
