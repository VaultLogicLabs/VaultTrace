const apiKey = process.env.HELIUS_API_KEY;
const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

const ownerWallet      = "9UcaW8ncMSBWEp597FAZbuydAWtqojVs47EnSpSKrtPV";
const tokenMintAddress = "7sGdNQSvUGpahh6qyXB3g5gsdK9FAzZM299KyCXspump";
// The first token-account transaction was at this time — scan owner activity here
const SEED_DATE_STR    = "2025-12-17";

const KNOWN = {
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun Program",
  "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM": "Pump.fun Fee",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA":  "SPL Token",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS": "ATA Program",
  "11111111111111111111111111111111":               "System Program",
  "ComputeBudget111111111111111111111111111111111": "Compute Budget",
  "SysvarRent111111111111111111111111111111111111": "Sysvar: Rent",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4":  "Jupiter v6",
};

async function rpc(method, params) {
  const res  = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
  });
  return (await res.json()).result;
}

const fmt      = (ts) => new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
const programs = (tx) => (tx?.transaction?.message?.accountKeys ?? [])
  .map((a) => KNOWN[a.pubkey ?? a]).filter(Boolean);

// Page backwards until we've passed a target date, collect sigs in that day window
async function getSigsAroundDate(address, targetDateStr, windowDays = 2) {
  const dayStart = Date.parse(targetDateStr + "T00:00:00Z") / 1000;
  const dayEnd   = dayStart + windowDays * 86400;

  let before = undefined;
  let found  = [];
  let done   = false;

  for (let page = 0; page < 20 && !done; page++) {
    const params = [address, { limit: 1000, ...(before ? { before } : {}) }];
    const sigs   = await rpc("getSignaturesForAddress", params);
    if (!sigs || sigs.length === 0) break;

    for (const s of sigs) {
      if (s.blockTime <= dayEnd && s.blockTime >= dayStart) found.push(s);
      if (s.blockTime < dayStart) { done = true; break; }
    }

    if (sigs.length < 1000) break;
    before = sigs[sigs.length - 1].signature;
    await new Promise((r) => setTimeout(r, 200));
  }

  return found.reverse(); // oldest first
}

function getTokenFlow(tx) {
  const pre  = tx.meta?.preTokenBalances  ?? [];
  const post = tx.meta?.postTokenBalances ?? [];

  const flows = [];
  const allMints = new Set([...pre, ...post].map((b) => b.mint));

  for (const mint of allMints) {
    if (mint !== tokenMintAddress) continue;
    const preEntry  = pre.find((b)  => b.mint === mint);
    const postEntry = post.find((b) => b.mint === mint);
    const preAmt    = parseFloat(preEntry?.uiTokenAmount?.uiAmountString  ?? "0");
    const postAmt   = parseFloat(postEntry?.uiTokenAmount?.uiAmountString ?? "0");
    const delta     = postAmt - preAmt;
    if (delta !== 0) flows.push({ mint, delta, owner: postEntry?.owner ?? preEntry?.owner ?? "?" });
  }
  return flows;
}

function getMintToInstructions(tx) {
  if (!tx?.transaction?.message?.instructions) return [];
  const inner = tx.meta?.innerInstructions ?? [];
  const all   = [
    ...tx.transaction.message.instructions,
    ...inner.flatMap((i) => i.instructions),
  ];
  return all.filter(
    (ix) =>
      ix?.parsed?.type === "mintTo" ||
      ix?.parsed?.type === "initializeAccount" ||
      ix?.parsed?.type === "transfer" ||
      ix?.parsed?.type === "transferChecked"
  );
}

