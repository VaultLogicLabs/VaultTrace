const apiKey = process.env.HELIUS_API_KEY;
const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

const tokenMintAddress = "7sGdNQSvUGpahh6qyXB3g5gsdK9FAzZM299KyCXspump";

// The two wallets to investigate
const TARGETS = {
  "holder1_tokenAcct":  "BmQqZCpLRD6K4JeSkfv6nNEomiVja9npxfcWkV7esK43",  // Holder #1 token account (102M)
  "recipient_wallet":   "5TsXr6fy1kdHiyjD4sFCRCNcxqjME3HiTJBbfAH8Twhq",  // Unknown recipient of tokens from #4
};

// Known context from previous scans
const KNOWN_OPERATOR = "9UcaW8ncMSBWEp597FAZbuydAWtqojVs47EnSpSKrtPV"; // Holder #4 owner
const SEED_DATE = "2025-12-17";

const KNOWN = {
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun Program",
  "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM": "Pump.fun Fee",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA":  "SPL Token",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS": "ATA Program",
  "11111111111111111111111111111111":               "System Program",
  "ComputeBudget111111111111111111111111111111111": "Compute Budget",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4":  "Jupiter v6",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM",
  [KNOWN_OPERATOR]: "⚠️ Holder #4 operator",
};

async function rpc(method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
  });
  return (await r.json()).result;
}

const fmt = (ts) => new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";

async function getOwner(tokenAcct) {
  const info = await rpc("getAccountInfo", [tokenAcct, { encoding: "jsonParsed" }]);
  const parsed = info?.value?.data?.parsed?.info;
  return parsed?.owner ?? null;
}

async function getOldestSigs(address, maxPages = 10) {
  let before, pages = [];
  for (let p = 0; p < maxPages; p++) {
    const sigs = await rpc("getSignaturesForAddress", [address, { limit: 1000, ...(before ? { before } : {}) }]);
    if (!sigs?.length) break;
    pages.push(...sigs);
    if (sigs.length < 1000) break;
    before = sigs[sigs.length - 1].signature;
    await new Promise(r => setTimeout(r, 200));
  }
  return pages.reverse(); // oldest first
}

async function getSigsAroundDate(address, dateStr, windowDays = 3) {
  const start = Date.parse(dateStr + "T00:00:00Z") / 1000;
  const end   = start + windowDays * 86400;
  let before, found = [], done = false;

  for (let p = 0; p < 20 && !done; p++) {
    const sigs = await rpc("getSignaturesForAddress", [address, { limit: 1000, ...(before ? { before } : {}) }]);
    if (!sigs?.length) break;
    for (const s of sigs) {
      if (s.blockTime <= end && s.blockTime >= start) found.push(s);
      if (s.blockTime < start) { done = true; break; }
    }
    if (sigs.length < 1000) break;
    before = sigs[sigs.length - 1].signature;
    await new Promise(r => setTimeout(r, 200));
  }
  return found.reverse();
}

async function getTx(sig) {
  return rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
}

function tokenDelta(tx, mint) {
  const pre  = tx?.meta?.preTokenBalances  ?? [];
  const post = tx?.meta?.postTokenBalances ?? [];
  const preAmt  = parseFloat(pre.find(b  => b.mint === mint)?.uiTokenAmount?.uiAmountString  ?? "0");
  const postAmt = parseFloat(post.find(b => b.mint === mint)?.uiTokenAmount?.uiAmountString ?? "0");
  return postAmt - preAmt;
}

function getAccounts(tx) {
  return (tx?.transaction?.message?.accountKeys ?? []).map(a => a.pubkey ?? a);
}

function signerLabels(tx, exclude = []) {
  return (tx?.transaction?.message?.accountKeys ?? [])
    .filter(a => a.signer && !exclude.includes(a.pubkey ?? a))
    .map(a => ({ addr: a.pubkey ?? a, label: KNOWN[a.pubkey ?? a] ?? null }));
}

