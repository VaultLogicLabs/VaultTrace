---
name: VaultTrace index.js audit findings
description: Confirmed bugs and their fixes from the adversarial security/perf audit of the scanner engine
---

# Confirmed bugs (fixed)

## CRITICAL
**getTokenAcctOwnerBatch null/MISS confusion** — the original code used `null` as both the MISS sentinel AND as a valid cached value (closed/non-SPL account owner). Every closed account re-fetched from RPC on every batch call, defeating the cache entirely.
**Fix:** per-call `Symbol("miss")` sentinel; `cacheGet` returning `undefined` is a miss, anything else (including `null`) is a cache hit.

## HIGH
**rpc() fetch has no AbortSignal** — the exponential-backoff retry loop only handles HTTP 429 responses, not hung TCP connections. A stalled Helius RPC blocked entire scans indefinitely.
**Fix:** `AbortSignal.timeout(15_000)` on the rpc() fetch.

**LP status TTL_7D for mutable states** — `unlocked`/`partially_locked` LP results cached for 7 days. A deployer who burns the LP on day 2 appears safe (unlocked) for up to 7 more days.
**Fix:** `_lpCacheTtl(status)` helper — `burned`/`locked` → TTL_7D (irreversible), all other states → TTL_6H.

## MEDIUM
**DAS fetch no timeout** — a hung DAS `getAsset` call blocks all callers sharing the IN_FLIGHT deduplication promise for the same mint.
**Fix:** `AbortSignal.timeout(12_000)` on DAS fetch inside `getTokenMetadata`.

**DAS name/symbol not sanitized** — DAS sometimes returns `""` or `"  "` (whitespace). These truthy strings suppress the Pump.fun and on-chain PDA fallbacks, leaving the UI with a blank token name.
**Fix:** `meta.name?.trim() || null` at both DAS and Pump.fun stages.

**5 external fetches had no timeout** — DexScreener price, pair, deployer-history enrichment; GeckoTerminal hourly and minute — all could hang scans permanently.
**Fix:** `AbortSignal.timeout(8_000)` on all five.

**getDeployerHistory batch loop no inter-batch sleep** — 100 sigs → 13 iterations of 8 parallel `getTx` calls with zero throttle between iterations, causing 429 cascades.
**Fix:** `if (i + 8 < sigs.length) await sleep(DELAY_MS)` after each batch.

## LOW
**Null metadata cached TTL_24H** — tokens not yet indexed show "Unknown" for a full day even after DAS/Pump.fun catch up.
**Fix:** refactored `getTokenMetadata` from `getCached(TTL_24H)` to manual in-flight pattern; caches `TTL_5MIN` when name is null, `TTL_24H` when resolved. Added `TTL_5MIN = 5 * 60_000` constant.

**Why these matter:** LP status is the primary rug-pull safety signal. A stale "unlocked" for 7 days or a hung scan are user-facing trust failures for a forensic tool.
