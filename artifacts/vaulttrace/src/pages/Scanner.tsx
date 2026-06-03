import { useState, useRef, useCallback, useEffect } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  Tooltip,
} from "recharts";
import { RiskGauge } from "@/components/RiskGauge";
import { TerminalFeed, ScanEvent } from "@/components/TerminalFeed";

// ── Types ──────────────────────────────────────────────────────────────────
interface LpStatus {
  poolType: string | null;
  lpMint: string | null;
  lpSupply: number | null;
  burned: boolean | null;
  burnedPct: number | null;
  lockedPct: number | null;
  lockerName: string | null;
  isLocked: boolean;
  lockedAddr: string | null;
  graduated: boolean;
  status: string;
  liquidityUsd?: number | null;
  lockedLiquidityUsd?: number | null;
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
  isLP?: boolean;
  isLiquidityPool?: boolean;
  isBurnedOrLocked?: boolean;
  isLpHolder?: boolean;
  isWhale?: boolean;
  isKnownEntity?: boolean;
  cexLabel?: string | null;
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
  logoUri: string | null;
}

interface TokenPriceData {
  price: number | null;
  marketCap: number | null;
  volume24h: number | null;
}

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface TokenChartData {
  candles: Candle[];
  direction: "up" | "down" | "flat" | null;
  priceChange24h: number | null;
}

interface CreatorAudit {
  address: string | null;
  txCount: number | null;
  isFresh: boolean;
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
  creatorAudit?: CreatorAudit;
  scanDurationSeconds?: number;
}

type Status = "idle" | "scanning" | "complete" | "error";

// ── Scan history (server-backed) ────────────────────────────────────────────
// History is persisted on the API server under /api/history so it survives
// across browsers and devices. A legacy localStorage cache is migrated to the
// server on first load, then removed.
const HISTORY_KEY = "vaulttrace_scan_history";
const HISTORY_MIGRATED_KEY = "vaulttrace_history_migrated_v1";
const HISTORY_ENDPOINT = "/api/history";

// ── Logo cache (URI → { data: base64 data URL, ts: last-accessed ms }) ──────
const LOGO_CACHE_KEY = "vaulttrace_logo_cache";
const MAX_LOGO_CACHE = 30;
const STORAGE_HIGH_WATERMARK = 0.85; // trim proactively above this ratio
const LOGO_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface LogoCacheEntry {
  data: string;
  ts: number;
}
type LogoCache = Record<string, LogoCacheEntry>;

function loadLogoCache(): LogoCache {
  try {
    const raw = localStorage.getItem(LOGO_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as LogoCache;
    const now = Date.now();
    const fresh: LogoCache = {};
    for (const [key, entry] of Object.entries(parsed)) {
      if (entry && typeof entry.ts === "number" && now - entry.ts <= LOGO_CACHE_MAX_AGE_MS) {
        fresh[key] = entry;
      }
    }
    return fresh;
  } catch {
    return {};
  }
}

function evictOldest(cache: LogoCache, keepCount: number): LogoCache {
  const sorted = Object.entries(cache).sort((a, b) => a[1].ts - b[1].ts);
  return Object.fromEntries(sorted.slice(Math.max(0, sorted.length - keepCount)));
}

async function saveLogoCache(cache: LogoCache): Promise<void> {
  // Proactive: check storage quota and trim before we even attempt the write
  try {
    const { usage = 0, quota = Infinity } = (await navigator.storage?.estimate?.()) ?? {};
    if (quota > 0 && usage / quota > STORAGE_HIGH_WATERMARK) {
      cache = evictOldest(cache, Math.floor(MAX_LOGO_CACHE / 2));
    }
  } catch {
    // estimate() unavailable — proceed without proactive trim
  }

  try {
    localStorage.setItem(LOGO_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Storage still full — try an aggressive eviction and retry once
    const trimmed = evictOldest(cache, Math.floor(MAX_LOGO_CACHE / 4));
    try {
      localStorage.setItem(LOGO_CACHE_KEY, JSON.stringify(trimmed));
    } catch {
      console.warn("[VaultTrace] Logo cache: storage critically full, logo caching unavailable.");
    }
  }
}

async function fetchLogoAsDataUrl(uri: string): Promise<string | null> {
  try {
    const resp = await fetch(uri);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function readLegacyLocalHistory(): ScanReport[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ScanReport[]) : [];
  } catch {
    return [];
  }
}

async function fetchServerHistory(): Promise<ScanReport[]> {
  const res = await fetch(HISTORY_ENDPOINT);
  if (!res.ok) throw new Error(`Failed to load history (${res.status})`);
  const data = await res.json();
  return Array.isArray(data) ? (data as ScanReport[]) : [];
}

async function postReport(report: ScanReport): Promise<ScanReport[]> {
  const res = await fetch(HISTORY_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report),
  });
  if (!res.ok) throw new Error(`Failed to save history (${res.status})`);
  const data = await res.json();
  return Array.isArray(data) ? (data as ScanReport[]) : [];
}

