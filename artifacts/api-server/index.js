const apiKey = process.env.HELIUS_API_KEY;
const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

const snipedTokenAccount = "4XRaaCBRjNKHTSatXXxKgQqkE4nSePkiKrL5pHsvvf7r";
const tokenMintAddress   = "7sGdNQSvUGpahh6qyXB3g5gsdK9FAzZM299KyCXspump";

const KNOWN_PROGRAMS = {
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun Program",
  "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM": "Pump.fun Fee Wallet",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA":  "SPL Token Program",
  "11111111111111111111111111111111":               "System Program",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS": "Associated Token Program",
  "ComputeBudget111111111111111111111111111111111": "Compute Budget",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4":  "Jupiter v6",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM",
};

async function rpcRequest(method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "forensic-agent", method, params }),
  });
  const data = await response.json();
  return data.result;
}

function fmt(ts) {
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}
function fmtDelta(s) {
  const abs = Math.abs(s);
  const sign = s < 0 ? "-" : "+";
  if (abs < 60) return `${sign}${abs}s`;
  return `${sign}${Math.floor(abs / 60)}m ${abs % 60}s`;
}

async function getOwner(tokenAccountAddress) {
  const info = await rpcRequest("getAccountInfo", [tokenAccountAddress, { encoding: "jsonParsed" }]);
  return info?.value?.data?.parsed?.info?.owner ?? null;
}

// Page all the way to the oldest signatures, return the first N chronologically
async function getOldestSignatures(address, n = 20) {
  let before = undefined;
  let pages = [];

  for (let page = 0; page < 10; page++) {
    const params = [address, { limit: 1000, ...(before ? { before } : {}) }];
    const sigs = await rpcRequest("getSignaturesForAddress", params);
    if (!sigs || sigs.length === 0) break;
    pages.push(...sigs);
    if (sigs.length < 1000) break;
    before = sigs[sigs.length - 1].signature;
    await new Promise((r) => setTimeout(r, 200));
  }

  // Reverse so oldest is first, return first n
  return pages.reverse().slice(0, n);
}

function classifyTx(tx) {
  if (!tx?.transaction) return "unknown";
  const accounts = (tx.transaction.message.accountKeys || []).map((a) => a.pubkey ?? a);
  const ids = new Set(accounts);
  if (ids.has("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")) return "Pump.fun buy/sell";
  if (ids.has("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"))  return "Jupiter swap";
  if (ids.has("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"))  return "Raydium swap";
  if (ids.has("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS"))  return "ATA init / transfer";
  return "other";
}

function getTokenDelta(tx) {
  const pre  = tx.meta?.preTokenBalances  ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const preAmt  = parseFloat(pre.find((b)  => b.mint === tokenMintAddress)?.uiTokenAmount?.uiAmountString  ?? "0");
  const postAmt = parseFloat(post.find((b) => b.mint === tokenMintAddress)?.uiTokenAmount?.uiAmountString ?? "0");
  return postAmt - preAmt;
}

function getSolDelta(tx, wallet) {
  const accounts = (tx.transaction.message.accountKeys || []).map((a) => a.pubkey ?? a);
  const idx = accounts.indexOf(wallet);
  if (idx === -1) return null;
  const pre  = tx.meta?.preBalances?.[idx]  ?? 0;
  const post = tx.meta?.postBalances?.[idx] ?? 0;
  return (post - pre) / 1e9;
}

function getPrograms(tx) {
  if (!tx?.transaction) return [];
  const accounts = (tx.transaction.message.accountKeys || []).map((a) => a.pubkey ?? a);
  return accounts.map((a) => KNOWN_PROGRAMS[a] ?? null).filter(Boolean);
}

