const apiKey = process.env.HELIUS_API_KEY;
const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
const tokenMintAddress = "7sGdNQSvUGpahh6qyXB3g5gsdK9FAzZM299KyCXspump"; // $HTTPS

async function rpcRequest(method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "forensic-agent",
      method: method,
      params: params,
    }),
  });
  const data = await response.json();
  return data.result;
}

async function getFundingSource(walletAddress) {
  // Get the full transaction history to find the very first tx
  const signatures = await rpcRequest("getSignaturesForAddress", [
    walletAddress,
    { limit: 1000 },
  ]);

  if (!signatures || signatures.length === 0) return null;

  // The oldest transaction is the last one in the list
  const oldestSig = signatures[signatures.length - 1].signature;

  // Fetch the full transaction to find who sent SOL to this wallet
  const tx = await rpcRequest("getTransaction", [
    oldestSig,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ]);

  if (!tx || !tx.transaction) return { signature: oldestSig, funder: null };

  // Look through account keys for the fee payer / signer that isn't this wallet
  const accounts = tx.transaction.message.accountKeys;
  const preBalances = tx.meta?.preBalances || [];
  const postBalances = tx.meta?.postBalances || [];

  let funder = null;
  for (let i = 0; i < accounts.length; i++) {
    const acct = accounts[i];
    const address = acct.pubkey || acct;
    if (address === walletAddress) continue;
    // A funder's balance decreases (they sent SOL)
    if (preBalances[i] > postBalances[i]) {
      funder = address;
      break;
    }
  }

  return { signature: oldestSig, funder };
}

async function analyzeTokenFootprint() {
  try {
    console.log(`[1/3] Fetching top holders for mint: ${tokenMintAddress}...`);

    const largestAccounts = await rpcRequest("getTokenLargestAccounts", [tokenMintAddress]);

    if (!largestAccounts || !largestAccounts.value) {
      console.log("No holder data found or invalid mint address.");
      return;
    }

    const topHolders = largestAccounts.value.slice(0, 10);
    console.log(`[2/3] Tracing funding sources for top ${topHolders.length} holders...\n`);

    const funderMap = {}; // funderAddress -> [wallets it funded]
    const results = [];

    for (let i = 0; i < topHolders.length; i++) {
      const holder = topHolders[i];
      const walletAddress = holder.address;
      const amount = (parseInt(holder.amount) / 10 ** 6).toLocaleString();

      process.stdout.write(` Holder #${i + 1} ${walletAddress.slice(0, 8)}... (${amount} tokens) — tracing...`);

      const origin = await getFundingSource(walletAddress);

      if (origin && origin.funder) {
        process.stdout.write(` funded by ${origin.funder.slice(0, 8)}...\n`);
        if (!funderMap[origin.funder]) funderMap[origin.funder] = [];
        funderMap[origin.funder].push({ wallet: walletAddress, amount });
      } else {
        process.stdout.write(` funder unknown\n`);
      }

      results.push({ wallet: walletAddress, amount, origin });

      // Pause to avoid rate limits
      await new Promise((r) => setTimeout(r, 300));
    }

    console.log("\n[3/3] Forensics Complete. Analyzing Parent Wallet Clusters:\n");
    console.log("============================================================");

    let clustersFound = 0;
    for (const [funder, wallets] of Object.entries(funderMap)) {
      if (wallets.length > 1) {
        clustersFound++;
        console.log(`\n⚠️  [CLUSTER DETECTED] Parent wallet: ${funder}`);
        console.log(`   Funded ${wallets.length} wallets in the top 10:`);
        wallets.forEach((w, idx) => {
          console.log(`     ${idx + 1}. ${w.wallet} (holds ${w.amount} tokens)`);
        });
      }
    }

    if (clustersFound === 0) {
      console.log("\n✅ No shared parent wallets detected among top 10 holders.");
      console.log("   Each wallet appears to have been funded by a distinct source.");
    }

    console.log("\n------------------------------------------------------------");
    console.log("Full funding map:");
    results.forEach((r, i) => {
      const funder = r.origin?.funder ? r.origin.funder.slice(0, 12) + "..." : "unknown";
      console.log(`  #${i + 1} ${r.wallet.slice(0, 12)}... ← funded by ${funder}`);
    });
    console.log("============================================================");
  } catch (error) {
    console.error("Forensic scan failed:", error);
  }
}

analyzeTokenFootprint();
