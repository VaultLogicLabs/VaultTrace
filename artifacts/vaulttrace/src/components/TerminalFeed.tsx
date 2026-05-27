import { useEffect, useRef } from "react";

export type ScanEvent =
  | { type: "section"; label: string }
  | { type: "progress"; message: string }
  | { type: "holder"; rank: number; total: number; address: string }
  | { type: "complete"; report: unknown }
  | { type: "error"; message: string };

interface TerminalFeedProps {
  events: ScanEvent[];
  isScanning: boolean;
}

function EventLine({ ev }: { ev: ScanEvent }) {
  if (ev.type === "section") {
    const raw = ev.label.replace(/^\d+ \/ \d+\s*[—–]\s*/i, "");
    return (
      <div className="mt-2 first:mt-0">
        <span className="text-cyan-400 font-mono text-xs font-semibold tracking-widest">
          ── {raw.toUpperCase()} ─────────────────────────────
        </span>
      </div>
    );
  }
  if (ev.type === "holder") {
    return (
      <div className="flex items-center gap-2 text-slate-500 font-mono text-xs">
        <span className="text-slate-600">  ⟳</span>
        <span>
          Holder{" "}
          <span className="text-slate-400">
            {ev.rank}/{ev.total}
          </span>{" "}
          — {ev.address}
          <span className="inline-flex w-1 h-3 ml-1 bg-cyan-500 animate-pulse rounded-sm" />
        </span>
      </div>
    );
  }
  if (ev.type === "progress") {
    return (
      <div className="flex items-center gap-2 text-slate-400 font-mono text-xs">
        <span className="text-slate-500">  ⟳</span>
        <span>{ev.message}</span>
        <span className="inline-flex w-1 h-3 bg-cyan-500 animate-pulse rounded-sm" />
      </div>
    );
  }
  if (ev.type === "complete") {
    return (
      <div className="mt-2 text-green-400 font-mono text-xs font-semibold">
        ✓ SCAN COMPLETE
      </div>
    );
  }
  if (ev.type === "error") {
    return (
      <div className="mt-2 text-red-400 font-mono text-xs font-semibold">
        ✗ ERROR: {ev.message}
      </div>
    );
  }
  return null;
}

export function TerminalFeed({ events, isScanning }: TerminalFeedProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  return (
    <div className="relative rounded-xl border border-slate-800 bg-[#080c14] overflow-hidden shadow-2xl">
      {/* Terminal header bar */}
      <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-slate-800 bg-slate-900/60">
        <span className="w-3 h-3 rounded-full bg-red-500/70" />
        <span className="w-3 h-3 rounded-full bg-yellow-500/70" />
        <span className="w-3 h-3 rounded-full bg-green-500/70" />
        <span className="ml-2 text-slate-500 font-mono text-xs">vaulttrace — forensic scan</span>
        {isScanning && (
          <span className="ml-auto flex items-center gap-1 text-cyan-400 font-mono text-xs">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
            SCANNING
          </span>
        )}
      </div>
      {/* Terminal body */}
      <div className="h-72 overflow-y-auto p-4 space-y-0.5 font-mono text-xs">
        {events.length === 0 ? (
          <div className="text-slate-600">
            <span className="text-cyan-500">$</span> awaiting scan target...
          </div>
        ) : (
          events.map((ev, i) => <EventLine key={i} ev={ev} />)
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
