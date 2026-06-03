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

const RAYDIUM_AMM      = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"; // Raydium AMM v4
const RAYDIUM_CPMM     = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"; // Raydium CPMM
const RAYDIUM_CLMM     = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"; // Raydium CLMM
const ORCA_WHIRLPOOL   = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"; // Orca Whirlpools
const ORCA_TOKEN_SWAP  = "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP"; // Orca v2 Token Swap
const METEORA_AMM      = "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB"; // Meteora Dynamic AMM
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const NULL_ADDR = "11111111111111111111111111111111";
const PUMPFUN_PROG = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

// AMM program → DEX label. Order matters: when a tx hits multiple programs,
// the first match wins (Raydium AMM v4 is the most common LP-mint pool type
// for pump.fun graduates, so it stays at the top).
const AMM_PROGRAMS = {
  [RAYDIUM_AMM]:     "raydium",
  [RAYDIUM_CPMM]:    "raydium_cpmm",
  [RAYDIUM_CLMM]:    "raydium_clmm",
  [ORCA_WHIRLPOOL]:  "orca_whirlpool",
  [ORCA_TOKEN_SWAP]: "orca",
  [METEORA_AMM]:     "meteora",
};

// Raydium v4 and CPMM both mint a fungible LP token in the same tx that
// creates the pool, so we can recover the LP mint via the balance-diff
// heuristic and check its burn state. CLMM/Whirlpools/Meteora use NFT
// positions instead, so we can detect pool existence but not LP burn.
const LP_MINT_DETECTABLE = new Set(["raydium", "raydium_cpmm"]);

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

// Known CEX and institutional hot wallet addresses on Solana.
// Sourced from public blockchain explorers and community research.
// False-negatives (missing address) are safe — only false-positives matter.
// Update as exchanges rotate deposit addresses.
const KNOWN_CEX_WALLETS = new Map([
  // Binance
  ["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "Binance"],
  ["5tzFkiKscXHK5B1bPsrWfGSXGpeBT6NAFoNRxLJHtTbq", "Binance"],
  ["AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2",  "Binance"],
  ["u6PJ8DtQuPFnfmwHbGFUnLmD5Cw6i6pDMW7a8EMBdZB",  "Binance"],
  // Coinbase
  ["H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS", "Coinbase"],
  ["GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE", "Coinbase"],
  ["pqx3fvvh6b3iZwcHCcCp6Mh4T9BHZX1ya2NF3sda4n",  "Coinbase"],
  // OKX
  ["FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5",  "OKX"],
  ["6U991TCNvBTc31DGbAgCfXRcGEMJSgBpBNBPCJNxRhSs",  "OKX"],
  ["HhoBDvnMerDHDwDHaGDZSEDQpNFWmBSbGTbMFSJ9kXuP", "OKX"],
  // Bybit
  ["2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm", "Bybit"],
  ["A7Nhe1MNhVFPPsNXeQ3bNPAnxNBD6WYb3CJK2bH4nrL",  "Bybit"],
  // KuCoin
  ["BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6", "KuCoin"],
  ["HVh6wHNBAsntVE4xDxeFVCFxQFhHiKSMbaMuiEXMsGNk",  "KuCoin"],
  // MEXC
  ["4CNQU9GvZpNZh98GGfNHi8JF3mvMODJ8JNLMUWmzfpRN", "MEXC"],
  ["MEXCYKnJoUEbhfp5FxkAGKNnSFN2KFjGhMZmLmVmfEL",  "MEXC"],
  // Gate.io
  ["4EQrNZYk5KR1RnjyzbaaRbHsv8VqZWzSUtvx58wLsZbj", "Gate.io"],
  ["7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3HTGT", "Gate.io"],
  // Kraken
  ["BE8dp7udNUHPUvYFBRCMoqc8XGdYiRSiaDJfGYkk9fRt", "Kraken"],
  ["Bv23rG9CmFGXkXTRfTUcnB8SZiQwuqBBkzPcTZnj2uU",  "Kraken"],
  // Crypto.com
  ["6D4s8bFpkLJnLWoGYNWTbXvGc6K5KByNmL8jmSwxH8qk", "Crypto.com"],
  ["7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",  "Crypto.com"],
  // HTX (Huobi)
  ["ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ",  "HTX"],
  ["BHYuJEYQYCEjXkqZmFqNzsXZdAkXQe7MWL4tJNYZwww",  "HTX"],
  // Bitget
  ["C6oFsE8nXNBBiGzNEpPnGtXFywSETJmFEsLRkH26FEqN", "Bitget"],
  // Jupiter (DeFi aggregator — large routing wallet, not whale risk)
  ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  "Jupiter"],
  ["7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5", "Jupiter"],
]);

// Addresses that represent LP vaults / DEX programs — excluded from supply
// concentration checks because their holdings are protocol-controlled liquidity,
// not individual wallet positions.
const LP_EXCLUDE = new Set([
  RAYDIUM_AMM,
  PUMPFUN_PROG,
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // Raydium Authority
  "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM",   // Pump.fun Fee Wallet
  "BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW",  // Pump.fun Launch Authority
  "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg",  // Pump.fun Bundler
  "EhYXq3ANp5nAerUpbSgd7VK2RRcxK1zNuSQ755G5Dbqk",  // Raydium Bundler
]);

// ── LP detection helpers ────────────────────────────────────────────────────
// Fast-path: statically-known program-wide authority PDAs.
// These are single, shared accounts that Raydium / Pump.fun use as the vault
// owner for every pool they create.  Checking owner membership here is O(1)
// and avoids an RPC round-trip for the most common case.
const DEX_AUTHORITY_ADDRS = new Set([
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // Raydium AMM v4 authority
  "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ",  // Raydium CPMM authority
  "7rQ1QFNosMkUCuh7Z7fPbTHvh73b68sQYdirycEzJVuw",  // Orca Whirlpool authority
  PUMPFUN_PROG,                                      // Pump.fun bonding-curve program
  ...Object.keys(AMM_PROGRAMS),                      // DEX program IDs themselves
]);

// On-chain tier: programs that are listed as the Solana "owner" of DEX vault
// PDAs when queried via getMultipleAccountsInfo.  Any holder whose wallet
// account is owned by one of these programs is a DEX-controlled vault.
const DEX_PROGRAM_OWNERS = new Set([
  RAYDIUM_AMM,
  RAYDIUM_CPMM,
  RAYDIUM_CLMM,
  ORCA_WHIRLPOOL,
  ORCA_TOKEN_SWAP,
  METEORA_AMM,
  PUMPFUN_PROG,
].map((a) => a.toLowerCase()));

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
const TTL_7D  = 604_800_000;
const TTL_6H  =  21_600_000;

// Known Solana LP locker programs. If the owner of an LP token account is one
// of these programs, the liquidity is "locked" (secured, not burned to null).
// Map: program address → display name shown in the UI.
const KNOWN_LOCKER_PROGRAMS = new Map([
  ["strmqDe5vC9STwYi62sM69ryC89366AnshonXfHSpvC", "Streamflow"],
  ["strmRqUCoQUgGUan5YonZIHo7cPo7P8ePq28w3i9o3N", "Streamflow"],
  ["vau1zxA2LbssAUEF7Gpw91zMM1LvXrvpzJtmZ58rPsn", "Metaplex Vault"],
  ["7sPptkymzvayoSbLXzBsXEF8TSf3typNnAWkrKrDhjMb", "Unicrypt"],
  ["DLockCRM3PxfXDFZJcMBLJjDHGHPD2b1rBEbAUBBvFw5", "PinkSale"],
  ["MGNAkHEWbBiMmb3yFjnMWVaJBSBtnHNGpGp7wZFaGhS", "Magna"],
]);

