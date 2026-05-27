import { useState, useRef, useCallback } from "react";
import { RiskGauge } from "@/components/RiskGauge";
import { TerminalFeed, ScanEvent } from "@/components/TerminalFeed";
import { HoldersTable } from "@/components/HoldersTable";

// ── Types ──────────────────────────────────────────────────────────────────
interface LpStatus {
  poolType: string | null;
  lpMint: string | null;
  lpSupply: number | null;
  burned: boolean | null;
  burnedPct: number | null;
  lockedAddr: string | null;
  graduated: boolean;
  status: string;
}

interface ContractSecurity {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  mintUnrevoked: boolean;
  freezeUnrevoked: boolean;
  decimals: number;
  totalSupply: number | null;
  lp: LpStatus;
}

interface RiskSignal {
  label: string;
  pts: number;
  severity: "critical" | "high" | "medium";
}

interface Risk {
  score: number;
  label: string;
  signals: RiskSignal[];
}

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

interface ClusterInfo {
  parent: string;
  label: string;
  rows: number[];
  totalTokens: number;
  pct: number;
}

interface TokenMetadata {
  name: string | null;
  symbol: string | null;
}

interface ScanReport {
  mint: string;
  timestamp: string;
  metadata?: TokenMetadata;
  contractSecurity: ContractSecurity;
  launchTime: number | null;
  holders: HolderRow[];
  clusters: ClusterInfo[];
  snipers: number[];
  risk: Risk;
  scanDurationSeconds?: number;
}

type Status = "idle" | "scanning" | "complete" | "error";

