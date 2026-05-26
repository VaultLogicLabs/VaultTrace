const apiKey = process.env.HELIUS_API_KEY;
const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

// The parent wallet identified in the previous scan
const targetWallet = "9M1EPWt6dFKnyB6PypA9TZoJ3g4RFMBKVd2UcM33qwAi";

// Max hops to trace up the chain before stopping
const MAX_DEPTH = 6;

// Known bundler / launchpad wallets (add more as needed)
const KNOWN_ENTITIES = {
  "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM": "Pump.fun: Fee Wallet",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun: Program",
  "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg": "Pump.fun: Bundler",
  "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5": "Jupiter Aggregator",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4": "Jupiter v6",
  "BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9VSGQDV": "Bonkbot",
  "HWEoBxYs7ssKuudEjzjmpileDs9685ykXMkNJsJCcaJo": "Wormhole",
  "EhYXq3ANp5nAerUpbSgd7VK2RRcxK1zNuSQ755G5Dbqk": "Raydium: Bundler",
};

async function rpcRequest(method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "forensic-agent",
      method,
      params,
    }),
  });
  const data = await response.json();
  return data.result;
}

async function getOldestFunder(walletAddress) {
  const signatures = await rpcRequest("getSignaturesForAddress", [
    walletAddress,
    { limit: 1000 },
  ]);

  if (!signatures || signatures.length === 0) return null;

  const oldestSig = signatures[signatures.length - 1].signature;

  const tx = await rpcRequest("getTransaction", [
    oldestSig,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ]);

  if (!tx?.transaction) return { signature: oldestSig, funder: null };

  const accounts = tx.transaction.message.accountKeys;
  const preBalances = tx.meta?.preBalances || [];
  const postBalances = tx.meta?.postBalances || [];

  let funder = null;
  for (let i = 0; i < accounts.length; i++) {
    const address = accounts[i].pubkey ?? accounts[i];
    if (address === walletAddress) continue;
    if (preBalances[i] > postBalances[i]) {
      funder = address;
      break;
    }
  }

  return { signature: oldestSig, funder };
}

async function traceChain(startWallet, maxDepth) {
  const chain = [startWallet];
  let current = startWallet;

  console.log(`\nTracing funding chain for: ${startWallet}\n`);
  console.log("  Depth  Wallet                                          Funded by");
  console.log("  -----  -----------------------------------------------  --------");

  for (let depth = 1; depth <= maxDepth; depth++) {
    await new Promise((r) => setTimeout(r, 300));

    const result = await getOldestFunder(current);

    if (!result || !result.funder) {
      console.log(`  [${depth}]    ${current.slice(0, 44)}  → no funder found (genesis or system)`);
      break;
    }

    const { funder, signature } = result;
    const label = KNOWN_ENTITIES[funder] ? ` ⚡ ${KNOWN_ENTITIES[funder]}` : "";
    const shortFunder = funder.slice(0, 12) + "...";
    const shortCurrent = current.slice(0, 44);

    console.log(`  [${depth}]    ${shortCurrent}  → ${shortFunder}${label}`);

    chain.push(funder);
    current = funder;

    if (KNOWN_ENTITIES[funder]) {
      console.log(`\n  ✅ Reached known entity at depth ${depth}: ${KNOWN_ENTITIES[funder]}`);
      break;
    }

    // Stop if we're going in circles
    if (chain.slice(0, -1).includes(funder)) {
      console.log(`\n  ⚠️  Circular reference detected at depth ${depth}, stopping.`);
      break;
    }
  }

  return chain;
}

async function main() {
  console.log("=================================================================");
  console.log("  DEEP CHAIN TRACE — Parent Wallet Forensics");
  console.log("=================================================================");
  console.log(`  Target: ${targetWallet}`);
  console.log(`  Max depth: ${MAX_DEPTH} hops\n`);

  const chain = await traceChain(targetWallet, MAX_DEPTH);

  console.log("\n=================================================================");
  console.log("  Full chain summary:");
  chain.forEach((addr, i) => {
    const label = KNOWN_ENTITIES[addr] ? ` (${KNOWN_ENTITIES[addr]})` : "";
    console.log(`  ${i === 0 ? "Start" : `Hop ${i}  `} → ${addr}${label}`);
  });
  console.log("=================================================================");
}

main();