// Maps holder-account owner addresses → DEX label.
// When a top-holder's token account is owned by one of these programs or
// authority PDAs, the token has an active pool on that DEX — regardless of
// how old the migration was (signature scan windows can't reach it).
const HOLDER_DEX_OWNERS = new Map([
  [RAYDIUM_AMM,  "raydium"],
  ["5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", "raydium"],      // Raydium v4 authority
  [RAYDIUM_CPMM, "raydium_cpmm"],
  ["GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ", "raydium_cpmm"], // CPMM authority
  [RAYDIUM_CLMM, "raydium_clmm"],
  [METEORA_AMM,  "meteora"],
  [ORCA_WHIRLPOOL,  "orca_whirlpool"],
  [ORCA_TOKEN_SWAP, "orca"],
]);

function cacheGet(key) {
  const entry = CACHE.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) { CACHE.delete(key); return undefined; }
 return typeof entry.value === 'object' && entry.value !== null ? structuredClone(entry.value) : entry.value;
}

function cacheSet(key, value, ttl = TTL_24H) {
  CACHE.set(key, { value, expiresAt: Date.now() + ttl });
}

// Active cache cleanup — runs every hour, removes expired entries to prevent
// long-running memory leaks from dead-token scans accumulating in CACHE.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of CACHE) {
    if (now > entry.expiresAt) CACHE.delete(key);
  }
}, 60 * 60 * 1000);

// Fetch-or-populate: returns cached value when fresh, otherwise calls fn(),
// stores the result, and returns it.
async function getCached(key, ttl, fn) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const value = await fn();
  cacheSet(key, value, ttl);
  return value;
}

// ── Token Price (DexScreener) ──────────────────────────────────────────────
// Short TTL: price data changes frequently and the results page auto-refreshes
// every 60s, so we keep the cache below that interval to ensure each refresh
// pulls a genuinely fresh quote while still absorbing duplicate concurrent hits.
const TTL_30S = 30_000;

export async function getTokenPrice(mint) {
  return getCached(`price:${mint}`, TTL_30S, async () => {
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      );
      if (!res.ok) return { price: null, marketCap: null, volume24h: null };
      const json = await res.json();
      const pairs = json.pairs ?? [];
      if (!pairs.length) return { price: null, marketCap: null, volume24h: null };
      // Pick the pair with the highest USD liquidity for the most reliable quote
      const best = [...pairs].sort(
        (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
      )[0];
      return {
        price:      best.priceUsd  != null ? parseFloat(best.priceUsd) : null,
        marketCap:  best.fdv       ?? null,
        volume24h:  best.volume?.h24 ?? null,
      };
    } catch {
      return { price: null, marketCap: null, volume24h: null };
    }
  });
}

// ── DexScreener pair lookup (LP fallback) ──────────────────────────────────
// Used by getLpStatus as a last-resort fallback when the on-chain tx scan
// can't find any known AMM program in the token's history. DexScreener
// indexes ~every Solana DEX and returns a stable pairAddress + dexId, so
// it's a reliable way to confirm a pool exists even when we can't determine
// LP burn state. Long TTL: pair addresses for established tokens are stable.
export async function getDexScreenerPair(mint) {
  return getCached(`dexpair:${mint}`, TTL_7D, async () => {
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      );
      if (!res.ok) return null;
      const json = await res.json();
      const pairs = (json.pairs ?? []).filter((p) => p.chainId === "solana");
      if (!pairs.length) return null;
      const best = [...pairs].sort(
        (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
      )[0];
      return {
        pairAddress:   best.pairAddress ?? null,
        dexId:         best.dexId ?? null,
        liquidityUsd:  best.liquidity?.usd ?? null,
        // DexScreener returns pairCreatedAt in MILLISECONDS since epoch.
        // Callers that compare against on-chain blockTime (seconds) must
        // divide by 1000.
        pairCreatedAt: best.pairCreatedAt ?? null,
      };
    } catch {
      return null;
    }
  });
}

// ── Token Chart / Sparkline (DexScreener OHLCV) ───────────────────────────
// Fetches 24h hourly candles for the token's best liquidity pair.
// Short TTL matches the price data cache so both stay in sync.
export async function getTokenChart(mint) {
  return getCached(`chart_gt:${mint}`, TTL_30S, async () => {
    try {
      const pair = await getDexScreenerPair(mint);
      if (!pair?.pairAddress) return { candles: [], direction: null };

      const GT_HEADERS = { Accept: "application/json;version=20230302" };

      // Helper: turn a raw GeckoTerminal ohlcv_list into the chart result object.
      // raw is newest-first; we reverse to chronological order.
      function buildResult(raw) {
        const c = [...raw].reverse();
        const first = c[0][1];           // open of oldest candle
        const last  = c[c.length - 1][4]; // close of newest candle
        return {
          candles: c.map(([t, o, h, l, cl, v]) => ({ t, o, h, l, c: cl, v })),
          direction: last > first ? "up" : last < first ? "down" : "flat",
          priceChange24h: first !== 0
            ? Math.round(((last - first) / first) * 10_000) / 100
            : null,
        };
      }

      // Primary: GeckoTerminal hourly candles (24 h window)
      const hourRes = await fetch(
        `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pair.pairAddress}/ohlcv/hour` +
        `?aggregate=1&limit=24`,
        { headers: GT_HEADERS },
      );
      if (!hourRes.ok) return { candles: [], direction: null, priceChange24h: null };
      const hourJson = await hourRes.json();
      const hourRaw  = hourJson?.data?.attributes?.ohlcv_list ?? [];

      // If ≥ 3 hourly candles exist, use them directly.
      if (hourRaw.length >= 3) return buildResult(hourRaw);

      // Fallback: token is brand-new — fetch 60 minute candles for a proper
      // high-resolution sparkline instead of a single dot.
      const minRes = await fetch(
        `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pair.pairAddress}/ohlcv/minute` +
        `?aggregate=1&limit=60`,
        { headers: GT_HEADERS },
      );
      if (!minRes.ok) {
        // Return the sparse hourly data rather than nothing
        return hourRaw.length ? buildResult(hourRaw) : { candles: [], direction: null, priceChange24h: null };
      }
      const minJson = await minRes.json();
      const minRaw  = minJson?.data?.attributes?.ohlcv_list ?? [];
      return minRaw.length
        ? buildResult(minRaw)
        : { candles: [], direction: null, priceChange24h: null };
    } catch {
      return { candles: [], direction: null, priceChange24h: null };
    }
  });
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
    // Upgrade 2: if the SOL fee-payer is a known relayer / system wallet,
    // trace the real funding source via WSOL or USDC token transfers.
    // Cabals route funds through intermediary relayers to obscure ownership.
    if (funder && (ENTITIES[funder] || BUNDLERS.has(funder))) {
      const WSOL = "So11111111111111111111111111111111111111112";
      const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const preTok  = tx.meta?.preTokenBalances  ?? [];
      const postTok = tx.meta?.postTokenBalances ?? [];
      for (const preBal of preTok) {
        if (preBal.mint !== WSOL && preBal.mint !== USDC) continue;
        const postBal = postTok.find((p) => p.accountIndex === preBal.accountIndex);
        const preAmt  = preBal.uiTokenAmount?.uiAmount  ?? 0;
        const postAmt = postBal?.uiTokenAmount?.uiAmount ?? 0;
        if (preAmt > postAmt) {
          const senderAcct = accts[preBal.accountIndex];
          if (senderAcct && senderAcct !== address) {
            const realFunder = await getTokenAcctOwner(senderAcct).catch(() => null);
            if (realFunder && realFunder !== address) funder = realFunder;
          }
          break;
        }
      }
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

async function getTokenMetadata(mint) {
  return getCached(`metadata:${mint}`, TTL_24H, async () => {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "scanner",
          method: "getAsset",
          params: { id: mint },
        }),
      });
      const json = await res.json();
      const result = json.result ?? {};
      const meta = result.content?.metadata ?? {};
      const links = result.content?.links ?? {};
      const files = result.content?.files ?? [];
      const logoUri =
        links.image ??
        files.find((f) => f.cdn_uri || f.uri)?.cdn_uri ??
        files.find((f) => f.cdn_uri || f.uri)?.uri ??
        null;
      return {
        name:    meta.name    ?? null,
        symbol:  meta.symbol  ?? null,
        logoUri: logoUri      ?? null,
      };
    } catch {
      return { name: null, symbol: null, logoUri: null };
    }
  });
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

