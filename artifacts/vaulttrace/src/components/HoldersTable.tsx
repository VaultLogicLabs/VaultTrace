interface HolderRow {
  rank: number;
  tokenAcct: string;
  owner: string;
  tokens: number;
  pct: number;
  buyTime: number | null;
  ownerBirth: number | null;
  funder: string | null;
  funderLabel: string | null;
}

interface HoldersTableProps {
  holders: HolderRow[];
  sniperRanks: number[];
  clusterRanks: number[];
  topN: number;
}

function short(addr: string) {
  if (!addr) return "—";
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function fmt(ts: number) {
  return new Date(ts * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

export function HoldersTable({ holders, sniperRanks, clusterRanks, topN }: HoldersTableProps) {
  const sniperSet = new Set(sniperRanks);
  const clusterSet = new Set(clusterRanks);

  return (
    <div className="rounded-xl border border-slate-800 bg-card overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground tracking-wide">
          Top {topN} Holders
        </h3>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="text-red-400">🎯</span> Sniper
          </span>
          <span className="flex items-center gap-1">
            <span className="text-yellow-400">🔗</span> Cluster
          </span>
          <span className="flex items-center gap-1">
            <span className="text-cyan-400">⚡</span> Known entity
          </span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-slate-800 text-muted-foreground">
              <th className="px-4 py-2.5 text-right w-10">#</th>
              <th className="px-4 py-2.5 text-left">Token Account</th>
              <th className="px-4 py-2.5 text-left">Owner</th>
              <th className="px-4 py-2.5 text-right">Tokens</th>
              <th className="px-4 py-2.5 text-right">%</th>
              <th className="px-4 py-2.5 text-left">First Buy</th>
              <th className="px-4 py-2.5 text-left">Funded By</th>
              <th className="px-4 py-2.5 text-center">Flags</th>
            </tr>
          </thead>
          <tbody>
            {holders.map((h) => {
              const isSniper = sniperSet.has(h.rank);
              const isCluster = clusterSet.has(h.rank);
              const hasLabel = !!h.funderLabel;

              const rowClass = isSniper
                ? "bg-red-950/30 border-l-2 border-l-red-500"
                : isCluster
                ? "bg-yellow-950/20 border-l-2 border-l-yellow-500"
                : "";

              return (
                <tr
                  key={h.rank}
                  className={`border-b border-slate-800/60 hover:bg-slate-800/40 transition-colors ${rowClass}`}
                >
                  <td className="px-4 py-2.5 text-right text-slate-500">{h.rank}</td>
                  <td className="px-4 py-2.5 text-slate-300 whitespace-nowrap">
                    <a
                      href={`https://solscan.io/account/${h.tokenAcct}`}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:text-cyan-400 transition-colors"
                    >
                      {short(h.tokenAcct)}
                    </a>
                  </td>
                  <td className="px-4 py-2.5 text-slate-300 whitespace-nowrap">
                    <a
                      href={`https://solscan.io/account/${h.owner}`}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:text-cyan-400 transition-colors"
                    >
                      {short(h.owner)}
                    </a>
                  </td>
                  <td className="px-4 py-2.5 text-right text-slate-200">
                    {fmtTokens(h.tokens)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <span
                      className={`font-semibold ${
                        h.pct >= 10
                          ? "text-red-400"
                          : h.pct >= 5
                          ? "text-yellow-400"
                          : "text-slate-300"
                      }`}
                    >
                      {h.pct.toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-400 whitespace-nowrap">
                    {h.buyTime ? fmt(h.buyTime) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-slate-400 whitespace-nowrap">
                    {h.funder ? (
                      <a
                        href={`https://solscan.io/account/${h.funder}`}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:text-cyan-400 transition-colors"
                      >
                        {h.funderLabel ?? short(h.funder)}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    <span className="flex items-center justify-center gap-0.5">
                      {isSniper && <span title="Same-block sniper">🎯</span>}
                      {isCluster && <span title="Funding cluster">🔗</span>}
                      {hasLabel && <span title={h.funderLabel ?? ""}>⚡</span>}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