async function clearServerHistory(): Promise<void> {
  const res = await fetch(HISTORY_ENDPOINT, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to clear history (${res.status})`);
}

async function migrateLocalHistoryOnce(): Promise<ScanReport[] | null> {
  if (typeof window === "undefined") return null;
  if (localStorage.getItem(HISTORY_MIGRATED_KEY)) return null;
  const legacy = readLegacyLocalHistory();
  if (legacy.length === 0) {
    localStorage.setItem(HISTORY_MIGRATED_KEY, "1");
    localStorage.removeItem(HISTORY_KEY);
    return null;
  }
  try {
    const res = await fetch(`${HISTORY_ENDPOINT}/migrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(legacy),
    });
    if (!res.ok) throw new Error(`migrate failed (${res.status})`);
    const merged = await res.json();
    localStorage.setItem(HISTORY_MIGRATED_KEY, "1");
    localStorage.removeItem(HISTORY_KEY);
    return Array.isArray(merged) ? (merged as ScanReport[]) : null;
  } catch (err) {
    // Leave legacy data in place so we can retry on the next load
    console.warn("[VaultTrace] History migration deferred:", err);
    return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
function fmtTs(ts: number) {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function shortAddr(addr: string) {
  if (!addr) return "—";
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function fmtHolderTs(ts: number) {
  return new Date(ts * 1000).toLocaleString("en-US", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtTokenAmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function fmtPrice(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.000001) return `$${n.toExponential(2)}`;
  if (n < 0.0001)   return `$${n.toPrecision(3)}`;
  if (n < 1)        return `$${n.toFixed(6)}`;
  if (n < 1000)     return `$${n.toFixed(2)}`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtShortUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000)     return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)         return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function fmtIso(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function tokenLabel(r: ScanReport): string {
  if (r.metadata?.name && r.metadata?.symbol)
    return `${r.metadata.name} ($${r.metadata.symbol})`;
  if (r.metadata?.name) return r.metadata.name;
  if (r.metadata?.symbol) return `$${r.metadata.symbol}`;
  return r.mint.slice(0, 8) + "…";
}

function riskColor(score: number): string {
  if (score >= 70) return "text-red-400";
  if (score >= 40) return "text-yellow-400";
  return "text-green-400";
}

function LpStatusBadge({ lp }: { lp: LpStatus }) {
  const cfg: Record<string, { label: string; cls: string }> = {
    burned:           { label: "LP Burned ✓",          cls: "text-green-400 border-green-800 bg-green-950/40" },
    locked:           { label: "🔒 LP Locked ✓",        cls: "text-blue-400 border-blue-800 bg-blue-950/40" },
    partially_locked: { label: "Partially Secured ⚠",  cls: "text-yellow-400 border-yellow-800 bg-yellow-950/40" },
    unlocked:         { label: "LP Unlocked 🚨",        cls: "text-red-400 border-red-800 bg-red-950/40" },
    bonding_curve:    { label: "Bonding Curve",         cls: "text-cyan-400 border-cyan-800 bg-cyan-950/40" },
    found_external:   { label: "Pool Found",            cls: "text-cyan-400 border-cyan-800 bg-cyan-950/40" },
    not_found:        { label: "No Pool Found",         cls: "text-slate-400 border-slate-700 bg-slate-800/40" },
    unknown:          { label: "Unknown",               cls: "text-slate-400 border-slate-700 bg-slate-800/40" },
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

// ── Price Sparkline ─────────────────────────────────────────────────────────
function PriceSparkline({ data }: { data: TokenChartData }) {
  if (!data.candles.length) return null;

  const isUp   = data.direction === "up";
  const isDown = data.direction === "down";
  const color  = isUp ? "#22c55e" : isDown ? "#f87171" : "#94a3b8";
  const gradId = `sparkGrad-${isUp ? "up" : isDown ? "down" : "flat"}`;

  const chartPoints = data.candles.map((c) => ({ c: c.c }));

  return (
    <div className="flex flex-col items-center">
      <div className="flex items-baseline gap-1.5 mb-0.5">
        <p className="text-xs font-mono text-slate-500 tracking-widest">24H CHART</p>
        {data.priceChange24h != null && (
          <span
            className={`text-[10px] font-mono font-semibold ${
              data.priceChange24h > 0
                ? "text-green-400"
                : data.priceChange24h < 0
                  ? "text-red-400"
                  : "text-slate-400"
            }`}
          >
            {data.priceChange24h > 0 ? "+" : ""}
            {data.priceChange24h.toFixed(2)}%
          </span>
        )}
      </div>
      <div style={{ width: 120, height: 40 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartPoints} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={color} stopOpacity={0.25} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const val = payload[0].value as number;
                return (
                  <div className="bg-slate-900 border border-slate-700 rounded px-2 py-1">
                    <span className="text-[10px] font-mono text-slate-200">
                      {val < 0.000001
                        ? `$${val.toExponential(2)}`
                        : val < 0.0001
                        ? `$${val.toPrecision(3)}`
                        : val < 1
                        ? `$${val.toFixed(6)}`
                        : `$${val.toFixed(2)}`}
                    </span>
                  </div>
                );
              }}
            />
            <Area
              type="monotone"
              dataKey="c"
              stroke={color}
              strokeWidth={1.5}
              fill={`url(#${gradId})`}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ── Token Logo ──────────────────────────────────────────────────────────────
function LogoPlaceholder({ size = "md" }: { size?: "sm" | "md" }) {
  const outer = size === "sm" ? "w-7 h-7" : "w-10 h-10";
  const inner = size === "sm" ? "w-3.5 h-3.5" : "w-5 h-5";
  return (
    <div
      className={`${outer} rounded-full flex items-center justify-center shrink-0 border border-slate-700`}
      style={{ background: "#1e293b" }}
      title="No logo"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className={`${inner} text-slate-500`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4m0 4h.01" strokeLinecap="round" />
      </svg>
    </div>
  );
}

function TokenLogo({
  uri,
  size = "md",
  cacheOnly = false,
}: {
  uri: string | null;
  size?: "sm" | "md";
  cacheOnly?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  // Initialise src from cache synchronously so cached logos render with no flicker
  const [src, setSrc] = useState<string | null>(() => {
    if (!uri) return null;
    return loadLogoCache()[uri]?.data ?? null;
  });

  useEffect(() => {
    if (cacheOnly) return; // history rows: never fetch, just use what's cached
    if (!uri || src) return; // already cached or no URI
    let cancelled = false;

    fetchLogoAsDataUrl(uri).then((dataUrl) => {
      if (cancelled) return;
      if (dataUrl) {
        // Persist in the logo cache with LRU timestamp, evicting oldest when over limit
        let cache = loadLogoCache();
        cache[uri] = { data: dataUrl, ts: Date.now() };
        if (Object.keys(cache).length > MAX_LOGO_CACHE) {
          cache = evictOldest(cache, MAX_LOGO_CACHE);
        }
        saveLogoCache(cache); // async — fire and forget is fine here
        setSrc(dataUrl);
      } else {
        // Fetch failed (CORS or network) — fall back to remote URI directly
        setSrc(uri);
      }
    });

    return () => { cancelled = true; };
  }, [uri, src, cacheOnly]);

  const dim = size === "sm" ? "w-7 h-7" : "w-10 h-10";

  if (!uri || broken) return <LogoPlaceholder size={size} />;

  if (!src) {
    if (cacheOnly) {
      // No base64 in cache — render directly from the remote URI with onError fallback
      return (
        <img
          src={uri}
          alt="Token logo"
          className={`${dim} rounded-full object-cover shrink-0 border border-slate-700`}
          onError={() => setBroken(true)}
        />
      );
    }
    // Show a pulse skeleton while the base64 fetch is in-flight
    return (
      <div className={`${dim} rounded-full shrink-0 border border-slate-700 bg-slate-800 animate-pulse`} />
    );
  }

  return (
    <img
      src={src}
      alt="Token logo"
      className={`${dim} rounded-full object-cover shrink-0 border border-slate-700`}
      onError={() => setBroken(true)}
    />
  );
}

// ── Recent Scans Panel ──────────────────────────────────────────────────────
interface RecentScansPanelProps {
  history: ScanReport[];
  onSelect: (r: ScanReport) => void;
  onClear: () => void;
}

type RiskFilter = "all" | "low" | "medium" | "high";

function riskBucket(score: number): "low" | "medium" | "high" {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

function RecentScansPanel({ history, onSelect, onClear }: RecentScansPanelProps) {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("all");

  if (history.length === 0) return null;

  const q = query.trim().toLowerCase();
  const filtered = history.filter((r) => {
    if (riskFilter !== "all") {
      const bucket = riskBucket(r.risk?.score ?? 0);
      if (bucket !== riskFilter) return false;
    }
    if (!q) return true;
    const name = r.metadata?.name?.toLowerCase() ?? "";
    const symbol = r.metadata?.symbol?.toLowerCase() ?? "";
    const mint = r.mint.toLowerCase();
    return name.includes(q) || symbol.includes(q) || mint.includes(q);
  });

  const filterBtn = (val: RiskFilter, label: string, activeCls: string) => (
    <button
      key={val}
      onClick={() => setRiskFilter(val)}
      className={`px-2.5 py-1 rounded-full border text-[10px] font-mono font-semibold tracking-wider transition-colors ${
        riskFilter === val
          ? activeCls
          : "border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="rounded-xl border border-slate-800 bg-card shadow-lg overflow-hidden">
      {/* Header row */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-6 py-4 hover:bg-slate-800/30 transition-colors"
      >
        <span className="text-xs font-mono font-semibold text-muted-foreground tracking-widest">
          RECENT SCANS
          <span className="ml-2 text-slate-400">
            {filtered.length === history.length
              ? `(${history.length})`
              : `(${filtered.length}/${history.length})`}
          </span>
        </span>
        <svg
          className={`w-4 h-4 text-slate-500 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="border-t border-slate-800">
          {/* Search + filters */}
          <div className="px-6 py-3 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center gap-3">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, symbol, or mint…"
              className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2
                         text-xs font-mono text-slate-100 placeholder:text-slate-500
                         focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30
                         transition-colors"
            />
            <div className="flex items-center gap-1.5 flex-wrap">
              {filterBtn("all", "ALL", "border-cyan-600 text-cyan-300 bg-cyan-950/40")}
              {filterBtn("low", "LOW", "border-green-800 text-green-300 bg-green-950/40")}
              {filterBtn("medium", "MED", "border-yellow-800 text-yellow-300 bg-yellow-950/40")}
              {filterBtn("high", "HIGH", "border-red-800 text-red-300 bg-red-950/40")}
            </div>
          </div>

          {filtered.length === 0 ? (
            <p className="px-6 py-6 text-xs font-mono text-slate-500 text-center">
              No scans match your filters.
            </p>
          ) : (
          <ul className="divide-y divide-slate-800/60 max-h-[28rem] overflow-y-auto">
            {filtered.map((r) => (
              <li key={r.mint}>
                <button
                  onClick={() => onSelect(r)}
                  className="w-full flex items-center gap-3 px-6 py-3 text-left hover:bg-slate-800/40 transition-colors group"
                >
                  {/* Token logo — read from cache only, no network fetch in history */}
                  <TokenLogo uri={r.metadata?.logoUri ?? null} size="sm" cacheOnly />

                  {/* Risk score badge */}
                  <span
                    className={`shrink-0 font-mono font-black text-base w-8 text-right ${riskColor(r.risk?.score ?? 0)}`}
                  >
                    {r.risk?.score ?? "—"}
                  </span>

                  {/* Token info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-mono font-semibold text-slate-200 truncate group-hover:text-cyan-300 transition-colors">
                      {tokenLabel(r)}
                    </p>
                    <p className="text-xs font-mono text-slate-400 truncate mt-0.5">
                      {r.mint.slice(0, 16)}…
                    </p>
                  </div>

                  {/* Timestamp */}
                  <span className="shrink-0 text-xs font-mono text-slate-400">
                    {fmtIso(r.timestamp)}
                  </span>

                  {/* Arrow */}
                  <svg
                    className="shrink-0 w-4 h-4 text-slate-500 group-hover:text-cyan-500 transition-colors"
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
          )}

          {/* Clear button */}
          <div className="px-6 py-3 border-t border-slate-800 flex justify-end">
            <button
              onClick={onClear}
              className="text-xs font-mono text-slate-400 hover:text-red-400 transition-colors"
            >
              Clear history
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────
export default function Scanner() {
  const [mint, setMint] = useState("");
  const [topN] = useState(20);
  const [depth] = useState(3);
  const [status, setStatus] = useState<Status>("idle");
  const [events, setEvents] = useState<ScanEvent[]>([]);
  const [report, setReport] = useState<ScanReport | null>(null);
  const [priceData, setPriceData] = useState<TokenPriceData | null>(null);
  const [chartData, setChartData] = useState<TokenChartData | null>(null);
  const [priceUpdatedAt, setPriceUpdatedAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [errorMsg, setErrorMsg] = useState("");
  const [history, setHistory] = useState<ScanReport[]>([]);
  const [hoveredParentWallet, setHoveredParentWallet] = useState<string | null>(null);
  const [priceFlash, setPriceFlash] = useState<"up" | "down" | null>(null);
  const [mcFlash, setMcFlash] = useState<"up" | "down" | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const prevPriceDataRef = useRef<TokenPriceData | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const fetchChartData = useCallback(async (mintAddr: string) => {
    try {
      const res = await fetch(`/api/token/${encodeURIComponent(mintAddr)}/chart`);
      if (res.ok) {
        const data = (await res.json()) as TokenChartData;
        setChartData(data);
      }
    } catch {
      // non-critical — chart is a visual enhancement
    }
  }, []);

  const fetchPriceData = useCallback(async (mintAddr: string) => {
    try {
      const res = await fetch(`/api/token/${encodeURIComponent(mintAddr)}/price`);
      if (res.ok) {
        const data = (await res.json()) as TokenPriceData;
        const prev = prevPriceDataRef.current;
        setPriceData(data);
        setPriceUpdatedAt(Date.now());
        prevPriceDataRef.current = data;

        if (prev !== null) {
          let nextPriceFlash: "up" | "down" | null = null;
          let nextMcFlash: "up" | "down" | null = null;

          if (prev.price !== null && data.price !== null) {
            if (data.price > prev.price) nextPriceFlash = "up";
            else if (data.price < prev.price) nextPriceFlash = "down";
          }
          if (prev.marketCap !== null && data.marketCap !== null) {
            if (data.marketCap > prev.marketCap) nextMcFlash = "up";
            else if (data.marketCap < prev.marketCap) nextMcFlash = "down";
          }

          if (nextPriceFlash || nextMcFlash) {
            setPriceFlash(nextPriceFlash);
            setMcFlash(nextMcFlash);
            if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
            flashTimerRef.current = setTimeout(() => {
              setPriceFlash(null);
              setMcFlash(null);
            }, 1000);
          }
        }
      }
    } catch {
      // silently ignore — price is non-critical
    }
  }, []);

  // Load history from the server on mount (migrating any legacy
  // localStorage entries on the first run).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const migrated = await migrateLocalHistoryOnce();
        if (cancelled) return;
        if (migrated) {
          setHistory(migrated);
          return;
        }
        const serverHistory = await fetchServerHistory();
        if (!cancelled) setHistory(serverHistory);
      } catch (err) {
        console.warn("[VaultTrace] Could not load scan history:", err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

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
    setPriceData(null);
    setChartData(null);
    setPriceUpdatedAt(null);
    setErrorMsg("");
    prevPriceDataRef.current = null;
    setPriceFlash(null);
    setMcFlash(null);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);

    const url = `/api/scan/${encodeURIComponent(trimmed)}/stream?top=${topN}&depth=${depth}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onmessage = (e) => {
      let ev: ScanEvent;
      try { ev = JSON.parse(e.data); } catch { return; }

      if (ev.type === "complete") {
        const completedReport = (ev as { type: "complete"; report: ScanReport }).report;
        setReport(completedReport);
        setStatus("complete");
        addEvent(ev);
        es.close();
        // Persist to server-side history; fall back to optimistic local update
        // if the request fails so the user still sees their scan in the panel.
        postReport(completedReport)
          .then((next) => setHistory(next))
          .catch((err) => {
            console.warn("[VaultTrace] Failed to save scan to history:", err);
            setHistory((prev) => {
              const deduped = prev.filter((r) => r.mint !== completedReport.mint);
              return [completedReport, ...deduped].slice(0, 200);
            });
          });
        // Fetch price + chart data asynchronously — doesn't block the scan result
        fetchPriceData(completedReport.mint);
        fetchChartData(completedReport.mint);
        // Scroll the results dashboard into view now that it will mount
        setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
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

  const restoreReport = useCallback((r: ScanReport) => {
    esRef.current?.close();
    setReport(r);
    setMint(r.mint);
    setStatus("complete");
    setEvents([]);
    setErrorMsg("");
    setPriceData(null);
    setChartData(null);
    setPriceUpdatedAt(null);
    prevPriceDataRef.current = null;
    setPriceFlash(null);
    setMcFlash(null);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    fetchPriceData(r.mint);
    fetchChartData(r.mint);
  }, [fetchPriceData, fetchChartData]);

  // Auto-refresh price + chart data every 60s while a completed report is on screen.
  // Stops automatically when the user starts a new scan, navigates away, or
  // unmounts the component.
  useEffect(() => {
    if (status !== "complete" || !report) return;
    const id = window.setInterval(() => {
      fetchPriceData(report.mint);
      fetchChartData(report.mint);
    }, 60_000);
    return () => window.clearInterval(id);
  }, [status, report, fetchPriceData, fetchChartData]);

  // Tick once per second so the "updated Xs ago" label stays accurate.
  useEffect(() => {
    if (status !== "complete" || priceUpdatedAt === null) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [status, priceUpdatedAt]);

  const clearHistory = useCallback(() => {
    setHistory([]);
    clearServerHistory().catch((err) => {
      console.warn("[VaultTrace] Failed to clear server history:", err);
    });
  }, []);

  const clusterRanks = report?.clusters?.flatMap((c) => c.rows) ?? [];
  const CLUSTER_EMOJIS = ["🟣", "🔵", "🟠", "🟤", "🩷", "🟡"];
  // Row highlight classes — bg, left-border, hover — parallel to CLUSTER_EMOJIS order.
  const CLUSTER_ROW_COLORS = [
    "bg-purple-950/25 border-l-purple-500 hover:bg-purple-950/45",  // 🟣 A
    "bg-blue-950/25   border-l-blue-500   hover:bg-blue-950/45",    // 🔵 B
    "bg-orange-950/25 border-l-orange-500 hover:bg-orange-950/45",  // 🟠 C
    "bg-amber-950/25  border-l-amber-700  hover:bg-amber-950/45",   // 🟤 D
    "bg-pink-950/25   border-l-pink-500   hover:bg-pink-950/45",    // 🩷 E
    "bg-yellow-950/25 border-l-yellow-500 hover:bg-yellow-950/45",  // 🟡 F
  ];
  const clusterBadgeMap = new Map<number, { label: string; emoji: string }>();
  const clusterColorMap = new Map<number, string>();
  (report?.clusters ?? []).forEach((c, idx) => {
    const emoji = CLUSTER_EMOJIS[idx % CLUSTER_EMOJIS.length];
    const letter = String.fromCharCode(65 + idx);
    const rowColor = CLUSTER_ROW_COLORS[idx % CLUSTER_ROW_COLORS.length];
    c.rows.forEach((rank) => {
      clusterBadgeMap.set(rank, { label: `Cluster ${letter}`, emoji });
      clusterColorMap.set(rank, rowColor);
    });
  });

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
          <div className="flex items-center gap-2 text-xs font-mono text-slate-400">
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
                         text-sm font-mono text-slate-100 placeholder:text-slate-400
                         focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            />
            <button
              onClick={startScan}
              disabled={status === "scanning" || !mint.trim()}
              className="px-6 py-3 rounded-lg font-mono font-semibold text-sm
                         bg-cyan-500 text-white font-bold hover:bg-cyan-400
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
          <p className="mt-3 text-xs text-slate-400 font-mono">
            Top {topN} holders · Chain depth {depth} · ~60–90s cold scan
          </p>
        </div>

        {/* ── Recent Scans ─────────────────────────────────────────────── */}
        <RecentScansPanel
          history={history}
          onSelect={restoreReport}
          onClear={clearHistory}
        />

        {/* ── Terminal Feed — visible only during an active scan ───────── */}
        {status === "scanning" && (
          <TerminalFeed events={events} isScanning={true} />
        )}

        {/* ── Results Dashboard ────────────────────────────────────────── */}
        {status === "complete" && report && (
          <div ref={resultsRef} className="space-y-6 animate-in fade-in duration-500">

            {/* Token identity header */}
            <div className="text-center">
              <div className="flex items-center justify-center gap-3">
                {/* Token logo */}
                <TokenLogo key={report.metadata?.logoUri ?? ""} uri={report.metadata?.logoUri ?? null} />
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
              </div>
              {(report.metadata?.name || report.metadata?.symbol) && (
                <p className="mt-1 text-xs font-mono text-slate-400 tracking-widest">
                  {report.mint.slice(0, 20)}…
                </p>
              )}

              {/* Market data — renders only when available, no layout shift */}
              {priceData && (
                priceData.price !== null ||
                priceData.marketCap !== null ||
                priceData.volume24h !== null
              ) && (
                <>
                  <div className="flex items-center justify-center gap-6 mt-4 flex-wrap">
                    {priceData.price !== null && (
                      <div className="text-center">
                        <p className="text-xs font-mono text-slate-500 tracking-widest mb-0.5">PRICE</p>
                        <p
                          key={`price-${priceData.price}-${priceFlash}`}
                          className={`text-sm font-mono font-semibold text-slate-200${priceFlash === "up" ? " price-flash-up" : priceFlash === "down" ? " price-flash-down" : ""}`}
                        >
                          {fmtPrice(priceData.price)}
                        </p>
                        {/* 24h sparkline mounted directly under the price value */}
                        {chartData != null && chartData.candles.length > 0 && (
                          <div className="mt-1.5 flex justify-center">
                            <PriceSparkline data={chartData} />
                          </div>
                        )}
                      </div>
                    )}
                    {priceData.marketCap !== null && (
                      <div className="text-center">
                        <p className="text-xs font-mono text-slate-500 tracking-widest mb-0.5">MARKET CAP</p>
                        <p
                          key={`mc-${priceData.marketCap}-${mcFlash}`}
                          className={`text-sm font-mono font-semibold text-slate-200${mcFlash === "up" ? " price-flash-up" : mcFlash === "down" ? " price-flash-down" : ""}`}
                        >
                          {fmtShortUsd(priceData.marketCap)}
                        </p>
                      </div>
                    )}
                    {priceData.volume24h !== null && (
                      <div className="text-center">
                        <p className="text-xs font-mono text-slate-500 tracking-widest mb-0.5">24H VOLUME</p>
                        <p className="text-sm font-mono font-semibold text-slate-200">
                          {fmtShortUsd(priceData.volume24h)}
                        </p>
                      </div>
                    )}
                  </div>
                  {priceUpdatedAt !== null && (
                    <p className="mt-2 text-[10px] font-mono text-slate-500 tracking-wider">
                      updated {fmtAgo(nowMs - priceUpdatedAt)}
                    </p>
                  )}
                </>
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
                  <p className="mt-4 text-xs text-slate-400 font-mono text-center">
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
                    {(() => {
                      const lp = report.contractSecurity.lp;
                      const safePct = (lp.burnedPct ?? 0) + (lp.lockedPct ?? 0);
                      // Prefer backend-computed lockedLiquidityUsd; fall back to
                      // deriving it client-side from liquidityUsd × safePct so that
                      // the "Locked Liquidity" row always appears when we have both
                      // the pool size and burn/lock percentage — regardless of whether
                      // the backend field made it through the cache/reference chain.
                      // PumpSwap pools are natively secured by the bonding curve —
                      // treat as 100% locked if the backend hasn't already set it.
                      const isPumpSwap = lp.poolType === "pumpswap";
                      const effectivePct = isPumpSwap ? 100 : safePct;
                      const lockedUsd: number | null =
                        lp.lockedLiquidityUsd != null
                          ? lp.lockedLiquidityUsd
                          : lp.liquidityUsd && effectivePct > 0
                            ? lp.liquidityUsd * (effectivePct / 100)
                            : null;
                      if (lockedUsd) {
                        return (
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-mono text-slate-400">Locked Liquidity</span>
                            <span className="text-xs font-mono font-semibold text-green-400">
                              ${lockedUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                              <span className="text-slate-500 font-normal ml-1">({safePct}% secured)</span>
                            </span>
                          </div>
                        );
                      }
                      if (lp.liquidityUsd) {
                        return (
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-mono text-slate-400">Total Liquidity</span>
                            <span className="text-xs font-mono text-slate-300">
                              ${lp.liquidityUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                              <span className="text-slate-500 font-normal ml-1">(lock unknown)</span>
                            </span>
                          </div>
                        );
                      }
                      return null;
                    })()}
                    {(() => {
                      const lp = report.contractSecurity.lp;
                      const burned = lp.burnedPct ?? 0;
                      const locked = lp.lockedPct ?? 0;
                      const hasAnalysis = ["burned","locked","partially_locked","unlocked"].includes(lp.status);
                      const fullyUnprotected = hasAnalysis && burned === 0 && locked === 0;
                      if (!hasAnalysis && burned === 0 && locked === 0) return null;
                      return (
                        <div className="border-t border-slate-800 pt-3 mt-3 space-y-2">
                          {burned > 0 && (
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-mono text-slate-400">LP Burned</span>
                              <span className={`text-xs font-mono font-semibold ${
                                burned >= 99 ? "text-green-400" : "text-yellow-400"
                              }`}>
                                {burned}%
                              </span>
                            </div>
                          )}
                          {locked > 0 && (
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-mono text-slate-400">
                                🔒 LP Locked
                                {lp.lockerName && (
                                  <span className="text-slate-500 ml-1">({lp.lockerName})</span>
                                )}
                              </span>
                              <span className="text-xs font-mono font-semibold text-blue-400">
                                {locked}%
                              </span>
                            </div>
                          )}
                          {fullyUnprotected && (
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-mono text-red-400">⚠️ LP Unlocked</span>
                              <span className="text-xs font-mono font-bold text-red-400">0% Protected</span>
                            </div>
                          )}
                        </div>
                      );
                    })()}
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

            {/* Audit Checklist — risk signals with severity icons + clean signals */}
            {(report.risk?.signals?.length > 0 || report.contractSecurity) && (
              <div className="rounded-xl border border-slate-800 bg-card p-5 shadow-lg">
                <p className="text-xs font-mono font-semibold text-muted-foreground tracking-widest mb-4">
                  AUDIT CHECKLIST
                </p>
                <div className="space-y-0">
                  {(report.risk?.signals ?? []).map((s, i) => {
                    const icon = s.severity === "critical" ? "🔴" : s.severity === "high" ? "🟠" : "🟡";
                    return (
                      <div key={i} className="flex items-start gap-2 py-1.5 border-b border-slate-800/60">
                        <span className="text-sm flex-shrink-0 mt-0.5">{icon}</span>
                        <span className="flex-1 text-xs font-mono text-slate-200 min-w-0">{s.label}</span>
                        <span className={`text-xs font-mono font-bold flex-shrink-0 ${
                          s.severity === "critical" ? "text-red-400" : s.severity === "high" ? "text-orange-400" : "text-yellow-400"
                        }`}>+{s.pts}</span>
                      </div>
                    );
                  })}
                  {!report.contractSecurity.mintUnrevoked && (
                    <div className="flex items-center gap-2 py-1.5 border-b border-slate-800/60">
                      <span className="text-sm">✅</span>
                      <span className="text-xs font-mono text-green-400">Mint Authority Revoked</span>
                    </div>
                  )}
                  {!report.contractSecurity.freezeUnrevoked && (
                    <div className="flex items-center gap-2 py-1.5 border-b border-slate-800/60">
                      <span className="text-sm">✅</span>
                      <span className="text-xs font-mono text-green-400">Freeze Authority Disabled</span>
                    </div>
                  )}
                  {(report.contractSecurity.lp?.status === "burned" ||
                    report.contractSecurity.lp?.status === "locked") && (
                    <div className="flex items-center gap-2 py-1.5 border-b border-slate-800/60">
                      <span className="text-sm">✅</span>
                      <span className="text-xs font-mono text-green-400">
                        {report.contractSecurity.lp.status === "locked"
                          ? `LP Tokens Locked${report.contractSecurity.lp.lockerName ? ` via ${report.contractSecurity.lp.lockerName}` : " (Secure Vault)"}`
                          : "LP Tokens Burned"}
                      </span>
                    </div>
                  )}
                  {(report.clusters?.length ?? 0) === 0 && (
                    <div className="flex items-center gap-2 py-1.5 border-b border-slate-800/60">
                      <span className="text-sm">✅</span>
                      <span className="text-xs font-mono text-green-400">No Funding Clusters Detected</span>
                    </div>
                  )}
                  {(report.snipers?.length ?? 0) === 0 && (
                    <div className="flex items-center gap-2 py-1.5">
                      <span className="text-sm">✅</span>
                      <span className="text-xs font-mono text-green-400">No Same-Block Snipers</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Creator Audit */}
            {report.creatorAudit?.address && (
              <div className="rounded-xl border border-slate-800 bg-card p-5 shadow-lg">
                <p className="text-xs font-mono font-semibold text-muted-foreground tracking-widest mb-4">
                  CREATOR AUDIT
                </p>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-slate-400">Creator Wallet</span>
                    <a
                      href={`https://solscan.io/account/${report.creatorAudit.address}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-mono text-slate-300 hover:text-cyan-400 transition-colors"
                    >
                      {shortAddr(report.creatorAudit.address)}
                    </a>
                  </div>
                  {report.creatorAudit.txCount !== null && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono text-slate-400">Lifetime Transactions</span>
                      <span className={`text-xs font-mono font-semibold tabular-nums ${
                        report.creatorAudit.isFresh ? "text-red-400" : "text-green-400"
                      }`}>
                        {report.creatorAudit.txCount >= 50
                          ? `${report.creatorAudit.txCount} +`
                          : report.creatorAudit.txCount}
                      </span>
                    </div>
                  )}
                  {report.creatorAudit.isFresh && (
                    <div className="flex items-center gap-2 bg-red-950/40 border border-red-800 rounded-lg px-3 py-2 mt-2">
                      <span className="flex-shrink-0">⚠️</span>
                      <span className="text-xs font-mono text-red-400 font-semibold tracking-wide">
                        Fresh Wallet — High Risk
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Bundled Supply Warning Banner */}
            {(report.clusters?.length ?? 0) > 0 && (() => {
              const totalPct = report.clusters.reduce((s, c) => s + c.pct, 0);
              const totalWallets = report.clusters.reduce((s, c) => s + c.rows.length, 0);
              return (
                <div className="rounded-xl border border-orange-700/60 bg-orange-950/30 p-4 flex items-center gap-3">
                  <span className="text-xl flex-shrink-0">⚠️</span>
                  <p className="text-sm font-mono font-semibold text-orange-300">
                    WARNING: Coordinated Bundles Control {totalPct.toFixed(1)}% of Supply across {totalWallets} wallets
                  </p>
                </div>
              );
            })()}

            {/* Holders Table */}
            {report.holders?.length > 0 && (() => {
              const sniperSet = new Set(report.snipers ?? []);
              const clusterSet = new Set(clusterRanks);
              return (
                <div className="rounded-xl border border-slate-800 bg-card overflow-hidden">
                  {/* Table header / legend */}
                  <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-foreground tracking-wide">
                      Top {topN} Holders
                    </h3>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <span className="text-red-400">🎯</span> Sniper
                      </span>
                      <span className="flex items-center gap-1">
                        <span>🟣</span> Cluster
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="text-cyan-400">⚡</span> Known entity
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="text-cyan-400">💧</span> Liquidity Pool
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="text-green-400">🔥</span> Burned/Locked
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="text-red-400">🚨</span> LP Holder
                      </span>
                      <span className="flex items-center gap-1">
                        <span>🐳</span> Whale
                      </span>
                    </div>
                  </div>

                  {/* Scrollable table */}
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
                        {report.holders.map((h) => {
                          const isSniper = sniperSet.has(h.rank);
                          const isCluster = clusterSet.has(h.rank);
                          const isFunderHighlighted =
                            !!hoveredParentWallet && h.funder === hoveredParentWallet;

                          const clusterRowColor = clusterColorMap.get(h.rank)
                            ?? "bg-yellow-950/20 border-l-yellow-500 hover:bg-yellow-950/40";
                          const rowCls = [
                            "border-b border-slate-800/60 transition-colors duration-150 cursor-default",
                            isFunderHighlighted
                              ? "bg-cyan-950/40 border-l-2 border-l-cyan-400"
                              : isSniper
                              ? "bg-red-950/30 border-l-2 border-l-red-500 hover:bg-red-950/50"
                              : isCluster
                              ? `border-l-2 ${clusterRowColor}`
                              : "border-l-2 border-l-transparent hover:bg-slate-800/40",
                          ].join(" ");

                          return (
                            <tr
                              key={h.rank}
                              className={rowCls}
                              onMouseEnter={
                                h.funder
                                  ? () => setHoveredParentWallet(h.funder)
                                  : undefined
                              }
                              onMouseLeave={() => setHoveredParentWallet(null)}
                            >
                              <td className="px-4 py-2.5 text-right text-slate-500">
                                {h.rank}
                              </td>
                              <td className="px-4 py-2.5 text-slate-300 whitespace-nowrap">
                                <a
                                  href={`https://solscan.io/account/${h.tokenAcct}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="hover:text-cyan-400 transition-colors"
                                >
                                  {shortAddr(h.tokenAcct)}
                                </a>
                              </td>
                              <td className="px-4 py-2.5 text-slate-300 whitespace-nowrap">
                                <a
                                  href={`https://solscan.io/account/${h.owner}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="hover:text-cyan-400 transition-colors"
                                >
                                  {shortAddr(h.owner)}
                                </a>
                              </td>
                              <td className="px-4 py-2.5 text-right text-slate-200">
                                {fmtTokenAmt(h.tokens)}
                              </td>
                              <td className="px-4 py-2.5 text-right">
                                <span
                                  className={
                                    h.pct >= 10
                                      ? "font-semibold text-red-400"
                                      : h.pct >= 5
                                      ? "font-semibold text-yellow-400"
                                      : "text-slate-300"
                                  }
                                >
                                  {h.pct.toFixed(1)}%
                                </span>
                              </td>
                              <td className="px-4 py-2.5 text-slate-400 whitespace-nowrap">
                                {h.buyTime ? fmtHolderTs(h.buyTime) : "—"}
                              </td>
                              <td className="px-4 py-2.5 text-slate-400 whitespace-nowrap">
                                {h.funder ? (
                                  <a
                                    href={`https://solscan.io/account/${h.funder}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="hover:text-cyan-400 transition-colors"
                                  >
                                    {h.funderLabel ?? shortAddr(h.funder)}
                                  </a>
                                ) : h.cexLabel ? (
                                  <span className="text-cyan-300 font-mono text-xs" title="Known institution">
                                    {h.cexLabel}
                                  </span>
                                ) : (
                                  "—"
                                )}
                              </td>
                              <td className="px-4 py-2.5 text-center">
                                <span className="flex items-center justify-center gap-0.5 flex-wrap">
                                  {isSniper && (
                                    <span title="Same-block sniper">🎯</span>
                                  )}
                                  {isCluster && (() => {
                                    const badge = clusterBadgeMap.get(h.rank);
                                    return badge ? (
                                      <span title={badge.label} className="text-xs whitespace-nowrap">{badge.emoji} {badge.label.split(" ")[1]}</span>
                                    ) : (
                                      <span title="Funding cluster">🟣</span>
                                    );
                                  })()}
                                  {!!h.funderLabel && (
                                    <span title={h.funderLabel ?? ""}>⚡</span>
                                  )}
                                  {h.isKnownEntity && (
                                    <span
                                      title={h.cexLabel ? `${h.cexLabel} — exchange custody` : "Known exchange wallet"}
                                      className="inline-flex items-center px-1 py-0.5 rounded text-[11px] bg-yellow-950 text-yellow-400 border border-yellow-800"
                                    >
                                      ⚡
                                    </span>
                                  )}
                                  {h.isLiquidityPool && (
                                    <span
                                      title="Liquidity Pool vault"
                                      className="inline-flex items-center px-1 py-0.5 rounded text-[11px] bg-cyan-950 text-cyan-300 border border-cyan-800"
                                    >
                                      💧
                                    </span>
                                  )}
                                  {h.isBurnedOrLocked && (
                                    <span
                                      title="Burned or locked tokens"
                                      className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-950 text-green-400 border border-green-800 whitespace-nowrap"
                                    >
                                      🔥 Burned/Locked
                                    </span>
                                  )}
                                  {h.isLpHolder && (
                                    <span
                                      title="Holds unlocked LP tokens — can rug pool"
                                      className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-950 text-red-400 border border-red-800 whitespace-nowrap"
                                    >
                                      🚨 LP Holder
                                    </span>
                                  )}
                                  {h.isWhale && (
                                    <span
                                      title="Whale — holds >5% of supply"
                                      className="inline-flex items-center px-1 py-0.5 rounded text-[11px] bg-blue-950 text-blue-400 border border-blue-900"
                                    >
                                      🐳
                                    </span>
                                  )}
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
            })()}

            {/* Scan Meta */}
            <div className="text-center text-xs font-mono text-slate-400 pb-4">
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
          <div className="text-center py-16 text-slate-400 font-mono text-sm space-y-2">
            <p className="text-4xl mb-4">🔍</p>
            <p>Enter a Solana mint address above to run a forensic scan.</p>
            <p className="text-xs text-slate-500">
              Checks mint/freeze authority · LP burn status · holder clusters · sniper wallets · funding chains
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
