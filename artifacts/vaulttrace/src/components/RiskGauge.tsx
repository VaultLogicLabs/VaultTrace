interface RiskGaugeProps {
  score: number;
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, startAngle: number, sweepDeg: number) {
  if (sweepDeg <= 0) return "";
  const s = polarToCartesian(cx, cy, r, startAngle);
  const e = polarToCartesian(cx, cy, r, startAngle + sweepDeg);
  const largeArc = sweepDeg > 180 ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

const GAUGE_START = 135;
const GAUGE_SWEEP = 270;
const CX = 100;
const CY = 100;
const R = 72;

function scoreColor(score: number) {
  if (score >= 75) return "#ef4444";
  if (score >= 50) return "#f97316";
  if (score >= 25) return "#eab308";
  return "#22c55e";
}

function riskLabel(score: number) {
  if (score >= 75) return "VERY HIGH";
  if (score >= 50) return "HIGH";
  if (score >= 25) return "MODERATE";
  return "LOW";
}

export function RiskGauge({ score }: RiskGaugeProps) {
  const clampedScore = Math.max(0, Math.min(100, score));
  const scoreSweep = (clampedScore / 100) * GAUGE_SWEEP;
  const color = scoreColor(clampedScore);
  const label = riskLabel(clampedScore);

  const bgPath = arcPath(CX, CY, R, GAUGE_START, GAUGE_SWEEP);
  const fgPath = arcPath(CX, CY, R, GAUGE_START, scoreSweep);

  return (
    <div className="flex flex-col items-center gap-2">
      <svg viewBox="0 0 200 190" className="w-52 h-44">
        {/* Tick marks */}
        {[0, 25, 50, 75, 100].map((tick) => {
          const angle = GAUGE_START + (tick / 100) * GAUGE_SWEEP;
          const inner = polarToCartesian(CX, CY, R - 10, angle);
          const outer = polarToCartesian(CX, CY, R + 4, angle);
          return (
            <line
              key={tick}
              x1={inner.x.toFixed(2)} y1={inner.y.toFixed(2)}
              x2={outer.x.toFixed(2)} y2={outer.y.toFixed(2)}
              stroke="#334155" strokeWidth={2}
            />
          );
        })}
        {/* Background track */}
        <path d={bgPath} fill="none" stroke="#1e293b" strokeWidth={14} strokeLinecap="round" />
        {/* Score arc */}
        {clampedScore > 0 && (
          <path
            d={fgPath}
            fill="none"
            stroke={color}
            strokeWidth={14}
            strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 6px ${color}88)` }}
          />
        )}
        {/* Needle dot at score position */}
        {clampedScore > 0 && (
          <circle
            cx={polarToCartesian(CX, CY, R, GAUGE_START + scoreSweep).x.toFixed(2)}
            cy={polarToCartesian(CX, CY, R, GAUGE_START + scoreSweep).y.toFixed(2)}
            r={7}
            fill={color}
            style={{ filter: `drop-shadow(0 0 8px ${color})` }}
          />
        )}
        {/* Score number */}
        <text
          x={CX} y={CY + 6}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="white"
          fontSize={38}
          fontWeight="bold"
          fontFamily="monospace"
          letterSpacing="-1"
        >
          {clampedScore}
        </text>
        <text x={CX} y={CY + 32} textAnchor="middle" fill="#64748b" fontSize={10} fontFamily="monospace">
          / 100
        </text>
      </svg>
      <div className="text-center">
        <span
          className="text-sm font-bold tracking-widest font-mono px-3 py-1 rounded-full border"
          style={{ color, borderColor: `${color}44`, backgroundColor: `${color}15` }}
        >
          {label} RISK
        </span>
      </div>
    </div>
  );
}
