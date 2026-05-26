const apiKey = process.env.HELIUS_API_KEY;
const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

const TARGET       = "FireuLYd4yjJBhXQyBs3Mq6ZpNEjyHPNPG2eqhTP9RHV"; // shared parent
const tokenMint    = "7sGdNQSvUGpahh6qyXB3g5gsdK9FAzZM299KyCXspump";

// Known wallets funded by FireuLYd4 (from prior scans)
const KNOWN_CHILDREN = {
  "AmK2hPHoHktE2tcJWKbfMpYR3JiMdS3J19xGdHX4ZCLK": "Holder #1 owner  (102M tokens)",
  "G1ZmxBfUbjmYZo3TQR42aPS7GAQZxks3g3rwNsMj2ZdS": "Holder #16 token acct (12.7M tokens)",
};

const KNOWN = {
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun Program",
  "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM": "Pump.fun Fee",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA":  "SPL Token",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS": "ATA Program",
  "11111111111111111111111111111111":               "System Program",
  "ComputeBudget111111111111111111111111111111111": "Compute Budget",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4":  "Jupiter v6",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM",
  "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg": "Pump.fun Bundler",
  "BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW": "Pump.fun Launch Authority",
  ...KNOWN_CHILDREN,
};

const CHAIN_DEPTH = 8;

async function rpc(method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
  });
  return (await r.json()).result;
}

const fmt = (ts) => new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";

// Page all the way to the oldest sigs for an address
async function getOldestSigs(address, maxPages = 10) {
  let before; const all = [];
  for (let p = 0; p < maxPages; p++) {
    const sigs = await rpc("getSignaturesForAddress", [address, { limit: 1000, ...(before ? { before } : {}) }]);
    if (!sigs?.length) break;
    all.push(...sigs);
    if (sigs.length < 1000) break;
    before = sigs[sigs.length - 1].signature;
    await new Promise(r => setTimeout(r, 200));
  }
  return all.reverse(); // oldest first
}

// Get the newest N sigs (default ordering, no paging needed)
async function getNewestSigs(address, limit = 50) {
  return (await rpc("getSignaturesForAddress", [address, { limit }])) ?? [];
}

async function getTx(sig) {
  return rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
}

function getAccounts(tx) {
  return (tx?.transaction?.message?.accountKeys ?? []).map(a => a.pubkey ?? a);
}

function getSolDelta(tx, wallet) {
  const accts = getAccounts(tx);
  const idx   = accts.indexOf(wallet);
  if (idx === -1) return null;
  const pre  = tx.meta?.preBalances?.[idx]  ?? 0;
  const post = tx.meta?.postBalances?.[idx] ?? 0;
  return (post - pre) / 1e9;
}

// Find who funded a wallet (SOL sender in its first tx)
async function getOldestFunder(address) {
  const sigs = await getOldestSigs(address, 10);
  if (!sigs.length) return null;
  const tx = await getTx(sigs[0].signature);
  if (!tx) return { birthTime: null, funder: null, sig: sigs[0].signature };

  const birthTime = sigs[0].blockTime;
  const accts = getAccounts(tx);
  const pre   = tx.meta?.preBalances  ?? [];
  const post  = tx.meta?.postBalances ?? [];

  let funder = null;
  for (let i = 0; i < accts.length; i++) {
    if (accts[i] === address) continue;
    if ((pre[i] ?? 0) > (post[i] ?? 0)) { funder = accts[i]; break; }
  }
  return { birthTime, funder, sig: sigs[0].signature };
}

// Trace the funding chain upward
async function traceChain(start, depth) {
  const chain = [{ addr: start, label: "TARGET" }];
  let current = start;

  for (let d = 1; d <= depth; d++) {
    await new Promise(r => setTimeout(r, 300));
    const result = await getOldestFunder(current);
    if (!result?.funder) break;

    const { funder, birthTime } = result;
    const label = KNOWN[funder] ?? null;
    chain.push({ addr: funder, label, birthTime });
    current = funder;

    if (label) break; // hit a known entity, stop
    if (chain.slice(0, -1).some(c => c.addr === funder)) break; // cycle
  }
  return chain;
}

// Find wallets that FireuLYd4 funded (by scanning its outgoing SOL txs)
async function findFundedWallets(operatorAddr, sampleSize = 200) {
  // Look at earliest transactions — that's when it would have seeded child wallets
  const oldSigs = await getOldestSigs(operatorAddr, 3);
  const newSigs = await getNewestSigs(operatorAddr, sampleSize);

  // Combine, deduplicate, process oldest first
  const allSigs = [...oldSigs];
  const seen = new Set(oldSigs.map(s => s.signature));
  for (const s of newSigs.reverse()) {
    if (!seen.has(s.signature)) { allSigs.push(s); seen.add(s.signature); }
  }

  const funded = new Map(); // addr -> { firstSeen, solSent }
  let processed = 0;

  for (const s of allSigs.slice(0, sampleSize)) {
    await new Promise(r => setTimeout(r, 150));
    const tx = await getTx(s.signature);
    if (!tx) continue;

    const accts = getAccounts(tx);
    const pre   = tx.meta?.preBalances  ?? [];
    const post  = tx.meta?.postBalances ?? [];

    for (let i = 0; i < accts.length; i++) {
      if (accts[i] === operatorAddr) continue;
      // This wallet received SOL from the operator (its balance increased while operator's decreased)
      const opIdx = accts.indexOf(operatorAddr);
      if (opIdx === -1) continue;
      if ((pre[opIdx] ?? 0) <= (post[opIdx] ?? 0)) continue; // operator didn't spend SOL

      const delta = (post[i] ?? 0) - (pre[i] ?? 0);
      if (delta > 0 && (pre[i] ?? 0) === 0) {
        // Wallet had 0 SOL before → operator seeded it
        if (!funded.has(accts[i])) {
          funded.set(accts[i], { firstSeen: s.blockTime, solReceived: delta / 1e9 });
        }
      }
    }
    processed++;
  }

  return { funded, processed };
}

