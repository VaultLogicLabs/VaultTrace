const apiKey = process.env.HELIUS_API_KEY;
const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
const tokenMintAddress = "7sGdNQSvUGpahh6qyXB3g5gsdK9FAzZM299KyCXspump"; // $HTTPS
const TOP_N = 20;
const CHAIN_DEPTH = 6;

const KNOWN_ENTITIES = {
  "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM": "Pump.fun: Fee Wallet",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun: Program",
  "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg": "Pump.fun: Bundler",
  "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5": "Jupiter Aggregator",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4": "Jupiter v6",
  "BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9VSGQDV": "Bonkbot",
  "HWEoBxYs7ssKuudEjzjmpileDs9685ykXMkNJsJCcaJo": "Wormhole",
  "EhYXq3ANp5nAerUpbSgd7VK2RRcxK1zNuSQ755G5Dbqk": "Raydium: Bundler",
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1": "Raydium: Authority",
  "So11111111111111111111111111111111111111112":   "Wrapped SOL",
  "11111111111111111111111111111111":              "System Program",
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

async function getOldestFunder(walletAddress) {
  const signatures = await rpcRequest("getSignaturesForAddress", [walletAddress, { limit: 1000 }]);
  if (!signatures || signatures.length === 0) return null;

  const oldestSig = signatures[signatures.length - 1].signature;
  const tx = await rpcRequest("getTransaction", [
    oldestSig,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ]);

  if (!tx?.transaction) return { signature: oldestSig, funder: null };

  const accounts = tx.transaction.message.accountKeys;
  const pre = tx.meta?.preBalances || [];
  const post = tx.meta?.postBalances || [];

  let funder = null;
  for (let i = 0; i < accounts.length; i++) {
    const address = accounts[i].pubkey ?? accounts[i];
    if (address === walletAddress) continue;
    if (pre[i] > post[i]) { funder = address; break; }
  }

  return { signature: oldestSig, funder };
}

async function traceChain(wallet, maxDepth) {
  const chain = [wallet];
  let current = wallet;

  for (let depth = 1; depth <= maxDepth; depth++) {
    await new Promise((r) => setTimeout(r, 300));
    const result = await getOldestFunder(current);
    if (!result || !result.funder) break;

    const { funder } = result;
    chain.push(funder);
    current = funder;

    if (KNOWN_ENTITIES[funder]) break;
    if (chain.slice(0, -1).includes(funder)) break;
  }

  return chain;
}

async function main() {
  console.log("=================================================================");
  console.log(`  FORENSIC SCAN — Top ${TOP_N} Holders + Deep Chain Analysis`);
  console.log(`  Token: ${tokenMintAddress}`);
  console.log("=================================================================\n");

  // Step 1: Fetch top holders
  console.log(`[1/3] Fetching top ${TOP_N} holders...`);
  const largestAccounts = await rpcRequest("getTokenLargestAccounts", [tokenMintAddress]);
  if (!largestAccounts?.value) { console.log("No holder data found."); return; }

  const topHolders = largestAccounts.value.slice(0, TOP_N);
  console.log(`      Found ${topHolders.length} holders.\n`);

  // Step 2: Trace each holder's direct funder
  console.log(`[2/3] Tracing direct funding source for each holder...`);
  const holderData = [];
  const directFunderMap = {};

  for (let i = 0; i < topHolders.length; i++) {
    const { address, amount } = topHolders[i];
    const tokens = (parseInt(amount) / 10 ** 6).toLocaleString();
    process.stdout.write(`  #${String(i + 1).padStart(2)} ${address.slice(0, 10)}... (${tokens}) → `);

    const origin = await getOldestFunder(address);
    const funder = origin?.funder ?? null;
    const label = funder && KNOWN_ENTITIES[funder] ? ` [${KNOWN_ENTITIES[funder]}]` : "";

    process.stdout.write(funder ? `${funder.slice(0, 10)}...${label}\n` : `unknown\n`);

    holderData.push({ address, tokens, funder });
    if (funder) {
      if (!directFunderMap[funder]) directFunderMap[funder] = [];
      directFunderMap[funder].push({ address, tokens });
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  // Step 3: For every cluster parent, trace its own chain
  const clusterParents = Object.entries(directFunderMap).filter(([, wallets]) => wallets.length > 1);

  console.log(`\n[3/3] Deep-tracing ${clusterParents.length} cluster parent(s) up to ${CHAIN_DEPTH} hops...\n`);

  const parentChains = {};
  for (const [parent] of clusterParents) {
    process.stdout.write(`  Tracing ${parent.slice(0, 10)}...`);
    const chain = await traceChain(parent, CHAIN_DEPTH);
    parentChains[parent] = chain;
    const root = chain[chain.length - 1];
    const rootLabel = KNOWN_ENTITIES[root] ? ` → ⚡ ${KNOWN_ENTITIES[root]}` : ` → ${root.slice(0, 10)}... (unknown origin)`;
    process.stdout.write(` ${chain.length - 1} hop(s)${rootLabel}\n`);
  }

  // ── RESULTS ───────────────────────────────────────────────────────────────
  console.log("\n=================================================================");
  console.log("  RESULTS");
  console.log("=================================================================");

  if (clusterParents.length === 0) {
    console.log("\n✅ No shared parent wallets detected among the top 20 holders.");
  } else {
    for (const [parent, wallets] of clusterParents) {
      const chain = parentChains[parent] || [parent];
      const root = chain[chain.length - 1];
      const rootLabel = KNOWN_ENTITIES[root] || "Unknown origin";

      console.log(`\n⚠️  [CLUSTER] Parent: ${parent}`);
      console.log(`   Controls ${wallets.length} wallets in the top 20:`);
      wallets.forEach((w, i) =>
        console.log(`     ${i + 1}. ${w.address}  (${w.tokens} tokens)`)
      );
      console.log(`\n   Chain (${chain.length - 1} hop${chain.length !== 2 ? "s" : ""}):`);
      chain.forEach((addr, i) => {
        const lbl = KNOWN_ENTITIES[addr] ? ` ⚡ ${KNOWN_ENTITIES[addr]}` : "";
        console.log(`     ${i === 0 ? "Cluster parent" : `Hop ${i}         `} → ${addr}${lbl}`);
      });
      console.log(`   Root origin: ${rootLabel}`);
    }
  }

  console.log("\n-----------------------------------------------------------------");
  console.log("  Full holder funding map:");
  holderData.forEach((h, i) => {
    const fShort = h.funder ? h.funder.slice(0, 14) + "..." : "unknown";
    const inCluster = h.funder && directFunderMap[h.funder]?.length > 1 ? " ⚠️" : "";
    const lbl = h.funder && KNOWN_ENTITIES[h.funder] ? ` [${KNOWN_ENTITIES[h.funder]}]` : "";
    console.log(`  #${String(i + 1).padStart(2)}  ${h.address.slice(0, 14)}...  ${h.tokens.padStart(22)} tokens  ← ${fShort}${lbl}${inCluster}`);
  });
  console.log("=================================================================");
}

main();
