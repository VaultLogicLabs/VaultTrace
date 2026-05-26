const apiKey = process.env.HELIUS_API_KEY;
const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
const tokenMintAddress = "7sGdNQSvUGpahh6qyXB3g5gsdK9FAzZM299KyCXspump"; // $HTTPS
const TOP_N = 20;

// Wallets created within this many seconds of each other are flagged as suspicious
const CLUSTER_WINDOW_SECONDS = 60;

async function rpcRequest(method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "forensic-agent", method, params }),
  });
  const data = await response.json();
  return data.result;
}

function formatTime(unixTs) {
  return new Date(unixTs * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

async function getWalletBirthTime(walletAddress) {
  // Page to the oldest known transaction
  let before = undefined;
  let oldest = null;

  for (let page = 0; page < 5; page++) {
    const params = [walletAddress, { limit: 1000, ...(before ? { before } : {}) }];
    const sigs = await rpcRequest("getSignaturesForAddress", params);
    if (!sigs || sigs.length === 0) break;

    const last = sigs[sigs.length - 1];
    oldest = last;

    if (sigs.length < 1000) break; // reached the beginning
    before = last.signature;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!oldest) return null;
  return { signature: oldest.signature, blockTime: oldest.blockTime };
}

async function main() {
  console.log("=================================================================");
  console.log(`  TIMING ANALYSIS — Top ${TOP_N} Holder Wallet Creation`);
  console.log(`  Token: ${tokenMintAddress}`);
  console.log(`  Cluster window: ±${CLUSTER_WINDOW_SECONDS}s`);
  console.log("=================================================================\n");

  console.log(`[1/2] Fetching top ${TOP_N} holders...`);
  const largestAccounts = await rpcRequest("getTokenLargestAccounts", [tokenMintAddress]);
  if (!largestAccounts?.value) { console.log("No holder data found."); return; }
  const topHolders = largestAccounts.value.slice(0, TOP_N);
  console.log(`      Found ${topHolders.length} holders.\n`);

  console.log(`[2/2] Finding wallet birth timestamps...\n`);
  console.log(`  #   Wallet              Tokens                  Created At (UTC)`);
  console.log(`  --  ------------------  ----------------------  -------------------------`);

  const holderTimings = [];

  for (let i = 0; i < topHolders.length; i++) {
    const { address, amount } = topHolders[i];
    const tokens = (parseInt(amount) / 10 ** 6).toLocaleString();

    const birth = await getWalletBirthTime(address);
    const ts = birth?.blockTime ?? null;
    const timeStr = ts ? formatTime(ts) : "unknown";

    console.log(`  #${String(i + 1).padStart(2)}  ${address.slice(0, 10)}...  ${tokens.padStart(22)}  ${timeStr}`);
    holderTimings.push({ address, tokens, blockTime: ts });

    await new Promise((r) => setTimeout(r, 300));
  }

  // ── Timing cluster analysis ───────────────────────────────────────────────
  const withTime = holderTimings.filter((h) => h.blockTime !== null).sort((a, b) => a.blockTime - b.blockTime);

  console.log("\n=================================================================");
  console.log("  TIMING CLUSTER REPORT");
  console.log("=================================================================");

  const visited = new Set();
  let clustersFound = 0;

  for (let i = 0; i < withTime.length; i++) {
    if (visited.has(withTime[i].address)) continue;

    const group = [withTime[i]];
    for (let j = i + 1; j < withTime.length; j++) {
      if (Math.abs(withTime[j].blockTime - withTime[i].blockTime) <= CLUSTER_WINDOW_SECONDS) {
        group.push(withTime[j]);
      }
    }

    if (group.length > 1) {
      clustersFound++;
      group.forEach((h) => visited.add(h.address));
      const spanSeconds = group[group.length - 1].blockTime - group[0].blockTime;

      console.log(`\n⚠️  [TIMING CLUSTER #${clustersFound}] ${group.length} wallets created within ${spanSeconds}s of each other:`);
      group.forEach((h, idx) => {
        const holderNum = holderTimings.findIndex((x) => x.address === h.address) + 1;
        console.log(`     #${String(holderNum).padStart(2)}  ${h.address}  created ${formatTime(h.blockTime)}  (${h.tokens} tokens)`);
      });
    }
  }

  if (clustersFound === 0) {
    console.log("\n✅ No coordinated wallet creation detected.");
    console.log("   All top 20 holders were created at distinct times.");
  }

  // ── Full sorted timeline ──────────────────────────────────────────────────
  console.log("\n-----------------------------------------------------------------");
  console.log("  Full creation timeline (oldest → newest):");
  withTime.forEach((h) => {
    const holderNum = holderTimings.findIndex((x) => x.address === h.address) + 1;
    console.log(`  #${String(holderNum).padStart(2)}  ${h.address.slice(0, 14)}...  ${formatTime(h.blockTime)}  (${h.tokens} tokens)`);
  });
  console.log("=================================================================");
}

main();