async function main() {
  console.log("═".repeat(65));
  console.log("  DEEP INVESTIGATION — FireuLYd4yjJBh (shared parent wallet)");
  console.log(`  Address: ${TARGET}`);
  console.log("═".repeat(65) + "\n");

  // 1. Basic profile
  process.stdout.write("[1/4] Wallet birth & own funding source... ");
  const { birthTime, funder: selfFunder, sig: birthSig } = await getOldestFunder(TARGET) ?? {};
  console.log(birthTime ? fmt(birthTime) : "unknown");
  console.log(`      Birth tx : ${birthSig?.slice(0, 20) ?? "?"}...`);
  console.log(`      Funded by: ${selfFunder ?? "unknown"}  ${KNOWN[selfFunder] ?? ""}`);

  // 2. Full chain trace
  console.log("\n[2/4] Tracing funding chain upstream...\n");
  const chain = await traceChain(TARGET, CHAIN_DEPTH);
  chain.forEach((c, i) => {
    const lbl = c.label ? `  ⚡ ${c.label}` : "";
    const ts  = c.birthTime ? `  (created ${fmt(c.birthTime)})` : "";
    console.log(`  ${i === 0 ? "Start " : `Hop ${i} `} → ${c.addr}${lbl}${ts}`);
  });

  // 3. Find wallets funded by FireuLYd4
  console.log("\n[3/4] Scanning for wallets seeded by this operator (sample 200 txs)...");
  const { funded, processed } = await findFundedWallets(TARGET, 200);
  console.log(`      Scanned ${processed} transactions. Found ${funded.size} wallet(s) seeded with SOL.\n`);

  if (funded.size > 0) {
    console.log("  Seeded wallets:");
    for (const [addr, info] of [...funded.entries()].sort((a, b) => a[1].firstSeen - b[1].firstSeen)) {
      const lbl = KNOWN_CHILDREN[addr] ? `  ← ${KNOWN_CHILDREN[addr]}` : "";
      console.log(`    ${addr}  +${info.solReceived.toFixed(4)} SOL  ${fmt(info.firstSeen)}${lbl}`);
    }
  }

  // 4. Token activity — does this wallet directly touch the token?
  console.log("\n[4/4] Checking if FireuLYd4 directly interacted with the token...");
  const recentSigs = await getNewestSigs(TARGET, 100);
  let tokenTxCount = 0;
  for (const s of recentSigs.slice(0, 30)) {
    await new Promise(r => setTimeout(r, 150));
    const tx = await getTx(s.signature);
    const balances = [...(tx?.meta?.preTokenBalances ?? []), ...(tx?.meta?.postTokenBalances ?? [])];
    if (balances.some(b => b.mint === tokenMint)) tokenTxCount++;
  }
  console.log(`      ${tokenTxCount > 0 ? `⚠️  ${tokenTxCount} transactions directly involved the token mint.` : "✅ No direct token interactions found — pure infrastructure wallet."}`);

  // Final verdict
  const rootAddr  = chain[chain.length - 1]?.addr ?? "unknown";
  const rootLabel = KNOWN[rootAddr] ?? "unknown origin";
  const childCount = funded.size;

  console.log("\n" + "═".repeat(65));
  console.log("  VERDICT");
  console.log("═".repeat(65));
  console.log(`\n  Wallet age    : ${birthTime ? fmt(birthTime) : "unknown"}`);
  console.log(`  Chain length  : ${chain.length - 1} hop(s) to known entity or genesis`);
  console.log(`  Root origin   : ${rootAddr}`);
  console.log(`  Root label    : ${rootLabel}`);
  console.log(`  Wallets seeded: ${childCount} (in sampled txs)`);
  console.log(`  Known children: Holder #1 (102M) + Holder #16 (12.7M) = 114.7M tokens`);
  console.log(`  Token direct  : ${tokenTxCount > 0 ? "Yes ⚠️" : "No"}`);

  if (chain.some(c => c.label?.includes("Pump.fun Bundler") || c.label?.includes("Bundler"))) {
    console.log("\n  🚨 BUNDLER CONFIRMED — chain traces to a known Pump.fun bundler.");
  } else if (chain.some(c => c.label?.includes("Pump.fun"))) {
    console.log("\n  ⚠️  PUMP.FUN LINKED — chain touches Pump.fun infrastructure.");
  } else if (childCount >= 3) {
    console.log("\n  ⚠️  OPERATOR WALLET — seeded multiple child wallets. Likely coordinated.");
  } else {
    console.log("\n  ℹ️  No known bundler in chain. Private operator wallet — not automated infra.");
  }
  console.log("═".repeat(65));
}

main();