async function main() {
  console.log("=================================================================");
  console.log("  SNIPER INVESTIGATION — Wallet that bought at second 0");
  console.log(`  Token Account : ${snipedTokenAccount}`);
  console.log(`  Token Mint    : ${tokenMintAddress}`);
  console.log("=================================================================\n");

  // 1. Resolve owner
  process.stdout.write("[1/4] Resolving token account owner... ");
  const ownerWallet = await getOwner(snipedTokenAccount);
  console.log(ownerWallet ?? "not found");
  if (!ownerWallet) { console.log("Cannot proceed."); return; }

  // 2. Get token mint's oldest tx to establish real launch time
  process.stdout.write("[2/4] Finding true token launch transaction... ");
  const mintOldestSigs = await getOldestSignatures(tokenMintAddress, 1);
  const launchTime = mintOldestSigs[0]?.blockTime ?? null;
  const launchSig  = mintOldestSigs[0]?.signature ?? null;
  console.log(launchTime ? fmt(launchTime) : "unknown");
  console.log(`      Launch tx: ${launchSig?.slice(0, 20)}...\n`);

  // 3. Get the first 20 transactions of the token account (oldest = the snipe)
  console.log("[3/4] Fetching first 20 transactions of the sniped token account...\n");
  const tokenAcctSigs = await getOldestSignatures(snipedTokenAccount, 20);

  console.log(`  #   Time (UTC)             Δ Launch   Type                   Token Δ              SOL Δ`);
  console.log(`  --  --------------------  ----------  ---------------------  -------------------  ---------`);

  const decoded = [];
  for (let i = 0; i < tokenAcctSigs.length; i++) {
    const sig = tokenAcctSigs[i];
    await new Promise((r) => setTimeout(r, 250));

    const tx = await rpcRequest("getTransaction", [
      sig.signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ]);

    const type       = classifyTx(tx);
    const tokenDelta = tx ? getTokenDelta(tx) : null;
    const solDelta   = tx ? getSolDelta(tx, ownerWallet) : null;
    const programs   = tx ? getPrograms(tx) : [];
    const deltaSec   = launchTime ? sig.blockTime - launchTime : null;

    const tokenStr = tokenDelta !== null ? (tokenDelta >= 0 ? `+${tokenDelta.toLocaleString()}` : tokenDelta.toLocaleString()) : "?";
    const solStr   = solDelta   !== null ? solDelta.toFixed(4) : "?";
    const deltaStr = deltaSec !== null ? fmtDelta(deltaSec) : "?";

    console.log(
      `  #${String(i + 1).padStart(2)}  ${fmt(sig.blockTime)}  ${deltaStr.padStart(10)}  ${type.padEnd(21)}  ${tokenStr.padStart(19)}  ${solStr.padStart(9)}`
    );
    if (programs.length) console.log(`       Programs: ${programs.join(", ")}`);

    decoded.push({ sig, tx, type, tokenDelta, solDelta, deltaSec, programs });
  }

  // 4. Verdict
  const firstBuy  = decoded.find((d) => (d.tokenDelta ?? 0) > 0);
  const firstSell = decoded.find((d) => (d.tokenDelta ?? 0) < 0);
  const buyCount  = decoded.filter((d) => (d.tokenDelta ?? 0) > 0).length;
  const sellCount = decoded.filter((d) => (d.tokenDelta ?? 0) < 0).length;
  const isPump    = decoded.some((d) => d.type === "Pump.fun buy/sell");

  console.log("\n=================================================================");
  console.log("  VERDICT");
  console.log("=================================================================");
  console.log(`\n  Owner wallet:    ${ownerWallet}`);
  console.log(`  Token launched:  ${launchTime ? fmt(launchTime) : "unknown"}`);
  console.log(`  First buy at:    ${firstBuy ? `${fmt(firstBuy.sig.blockTime)}  (${fmtDelta(firstBuy.deltaSec)} after launch)` : "not found"}`);
  console.log(`  Buys / Sells:    ${buyCount} buys, ${sellCount} sells`);
  console.log(`  Protocol:        ${isPump ? "Pump.fun" : "other"}`);

  if (firstBuy) {
    if (firstBuy.deltaSec <= 2) {
      console.log(`\n  🚨 SAME-BLOCK SNIPE — Bought in the exact launch block (+${firstBuy.deltaSec}s).`);
      console.log(`     This is a bot (bundler or mempool listener) that fires in the`);
      console.log(`     same block as token creation — classic insider/bundler pattern.`);
    } else if (firstBuy.deltaSec <= 30) {
      console.log(`\n  ⚠️  FAST SNIPE — Bought ${fmtDelta(firstBuy.deltaSec)} after launch.`);
      console.log(`     Very fast but not same-block. Likely an automated monitoring bot.`);
    } else if (firstBuy.deltaSec <= 300) {
      console.log(`\n  ⚠️  EARLY BUY — Purchased ${fmtDelta(firstBuy.deltaSec)} after launch.`);
      console.log(`     Early but not bot-speed. Could be an alert-driven manual buy.`);
    } else {
      console.log(`\n  ℹ️  Late buy — ${fmtDelta(firstBuy.deltaSec)} after launch. Not a snipe.`);
    }
  } else {
    console.log(`\n  ❓ No buy transaction detected in the first 20 token account transactions.`);
  }

  if (sellCount > 0) {
    console.log(`\n  ⚠️  ${sellCount} sell(s) detected — wallet has partially or fully exited.`);
    const totalTokenIn  = decoded.filter((d) => (d.tokenDelta ?? 0) > 0).reduce((s, d) => s + d.tokenDelta, 0);
    const totalTokenOut = Math.abs(decoded.filter((d) => (d.tokenDelta ?? 0) < 0).reduce((s, d) => s + d.tokenDelta, 0));
    console.log(`     Bought: ${totalTokenIn.toLocaleString()} tokens | Sold: ${totalTokenOut.toLocaleString()} tokens`);
  } else {
    console.log(`\n  ℹ️  No sells in first 20 txs — wallet appears to be holding.`);
  }

  console.log("\n=================================================================");
}

main();