async function main() {
  console.log("=================================================================");
  console.log("  ORIGIN TRACE — Where did the 284M tokens come from?");
  console.log(`  Owner wallet : ${ownerWallet}`);
  console.log(`  Token        : ${tokenMintAddress}`);
  console.log(`  Scanning     : ${SEED_DATE_STR} (±2 days)`);
  console.log("=================================================================\n");

  // 1. Get all owner-wallet transactions around Dec 17 2025
  process.stdout.write(`[1/3] Paging owner wallet history to ${SEED_DATE_STR}... `);
  const sigs = await getSigsAroundDate(ownerWallet, SEED_DATE_STR, 2);
  console.log(`${sigs.length} transactions found in window.\n`);

  if (sigs.length === 0) {
    console.log("No transactions found. The owner may have very few txs or the date is wrong.");
    return;
  }

  // 2. Fetch and decode each, filter to ones touching our token mint
  console.log(`[2/3] Decoding transactions — filtering for token mint activity...\n`);

  const relevant = [];
  for (let i = 0; i < sigs.length; i++) {
    const s   = sigs[i];
    const tx  = await rpc("getTransaction", [
      s.signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ]);

    // Only keep txs that touched our mint
    const prePost = [...(tx?.meta?.preTokenBalances ?? []), ...(tx?.meta?.postTokenBalances ?? [])];
    const touchesMint = prePost.some((b) => b.mint === tokenMintAddress);

    if (touchesMint) {
      const flows  = getTokenFlow(tx);
      const ixs    = getMintToInstructions(tx);
      const progs  = programs(tx);
      relevant.push({ s, tx, flows, ixs, progs });
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`  ${relevant.length} transaction(s) touched the token mint in this window.\n`);

  // 3. Print each relevant tx in detail
  console.log("[3/3] Detailed breakdown:\n");

  for (let i = 0; i < relevant.length; i++) {
    const { s, tx, flows, ixs, progs } = relevant[i];
    const err   = tx?.meta?.err ? "❌ FAILED" : "✅ OK";
    const delta = flows.find((f) => f.mint === tokenMintAddress);

    console.log(`  ── Tx #${i + 1} ──────────────────────────────────────────────`);
    console.log(`  Time      : ${fmt(s.blockTime)}`);
    console.log(`  Status    : ${err}`);
    console.log(`  Signature : ${s.signature}`);
    console.log(`  Programs  : ${progs.join(", ") || "unknown"}`);

    if (delta) {
      const dir = delta.delta > 0 ? "RECEIVED" : "SENT";
      console.log(`  Token flow: ${dir} ${Math.abs(delta.delta).toLocaleString()} tokens  (owner: ${delta.owner.slice(0, 12)}...)`);
    }

    // Show parsed instructions that reveal the source
    if (ixs.length > 0) {
      console.log(`  Key instructions:`);
      ixs.forEach((ix) => {
        const p = ix.parsed;
        if (p?.type === "mintTo") {
          console.log(`    🪙 mintTo — minted ${parseFloat(p.info?.amount ?? 0) / 1e6} tokens → ${p.info?.account?.slice(0, 16)}...`);
        } else if (p?.type === "initializeAccount") {
          console.log(`    🆕 initializeAccount — new token account for owner ${p.info?.owner?.slice(0, 16)}...`);
        } else if (p?.type === "transfer" || p?.type === "transferChecked") {
          const amt = p.info?.tokenAmount?.uiAmount ?? p.info?.amount;
          const src = p.info?.source?.slice(0, 16)  ?? "?";
          const dst = p.info?.destination?.slice(0, 16) ?? "?";
          console.log(`    ↔️  ${p.type} — ${amt} tokens  ${src}... → ${dst}...`);
        }
      });
    }

    // Show all accounts in the tx to find co-signers
    const accounts = (tx?.transaction?.message?.accountKeys ?? [])
      .map((a) => ({ addr: a.pubkey ?? a, signer: a.signer, writable: a.writable }))
      .filter((a) => a.signer && a.addr !== ownerWallet);

    if (accounts.length > 0) {
      console.log(`  Co-signers:`);
      accounts.forEach((a) => console.log(`    🔑 ${a.addr}  ${KNOWN[a.addr] ?? ""}`));
    }
    console.log();
  }

  // Summary
  if (relevant.length === 0) {
    console.log("=================================================================");
    console.log("  ❓ No token-mint activity found on the owner wallet in this window.");
    console.log("     The 284M tokens may have been seeded via a separate ATA that");
    console.log("     isn't directly linked to this owner address in the transaction logs.");
    console.log("=================================================================");
  } else {
    const firstIn = relevant.find((r) => (r.flows.find((f) => f.delta > 0)));
    console.log("=================================================================");
    console.log("  ORIGIN SUMMARY");
    console.log("=================================================================");
    if (firstIn) {
      const prog = firstIn.progs.join(", ") || "unknown protocol";
      console.log(`\n  First token receipt: ${fmt(firstIn.s.blockTime)}`);
      console.log(`  Via protocol       : ${prog}`);
      const mintTo = firstIn.ixs.find((ix) => ix.parsed?.type === "mintTo");
      if (mintTo) {
        console.log(`\n  🚨 DIRECT MINT DETECTED — tokens were minted directly to this wallet.`);
        console.log(`     This is a dev/team allocation, not a market buy.`);
      } else {
        console.log(`\n  ℹ️  Tokens arrived via transfer (not a direct mint).`);
        console.log(`     Source was another wallet — likely a buy or OTC transfer.`);
      }
    }
    console.log("=================================================================");
  }
}

main();