// Raydium REST API — returns the LP mint address for the best pool matching
// the given token mint.  Uses poolType=all to cover both AMM v4 and CPMM.
// Returns null on any error or when no pool is indexed by Raydium.
async function getRaydiumLpMint(mint) {
  try {
    const url =
      `https://api-v3.raydium.io/pools/info/mint` +
      `?mint1=${mint}&poolType=all&poolSortField=default&sortType=desc&pageSize=1&page=1`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!resp.ok) return null;
    const json = await resp.json();
    return json?.data?.data?.[0]?.lpMint?.address ?? null;
  } catch { return null; }
}

async function getLpStatus(mint, mintSigs, holderRows = []) {
  // Caching strategy:
  //   - Pool FOUND  (burned / partially_locked / unlocked / bonding_curve /
  //     found_external) → TTL_7D. Once we've located the pool/LP mint, that
  //     identity is immutable; burn status can change, but burned never
  //     regresses, and the cost of a stale "unlocked" read is just one stale
  //     scan within a week — far cheaper than the deep-scan cost on miss.
  //   - Pool NOT FOUND / unknown → TTL_6H, so a future scan retries soon.
  const cached = cacheGet(`lpStatus:${mint}`);
  if (cached !== undefined) return cached;

  const result = {
    poolType: null,
    lpMint: null,
    lpSupply: null,
    burned: null,
    burnedPct: null,
    lockedPct: null,
    lockerName: null,
    isLocked: false,
    lockedAddr: null,
    graduated: false,
    pairAddress: null,
    lpOwnerWallet: null,
    vaultOwners: [],   // vault token account addresses for CLMM/Meteora/Orca pools
    status: "unknown",
  };

  // Scan at most 50 oldest signatures — 5 "pages" of 10 — with a 15 s hard
  // deadline. 500-tx scans were the source of 4-minute hangs; the DexScreener
  // fallback below already handles tokens whose LP creation falls outside
  // this window, so speed > completeness here.
  const LP_SCAN_MAX    = 50;
  const LP_DEADLINE_MS = 15_000;
  const lpDeadline     = Date.now() + LP_DEADLINE_MS;
  const txsToScan = mintSigs.slice(0, LP_SCAN_MAX);
  for (const sigEntry of txsToScan) {
    if (Date.now() > lpDeadline) break; // fall through to DexScreener fallback
    await sleep(DELAY_MS);
    const tx = await getTx(sigEntry.signature);
    if (!tx) continue;
    const accts = getAccounts(tx);

    // Match against any known AMM program (not just Raydium v4). First hit wins.
    let matchedDex = null;
    for (const acc of accts) {
      if (AMM_PROGRAMS[acc]) { matchedDex = AMM_PROGRAMS[acc]; break; }
    }
    if (!matchedDex) continue;

    // For Raydium AMM v4 / CPMM, the same tx that creates the pool also mints
    // the fungible LP token, so the balance-diff heuristic recovers the LP mint.
    if (LP_MINT_DETECTABLE.has(matchedDex)) {
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

      result.poolType = matchedDex;
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
        cacheSet(`lpStatus:${mint}`, result, TTL_7D);
        return result;
      }

      await sleep(DELAY_MS);
      const largest = await rpc("getTokenLargestAccounts", [lpMint]);
      const holders = largest?.value ?? [];
      let burnedAmt = 0;
      let lockedAmt = 0;
      let lockerName = null;
      let firstLpOwner = null;
      for (const h of holders.slice(0, 5)) {
        await sleep(DELAY_MS);
        const owner = await getTokenAcctOwner(h.address);
        if (firstLpOwner === null) firstLpOwner = owner;
        if (owner === NULL_ADDR) {
          burnedAmt += parseInt(h.amount ?? "0");
          result.lockedAddr = h.address;
        } else if (KNOWN_LOCKER_PROGRAMS.has(owner)) {
          lockedAmt += parseInt(h.amount ?? "0");
          lockerName = lockerName ?? KNOWN_LOCKER_PROGRAMS.get(owner);
          result.lockedAddr = h.address;
        }
      }
      if (lpSupply > 0) {
        result.burnedPct = Math.round((burnedAmt / lpSupply) * 100);
        result.lockedPct = Math.round((lockedAmt / lpSupply) * 100);
        result.lockerName = lockerName;
        result.isLocked = result.lockedPct > 0;
        const safePct = result.burnedPct + result.lockedPct;
        result.burned = result.burnedPct >= 99;
        result.status = result.burned
          ? "burned"
          : result.lockedPct >= 99
            ? "locked"
            : safePct >= 50
              ? "partially_locked"
              : "unlocked";
        if (result.status === "unlocked") result.lpOwnerWallet = firstLpOwner;
      }
      cacheSet(`lpStatus:${mint}`, result, TTL_7D);
      return result;
    }

    // CLMM / Whirlpool / Meteora / Pumpswap — pool exists, but burn analysis
    // is protocol-specific.  Report existence and let the UI surface it.
    // Extract the vault token accounts for our mint from this tx so the
    // holder-flag loop can mark them as isLiquidityPool even when
    // getTokenAcctOwner() fails (falls back to tokenAcct address).
    result.poolType = matchedDex;
    result.status = "found_external";
    {
      const txVaults = (tx.meta?.postTokenBalances ?? [])
        .filter((b) => b.mint === mint && accts[b.accountIndex])
        .map((b) => accts[b.accountIndex]);
      if (txVaults.length) result.vaultOwners = txVaults;
    }
    // Always resolve the highest-liquidity pool from DexScreener — the
    // sig-scan may have matched a low-liquidity or dead pool (e.g. a
    // Pumpswap launch curve that co-exists with an active Raydium pool).
    // getDexScreenerPair already sorts pairs by USD liquidity; this call
    // is cached (TTL_7D) so it adds no latency on repeated scans.
    try {
      const dsPair = await getDexScreenerPair(mint);
      if (dsPair?.pairAddress) {
        result.pairAddress = dsPair.pairAddress;
        if (dsPair.dexId) result.poolType = dsPair.dexId;
      }
    } catch { /* non-fatal */ }
    cacheSet(`lpStatus:${mint}`, result, TTL_7D);
    return result;
  }

  // ── Migration scan ────────────────────────────────────────────────────────
  // The oldest-50 window above may have missed the pool-creation tx for tokens
  // that graduated from Pump.fun long after launch (many bonding-curve trades
  // before the graduation tx exists).  Scan the most recent 25 sigs instead,
  // applying the same balance-diff heuristic to locate the LP mint creation tx.
  // A Raydium creation tx is the ONLY one that shows the LP mint appearing in
  // postTokenBalances but NOT in preTokenBalances — regular trades never do this.
  const MIGRATION_SCAN_LIMIT = 25;
  const migrationSigs =
    (await rpc("getSignaturesForAddress", [mint, { limit: MIGRATION_SCAN_LIMIT }])) ?? [];
  for (const s of migrationSigs) {
    await sleep(DELAY_MS);
    const tx = await getTx(s.signature);
    if (!tx) continue;
    const maccts = getAccounts(tx);

    let migDex = null;
    for (const acc of maccts) {
      if (AMM_PROGRAMS[acc]) { migDex = AMM_PROGRAMS[acc]; break; }
    }
    if (!migDex || !LP_MINT_DETECTABLE.has(migDex)) continue;

    // Balance-diff: new mint in post not in pre = LP token first minted here.
    const preBals2  = tx.meta?.preTokenBalances  ?? [];
    const postBals2 = tx.meta?.postTokenBalances ?? [];
    const preMints2 = new Set(preBals2.map((b) => b.mint));
    let lpMint2 = null;
    for (const bal of postBals2) {
      if (bal.mint === mint || bal.mint === WSOL_MINT) continue;
      if (!preMints2.has(bal.mint)) { lpMint2 = bal.mint; break; }
    }
    if (!lpMint2) continue; // Not the pool-creation tx — keep scanning

    // Found the migration / pool-creation tx — run full burn/lock analysis.
    result.poolType = migDex;
    result.lpMint   = lpMint2;
    result.graduated = maccts.includes(PUMPFUN_PROG);

    await sleep(DELAY_MS);
    const supplyData2 = await rpc("getTokenSupply", [lpMint2]);
    const lpSupply2   = parseInt(supplyData2?.value?.amount ?? "-1");
    result.lpSupply   = lpSupply2;

    if (lpSupply2 === 0) {
      result.burned = true; result.burnedPct = 100; result.status = "burned";
      cacheSet(`lpStatus:${mint}`, result, TTL_7D);
      return result;
    }

    await sleep(DELAY_MS);
    const largest2  = await rpc("getTokenLargestAccounts", [lpMint2]);
    const holders2  = largest2?.value ?? [];
    let burnedAmt2 = 0, lockedAmt2 = 0, lockerName2 = null, firstLpOwner2 = null;
    for (const h of holders2.slice(0, 5)) {
      await sleep(DELAY_MS);
      const owner2 = await getTokenAcctOwner(h.address);
      if (firstLpOwner2 === null) firstLpOwner2 = owner2;
      if (owner2 === NULL_ADDR) {
        burnedAmt2 += parseInt(h.amount ?? "0");
        result.lockedAddr = h.address;
      } else if (KNOWN_LOCKER_PROGRAMS.has(owner2)) {
        lockedAmt2 += parseInt(h.amount ?? "0");
        lockerName2 = lockerName2 ?? KNOWN_LOCKER_PROGRAMS.get(owner2);
        result.lockedAddr = h.address;
      }
    }
    if (lpSupply2 > 0) {
      result.burnedPct  = Math.round((burnedAmt2 / lpSupply2) * 100);
      result.lockedPct  = Math.round((lockedAmt2 / lpSupply2) * 100);
      result.lockerName = lockerName2;
      result.isLocked   = result.lockedPct > 0;
      const safePct2    = result.burnedPct + result.lockedPct;
      result.burned     = result.burnedPct >= 99;
      result.status     = result.burned ? "burned"
        : result.lockedPct >= 99 ? "locked"
        : safePct2 >= 50        ? "partially_locked"
        :                          "unlocked";
      if (result.status === "unlocked") result.lpOwnerWallet = firstLpOwner2;
    }
    cacheSet(`lpStatus:${mint}`, result, TTL_7D);
    return result;
  }

  // ── Holder-based DEX detection ────────────────────────────────────────────
  // For established, high-volume tokens the pool-creation tx is buried far
  // beyond any signature scan window.  Instead, inspect the pre-computed
  // holderRows: if any holder's token account is owned by a known DEX program
  // or authority PDA, the token HAS an active pool on that DEX.
  //
  // Once we confirm a Raydium / CPMM pool, query the Raydium REST API to get
  // the LP mint (one HTTP call, no RPC round-trips) and then run the standard
  // burn/lock analysis on it.  For CLMM / Meteora / Orca we can confirm the
  // pool exists but can't measure LP burn — fall through to "found_external".
  for (const row of holderRows) {
    const dexLabel = HOLDER_DEX_OWNERS.get(row.owner);
    if (!dexLabel) continue;

    result.poolType = dexLabel;
    result.graduated = true;

    if (LP_MINT_DETECTABLE.has(dexLabel)) {
      const lpMintFromApi = await getRaydiumLpMint(mint);
      if (lpMintFromApi) {
        result.lpMint = lpMintFromApi;

        await sleep(DELAY_MS);
        const supplyData3 = await rpc("getTokenSupply", [lpMintFromApi]);
        const lpSupply3   = parseInt(supplyData3?.value?.amount ?? "-1");
        result.lpSupply   = lpSupply3;

        if (lpSupply3 === 0) {
          result.burned = true; result.burnedPct = 100; result.status = "burned";
          cacheSet(`lpStatus:${mint}`, result, TTL_7D);
          return result;
        }

        await sleep(DELAY_MS);
        const largest3  = await rpc("getTokenLargestAccounts", [lpMintFromApi]);
        const holders3  = largest3?.value ?? [];
        let burnedAmt3 = 0, lockedAmt3 = 0, lockerName3 = null;
        let firstLpOwner3 = null;
        for (const h of holders3.slice(0, 5)) {
          await sleep(DELAY_MS);
          const owner3 = await getTokenAcctOwner(h.address);
          if (firstLpOwner3 === null) firstLpOwner3 = owner3;
          if (owner3 === NULL_ADDR) {
            burnedAmt3 += parseInt(h.amount ?? "0");
            result.lockedAddr = h.address;
          } else if (KNOWN_LOCKER_PROGRAMS.has(owner3)) {
            lockedAmt3 += parseInt(h.amount ?? "0");
            lockerName3 = lockerName3 ?? KNOWN_LOCKER_PROGRAMS.get(owner3);
            result.lockedAddr = h.address;
          }
        }
        if (lpSupply3 > 0) {
          result.burnedPct  = Math.round((burnedAmt3 / lpSupply3) * 100);
          result.lockedPct  = Math.round((lockedAmt3 / lpSupply3) * 100);
          result.lockerName = lockerName3;
          result.isLocked   = result.lockedPct > 0;
          const safePct3    = result.burnedPct + result.lockedPct;
          result.burned     = result.burnedPct >= 99;
          result.status     = result.burned ? "burned"
            : result.lockedPct >= 99 ? "locked"
            : safePct3 >= 50         ? "partially_locked"
            :                          "unlocked";
          if (result.status === "unlocked") result.lpOwnerWallet = firstLpOwner3;
        }
        cacheSet(`lpStatus:${mint}`, result, TTL_7D);
        return result;
      }
    }

    // CLMM / Meteora / Orca or Raydium API miss — pool confirmed but LP burn
    // analysis is not available.  Override poolType and surface as "found_external".
    // Record the matching holder's tokenAcct as a known vault address.
    result.status = "found_external";
    if (row.tokenAcct) result.vaultOwners = [row.tokenAcct];
    // Resolve the highest-liquidity pool from DexScreener so pairAddress
    // is always the active pool, not the holder-matched one (cached TTL_7D).
    try {
      const dsPair = await getDexScreenerPair(mint);
      if (dsPair?.pairAddress) {
        result.pairAddress = dsPair.pairAddress;
        if (dsPair.dexId) result.poolType = dsPair.dexId;
      }
    } catch { /* non-fatal */ }
    cacheSet(`lpStatus:${mint}`, result, TTL_7D);
    return result;
  }

  // ── Bonding-curve check ───────────────────────────────────────────────────
  // Only mark as "bonding_curve" if the tx touches PUMPFUN_PROG but does NOT
  // touch any AMM program.  A graduation tx touches both — that case falls
  // through to the DexScreener fallback which correctly surfaces the pool.
  const recentSigs =
    (await rpc("getSignaturesForAddress", [mint, { limit: 5 }])) ?? [];
  for (const s of recentSigs) {
    await sleep(DELAY_MS);
    const tx = await getTx(s.signature);
    if (!tx) continue;
    const bcAccts  = getAccounts(tx);
    const hasPump  = bcAccts.includes(PUMPFUN_PROG);
    const hasAMM   = bcAccts.some((a) => !!AMM_PROGRAMS[a]);
    if (hasPump && !hasAMM) {
      result.poolType = "pumpfun";
      result.status   = "bonding_curve";
      cacheSet(`lpStatus:${mint}`, result, TTL_7D);
      return result;
    }
  }

  // Final fallback: DexScreener targeted query. If the token has any indexed
  // pair on Solana, surface it as "found_external" with the dex name + pair
  // address. This catches pools that exist but were created outside our
  // 500-tx scan window or on a DEX program we don't recognize yet.
  const pair = await getDexScreenerPair(mint);
  if (pair && pair.pairAddress) {
    result.poolType = pair.dexId ?? "external";
    result.pairAddress = pair.pairAddress;
    result.status = "found_external";
    // Try to resolve vault token accounts for our mint owned by the pool
    // address. Works for Meteora Dynamic AMM (pool owns vaults directly).
    // Non-fatal — CLMM pools use authority PDAs so this may return empty.
    try {
      await sleep(DELAY_MS);
      const vaultResult = await rpc("getTokenAccountsByOwner", [
        pair.pairAddress,
        { mint },
        { encoding: "base64" },
      ]);
      const vaultAddrs = (vaultResult?.value ?? [])
        .map((v) => v.pubkey)
        .filter(Boolean);
      if (vaultAddrs.length) result.vaultOwners = vaultAddrs;
    } catch { /* non-fatal */ }

    // Upgrade 4: Deep LP history scan — for tokens whose creation tx fell
    // outside the sig-scan horizon (high-volume or older pools), scan the
    // LP pool account's own oldest transaction to recover LP mint + burn/lock
    // status that the horizon-capped sig scan could not reach.
    if (LP_MINT_DETECTABLE.has(pair.dexId ?? "")) {
      try {
        await sleep(DELAY_MS);
        const poolSigs = await rpc("getSignaturesForAddress", [
          pair.pairAddress,
          { limit: 10 },
        ]);
        const creationSig = poolSigs?.[poolSigs.length - 1];
        if (creationSig) {
          await sleep(DELAY_MS);
          const poolTx = await getTx(creationSig.signature);
          if (poolTx) {
            const preBals  = poolTx.meta?.preTokenBalances  ?? [];
            const postBals = poolTx.meta?.postTokenBalances ?? [];
            const preMints = new Set(preBals.map((b) => b.mint));
            let lpMint = null;
            for (const bal of postBals) {
              if (bal.mint === mint || bal.mint === WSOL_MINT) continue;
              if (!preMints.has(bal.mint)) { lpMint = bal.mint; break; }
            }
            if (!lpMint) {
              for (const bal of postBals) {
                if (bal.mint !== mint && bal.mint !== WSOL_MINT) { lpMint = bal.mint; break; }
              }
            }
            if (lpMint) {
              result.lpMint = lpMint;
              await sleep(DELAY_MS);
              const supplyData = await rpc("getTokenSupply", [lpMint]);
              const lpSupply = parseInt(supplyData?.value?.amount ?? "-1");
              result.lpSupply = lpSupply;
              if (lpSupply === 0) {
                result.burned = true;
                result.burnedPct = 100;
                result.status = "burned";
              } else if (lpSupply > 0) {
                await sleep(DELAY_MS);
                const largest = await rpc("getTokenLargestAccounts", [lpMint]);
                const lpHolders = largest?.value ?? [];
                let burnedAmt = 0; let lockedAmt = 0; let lockerName = null;
                for (const h of lpHolders.slice(0, 5)) {
                  await sleep(DELAY_MS);
                  const lpOwner = await getTokenAcctOwner(h.address);
                  if (lpOwner === NULL_ADDR) {
                    burnedAmt += parseInt(h.amount ?? "0");
                  } else if (KNOWN_LOCKER_PROGRAMS.has(lpOwner)) {
                    lockedAmt += parseInt(h.amount ?? "0");
                    lockerName = lockerName ?? KNOWN_LOCKER_PROGRAMS.get(lpOwner);
                    result.lockedAddr = h.address;
                  }
                }
                result.burnedPct = Math.round((burnedAmt / lpSupply) * 100);
                result.lockedPct = Math.round((lockedAmt / lpSupply) * 100);
                result.lockerName = lockerName;
                result.isLocked   = result.lockedPct > 0;
                const safePct     = result.burnedPct + result.lockedPct;
                result.burned     = result.burnedPct >= 99;
                result.status     = result.burned        ? "burned"
                  : result.lockedPct >= 99              ? "locked"
                  : safePct >= 50                       ? "partially_locked"
                  : "unlocked";
              }
            }
          }
        }
      } catch { /* non-fatal — surface whatever partial data we have */ }
    }

    cacheSet(`lpStatus:${mint}`, result, TTL_7D);
    return result;
  }

  result.status = "not_found";
  cacheSet(`lpStatus:${mint}`, result, TTL_6H);
  return result;
}

