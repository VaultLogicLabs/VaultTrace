async function testConnection() {
  // 1. Securely grab your hidden key from the Replit vault
  const apiKey = process.env.HELIUS_API_KEY;
  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

  console.log("Connecting to Solana Mainnet via Helius...");

  // 2. Ping the blockchain
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSlot", // Asking for the current block number
    }),
  });

  // 3. Print the result to your terminal
  const data = await response.json();
  console.log("Success! Current Solana Slot:", data.result);
}

testConnection();