const apiKey = process.env.HELIUS_API_KEY;
const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
const tokenMintAddress = "7sGdNQSvUGpahh6qyXB3g5gsdK9FAzZM299KyCXspump"; // $HTTPS
const TOP_N = 20;

// Wallets that bought within this many seconds of token launch are flagged
const EARLY_BUY_WINDOW_SECONDS = 5 * 60; // 5 minutes
// Wallets whose first buy happened within this many seconds of each other are timing-clustered
const SYNC_WINDOW_SECONDS = 30;

async function rpcRequest(method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "forensic-agent", method, params }),
  });
  const data = await response.json();
  return data.result;
}

function fmt(unixTs) {
  return new Date(unixTs * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function fmtDelta(seconds) {
  const abs = Math.abs(seconds);
  const sign = seconds < 0 ? "-" : "+";
  if (abs < 60) return `${sign}${abs}s`;
  if (abs < 3600) return `${sign}${Math.floor(abs / 60)}m ${abs % 60}s`;
  return `${sign}${Math.floor(abs / 3600)}h ${Math.floor((abs % 3600) / 60)}m`;
}

// Pages backwards to find the absolute oldest signature for an address
async function getOldestSignature(address) {
  let before = undefined;
  let oldest = null;

  for (let page = 0; page < 5; page++) {
    const params = [address, { limit: 1000, ...(before ? { before } : {}) }];
    const sigs = await rpcRequest("getSignaturesForAddress", params);
    if (!sigs || sigs.length === 0) break;
    oldest = sigs[sigs.length - 1];
    if (sigs.length < 1000) break;
    before = oldest.signature;
    await new Promise((r) => setTimeout(r, 150));
  }

  return oldest;
}

// The true launch time = the blockTime of the mint account creation tx.
// We fetch the mint's oldest tx and then confirm via getAccountInfo when the
// account was first funded. As a fallback we use the minimum blockTime across
// the top-holder token accounts (they cannot exist before the mint).
async function getTrueLaunchTime(topHolderBuyTimes) {
  const mintOldest = await getOldestSignature(tokenMintAddress);
  const mintTime = mintOldest?.blockTime ?? null;

  // True launch = earliest of (mint oldest tx, earliest holder buy)
  const holderMin = topHolderBuyTimes.reduce((min, t) => (t !== null && t < min ? t : min), Infinity);
  const candidates = [mintTime, holderMin === Infinity ? null : holderMin].filter(Boolean);
  return candidates.length ? Math.min(...candidates) : null;
}

async function main() {
  console.log("=================================================================");
  console.log(`  BUY TIMING ANALYSIS — Top ${TOP_N} Holders vs Token Launch`);
  console.log(`  Token: ${tokenMintAddress}`);
  console.log("=================================================================\n");

  // Step 1: Top holders
  console.log(`[1/3] Fetching top ${TOP_N} holders...`);
  const largestAccounts = await rpcRequest("getTokenLargestAccounts", [tokenMintAddress]);
  if (!largestAccounts?.value) { console.log("No holder data found."); return; }
  const topHolders = largestAccounts.value.slice(0, TOP_N);
  console.log(`      Found ${topHolders.length} holders.\n`);

  // Step 2: First acquisition time per holder (token account birth = first buy)
  console.log(`[2/3] Tracing first token acquisition per holder...`);
  const rawHolderData = [];

  for (let i = 0; i < topHolders.length; i++) {
    const { address, amount } = topHolders[i];
    const tokens = (parseInt(amount) / 10 ** 6).toLocaleString();
    process.stdout.write(`  #${String(i + 1).padStart(2)} ${address.slice(0, 10)}... `);
    const oldest = await getOldestSignature(address);
    const buyTime = oldest?.blockTime ?? null;
    process.stdout.write(`${buyTime ? fmt(buyTime) : "unknown"}\n`);
    rawHolderData.push({ address, tokens, buyTime });
    await new Promise((r) => setTimeout(r, 300));
  }

  // Step 3: True launch time = minimum of mint creation and earliest holder buy
  process.stdout.write("\n[3/3] Determining true token launch time...");
  const buyTimes = rawHolderData.map((h) => h.buyTime);
  const launchTime = await getTrueLaunchTime(buyTimes);
  console.log(` ${launchTime ? fmt(launchTime) : "unknown"}\n`);

  // Annotate each holder with delay
  const holderData = rawHolderData.map((h) => ({
    ...h,
    delaySeconds: h.buyTime !== null && launchTime !== null ? h.buyTime - launchTime : null,
  }));

  // ── Per-holder table ───────────────────────────────────────────────────────
  console.log(`  #   Token Account        Tokens                  First Buy (UTC)           Delay`);
  console.log(`  --  ------------------  ----------------------  ------------------------  -------`);
  holderData.forEach((h, i) => {
    const d = h.delaySeconds;
    const delayStr = d !== null ? fmtDelta(d) : "unknown";
    const timeStr = h.buyTime ? fmt(h.buyTime) : "unknown";
    const flag = d !== null && d >= 0 && d <= EARLY_BUY_WINDOW_SECONDS ? " ⚠️" : "";
    console.log(
      `  #${String(i + 1).padStart(2)}  ${h.address.slice(0, 10)}...  ${h.tokens.padStart(22)}  ${timeStr}  ${delayStr.padStart(7)}${flag}`
    );
  });

  // ── Early buyer report ─────────────────────────────────────────────────────
  const earlyBuyers = holderData.filter(
    (h) => h.delaySeconds !== null && h.delaySeconds >= 0 && h.delaySeconds <= EARLY_BUY_WINDOW_SECONDS
  );

  console.log("\n=================================================================");
  console.log("  EARLY BUYER REPORT (within 5 min of launch)");
  console.log("=================================================================");

  if (earlyBuyers.length === 0) {
    console.log("\n✅ No wallets in the top 20 bought within the first 5 minutes of launch.");
  } else {
    console.log(`\n⚠️  ${earlyBuyers.length} wallet(s) acquired tokens within 5 minutes of launch:\n`);
    earlyBuyers.forEach((h) => {
      const num = holderData.findIndex((x) => x.address === h.address) + 1;
      console.log(`  #${String(num).padStart(2)}  ${h.address}  ${fmtDelta(h.delaySeconds)} after launch  (${h.tokens} tokens)`);
    });
  }

  // ── Synchronized buy timing ────────────────────────────────────────────────
  const withTime = holderData.filter((h) => h.buyTime !== null).sort((a, b) => a.buyTime - b.buyTime);
  const visited = new Set();
  const syncClusters = [];

  for (let i = 0; i < withTime.length; i++) {
    if (visited.has(withTime[i].address)) continue;
    const group = [withTime[i]];
    for (let j = i + 1; j < withTime.length; j++) {
      if (Math.abs(withTime[j].buyTime - withTime[i].buyTime) <= SYNC_WINDOW_SECONDS) {
        group.push(withTime[j]);
      }
    }
    if (group.length > 1) {
      group.forEach((h) => visited.add(h.address));
      syncClusters.push(group);
    }
  }

  console.log("\n=================================================================");
  console.log(`  SYNCHRONIZED BUY TIMING (within ${SYNC_WINDOW_SECONDS}s of each other)`);
  console.log("=================================================================");

  if (syncClusters.length === 0) {
    console.log("\n✅ No synchronized buy timing detected across top 20 holders.");
  } else {
    syncClusters.forEach((group, ci) => {
      const span = group[group.length - 1].buyTime - group[0].buyTime;
      console.log(`\n⚠️  [SYNC CLUSTER #${ci + 1}] ${group.length} wallets bought within ${span}s of each other:`);
      group.forEach((h) => {
        const num = holderData.findIndex((x) => x.address === h.address) + 1;
        console.log(`     #${String(num).padStart(2)}  ${h.address}  ${fmt(h.buyTime)}  (${fmtDelta(h.delaySeconds ?? 0)} from launch)  ${h.tokens} tokens`);
      });
    });
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n=================================================================");
  console.log("  SUMMARY");
  console.log(`  Token launched:      ${launchTime ? fmt(launchTime) : "unknown"}`);
  console.log(`  Holders scanned:     ${TOP_N}`);
  console.log(`  Early buyers (<5m):  ${earlyBuyers.length}`);
  console.log(`  Sync buy clusters:   ${syncClusters.length}`);
  console.log("=================================================================");
}

main();
