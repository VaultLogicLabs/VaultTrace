/**
 * Solana Token Forensic Scanner — engine module
 * Can be used as a CLI:  node index.js <MINT> [--top=N] [--depth=N] [--json] [--save=FILE]
 * Or imported:           import { runScan } from "./index.js"
 */

import { createWriteStream } from "fs";

// ── Detect CLI vs module mode ──────────────────────────────────────────────
const IS_CLI = process.argv[1]?.endsWith("index.js");

// ── Config ─────────────────────────────────────────────────────────────────
const API_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`;
const DELAY_MS = 220;
const SYNC_WIN = 30;
const EARLY_WIN = 300;

const RAYDIUM_AMM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const NULL_ADDR = "11111111111111111111111111111111";
const PUMPFUN_PROG = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const ENTITIES = {
  [PUMPFUN_PROG]: "Pump.fun Program",
  TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM: "Pump.fun Fee Wallet",
  "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg": "Pump.fun Bundler",
  BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW: "Pump.fun Launch Authority",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter v6",
  "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5": "Jupiter Aggregator",
  [RAYDIUM_AMM]: "Raydium AMM",
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1": "Raydium Authority",
  EhYXq3ANp5nAerUpbSgd7VK2RRcxK1zNuSQ755G5Dbqk: "Raydium Bundler",
  BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9VSGQDV: "Bonkbot",
  HWEoBxYs7ssKuudEjzjmpileDs9685ykXMkNJsJCcaJo: "Wormhole",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token Program",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS: "ATA Program",
  [NULL_ADDR]: "System Program",
  ComputeBudget111111111111111111111111111111111: "Compute Budget",
};

const BUNDLERS = new Set([
  "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg",
  "EhYXq3ANp5nAerUpbSgd7VK2RRcxK1zNuSQ755G5Dbqk",
  "BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW",
]);

// ── ANSI (CLI only) ────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};
const ansi = (color, str, tty) => (tty ? `${C[color]}${str}${C.reset}` : str);
const bold = (s, tty) => ansi("bold", s, tty);
const dim = (s, tty) => ansi("dim", s, tty);

// ── Formatting ─────────────────────────────────────────────────────────────
const fmt = (ts) =>
  new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
const fmtN = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
const short = (a, n = 8) => (a ? a.slice(0, n) + "…" : "?");

function fmtDelta(s) {
  const abs = Math.abs(s),
    sign = s < 0 ? "-" : "+";
  if (abs < 60) return `${sign}${abs}s`;
  if (abs < 3600) return `${sign}${Math.floor(abs / 60)}m ${abs % 60}s`;
  return `${sign}${Math.floor(abs / 3600)}h ${Math.floor((abs % 3600) / 60)}m`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── In-process cache (survives across runScan calls in the same server process)
// Keyed on stable, address-derived strings. TTL is enforced lazily on read.
// Static on-chain data (birth tx, mint authority, token ownership) never changes,
// so 24 h is safe. LP status is cached for 6 h in case it transitions from
// unlocked → burned between two scans run on the same day.
const CACHE = new Map();
const TTL_24H = 86_400_000;
const TTL_6H  =  21_600_000;

function cacheGet(key) {
  const entry = CACHE.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) { CACHE.delete(key); return undefined; }
  return entry.value;
}

function cacheSet(key, value, ttl = TTL_24H) {
  CACHE.set(key, { value, expiresAt: Date.now() + ttl });
}

// Fetch-or-populate: returns cached value when fresh, otherwise calls fn(),
// stores the result, and returns it.
async function getCached(key, ttl, fn) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const value = await fn();
  cacheSet(key, value, ttl);
  return value;
}

// Exported so server.js can surface cache health
export function cacheStats() {
  let alive = 0, expired = 0;
  const now = Date.now();
  for (const entry of CACHE.values()) {
    entry.expiresAt > now ? alive++ : expired++;
  }
  return { entries: alive, expired, total: CACHE.size };
}

export function cacheClear() {
  CACHE.clear();
}

// ── RPC with exponential-backoff retry ────────────────────────────────────
const MAX_RETRIES = 5;
const BACKOFF_BASE = 500;

async function rpc(method, params) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "scanner", method, params }),
      });
    } catch (networkErr) {
      if (attempt === MAX_RETRIES) throw networkErr;
      await sleep(BACKOFF_BASE * Math.pow(2, attempt));
      continue;
    }

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "0") * 1000;
      const wait = Math.max(retryAfter, BACKOFF_BASE * Math.pow(2, attempt));
      if (attempt === MAX_RETRIES)
        throw new Error(`RPC rate-limited after ${MAX_RETRIES} retries`);
      await sleep(wait);
      continue;
    }

    const json = await res.json();
    if (json.error) {
      const code = json.error.code;
      if (code === -32429 || code === 429) {
        const wait = BACKOFF_BASE * Math.pow(2, attempt);
        if (attempt === MAX_RETRIES)
          throw new Error(`RPC error ${code}: ${json.error.message}`);
        await sleep(wait);
        continue;
      }
      return null;
    }
    return json.result;
  }
}

// ── Signature paging ───────────────────────────────────────────────────────
// Cached: the oldest transactions for an address never change, so a 24 h TTL
// is always safe. maxPages is folded into the key so different depths don't
// collide — and a deeper call will naturally supersede a shallower one on the
// next miss (shallower results are never "wrong", just potentially incomplete).
async function getOldestSigs(address, maxPages = 8) {
  return getCached(`sigs:${address}:${maxPages}`, TTL_24H, async () => {
    let before;
    const all = [];
    for (let p = 0; p < maxPages; p++) {
      const sigs = await rpc("getSignaturesForAddress", [
        address,
        { limit: 1000, ...(before ? { before } : {}) },
      ]);
      if (!sigs?.length) break;
      all.push(...sigs);
      if (sigs.length < 1000) break;
      before = sigs[sigs.length - 1].signature;
      await sleep(DELAY_MS);
    }
    return all.reverse();
  });
}

async function getTx(sig) {
  return rpc("getTransaction", [
    sig,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ]);
}

function getAccounts(tx) {
  return (tx?.transaction?.message?.accountKeys ?? []).map(
    (a) => a.pubkey ?? a,
  );
}

async function getOldestFunder(address) {
  return getCached(`funder:${address}`, TTL_24H, async () => {
    const sigs = await getOldestSigs(address, 8);
    if (!sigs.length) return { birthTime: null, funder: null };
    const tx = await getTx(sigs[0].signature);
    if (!tx) return { birthTime: sigs[0].blockTime, funder: null };
    const accts = getAccounts(tx);
    const pre = tx.meta?.preBalances ?? [];
    const post = tx.meta?.postBalances ?? [];
    let funder = null;
    for (let i = 0; i < accts.length; i++) {
      if (accts[i] === address) continue;
      if ((pre[i] ?? 0) > (post[i] ?? 0)) { funder = accts[i]; break; }
    }
    return { birthTime: sigs[0].blockTime, funder };
  });
}

async function getTokenAcctOwner(tokenAcct) {
  return getCached(`owner:${tokenAcct}`, TTL_24H, async () => {
    const info = await rpc("getAccountInfo", [tokenAcct, { encoding: "jsonParsed" }]);
    return info?.value?.data?.parsed?.info?.owner ?? null;
  });
}

async function getFirstAcquisition(tokenAcct) {
  return getCached(`firstAcq:${tokenAcct}`, TTL_24H, async () => {
    const sigs = await getOldestSigs(tokenAcct, 5);
    return sigs[0] ? { sig: sigs[0].signature, blockTime: sigs[0].blockTime } : null;
  });
}

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

async function getMintAuthority(mint) {
  return getCached(`mintAuth:${mint}`, TTL_24H, async () => {
    const info   = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
    const parsed = info?.value?.data?.parsed?.info ?? null;
    if (!parsed) return { mintAuthority: "unknown", freezeAuthority: "unknown", decimals: null, supply: null };
    return {
      mintAuthority:   parsed.mintAuthority   ?? null,
      freezeAuthority: parsed.freezeAuthority ?? null,
      decimals:        parsed.decimals        ?? null,
      supply:          parsed.supply          ?? null,
      isInitialized:   parsed.isInitialized   ?? null,
    };
  });
}

async function getLpStatus(mint, mintSigs) {
  // LP status uses TTL_6H (not 24 h) because an unlocked pool could be burned
  // between two scans run on the same day. Once status is "burned" or
  // "bonding_curve" it won't regress, but we don't know that at read time.
  const cached = cacheGet(`lpStatus:${mint}`);
  if (cached !== undefined) return cached;

  const result = {
    poolType: null,
    lpMint: null,
    lpSupply: null,
    burned: null,
    burnedPct: null,
    lockedAddr: null,
    graduated: false,
    status: "unknown",
  };

  const txsToScan = mintSigs.slice(0, 80);
  for (const sigEntry of txsToScan) {
    await sleep(DELAY_MS);
    const tx = await getTx(sigEntry.signature);
    if (!tx) continue;
    const accts = getAccounts(tx);
    if (!accts.includes(RAYDIUM_AMM)) continue;

    const preBals = tx.meta?.preTokenBalances ?? [];
    const postBals = tx.meta?.postTokenBalances ?? [];
    const preMints = new Set(preBals.map((b) => b.mint));
    let lpMint = null;
    for (const bal of postBals) {
      if (bal.mint === mint || bal.mint === WSOL_MINT) continue;
      if (!preMints.has(bal.mint)) {
        lpMint = bal.mint;
        break;
      }
    }
    if (!lpMint) {
      for (const bal of postBals) {
        if (bal.mint !== mint && bal.mint !== WSOL_MINT) {
          lpMint = bal.mint;
          break;
        }
      }
    }
    if (!lpMint) continue;

    result.poolType = "raydium";
    result.lpMint = lpMint;
    result.graduated = accts.includes(PUMPFUN_PROG);

    await sleep(DELAY_MS);
    const supplyData = await rpc("getTokenSupply", [lpMint]);
    const lpSupply = parseInt(supplyData?.value?.amount ?? "-1");
    result.lpSupply = lpSupply;

    if (lpSupply === 0) {
      result.burned = true;
      result.burnedPct = 100;
      result.status = "burned";
      cacheSet(`lpStatus:${mint}`, result, TTL_6H);
      return result;
    }

    await sleep(DELAY_MS);
    const largest = await rpc("getTokenLargestAccounts", [lpMint]);
    const holders = largest?.value ?? [];
    let burnedAmt = 0;
    for (const h of holders.slice(0, 5)) {
      await sleep(DELAY_MS);
      const owner = await getTokenAcctOwner(h.address);
      if (owner === NULL_ADDR) {
        burnedAmt += parseInt(h.amount ?? "0");
        result.lockedAddr = h.address;
      }
    }
    if (lpSupply > 0) {
      result.burnedPct = Math.round((burnedAmt / lpSupply) * 100);
      result.burned = result.burnedPct >= 99;
      result.status = result.burned
        ? "burned"
        : result.burnedPct >= 50
          ? "partially_locked"
          : "unlocked";
    }
    cacheSet(`lpStatus:${mint}`, result, TTL_6H);
    return result;
  }

  const recentSigs =
    (await rpc("getSignaturesForAddress", [mint, { limit: 5 }])) ?? [];
  for (const s of recentSigs) {
    await sleep(DELAY_MS);
    const tx = await getTx(s.signature);
    if (!tx) continue;
    if (getAccounts(tx).includes(PUMPFUN_PROG)) {
      result.poolType = "pumpfun";
      result.status = "bonding_curve";
      cacheSet(`lpStatus:${mint}`, result, TTL_6H);
      return result;
    }
  }
  result.status = "not_found";
  cacheSet(`lpStatus:${mint}`, result, TTL_6H);
  return result;
}

// ── Core scan function (exported) ──────────────────────────────────────────
export async function runScan(mintAddress, options = {}) {
  const {
    topN = 20,
    depth = 6,
    silent = false, // suppress all stdout when called from server
    save = null,
    onProgress = null, // optional callback for SSE / streaming callers
  } = options;

  const startTime = Date.now();
  const tty = !silent; // emit ANSI only in CLI mode
  const lines = [];

  // Fire-and-forget progress emitter for SSE / streaming callers
  const emit = (ev) => { try { if (onProgress) onProgress(ev); } catch (_) {} };

  const report = {
    mint: mintAddress,
    timestamp: new Date().toISOString(),
    contractSecurity: {},
    launchTime: null,
    holders: [],
    clusters: [],
    snipers: [],
    risk: {},
  };

  function log(s = "") {
    lines.push(s);
    if (tty) process.stdout.write(s + "\n");
  }
  function section(title) {
    log();
    log(ansi("cyan", "─".repeat(65), tty));
    log(ansi("cyan", `  ${title}`, tty));
    log(ansi("cyan", "─".repeat(65), tty));
    emit({ type: "section", label: title });
  }
  function progress(msg) {
    if (tty) process.stdout.write(ansi("gray", `  ⟳  ${msg}...\r`, tty));
    emit({ type: "progress", message: msg });
  }
  function clr() {
    if (tty) process.stdout.write("\x1b[2K\r");
  }

  // ── Header ─────────────────────────────────────────────────────────────
  log(bold("═".repeat(65), tty));
  log(bold("  🔍 SOLANA TOKEN FORENSIC SCANNER", tty));
  log(bold("═".repeat(65), tty));
  log(`  Mint    : ${ansi("yellow", mintAddress, tty)}`);
  log(
    `  Top N   : ${topN}   Chain depth : ${depth}   Sync window : ${SYNC_WIN}s`,
  );
  log(`  API     : Helius Mainnet`);
  log(bold("═".repeat(65), tty));

  // ── 1. Contract Security ────────────────────────────────────────────────
  section("1 / 7  —  CONTRACT SECURITY");
  progress("Querying mint account authority fields");
  const authority = await getMintAuthority(mintAddress);
  clr();

  const mintUnrevoked =
    authority.mintAuthority !== null && authority.mintAuthority !== undefined;
  const freezeUnrevoked =
    authority.freezeAuthority !== null &&
    authority.freezeAuthority !== undefined;

  log(`  Decimals      : ${authority.decimals ?? "unknown"}`);
  log(
    `  Total supply  : ${authority.supply ? fmtN(parseInt(authority.supply) / Math.pow(10, authority.decimals ?? 6)) : "unknown"}`,
  );
  log();

  if (mintUnrevoked) {
    log(
      ansi(
        "red",
        `  🚨  MINT AUTHORITY   : NOT REVOKED  — ${authority.mintAuthority}`,
        tty,
      ),
    );
    log(
      ansi(
        "red",
        `       ⚠  Whoever holds this key can mint unlimited tokens at any time.`,
        tty,
      ),
    );
    log(
      ansi(
        "red",
        `       ⚠  CRITICAL RISK: supply inflation can rug all existing holders.`,
        tty,
      ),
    );
  } else {
    log(ansi("green", `  ✅  Mint authority  : revoked (null)`, tty));
  }
  log();
  if (freezeUnrevoked) {
    log(
      ansi(
        "yellow",
        `  ⚠   FREEZE AUTHORITY: NOT REVOKED  — ${authority.freezeAuthority}`,
        tty,
      ),
    );
    log(
      ansi(
        "yellow",
        `       ⚠  Token accounts can be frozen, preventing holders from selling.`,
        tty,
      ),
    );
    log(
      ansi(
        "yellow",
        `       ⚠  HIGH RISK: selective freeze is a honeypot mechanism.`,
        tty,
      ),
    );
  } else {
    log(ansi("green", `  ✅  Freeze authority: revoked (null)`, tty));
  }

  report.contractSecurity.mintAuthority = authority.mintAuthority;
  report.contractSecurity.freezeAuthority = authority.freezeAuthority;
  report.contractSecurity.mintUnrevoked = mintUnrevoked;
  report.contractSecurity.freezeUnrevoked = freezeUnrevoked;
  report.contractSecurity.decimals = authority.decimals;
  report.contractSecurity.totalSupply = authority.supply
    ? parseInt(authority.supply) / Math.pow(10, authority.decimals ?? 6)
    : null;

  // ── 2. Top Holders ──────────────────────────────────────────────────────
  section("2 / 7  —  TOP HOLDERS");
  progress(`Fetching top ${topN} holders`);
  const largestAccts = await rpc("getTokenLargestAccounts", [mintAddress]);
  clr();

  if (!largestAccts?.value?.length) {
    const err = { error: "No holder data returned. Verify the mint address." };
    report.error = err.error;
    return report;
  }

  const topHolders = largestAccts.value.slice(0, topN);
  const totalInTop = topHolders.reduce((s, h) => s + parseInt(h.amount), 0);
  log(
    `  Found ${topHolders.length} holders. Top-${topN} combined supply: ${fmtN(totalInTop / 1e6)} tokens`,
  );

  // ── 3. Token Launch Time ────────────────────────────────────────────────
  section("3 / 7  —  TOKEN LAUNCH TIME");
  progress("Paging to mint's oldest transaction");
  const mintSigs = await getOldestSigs(mintAddress, 10);
  clr();

  let launchTime = mintSigs[0]?.blockTime ?? null;
  log(
    `  Mint oldest tx   : ${launchTime ? ansi("yellow", fmt(launchTime), tty) : ansi("red", "not found", tty)}`,
  );

  // ── 4. Holder Analysis ──────────────────────────────────────────────────
  section("4 / 7  —  HOLDER ANALYSIS (funding + timing)");
  log(
    dim(
      `  Scanning ${topHolders.length} holders — this takes ~${Math.ceil((topHolders.length * DELAY_MS * 3) / 1000)}s...`,
      tty,
    ),
  );
  log();

  const holderRows = [];
  const funderMap = {};

  for (let i = 0; i < topHolders.length; i++) {
    const { address, amount } = topHolders[i];
    const tokens = parseInt(amount) / 1e6;
    const pct = ((tokens / (totalInTop / 1e6)) * 100).toFixed(1);

    emit({ type: "holder", rank: i + 1, total: topHolders.length, address: short(address) });
    progress(`Holder ${i + 1}/${topHolders.length}: ${short(address)}`);

    const [owner, acq] = await Promise.all([
      getTokenAcctOwner(address),
      getFirstAcquisition(address),
    ]);

    const buyTime = acq?.blockTime ?? null;
    if (buyTime && launchTime && buyTime < launchTime) launchTime = buyTime;

    const { funder, birthTime: ownerBirth } = await getOldestFunder(
      owner ?? address,
    );

    const row = {
      rank: i + 1,
      tokenAcct: address,
      owner: owner ?? address,
      tokens,
      pct: parseFloat(pct),
      buyTime,
      ownerBirth,
      funder,
      funderLabel: funder ? (ENTITIES[funder] ?? null) : null,
    };
    holderRows.push(row);
    if (funder) {
      if (!funderMap[funder]) funderMap[funder] = [];
      funderMap[funder].push(row);
    }
    await sleep(DELAY_MS);
  }

  clr();
  report.launchTime = launchTime;
  log(
    `  True launch time : ${launchTime ? ansi("yellow", fmt(launchTime), tty) : ansi("red", "unknown", tty)}`,
  );
  log();

  log(
    `  ${"#".padStart(3)}  ${"Token Account".padEnd(14)}  ${"Owner".padEnd(14)}  ${"Tokens".padStart(16)}  ${"% Top"}  ${"First Buy".padEnd(21)}  ${"Funded by".padEnd(14)}`,
  );
  log(
    `  ${"─".repeat(3)}  ${"─".repeat(14)}  ${"─".repeat(14)}  ${"─".repeat(16)}  ${"─".repeat(5)}  ${"─".repeat(21)}  ${"─".repeat(14)}`,
  );

  for (const r of holderRows) {
    const buyStr = r.buyTime ? fmt(r.buyTime).slice(0, 19) : "unknown";
    const funderStr = r.funder ? short(r.funder) : "unknown";
    const flags = [];
    if (r.funderLabel) flags.push("⚡");
    if (r.buyTime && launchTime && r.buyTime - launchTime <= EARLY_WIN)
      flags.push("🎯");
    log(
      `  ${String(r.rank).padStart(3)}  ${short(r.tokenAcct, 12).padEnd(14)}  ${short(r.owner, 12).padEnd(14)}  ` +
        `${fmtN(r.tokens).padStart(16)}  ${String(r.pct + "%").padStart(5)}  ${buyStr.padEnd(21)}  ${funderStr.padEnd(14)} ${flags.join("")}`,
    );
  }
  report.holders = holderRows;

  // ── 5. Cluster Detection ────────────────────────────────────────────────
  section("5 / 7  —  CLUSTER DETECTION");

  const clusters = Object.entries(funderMap)
    .filter(([, rows]) => rows.length > 1)
    .sort(
      (a, b) =>
        b[1].reduce((s, r) => s + r.tokens, 0) -
        a[1].reduce((s, r) => s + r.tokens, 0),
    );

  if (clusters.length === 0) {
    log(
      ansi(
        "green",
        "  ✅  No funding clusters detected. All holders have distinct funders.",
        tty,
      ),
    );
  } else {
    log(`  Found ${clusters.length} cluster(s):\n`);
    for (const [parent, rows] of clusters) {
      const totalTokens = rows.reduce((s, r) => s + r.tokens, 0);
      const pct = ((totalTokens / (totalInTop / 1e6)) * 100).toFixed(1);
      const label = ENTITIES[parent] ?? "unknown entity";
      const isBad = BUNDLERS.has(parent);
      log(
        ansi(isBad ? "red" : "yellow", `  ⚠  Cluster parent: ${parent}`, tty),
      );
      log(`     Entity    : ${label}`);
      log(
        `     Controls  : ${rows.length} wallets — ${fmtN(totalTokens)} tokens (${pct}% of top ${topN})`,
      );
      log(`     Members   :`);
      rows.forEach((r) =>
        log(
          `       #${String(r.rank).padStart(2)}  ${r.tokenAcct}  ${fmtN(r.tokens)} tokens`,
        ),
      );

      progress(`Tracing chain for ${short(parent)}`);
      const chain = await traceChain(parent, depth);
      clr();

      log(
        `     Chain (${chain.length - 1} hop${chain.length !== 2 ? "s" : ""}):`,
      );
      chain.forEach((c2, i) => {
        const lbl = c2.label ? ` ⚡ ${c2.label}` : "";
        const ts = c2.birthTime ? ` (${fmt(c2.birthTime)})` : "";
        log(`       ${i === 0 ? "Start" : `Hop ${i}`} → ${c2.addr}${lbl}${ts}`);
      });
      report.clusters.push({
        parent,
        label,
        rows: rows.map((r) => r.rank),
        totalTokens,
        pct: parseFloat(pct),
        chain,
      });
      log();
    }
  }

  // ── 6. Timing Analysis ──────────────────────────────────────────────────
  section("6 / 7  —  TIMING ANALYSIS");

  const withBuyTime = holderRows.filter(
    (r) => r.buyTime !== null && launchTime !== null,
  );
  const earlyBuyers = withBuyTime
    .filter(
      (r) => r.buyTime - launchTime >= 0 && r.buyTime - launchTime <= EARLY_WIN,
    )
    .sort((a, b) => a.buyTime - b.buyTime);

  log(`  Early buyers (within ${EARLY_WIN / 60}min of launch):`);
  if (earlyBuyers.length === 0) {
    log(ansi("green", "  ✅  None detected.", tty));
  } else {
    earlyBuyers.forEach((r) => {
      const delay = r.buyTime - launchTime;
      log(
        ansi(
          delay <= 2 ? "red" : "yellow",
          `  ⚠  #${String(r.rank).padStart(2)}  ${r.tokenAcct}  ${fmtDelta(delay)} after launch  (${fmtN(r.tokens)} tokens)`,
          tty,
        ),
      );
    });
  }

  log();
  const sorted = [...withBuyTime].sort((a, b) => a.buyTime - b.buyTime);
  const visited = new Set();
  const syncGroups = [];
  for (let i = 0; i < sorted.length; i++) {
    if (visited.has(sorted[i].owner)) continue;
    const group = [sorted[i]];
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].buyTime - sorted[i].buyTime <= SYNC_WIN)
        group.push(sorted[j]);
    }
    if (group.length > 1) {
      group.forEach((r) => visited.add(r.owner));
      syncGroups.push(group);
    }
  }

  log(`  Synchronized buys (within ${SYNC_WIN}s of each other):`);
  if (syncGroups.length === 0) {
    log(ansi("green", "  ✅  None detected.", tty));
  } else {
    syncGroups.forEach((group, i) => {
      const span = group[group.length - 1].buyTime - group[0].buyTime;
      log(
        ansi(
          "yellow",
          `  ⚠  Sync group #${i + 1}: ${group.length} wallets bought within ${span}s`,
          tty,
        ),
      );
      group.forEach((r) =>
        log(
          `     #${String(r.rank).padStart(2)}  ${r.tokenAcct}  ${fmt(r.buyTime)}  (${fmtN(r.tokens)} tokens)`,
        ),
      );
    });
  }

  log();
  const withBirth = holderRows
    .filter((r) => r.ownerBirth !== null)
    .sort((a, b) => a.ownerBirth - b.ownerBirth);
  const birthVisited = new Set();
  const birthGroups = [];
  for (let i = 0; i < withBirth.length; i++) {
    if (birthVisited.has(withBirth[i].owner)) continue;
    const group = [withBirth[i]];
    for (let j = i + 1; j < withBirth.length; j++) {
      if (Math.abs(withBirth[j].ownerBirth - withBirth[i].ownerBirth) <= 60)
        group.push(withBirth[j]);
    }
    if (group.length > 1) {
      group.forEach((r) => birthVisited.add(r.owner));
      birthGroups.push(group);
    }
  }

  log(`  Coordinated wallet creation (within 60s of each other):`);
  if (birthGroups.length === 0) {
    log(ansi("green", "  ✅  None detected.", tty));
  } else {
    birthGroups.forEach((group, i) => {
      const span = group[group.length - 1].ownerBirth - group[0].ownerBirth;
      log(
        ansi(
          "yellow",
          `  ⚠  Creation group #${i + 1}: ${group.length} wallets created within ${span}s`,
          tty,
        ),
      );
      group.forEach((r) =>
        log(
          `     #${String(r.rank).padStart(2)}  ${r.owner}  created ${fmt(r.ownerBirth)}`,
        ),
      );
    });
  }

  // ── 7. Sniper Detection ─────────────────────────────────────────────────
  section("7 / 7  —  SNIPER DETECTION");

  const snipers = earlyBuyers.filter(
    (r) => launchTime && r.buyTime - launchTime <= 2,
  );
  const fastBuyers = earlyBuyers.filter(
    (r) =>
      launchTime && r.buyTime - launchTime > 2 && r.buyTime - launchTime <= 60,
  );

  if (snipers.length > 0) {
    log(
      ansi(
        "red",
        `  🚨  ${snipers.length} same-block sniper(s) detected:`,
        tty,
      ),
    );
    snipers.forEach((r) => {
      log(
        ansi("red", `     #${String(r.rank).padStart(2)}  ${r.tokenAcct}`, tty),
      );
      log(`          Owner : ${r.owner}`);
      log(`          Tokens: ${fmtN(r.tokens)}  (${r.pct}% of top ${topN})`);
      log(
        `          Funder: ${r.funder ?? "unknown"}  ${r.funderLabel ? `[${r.funderLabel}]` : ""}`,
      );
    });
    report.snipers = snipers.map((r) => r.rank);
  } else {
    log(ansi("green", "  ✅  No same-block snipers detected.", tty));
  }

  if (fastBuyers.length > 0) {
    log();
    log(
      ansi(
        "yellow",
        `  ⚠  ${fastBuyers.length} fast buyer(s) (1–60s after launch):`,
        tty,
      ),
    );
    fastBuyers.forEach((r) =>
      log(
        `     #${String(r.rank).padStart(2)}  ${r.tokenAcct}  +${r.buyTime - launchTime}s  ${fmtN(r.tokens)} tokens`,
      ),
    );
  }

  // ── LP Status ───────────────────────────────────────────────────────────
  section("LP / LIQUIDITY POOL STATUS");
  progress("Scanning transaction history for liquidity pool");
  const lp = await getLpStatus(mintAddress, mintSigs);
  clr();

  report.contractSecurity.lp = lp;

  if (lp.status === "bonding_curve") {
    log(
      ansi(
        "yellow",
        "  ⟳  Token still on Pump.fun bonding curve — no LP minted yet.",
        tty,
      ),
    );
    log(
      ansi(
        "yellow",
        "     LP burn status will be available after graduation to Raydium.",
        tty,
      ),
    );
  } else if (lp.status === "not_found") {
    log(
      ansi("gray", "  ℹ  No Raydium pool found in scanned transactions.", tty),
    );
    log(
      ansi(
        "gray",
        "     Token may use a different DEX or pool was created outside the scan window.",
        tty,
      ),
    );
  } else if (lp.poolType === "raydium") {
    log(
      `  Pool type     : ${lp.graduated ? "Pump.fun → Raydium (graduated)" : "Raydium AMM"}`,
    );
    log(`  LP mint       : ${lp.lpMint}`);
    log(
      `  LP supply     : ${lp.lpSupply !== null ? fmtN(lp.lpSupply) : "unknown"}`,
    );
    log();
    if (lp.status === "burned") {
      log(
        ansi(
          "green",
          "  ✅  LP tokens BURNED — supply is 0. Liquidity is permanently locked.",
          tty,
        ),
      );
    } else if (lp.status === "partially_locked") {
      log(
        ansi(
          "yellow",
          `  ⚠   LP tokens PARTIALLY LOCKED — ${lp.burnedPct}% held by null address.`,
          tty,
        ),
      );
      log(ansi("yellow", `       Locked account: ${lp.lockedAddr}`, tty));
      log(
        ansi(
          "yellow",
          `       ${100 - lp.burnedPct}% of LP is still withdrawable by the deployer.`,
          tty,
        ),
      );
    } else {
      log(
        ansi(
          "red",
          "  🚨  LP tokens NOT BURNED — deployer can withdraw liquidity at any time.",
          tty,
        ),
      );
      log(
        ansi(
          "red",
          "       HIGH RISK: classic rug-pull vector. Avoid large positions.",
          tty,
        ),
      );
    }
  }

  // ── Risk Score ──────────────────────────────────────────────────────────
  section("RISK SCORE");

  let score = 0;
  const signals = [];

  if (mintUnrevoked) {
    score += 30;
    signals.push({
      label: "Mint authority not revoked (CRITICAL — unlimited supply risk)",
      pts: 30,
      severity: "critical",
    });
  }
  if (freezeUnrevoked) {
    score += 15;
    signals.push({
      label: "Freeze authority not revoked (honeypot risk)",
      pts: 15,
      severity: "high",
    });
  }
  if (lp.status === "unlocked") {
    score += 20;
    signals.push({
      label: "LP tokens not burned — rug-pull vector",
      pts: 20,
      severity: "high",
    });
  } else if (lp.status === "partially_locked") {
    const pts = Math.round((100 - lp.burnedPct) / 10);
    score += pts;
    signals.push({
      label: `LP tokens partially locked (${lp.burnedPct}% locked, ${100 - lp.burnedPct}% withdrawable)`,
      pts,
      severity: "medium",
    });
  }

  const clusterTokenPct = clusters.reduce(
    (s, [, rows]) =>
      s + (rows.reduce((t, r) => t + r.tokens, 0) / (totalInTop / 1e6)) * 100,
    0,
  );
  if (clusters.length > 0) {
    const pts = Math.min(30, Math.round(clusterTokenPct / 2));
    score += pts;
    signals.push({
      label: `Funding clusters (${clusters.length} found, ${clusterTokenPct.toFixed(0)}% of top holders)`,
      pts,
      severity: "medium",
    });
  }
  if (
    report.clusters.some((cl) => cl.chain.some((c2) => BUNDLERS.has(c2.addr)))
  ) {
    score += 25;
    signals.push({
      label: "Known bundler in funding chain",
      pts: 25,
      severity: "high",
    });
  }
  if (snipers.length > 0) {
    const pts = Math.min(20, snipers.length * 8);
    score += pts;
    signals.push({
      label: `Same-block snipers (${snipers.length})`,
      pts,
      severity: "high",
    });
  }
  if (fastBuyers.length > 0) {
    const pts = Math.min(10, fastBuyers.length * 3);
    score += pts;
    signals.push({
      label: `Fast buyers <60s (${fastBuyers.length})`,
      pts,
      severity: "medium",
    });
  }
  if (syncGroups.length > 0) {
    score += syncGroups.length * 8;
    signals.push({
      label: `Synchronized buy groups (${syncGroups.length})`,
      pts: syncGroups.length * 8,
      severity: "medium",
    });
  }
  if (birthGroups.length > 0) {
    score += birthGroups.length * 6;
    signals.push({
      label: `Coordinated wallet creation (${birthGroups.length} groups)`,
      pts: birthGroups.length * 6,
      severity: "medium",
    });
  }

  score = Math.min(100, score);
  const riskLabel =
    score >= 75
      ? "🔴  VERY HIGH"
      : score >= 50
        ? "🟠  HIGH"
        : score >= 25
          ? "🟡  MODERATE"
          : "🟢  LOW";
  const riskColor = score >= 50 ? "red" : score >= 25 ? "yellow" : "green";

  log();
  log(
    bold(
      `  Risk Score : ${score} / 100   ${ansi(riskColor, riskLabel, tty)}`,
      tty,
    ),
  );
  log();

  if (signals.length === 0) {
    log(ansi("green", "  No risk signals detected.", tty));
  } else {
    const order = { critical: 0, high: 1, medium: 2 };
    signals.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
    log("  Signal breakdown:");
    signals.forEach((s) => {
      const col =
        s.severity === "critical"
          ? "red"
          : s.severity === "high"
            ? "yellow"
            : "white";
      log(ansi(col, `    +${String(s.pts).padStart(2)}  ${s.label}`, tty));
    });
  }

  log();
  log(ansi("green", "  Clean signals:", tty));
  if (!mintUnrevoked) log(ansi("green", "    ✅  Mint authority revoked", tty));
  if (!freezeUnrevoked)
    log(ansi("green", "    ✅  Freeze authority revoked", tty));
  if (lp.status === "burned")
    log(ansi("green", "    ✅  LP tokens burned", tty));
  if (clusters.length === 0)
    log(ansi("green", "    ✅  No funding clusters", tty));
  if (snipers.length === 0)
    log(ansi("green", "    ✅  No same-block snipers", tty));
  if (syncGroups.length === 0)
    log(ansi("green", "    ✅  No synchronized buys", tty));
  if (birthGroups.length === 0)
    log(ansi("green", "    ✅  No coordinated wallet creation", tty));

  report.risk = { score, label: riskLabel, signals };

  // ── Footer ──────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log();
  log(bold("═".repeat(65), tty));
  log(
    dim(`  Scan complete in ${elapsed}s  |  ${new Date().toISOString()}`, tty),
  );
  log(bold("═".repeat(65), tty));
  report.scanDurationSeconds = parseFloat(elapsed);

  if (save) {
    const stream = createWriteStream(save);
    stream.write(lines.join("\n"));
    stream.end();
    process.stderr.write(`Report saved to ${save}\n`);
  }

  return report;
}

// ── CLI entry point ────────────────────────────────────────────────────────
if (IS_CLI) {
  const cliArgs = process.argv.slice(2);
  const mint =
    cliArgs.find((a) => !a.startsWith("--")) ??
    "7sGdNQSvUGpahh6qyXB3g5gsdK9FAzZM299KyCXspump";
  const topN = parseInt(
    cliArgs.find((a) => a.startsWith("--top="))?.split("=")[1] ?? "20",
  );
  const depth = parseInt(
    cliArgs.find((a) => a.startsWith("--depth="))?.split("=")[1] ?? "6",
  );
  const jsonOut = cliArgs.includes("--json");
  const save = cliArgs.find((a) => a.startsWith("--save="))?.split("=")[1];

  runScan(mint, { topN, depth, silent: false, save })
    .then((report) => {
      if (jsonOut) console.log(JSON.stringify(report, null, 2));
    })
    .catch((err) => {
      process.stderr.write(`\nFatal error: ${err.message}\n`);
      process.exitCode = 1;
    });
}