// ── Helpers ────────────────────────────────────────────────────────────────
function fmtTs(ts: number) {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function LpStatusBadge({ lp }: { lp: LpStatus }) {
  const cfg: Record<string, { label: string; cls: string }> = {
    burned:           { label: "LP Burned ✓",       cls: "text-green-400 border-green-800 bg-green-950/40" },
    partially_locked: { label: "Partially Locked ⚠", cls: "text-yellow-400 border-yellow-800 bg-yellow-950/40" },
    unlocked:         { label: "LP Unlocked 🚨",     cls: "text-red-400 border-red-800 bg-red-950/40" },
    bonding_curve:    { label: "Bonding Curve",      cls: "text-cyan-400 border-cyan-800 bg-cyan-950/40" },
    not_found:        { label: "No Pool Found",      cls: "text-slate-400 border-slate-700 bg-slate-800/40" },
    unknown:          { label: "Unknown",             cls: "text-slate-400 border-slate-700 bg-slate-800/40" },
  };
  const c = cfg[lp.status] ?? cfg.unknown;
  return (
    <span className={`text-xs font-mono font-semibold px-2.5 py-1 rounded-full border ${c.cls}`}>
      {c.label}
    </span>
  );
}

function SignalRow({ signal }: { signal: RiskSignal }) {
  const col = signal.severity === "critical"
    ? "text-red-400"
    : signal.severity === "high"
    ? "text-orange-400"
    : "text-yellow-400";
  return (
    <div className="flex items-start gap-3 py-1.5 border-b border-slate-800/60 last:border-0">
      <span className={`font-mono text-xs font-bold w-8 text-right shrink-0 ${col}`}>
        +{signal.pts}
      </span>
      <span className="text-xs text-slate-300 font-mono">{signal.label}</span>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────
export default function Scanner() {
  const [mint, setMint] = useState("");
  const [topN] = useState(20);
  const [depth] = useState(6);
  const [status, setStatus] = useState<Status>("idle");
  const [events, setEvents] = useState<ScanEvent[]>([]);
  const [report, setReport] = useState<ScanReport | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const esRef = useRef<EventSource | null>(null);

  const addEvent = useCallback((ev: ScanEvent) => {
    setEvents((prev) => [...prev, ev]);
  }, []);

  const startScan = useCallback(() => {
    const trimmed = mint.trim();
    if (!trimmed) return;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) {
      setErrorMsg("Invalid Solana mint address format.");
      return;
    }

    // Close any previous connection
    esRef.current?.close();

    setStatus("scanning");
    setEvents([]);
    setReport(null);
    setErrorMsg("");

    const url = `/api/scan/${encodeURIComponent(trimmed)}/stream?top=${topN}&depth=${depth}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onmessage = (e) => {
      let ev: ScanEvent;
      try { ev = JSON.parse(e.data); } catch { return; }

      if (ev.type === "complete") {
        setReport((ev as { type: "complete"; report: ScanReport }).report);
        setStatus("complete");
        addEvent(ev);
        es.close();
      } else if (ev.type === "error") {
        setErrorMsg((ev as { type: "error"; message: string }).message);
        setStatus("error");
        addEvent(ev);
        es.close();
      } else {
        addEvent(ev);
      }
    };

    es.onerror = () => {
      if (status !== "complete" && status !== "error") {
        const errEv: ScanEvent = { type: "error", message: "Connection to scan server lost." };
        addEvent(errEv);
        setErrorMsg("Connection to scan server lost.");
        setStatus("error");
      }
      es.close();
    };
  }, [mint, topN, depth, addEvent, status]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && status !== "scanning") startScan();
  };

  const clusterRanks = report?.clusters.flatMap((c) => c.rows) ?? [];

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-black tracking-[0.2em] font-mono text-white">
              VAULT<span className="text-cyan-400">TRACE</span>
            </h1>
            <p className="text-slate-500 text-xs font-mono tracking-widest mt-0.5">
              SOLANA TOKEN FORENSIC SCANNER
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs font-mono text-slate-600">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            LIVE
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-10 space-y-8">

        {/* ── Search ─────────────────────────────────────────────────── */}
        <div className="rounded-xl border border-slate-800 bg-card p-6 shadow-lg">
          <label className="block text-xs font-mono font-semibold text-muted-foreground tracking-widest mb-3">
            MINT ADDRESS
          </label>
          <div className="flex gap-3">
            <input
              type="text"
              value={mint}
              onChange={(e) => setMint(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={status === "scanning"}
              placeholder="Enter Solana token mint address…"
              className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-4 py-3
                         text-sm font-mono text-slateite-200 placeholder:text-slate-600
                         focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            />
            <button
              onClick={startScan}
              disabled={status === "scanning" || !mint.trim()}
              className="px-6 py-3 rounded-lg font-mono font-semibold text-sm
                         bg-cyan-500 text-slate-950 hover:bg-cyan-400
                         disabled:opacity-40 disabled:cursor-not-allowed
                         transition-colors shadow-lg shadow-cyan-500/20
                         tracking-wide"
            >
              {status === "scanning" ? "SCANNING…" : "SCAN"}
            </button>
          </div>
          {errorMsg && (
            <p className="mt-3 text-xs text-red-400 font-mono">{errorMsg}</p>
          )}

          {/* Advanced params hint */}
          <p className="mt-3 text-xs text-slate-600 font-mono">
            Top {topN} holders · Chain depth {depth} · ~60–90s cold scan
          </p>
        </div>

        {/* ── Terminal Feed (scanning or complete) ────────────────────── */}
        {(status === "scanning" || events.length > 0) && (
          <TerminalFeed events={events} isScanning={status === "scanning"} />
        )}

        {/* ── Results Dashboard ────────────────────────────────────────── */}
        {status === "complete" && report && (
          <div className="space-y-6 animate-in fade-in duration-500">

            {/* Token identity header */}
            <div className="text-center">
              <h2
                className="text-3xl font-black font-mono tracking-tight"
                style={{ color: "#22C55E" }}
              >
                {report.metadata?.name
                  ? report.metadata.symbol
                    ? `${report.metadata.name} ($${report.metadata.symbol})`
                    : report.metadata.name
                  : report.mint.slice(0, 8) + "…"}
              </h2>
              {(report.metadata?.name || report.metadata?.symbol) && (
                <p className="mt-1 text-xs font-mono text-slate-600 tracking-widest">
                  {report.mint.slice(0, 20)}…
                </p>
              )}
            </div>

            {/* Risk Score + Summary row */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

              {/* Risk Gauge */}
              <div className="rounded-xl border border-slate-800 bg-card p-6 flex flex-col items-center justify-center shadow-lg">
                <p className="text-xs font-mono font-semibold text-muted-foreground tracking-widest mb-4">
                  RISK SCORE
                </p>
                <RiskGauge score={report.risk?.score ?? 0} />
                {report.launchTime && (
                  <p className="mt-4 text-xs text-slate-600 font-mono text-center">
                    Launch: {fmtTs(report.launchTime)}
                  </p>
                )}
              </div>

              {/* Contract Security */}
              <div className="rounded-xl border border-slate-800 bg-card p-5 shadow-lg">
                <p className="text-xs font-mono font-semibold text-muted-foreground tracking-widest mb-4">
                  CONTRACT SECURITY
                </p>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-slate-400">Mint Authority</span>
                    {report.contractSecurity.mintUnrevoked ? (
                      <span className="text-xs font-mono font-semibold text-red-400 bg-red-950/40 border border-red-800 px-2 py-0.5 rounded-full">
                        NOT REVOKED 🚨
                      </span>
                    ) : (
                      <span className="text-xs font-mono font-semibold text-green-400 bg-green-950/40 border border-green-800 px-2 py-0.5 rounded-full">
                        Revoked ✓
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-slate-400">Freeze Authority</span>
                    {report.contractSecurity.freezeUnrevoked ? (
                      <span className="text-xs font-mono font-semibold text-yellow-400 bg-yellow-950/40 border border-yellow-800 px-2 py-0.5 rounded-full">
                        NOT REVOKED ⚠
                      </span>
                    ) : (
                      <span className="text-xs font-mono font-semibold text-green-400 bg-green-950/40 border border-green-800 px-2 py-0.5 rounded-full">
                        Revoked ✓
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between border-t border-slate-800 pt-3 mt-3">
                    <span className="text-xs font-mono text-slate-400">Decimals</span>
                    <span className="text-xs font-mono text-slate-300">
                      {report.contractSecurity.decimals ?? "—"}
                    </span>
                  </div>
                  {report.contractSecurity.totalSupply !== null && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono text-slate-400">Total Supply</span>
                      <span className="text-xs font-mono text-slate-300">
                        {report.contractSecurity.totalSupply.toLocaleString()}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* LP Status */}
              <div className="rounded-xl border border-slate-800 bg-card p-5 shadow-lg">
                <p className="text-xs font-mono font-semibold text-muted-foreground tracking-widest mb-4">
                  LIQUIDITY POOL
                </p>
                {report.contractSecurity.lp ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono text-slate-400">Status</span>
                      <LpStatusBadge lp={report.contractSecurity.lp} />
                    </div>
                    {report.contractSecurity.lp.poolType && (
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-mono text-slate-400">Pool</span>
                        <span className="text-xs font-mono text-slate-300 capitalize">
                          {report.contractSecurity.lp.graduated
                            ? "Pump → Raydium"
                            : report.contractSecurity.lp.poolType}
                        </span>
                      </div>
                    )}
                    {report.contractSecurity.lp.burnedPct !== null && (
                      <div className="flex items-center justify-between border-t border-slate-800 pt-3 mt-3">
                        <span className="text-xs font-mono text-slate-400">LP Burned</span>
                        <span className={`text-xs font-mono font-semibold ${
                          (report.contractSecurity.lp.burnedPct ?? 0) >= 99
                            ? "text-green-400"
                            : (report.contractSecurity.lp.burnedPct ?? 0) >= 50
                            ? "text-yellow-400"
                            : "text-red-400"
                        }`}>
                          {report.contractSecurity.lp.burnedPct}%
                        </span>
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono text-slate-400">Snipers</span>
                      <span className={`text-xs font-mono font-semibold ${
                        (report.snipers?.length ?? 0) > 0 ? "text-red-400" : "text-green-400"
                      }`}>
                        {report.snipers?.length ?? 0} detected
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono text-slate-400">Clusters</span>
                      <span className={`text-xs font-mono font-semibold ${
                        (report.clusters?.length ?? 0) > 0 ? "text-yellow-400" : "text-green-400"
                      }`}>
                        {report.clusters?.length ?? 0} found
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-slate-500 font-mono">No LP data</p>
                )}
              </div>
            </div>

            {/* Risk Signals */}
            {report.risk?.signals?.length > 0 && (
              <div className="rounded-xl border border-slate-800 bg-card p-5 shadow-lg">
                <p className="text-xs font-mono font-semibold text-muted-foreground tracking-widest mb-4">
                  RISK SIGNALS
                </p>
                <div>
                  {report.risk.signals.map((s, i) => (
                    <SignalRow key={i} signal={s} />
                  ))}
                </div>
              </div>
            )}

            {/* Holders Table */}
            {report.holders?.length > 0 && (
              <HoldersTable
                holders={report.holders}
                sniperRanks={report.snipers ?? []}
                clusterRanks={clusterRanks}
                topN={topN}
              />
            )}

            {/* Scan Meta */}
            <div className="text-center text-xs font-mono text-slate-700 pb-4">
              Scanned at {new Date(report.timestamp).toLocaleString()} ·{" "}
              {report.scanDurationSeconds != null
                ? `${report.scanDurationSeconds}s`
                : ""}{" "}
              · Powered by Helius
            </div>
          </div>
        )}

        {/* ── Idle placeholder ─────────────────────────────────────────── */}
        {status === "idle" && (
          <div className="text-center py-16 text-slate-700 font-mono text-sm space-y-2">
            <p className="text-4xl mb-4">🔍</p>
            <p>Enter a Solana mint address above to run a forensic scan.</p>
            <p className="text-xs text-slate-800">
              Checks mint/freeze authority · LP burn status · holder clusters · sniper wallets · funding chains
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