// ── Serial Rugger Tracker ─────────────────────────────────────────────────
// Scans a deployer wallet's transaction history to detect other token launches.
// Detection heuristic: any tx where the creator is fee payer AND a mint
// appears in postTokenBalances that was absent from preTokenBalances with a
// raw amount > 1 000 000 units — this is the fingerprint of a "create + mint"
// transaction. Each discovered mint is then enriched via DexScreener.
// Cached TTL_24H — deployer history is stable on that horizon.
async function getDeployerHistory(creatorAddress, currentMint) {
  return getCached(`deployerHistory:${creatorAddress}`, TTL_24H, async () => {
    const foundMints = new Map(); // mint → blockTime (seconds)

    try {
      const sigs =
        (await rpc("getSignaturesForAddress", [creatorAddress, { limit: 100 }])) ?? [];

      // Fetch txs in parallel batches of 8 to bound latency
      for (let i = 0; i < sigs.length; i += 8) {
        const batch = sigs.slice(i, i + 8);
        await Promise.all(
          batch.map(async (s) => {
            try {
              const tx = await getTx(s.signature);
              if (!tx) return;
              const accts = getAccounts(tx);
              if (accts[0] !== creatorAddress) return; // creator must be fee payer

              const preMints = new Set(
                (tx.meta?.preTokenBalances ?? []).map((b) => b.mint),
              );
              for (const b of tx.meta?.postTokenBalances ?? []) {
                const rawAmt = parseFloat(b.uiTokenAmount?.amount ?? "0");
                // A mint absent from preTokenBalances with a large supply injection
                // strongly indicates a freshly created token in this transaction.
                if (!preMints.has(b.mint) && rawAmt > 1_000_000) {
                  if (!foundMints.has(b.mint)) {
                    foundMints.set(b.mint, s.blockTime ?? null);
                  }
                }
              }
            } catch { /* non-fatal */ }
          }),
        );
      }
    } catch { /* non-fatal */ }

    // Enrich each discovered mint with DexScreener data (name, MC, liquidity)
    const results = [];
    const candidates = [...foundMints.entries()]
      .filter(([mint]) => mint !== currentMint) // exclude the token currently being scanned
      .slice(0, 15);

    await Promise.all(
      candidates.map(async ([mint, launchTs]) => {
        try {
          const res = await fetch(
            `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
          );
          if (!res.ok) {
            results.push({ mint, name: null, symbol: null, launchTs, liquidityUsd: 0, marketCap: null, status: "rugged", priceChange24h: null });
            return;
          }
          const json = await res.json();
          const pairs = (json.pairs ?? []).filter((p) => p.chainId === "solana");
          if (!pairs.length) {
            results.push({ mint, name: null, symbol: null, launchTs, liquidityUsd: 0, marketCap: null, status: "rugged", priceChange24h: null });
            return;
          }
          const best = [...pairs].sort(
            (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
          )[0];
          const liquidityUsd  = best.liquidity?.usd ?? 0;
          const marketCap     = best.fdv ?? null;
          const name          = best.baseToken?.name ?? null;
          const symbol        = best.baseToken?.symbol ?? null;
          const priceChange24h = best.priceChange?.h24 ?? null;
          const status        = liquidityUsd < 1_000 ? "rugged" : "active";
          results.push({ mint, name, symbol, launchTs, liquidityUsd, marketCap, status, priceChange24h });
        } catch { /* non-fatal */ }
      }),
    );

    results.sort((a, b) => (b.launchTs ?? 0) - (a.launchTs ?? 0));
    return results;
  });
}

// ── Core scan function (exported) ──────────────────────────────────────────
export async function runScan(mintAddress, options = {}) {
  const {
    topN = 20,
    depth = 3,
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
    metadata: { name: null, symbol: null },
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

  // ── 0 + 1. Token Metadata & Mint Authority (parallel) ───────────────────
  progress("Fetching token metadata & authority");
  const [tokenMeta, authority] = await Promise.all([
    getTokenMetadata(mintAddress),
    getMintAuthority(mintAddress),
  ]);
  report.metadata = tokenMeta;
  if (tokenMeta.name || tokenMeta.symbol) {
    log(
      `  Token   : ${ansi("green", tokenMeta.name ?? "—", tty)}  ${ansi("cyan", tokenMeta.symbol ? `($${tokenMeta.symbol})` : "", tty)}`,
    );
  }

  // ── 1. Contract Security ────────────────────────────────────────────────
  section("1 / 7  —  CONTRACT SECURITY");
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
  const MINT_SIG_MAX_PAGES = 10;
  const MINT_SIG_CAP = MINT_SIG_MAX_PAGES * 1000;
  const mintSigs = await getOldestSigs(mintAddress, MINT_SIG_MAX_PAGES);
  clr();

  let launchTime = mintSigs[0]?.blockTime ?? null;
  log(
    `  Mint oldest tx   : ${launchTime ? ansi("yellow", fmt(launchTime), tty) : ansi("red", "not found", tty)}`,
  );

  // Fallback: if we hit the pagination cap, the oldest sig we saw is almost
  // certainly NOT the genesis tx — high-volume tokens have >10k sigs and we
  // only pulled the most recent 10k oldest-first. Anchor launchTime to
  // DexScreener's pairCreatedAt instead, which reflects the true pool
  // creation time (the practical "launch" for sniper / timing analysis).
  // Line 754 may still shrink launchTime further if a holder's first buy
  // predates the pool (presale wallets, etc.), which is the correct semantic.
  if (mintSigs.length >= MINT_SIG_CAP) {
    const pair = await getDexScreenerPair(mintAddress);
    const dexCreatedSec = pair?.pairCreatedAt
      ? Math.floor(pair.pairCreatedAt / 1000)
      : null;
    if (dexCreatedSec && (launchTime === null || dexCreatedSec < launchTime)) {
      log(
        ansi(
          "yellow",
          `  ⚠   Mint history hit ${MINT_SIG_CAP}-sig cap — genesis tx likely outside window.`,
          tty,
        ),
      );
      log(
        ansi(
          "yellow",
          `      Anchoring launch time to DexScreener pool creation: ${fmt(dexCreatedSec)}`,
          tty,
        ),
      );
      launchTime = dexCreatedSec;
    }
  }

  // ── 3b. Creator Audit ────────────────────────────────────────────────────
  // Identify the wallet that funded the genesis mint transaction and check if
  // it is a "fresh" wallet (< 10 lifetime txns = throwaway / disposable risk).
  let creatorWallet = null;
  let creatorTxCount = null;
  let creatorIsFresh = false;
  if (mintSigs.length > 0) {
    try {
      const genesisTx = await getTx(mintSigs[0].signature);
      const accounts = getAccounts(genesisTx);
      creatorWallet = accounts[0] ?? null; // fee payer / signer is first account key
    } catch { /* non-fatal */ }
  }
  if (creatorWallet) {
    try {
      const creatorSigs =
        (await rpc("getSignaturesForAddress", [creatorWallet, { limit: 50 }])) ?? [];
      creatorTxCount = creatorSigs.length;
      creatorIsFresh = creatorTxCount < 10;
      log(`  Creator wallet : ${short(creatorWallet)}`);
      if (creatorIsFresh) {
        log(ansi("red", `  🚨  Fresh wallet — only ${creatorTxCount} lifetime txn(s). High risk.`, tty));
      } else {
        log(`  Creator txns   : ${creatorTxCount}${creatorTxCount >= 50 ? "+" : ""}`);
      }
    } catch { /* non-fatal */ }
  }
  report.creatorAudit = { address: creatorWallet, txCount: creatorTxCount, isFresh: creatorIsFresh };

  // ── 3c. Serial Rugger Audit ──────────────────────────────────────────────
  // Discover other tokens this deployer has launched and classify their fate.
  report.deployerHistory = [];
  if (creatorWallet) {
    try {
      report.deployerHistory = await getDeployerHistory(creatorWallet, mintAddress);
      const rugCount = report.deployerHistory.filter((t) => t.status === "rugged").length;
      if (report.deployerHistory.length > 0) {
        log(`  Deployer history : ${report.deployerHistory.length} other token(s) found — ${rugCount} rugged`);
      }
    } catch { /* non-fatal */ }
  }

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

  // ── Upgrade 1: Parallelized holder analysis ───────────────────────────────
  // Phase A — Batch all token-account owner lookups in ONE getMultipleAccounts
  // call instead of N sequential getAccountInfo calls (20 calls → 1 call).
  emit({ type: "holder", rank: 1, total: topHolders.length, address: "…" });
  progress(`Batch-fetching ${topHolders.length} holder owners…`);
  const batchOwners = new Array(topHolders.length).fill(null);
  try {
    const batchInfo = await rpc("getMultipleAccounts", [
      topHolders.map((h) => h.address),
      { encoding: "jsonParsed" },
    ]);
    (batchInfo?.value ?? []).forEach((info, i) => {
      batchOwners[i] = info?.data?.parsed?.info?.owner ?? null;
    });
  } catch { /* non-fatal — per-holder fallback in Phase B */ }

  // Phase B — Fetch acquisition time + funder for ALL holders simultaneously.
  // getFirstAcquisition and getOldestFunder are TTL_24H cached; fresh scans
  // run concurrently via Promise.all, collapsing N×sleep(DELAY_MS) → 0.
  progress(`Fetching ${topHolders.length} holder histories in parallel…`);
  const holderResults = await Promise.all(
    topHolders.map(async (h, i) => {
      const owner = batchOwners[i] ??
        await getTokenAcctOwner(h.address).catch(() => null);
      const [acq, funderResult] = await Promise.all([
        getFirstAcquisition(h.address),
        getOldestFunder(owner ?? h.address),
      ]);
      return { owner, acq, funderResult };
    }),
  );

  // Phase C — Assemble rows in rank order (synchronous, preserves ordering).
  for (let i = 0; i < topHolders.length; i++) {
    const { address, amount } = topHolders[i];
    const tokens = parseInt(amount) / 1e6;
    const pct = ((tokens / (totalInTop / 1e6)) * 100).toFixed(1);
    const { owner, acq, funderResult } = holderResults[i];
    const buyTime = acq?.blockTime ?? null;
    if (buyTime && launchTime && buyTime < launchTime) launchTime = buyTime;
    const { funder = null, birthTime: ownerBirth = null } = funderResult ?? {};
    emit({ type: "holder", rank: i + 1, total: topHolders.length, address: short(address) });
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

  // Upgrade 3: Filter MEV/Jito bots from confirmed snipers.
  // Early buyers routing through known Jito tip accounts, or consuming
  // >200k CUs (on-chain MEV arb profile), are automated bots — not
  // malicious dev snipers. Tag them separately and exclude from risk score.
  const JITO_TIP_ACCOUNTS = new Set([
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt13ib8T3s",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyfgGtiPhcmKZ",
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
  ]);
  const mevBotRanks = new Set();
  if (snipers.length > 0) {
    await Promise.all(
      snipers.map(async (r) => {
        try {
          const acqData = await getFirstAcquisition(r.tokenAcct);
          if (!acqData?.sig) return;
          const mevTx = await getTx(acqData.sig);
          if (!mevTx) return;
          const txAccts = getAccounts(mevTx);
          const hasTip = txAccts.some((a) => JITO_TIP_ACCOUNTS.has(a));
          const computeUnits = mevTx.meta?.computeUnitsConsumed ?? 0;
          if (hasTip || computeUnits > 200_000) mevBotRanks.add(r.rank);
        } catch { /* non-fatal */ }
      }),
    );
  }
  const confirmedSnipers = snipers.filter((r) => !mevBotRanks.has(r.rank));
  const mevBots          = snipers.filter((r) =>  mevBotRanks.has(r.rank));

  if (confirmedSnipers.length > 0) {
    log(
      ansi(
        "red",
        `  🚨  ${confirmedSnipers.length} same-block sniper(s) detected:`,
        tty,
      ),
    );
    confirmedSnipers.forEach((r) => {
      log(
        ansi("red", `     #${String(r.rank).padStart(2)}  ${r.tokenAcct}`, tty),
      );
      log(`          Owner : ${r.owner}`);
      log(`          Tokens: ${fmtN(r.tokens)}  (${r.pct}% of top ${topN})`);
      log(
        `          Funder: ${r.funder ?? "unknown"}  ${r.funderLabel ? `[${r.funderLabel}]` : ""}`,
      );
    });
    report.snipers = confirmedSnipers.map((r) => r.rank);
  } else {
    log(ansi("green", "  ✅  No same-block snipers detected.", tty));
  }
  if (mevBots.length > 0) {
    log(
      ansi("cyan", `  🤖  ${mevBots.length} MEV/Jito bot(s) filtered from snipers (low risk):`, tty),
    );
    mevBots.forEach((r) =>
      log(ansi("cyan", `     #${String(r.rank).padStart(2)}  ${r.tokenAcct}`, tty)),
    );
    report.mevBots = mevBots.map((r) => r.rank);
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
  const lp = await getLpStatus(mintAddress, mintSigs, holderRows);
  clr();

  report.contractSecurity.lp = lp;
  // Override poolType with the highest-liquidity DEX name from DexScreener.
  // Fixes cached lp objects whose poolType is a stale early-return sig-scan match
  // (e.g. "pumpswap" launch curve) even when the active pool is Raydium/Meteora.
  // getDexScreenerPair sorts by USD liquidity and is TTL_7D cached — no extra RPC.
  try {
    const bestPair = await getDexScreenerPair(mintAddress);
    if (bestPair) {
      if (bestPair.dexId) lp.poolType = bestPair.dexId;
      if (bestPair.liquidityUsd) {
        lp.liquidityUsd = bestPair.liquidityUsd;
        // PumpSwap liquidity is natively locked by the Pump.fun bonding curve
        // contract — there is no separate LP token to burn or lock.
        if (lp.poolType === "pumpswap") {
          lp.burnedPct = 100;
          lp.lockedLiquidityUsd = bestPair.liquidityUsd;
        } else {
          const safePct = (lp.burnedPct ?? 0) + (lp.lockedPct ?? 0);
          if (safePct > 0) {
            lp.lockedLiquidityUsd = bestPair.liquidityUsd * (safePct / 100);
          }
        }
      }
    }
  } catch { /* non-fatal */ }

  // Back-fill isLP flag — three-tier, case-insensitive detection:
  //
  //   Tier 1 — Fast-path static check (no RPC):
  //     holder.owner is in DEX_AUTHORITY_ADDRS (known program-wide PDAs
  //     like the Raydium v4 authority, or a DEX program ID itself).
  //
  //   Tier 2 — Pair-address match (no RPC):
  //     holder.owner or holder.tokenAcct equals the detected pairAddress.
  //
  //   Tier 3 — On-chain program-ownership check (one batch RPC call):
  //     For every unique owner not already resolved by tiers 1–2, call
  //     getMultipleAccountsInfo.  If the returned account's "owner" field
  //     (the Solana program that controls that PDA) is a DEX program, the
  //     holder wallet is a DEX vault — flag it as LP.
  //     This catches per-pool PDAs used by Meteora, Orca CLMM, Raydium CPMM,
  //     and any other DEX whose vault authority PDAs are not statically known.

  const lpPairLower = lp.pairAddress?.toLowerCase() ?? "";

  // Addresses already definitively resolved — skip them in the RPC batch.
  const fastResolved = new Set();
  for (const row of holderRows) {
    const ol = row.owner.toLowerCase();
    if (
      DEX_AUTHORITY_ADDRS.has(row.owner) ||
      (lpPairLower && (ol === lpPairLower || row.tokenAcct.toLowerCase() === lpPairLower))
    ) {
      fastResolved.add(ol);
    }
  }

  // Collect unique owner addresses that still need an on-chain lookup.
  const toCheck = [...new Set(
    holderRows
      .map((r) => r.owner)
      .filter((addr) => !fastResolved.has(addr.toLowerCase())),
  )];

  // Chunked batch RPC — Solana nodes reject payloads with > 100 accounts.
  // Split toCheck into ≤ 100-address chunks, sleep between chunks to avoid
  // rate-limiting, and merge results into a single Set.
  const onChainLpOwners = new Set(); // lowercase addrs confirmed as DEX vaults
  const CHUNK_SIZE = 100;
  for (let i = 0; i < toCheck.length; i += CHUNK_SIZE) {
    const chunk = toCheck.slice(i, i + CHUNK_SIZE);
    try {
      const infos = await rpc("getMultipleAccounts", [
        chunk,
        { encoding: "base64" },
      ]);
      (infos?.value ?? []).forEach((info, j) => {
        if (DEX_PROGRAM_OWNERS.has((info?.owner ?? "").toLowerCase())) {
          onChainLpOwners.add(chunk[j].toLowerCase());
        }
      });
    } catch { /* non-fatal; fall back to fast-path results only */ }
    if (i + CHUNK_SIZE < toCheck.length) await sleep(DELAY_MS);
  }

  // Apply flags to all rows — priority order prevents mislabelling.
  //
  // When getTokenAcctOwner() returns null (closed / non-standard accounts),
  // row.owner falls back to row.tokenAcct (the SPL account address itself).
  // Every tier therefore checks BOTH fields so flags fire regardless of
  // whether the owner-lookup succeeded or fell back.
  //
  // Incinerator prefix match ("1nc1nerator") is intentional: the address has
  // length variants across protocols, and startsWith is unambiguous.
  const lpOwnerWallet = lp.lpOwnerWallet ?? null;
  const NULL_LOWER = NULL_ADDR.toLowerCase();
  // vaultOwnerSet: token account addresses of known pool vaults extracted
  // during getLpStatus for CLMM / Meteora / Orca pools (where vault authority
  // PDAs are per-pool and not in any static address set).
  const vaultOwnerSet = new Set((lp.vaultOwners ?? []).map((a) => a.toLowerCase()));
  // First 8 chars of the pool address (pairAddress) used as a prefix probe
  // for CLMM / Meteora pools where the vault authority PDA shares its prefix
  // with the pool state account reported by DexScreener.
  const mainPoolPrefix8 = lp.pairAddress
    ? lp.pairAddress.substring(0, 8).toLowerCase()
    : null;
  for (const row of holderRows) {
    const ol = row.owner.toLowerCase();
    const al = row.tokenAcct.toLowerCase();

    // Tier 1 — Liquidity Pool.
    // Checks owner AND tokenAcct in every sub-condition.
    row.isLP = !!(
      DEX_AUTHORITY_ADDRS.has(row.owner) || DEX_AUTHORITY_ADDRS.has(row.tokenAcct) ||
      onChainLpOwners.has(ol) || onChainLpOwners.has(al) ||
      (lpPairLower && (ol === lpPairLower || al === lpPairLower))
    );
    row.isLiquidityPool = row.isLP ||
      HOLDER_DEX_OWNERS.has(row.owner) || HOLDER_DEX_OWNERS.has(row.tokenAcct) ||
      vaultOwnerSet.has(ol) || vaultOwnerSet.has(al) ||
      // Prefix probe: catches CLMM vault authority PDAs that share an 8-char
      // prefix with the pool state address when the exact address isn't stored.
      !!(mainPoolPrefix8 && (ol.startsWith(mainPoolPrefix8) || al.startsWith(mainPoolPrefix8)));

    // Tier 2 — Burned / Locked.
    // NULL_ADDR = System Program (on-chain owner of burned SPL accounts).
    // "1nc1nerator" prefix = incinerator; startsWith handles length variants.
    // Both owner and tokenAcct checked for the fallback case.
    row.isBurnedOrLocked = (
      ol === NULL_LOWER || al === NULL_LOWER ||
      ol.startsWith("1nc1nerator") || al.startsWith("1nc1nerator") ||
      KNOWN_LOCKER_PROGRAMS.has(row.owner) || KNOWN_LOCKER_PROGRAMS.has(row.tokenAcct)
    );

    // Tier 3 — LP Holder: wallet that holds the unburned LP token (rug risk).
    row.isLpHolder = !row.isLiquidityPool && !row.isBurnedOrLocked &&
      !!(lpOwnerWallet && (row.owner === lpOwnerWallet || row.tokenAcct === lpOwnerWallet));

    // Tier 4 — Whale: large non-DEX, non-system wallet.
    row.isWhale = !row.isLiquidityPool && !row.isBurnedOrLocked && !row.isLpHolder &&
      row.pct > 5.0 &&
      !HOLDER_DEX_OWNERS.has(row.owner) && !HOLDER_DEX_OWNERS.has(row.tokenAcct);

    // Tier 5 — Known Entity: CEX hot wallet or institutional address.
    // Having an exchange in the top holders signals listing/deposits, not risk.
    // Suppress Whale so the risk score is not inflated by exchange custody.
    const cexLabel = KNOWN_CEX_WALLETS.get(row.owner) ?? KNOWN_CEX_WALLETS.get(row.tokenAcct) ?? null;
    row.isKnownEntity = cexLabel !== null;
    row.cexLabel = cexLabel;
    if (row.isKnownEntity) row.isWhale = false;
  }

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
      ansi("gray", "  ℹ  No AMM pool found on-chain or via DexScreener.", tty),
    );
    log(
      ansi(
        "gray",
        "     Token may be pre-launch or trading only on an unindexed venue.",
        tty,
      ),
    );
  } else if (lp.status === "found_external") {
    log(
      `  Pool type     : ${lp.poolType ?? "external"}${lp.pairAddress ? " (via DexScreener)" : ""}`,
    );
    if (lp.pairAddress) log(`  Pair address  : ${lp.pairAddress}`);
    if (lp.lockedLiquidityUsd) {
      const safePct = (lp.burnedPct ?? 0) + (lp.lockedPct ?? 0);
      log(`  Locked Liquidity: ${ansi("green", "$" + fmtN(lp.lockedLiquidityUsd), tty)} (${safePct}% secured)`);
    } else if (lp.liquidityUsd) {
      log(`  Total Liquidity : $${fmtN(lp.liquidityUsd)} (Lock status unknown or 0%)`);
    }
    log(
      ansi(
        "yellow",
        "  ⚠   Pool detected, but LP burn status can't be determined for this DEX type.",
        tty,
      ),
    );
    log(
      ansi(
        "gray",
        "     CLMM / Whirlpool / Meteora pools use NFT positions, not fungible LP tokens.",
        tty,
      ),
    );
  } else if (LP_MINT_DETECTABLE.has(lp.poolType)) {
    log(
      `  Pool type     : ${lp.graduated ? "Pump.fun → Raydium (graduated)" : "Raydium AMM"}`,
    );
    log(`  LP mint       : ${lp.lpMint}`);
    log(
      `  LP supply     : ${lp.lpSupply !== null ? fmtN(lp.lpSupply) : "unknown"}`,
    );
    if (lp.lockedLiquidityUsd) {
      const safePct = (lp.burnedPct ?? 0) + (lp.lockedPct ?? 0);
      log(`  Locked Liquidity: ${ansi("green", "$" + fmtN(lp.lockedLiquidityUsd), tty)} (${safePct}% secured)`);
    } else if (lp.liquidityUsd) {
      log(`  Total Liquidity : $${fmtN(lp.liquidityUsd)} (Lock status unknown or 0%)`);
    }
    log();
    if (lp.status === "burned") {
      log(
        ansi(
          "green",
          "  ✅  LP tokens BURNED — supply is 0. Liquidity is permanently locked.",
          tty,
        ),
      );
    } else if (lp.status === "locked") {
      log(
        ansi(
          "green",
          `  🔒  LP tokens LOCKED via ${lp.lockerName ?? "known locker"} (${lp.lockedPct}%).`,
          tty,
        ),
      );
      log(
        ansi(
          "green",
          "       Liquidity is secured — deployer cannot withdraw without the locker's release.",
          tty,
        ),
      );
    } else if (lp.status === "partially_locked") {
      const safePct = (lp.burnedPct ?? 0) + (lp.lockedPct ?? 0);
      log(
        ansi(
          "yellow",
          `  ⚠   LP tokens PARTIALLY SECURED — ${safePct}% safe (${lp.burnedPct}% burned, ${lp.lockedPct ?? 0}% locked).`,
          tty,
        ),
      );
      log(ansi("yellow", `       Secured account: ${lp.lockedAddr}`, tty));
      log(
        ansi(
          "yellow",
          `       ${100 - safePct}% of LP is still withdrawable by the deployer.`,
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
      label: "LP tokens not burned or locked — rug-pull vector",
      pts: 20,
      severity: "high",
    });
  } else if (lp.status === "partially_locked") {
    const safePct = (lp.burnedPct ?? 0) + (lp.lockedPct ?? 0);
    const pts = Math.round((100 - safePct) / 10);
    score += pts;
    signals.push({
      label: `LP partially secured (${safePct}% safe, ${100 - safePct}% still withdrawable)`,
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
  if (confirmedSnipers.length > 0) {
    const pts = Math.min(20, confirmedSnipers.length * 8);
    score += pts;
    signals.push({
      label: `Same-block snipers (${confirmedSnipers.length})`,
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

  // ── Supply Concentration Override ────────────────────────────────────────
  // Checks top 2 and top 3 non-LP/DEX holders. If either group controls
  // strictly more than 50% of supply, add a +30 critical penalty.
  progress("Checking supply concentration among top holders");
  const nonLpHolders = holderRows.filter((r) => !LP_EXCLUDE.has(r.owner));
  const totalSupplyTokens = report.contractSecurity.totalSupply;
  const concentrationDenominator = totalSupplyTokens ?? (totalInTop / 1e6);
  const top2Tokens = nonLpHolders.slice(0, 2).reduce((s, r) => s + r.tokens, 0);
  const top3Tokens = nonLpHolders.slice(0, 3).reduce((s, r) => s + r.tokens, 0);
  const top2Pct = concentrationDenominator > 0 ? (top2Tokens / concentrationDenominator) * 100 : 0;
  const top3Pct = concentrationDenominator > 0 ? (top3Tokens / concentrationDenominator) * 100 : 0;
  const supplyConcentrated = top2Pct > 50 || top3Pct > 50;
  const concentrationTopN = top2Pct > 50 ? 2 : 3;
  const concentrationPct = top2Pct > 50 ? top2Pct : top3Pct;

  if (supplyConcentrated) {
    score += 30;
    signals.push({
      label: `Top holders control >50% of supply (top ${concentrationTopN} non-LP wallets hold ${concentrationPct.toFixed(1)}%)`,
      pts: 30,
      severity: "critical",
    });
  }
  report.supplyConcentration = {
    top2Pct: parseFloat(top2Pct.toFixed(2)),
    top3Pct: parseFloat(top3Pct.toFixed(2)),
    concentrated: supplyConcentrated,
  };

  if (creatorIsFresh && creatorWallet) {
    score += 20;
    signals.push({
      label: `Creator is a fresh wallet (${creatorTxCount} lifetime txn${creatorTxCount === 1 ? "" : "s"} — disposable wallet risk)`,
      pts: 20,
      severity: "high",
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
  if (confirmedSnipers.length === 0)
    log(ansi("green", "    ✅  No same-block snipers", tty));
  if (syncGroups.length === 0)
    log(ansi("green", "    ✅  No synchronized buys", tty));
  if (birthGroups.length === 0)
    log(ansi("green", "    ✅  No coordinated wallet creation", tty));
  if (!supplyConcentrated)
    log(ansi("green", `    ✅  Supply not concentrated (top 3 non-LP hold ${top3Pct.toFixed(1)}%)`, tty));

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
    cliArgs.find((a) => a.startsWith("--depth="))?.split("=")[1] ?? "3",
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