async function profileWallet(label, address, isTokenAcct = false) {
  console.log(`\n${"═".repeat(65)}`);
  console.log(`  ${label}`);
  console.log(`  Address: ${address}`);
  console.log(`${"═".repeat(65)}`);

  // Resolve owner if token account
  let ownerAddr = address;
  if (isTokenAcct) {
    process.stdout.write("  Resolving owner... ");
    ownerAddr = await getOwner(address) ?? address;
    console.log(ownerAddr);
    KNOWN[ownerAddr] = KNOWN[ownerAddr] ?? `⚠️ ${label} owner`;
  }

  // Find wallet birth (oldest tx)
  process.stdout.write("  Finding wallet creation... ");
  const allSigs = await getOldestSigs(ownerAddr, 10);
  const birthTx = allSigs[0];
  console.log(birthTx ? fmt(birthTx.blockTime) : "unknown");

  // Scan activity around the seed date
  process.stdout.write(`  Scanning txs around ${SEED_DATE}... `);
  const windowSigs = await getSigsAroundDate(ownerAddr, SEED_DATE, 3);
  console.log(`${windowSigs.length} found`);

  // Decode and filter to token-touching txs
  const relevant = [];
  for (const s of windowSigs) {
    await new Promise(r => setTimeout(r, 200));
    const tx   = await getTx(s.signature);
    const pre  = tx?.meta?.preTokenBalances  ?? [];
    const post = tx?.meta?.postTokenBalances ?? [];
    const touchesMint = [...pre, ...post].some(b => b.mint === tokenMintAddress);
    if (!touchesMint) continue;

    const delta  = tokenDelta(tx, tokenMintAddress);
    const accts  = getAccounts(tx);
    const signers = signerLabels(tx, [ownerAddr]);
    const linkedToKnown = accts.some(a => a === KNOWN_OPERATOR);
    relevant.push({ s, tx, delta, signers, linkedToKnown, accts });
  }

  if (relevant.length === 0) {
    console.log(`  ⚪ No token-mint activity found in the ${SEED_DATE} window.`);
  } else {
    console.log(`\n  Token activity (${SEED_DATE} window):`);
    console.log(`  ${"─".repeat(60)}`);
    for (const r of relevant) {
      const dir   = r.delta > 0 ? "RECV +" : "SENT ";
      const flag  = r.linkedToKnown ? "  ⚠️  LINKED TO HOLDER #4 OPERATOR" : "";
      const progs = (r.tx?.transaction?.message?.accountKeys ?? [])
        .map(a => KNOWN[a.pubkey ?? a]).filter(Boolean).join(", ");

      console.log(`  ${fmt(r.s.blockTime)}  ${dir}${Math.abs(r.delta).toLocaleString()} tokens${flag}`);
      if (progs) console.log(`    Programs : ${progs}`);
      r.signers.filter(s => s.label || s.addr === KNOWN_OPERATOR)
               .forEach(s => console.log(`    Co-signer: ${s.addr}  ${s.label ?? ""}`));
    }
    console.log(`  ${"─".repeat(60)}`);
  }

  // Check if owner wallet == KNOWN_OPERATOR or shares funding with it
  const isDirectMatch = ownerAddr === KNOWN_OPERATOR;
  if (isDirectMatch) {
    console.log(`\n  🚨 DIRECT MATCH — this IS the holder #4 operator wallet.`);
  } else {
    // Get funder of this wallet's oldest tx
    if (allSigs.length > 0) {
      const oldestTx = await getTx(allSigs[0].signature);
      const pre  = oldestTx?.meta?.preBalances  ?? [];
      const post = oldestTx?.meta?.postBalances ?? [];
      const accts = getAccounts(oldestTx);
      let funder = null;
      for (let i = 0; i < accts.length; i++) {
        if (accts[i] === ownerAddr) continue;
        if ((pre[i] ?? 0) > (post[i] ?? 0)) { funder = accts[i]; break; }
      }
      if (funder) {
        const fLabel = KNOWN[funder] ?? "unknown";
        const isOp   = funder === KNOWN_OPERATOR;
        console.log(`\n  Origin funder: ${funder}  ${fLabel}`);
        if (isOp) console.log(`  🚨 FUNDED BY HOLDER #4 OPERATOR — same actor.`);
      }
    }
  }

  return { ownerAddr, relevant };
}

async function main() {
  console.log("=================================================================");
  console.log("  NETWORK INVESTIGATION — Holder #1 & Unknown Recipient");
  console.log(`  Are BmQqZCpL (Holder #1) and 5TsXr6fy (recipient) connected`);
  console.log(`  to 9UcaW8nc (Holder #4 operator)?`);
  console.log("=================================================================");

  const h1 = await profileWallet(
    "HOLDER #1 token account (102M tokens)",
    TARGETS.holder1_tokenAcct,
    true
  );

  await new Promise(r => setTimeout(r, 500));

  const recip = await profileWallet(
    "UNKNOWN RECIPIENT (5TsXr6fy — received tokens from Holder #4)",
    TARGETS.recipient_wallet,
    false
  );

  // Cross-link check: do h1 and recip share the same owner?
  console.log(`\n${"═".repeat(65)}`);
  console.log("  CROSS-LINK SUMMARY");
  console.log(`${"═".repeat(65)}`);

  const sameOwner = h1.ownerAddr && recip.ownerAddr && h1.ownerAddr === recip.ownerAddr;
  const h1LinkedToOp   = h1.relevant.some(r => r.linkedToKnown);
  const recipLinkedToOp = recip.relevant.some(r => r.linkedToKnown);

  if (sameOwner) {
    console.log(`\n  🚨 SAME OWNER — Holder #1 token acct and 5TsXr6fy are controlled`);
    console.log(`     by the same wallet: ${h1.ownerAddr}`);
  } else {
    console.log(`\n  Holder #1 owner : ${h1.ownerAddr}`);
    console.log(`  Recipient owner : ${recip.ownerAddr ?? "5TsXr6fy... (not a token acct)"}`);
    console.log(`  Same owner?     : ${sameOwner ? "YES 🚨" : "No"}`);
  }

  console.log(`\n  Holder #1 transacted with Holder #4 operator? ${h1LinkedToOp ? "YES ⚠️" : "No"}`);
  console.log(`  Recipient transacted with Holder #4 operator? ${recipLinkedToOp ? "YES ⚠️" : "No"}`);

  const connectedCount = [sameOwner, h1LinkedToOp, recipLinkedToOp].filter(Boolean).length;
  console.log(`\n  Connection score: ${connectedCount}/3 signals linked to Holder #4 operator.`);
  if (connectedCount >= 2) {
    console.log("  🚨 HIGH CONFIDENCE: These wallets are likely operated by the same actor.");
  } else if (connectedCount === 1) {
    console.log("  ⚠️  MODERATE: Partial connection found — possible shared actor.");
  } else {
    console.log("  ✅ LOW: No direct connection signals found.");
  }
  console.log(`${"═".repeat(65)}`);
}

main();
