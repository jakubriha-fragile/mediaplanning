"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Grafy přehledu — čisté SVG bez knihovny.
 *
 * Pravidla (viz dataviz): jedna osa y, tenké sloupce se zaobleným jen datovým
 * koncem, 2px mezera mezi segmenty, legenda vždy nad grafem, tooltip po najetí
 * na celý sloupec měsíce. Barvy jdou přes style, ne atribut fill — jen tak
 * v nich funguje var(--…) a s ní tmavý režim. Dál: a pod každým grafem přepínač na tabulku — barvy mají
 * proti bílé ploše kontrast pod 3:1, tabulka je proto povinná náhrada.
 */

export type Series = { key: string; label: string; color: string };
export type Bar = { label: string; values: Record<string, number> };

const H = 240;
const PAD = { top: 12, right: 12, bottom: 28, left: 56 };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(720);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Hezké kroky osy: 1, 2, 2,5, 5 × 10ⁿ. */
function ticks(max: number, n = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / n;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

/** Obdélník se zaobleným jen horním (datovým) koncem. */
function topRounded(x: number, y: number, w: number, h: number, r = 4) {
  if (h <= 0) return "";
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

export function Legend({ series, extra }: { series: Series[]; extra?: React.ReactNode }) {
  return (
    <div className="db-legend">
      {series.map((s) => (
        <span key={s.key}><i className="db-sw" style={{ background: s.color }} />{s.label}</span>
      ))}
      {extra}
    </div>
  );
}

/**
 * Skládané sloupce po měsících. `line` je volitelná druhá veličina ve STEJNÉ
 * jednotce (např. kumulativní zásah k měsíčnímu) — žádná druhá osa.
 */
export function StackedBars({
  bars, series, format, axisFormat, line, threshold, tooltipExtra, maxValue, caption, totalLabel = "Celkem",
}: {
  /** jak se jmenuje součet segmentů — u zásahu je to čistý zásah, ne „celkem" */
  totalLabel?: string;
  bars: Bar[];
  series: Series[];
  format: (v: number) => string;
  axisFormat?: (v: number) => string;
  line?: { label: string; values: number[] };
  threshold?: { value: number; label: string };
  tooltipExtra?: (i: number) => React.ReactNode;
  maxValue?: number;
  caption: string;
}) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);

  const totals = bars.map((b) => series.reduce((s, x) => s + (b.values[x.key] ?? 0), 0));
  const top = maxValue ?? Math.max(1, ...totals, ...(line?.values ?? []), threshold?.value ?? 0);
  const yt = maxValue ? [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxValue) : ticks(top);
  const yMax = yt[yt.length - 1];
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const band = iw / Math.max(1, bars.length);
  const bw = Math.min(44, band * 0.62);
  const y = (v: number) => PAD.top + ih - (v / yMax) * ih;
  const fmtAxis = axisFormat ?? format;

  return (
    <div className="db-chart" ref={ref}>
      <svg width={W} height={H} role="img" aria-label={caption}
        onMouseLeave={() => setHover(null)}>
        {yt.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className={t === 0 ? "db-base" : "db-grid"} />
            <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">{fmtAxis(t)}</text>
          </g>
        ))}
        {bars.map((b, i) => {
          const cx = PAD.left + band * i + band / 2;
          let acc = 0;
          const segs = series.map((s) => {
            const v = b.values[s.key] ?? 0;
            const y0 = y(acc), y1 = y(acc + v);
            acc += v;
            return { s, v, y0, y1 };
          }).filter((x) => x.v > 0);
          return (
            <g key={b.label}>
              {hover === i && <rect x={cx - band / 2} y={PAD.top} width={band} height={ih} className="db-hoverband" />}
              {segs.map((g, j) => {
                const isTop = j === segs.length - 1;
                // 2px mezera mezi segmenty — odečte se z horní hrany spodního segmentu
                const h = Math.max(0, g.y0 - g.y1 - (isTop ? 0 : 2));
                const yy = g.y1 + (isTop ? 0 : 2);
                return isTop
                  ? <path key={g.s.key} d={topRounded(cx - bw / 2, yy, bw, h)} style={{ fill: g.s.color }} />
                  : <rect key={g.s.key} x={cx - bw / 2} y={yy} width={bw} height={h} style={{ fill: g.s.color }} />;
              })}
              <text x={cx} y={H - 10} textAnchor="middle" className={hover === i ? "db-xlab on" : "db-xlab"}>{b.label}</text>
              <rect x={cx - band / 2} y={PAD.top} width={band} height={ih + PAD.bottom} fill="transparent"
                onMouseEnter={() => setHover(i)} />
            </g>
          );
        })}
        {threshold && threshold.value <= yMax && (
          <g>
            {/* popisek je v legendě — přímo v grafu se překrýval se sloupci */}
            <line x1={PAD.left} x2={W - PAD.right} y1={y(threshold.value)} y2={y(threshold.value)} className="db-threshold">
              <title>{threshold.label}</title>
            </line>
          </g>
        )}
        {line && (
          <g pointerEvents="none">
            <polyline className="db-line" fill="none"
              points={line.values.map((v, i) => `${PAD.left + band * i + band / 2},${y(v)}`).join(" ")} />
            {line.values.map((v, i) => (
              <circle key={i} cx={PAD.left + band * i + band / 2} cy={y(v)} r={hover === i ? 5 : 3.5} className="db-dot" />
            ))}
          </g>
        )}
      </svg>

      {hover !== null && (
        <div className="db-tip" style={{
          left: Math.min(W - 210, Math.max(0, PAD.left + band * hover + band / 2 + 14)),
          top: 8,
        }}>
          <b>{bars[hover].label}</b>
          {[...series].reverse().map((s) => (bars[hover].values[s.key] ?? 0) > 0 && (
            <div key={s.key}><i className="db-sw" style={{ background: s.color }} />{s.label}<span>{format(bars[hover].values[s.key])}</span></div>
          ))}
          {series.length > 1 && <div className="db-tip-sum">{totalLabel}<span>{format(totals[hover])}</span></div>}
          {line && <div><i className="db-sw db-sw-line" />{line.label}<span>{format(line.values[hover])}</span></div>}
          {tooltipExtra?.(hover)}
        </div>
      )}

      <button className="db-tablebtn" onClick={() => setTable((t) => !t)} aria-expanded={table}>
        {table ? "Skrýt tabulku" : "Zobrazit jako tabulku"}
      </button>
      {table && (
        <div className="db-tablewrap">
          <table className="db-table">
            <thead>
              <tr><th>Měsíc</th>{series.map((s) => <th key={s.key}>{s.label}</th>)}
                {series.length > 1 && <th>{totalLabel}</th>}{line && <th>{line.label}</th>}</tr>
            </thead>
            <tbody>
              {bars.map((b, i) => (
                <tr key={b.label}>
                  <td>{b.label}</td>
                  {series.map((s) => <td key={s.key}>{(b.values[s.key] ?? 0) ? format(b.values[s.key]) : "—"}</td>)}
                  {series.length > 1 && <td>{format(totals[i])}</td>}
                  {line && <td>{format(line.values[i])}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Zásah a frekvence pod sebou se SPOLEČNOU časovou osou. Nejde o dvě osy
 * v jednom grafu: jsou to dva grafy nad stejnými měsíci, každý se svou
 * jednotkou. Příběh plánu je obvykle „zásah stojí, roste jen frekvence"
 * a ten je vidět jen vedle sebe. Najetí myší zvýrazní měsíc v obou.
 */
export function ReachFrequency({
  labels, tv, inc, cum, freq, limit, formatPct, caption,
}: {
  labels: string[];
  tv: number[];
  inc: number[];
  cum: number[];
  freq: number[];
  limit: number;
  formatPct: (v: number) => string;
  caption: string;
}) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const RH = 150, FH = 150, GAP = 34, L = 48, R = 12, T = 8;
  const H = T + RH + GAP + FH + 6;
  const iw = W - L - R;
  const band = iw / Math.max(1, labels.length);
  const bw = Math.min(40, band * 0.58);
  const yR = (v: number) => T + RH - v * RH;
  const fMax = Math.max(limit * 1.5, ...freq) * 1.08;
  const fTicks = ticks(fMax, 3);
  const fTop = fTicks[fTicks.length - 1];
  const f0 = T + RH + GAP;
  const yF = (v: number) => f0 + FH - (v / fTop) * FH;
  const fmtF = (v: number) => (v ? v.toFixed(1).replace(".", ",") + "×" : "—");
  const lowBand = Math.min(3, limit);

  return (
    <div className="db-chart" ref={ref}>
      <svg width={W} height={H} role="img" aria-label={caption} onMouseLeave={() => setHover(null)}>
        {/* zásah */}
        {[0, 0.5, 1].map((t) => (
          <g key={`r${t}`}>
            <line x1={L} x2={W - R} y1={yR(t)} y2={yR(t)} className={t === 0 ? "db-base" : "db-grid"} />
            <text x={L - 8} y={yR(t)} dy="0.32em" textAnchor="end">{Math.round(t * 100)} %</text>
          </g>
        ))}
        {/* frekvence: pásmo rozumné frekvence a osa */}
        <rect x={L} width={iw} y={yF(limit)} height={yF(lowBand) - yF(limit)} className="db-band" />
        {fTicks.map((t) => (
          <g key={`f${t}`}>
            <line x1={L} x2={W - R} y1={yF(t)} y2={yF(t)} className={t === 0 ? "db-base" : "db-grid"} />
            <text x={L - 8} y={yF(t)} dy="0.32em" textAnchor="end">{Math.round(t)}×</text>
          </g>
        ))}
        <line x1={L} x2={W - R} y1={yF(limit)} y2={yF(limit)} className="db-threshold" />

        {labels.map((lab, i) => {
          const x = L + band * i + band / 2 - bw / 2;
          const tvH = tv[i] * RH, incH = inc[i] * RH;
          const f = freq[i], base = Math.min(f, limit);
          return (
            <g key={lab}>
              {hover === i && <rect x={L + band * i} y={T} width={band} height={H - T - 6} className="db-hoverband" />}
              {tvH > 0 && <path d={topRounded(x, yR(tv[i]) + (incH > 0 ? 2 : 0), bw, tvH - (incH > 0 ? 2 : 0))} style={{ fill: "var(--m-tv)" }} />}
              {incH > 0 && <path d={topRounded(x, yR(tv[i] + inc[i]), bw, incH)} style={{ fill: "var(--m-inc)" }} />}
              {f > 0 && <path d={topRounded(x, yF(base) + (f > limit ? 2 : 0), bw, yF(0) - yF(base) - (f > limit ? 2 : 0))} style={{ fill: "var(--m-tv)" }} />}
              {f > limit && <path d={topRounded(x, yF(f), bw, yF(limit) - yF(f))} style={{ fill: "var(--bad-pure)" }} />}
              {f > 0 && <text x={x + bw / 2} y={yF(f) - 6} textAnchor="middle" className="db-vlab">{fmtF(f)}</text>}
              <text x={x + bw / 2} y={T + RH + 20} textAnchor="middle" className={hover === i ? "db-xlab on" : "db-xlab"}>{lab}</text>
              <rect x={L + band * i} y={T} width={band} height={H - T} fill="transparent" onMouseEnter={() => setHover(i)} />
            </g>
          );
        })}
        <polyline className="db-line" fill="none" pointerEvents="none"
          points={cum.map((v, i) => `${L + band * i + band / 2},${yR(v)}`).join(" ")} />
      </svg>

      {hover !== null && (
        <div className="db-tip" style={{ left: Math.min(W - 220, Math.max(0, L + band * hover + band / 2 + 16)), top: 8 }}>
          <b>{labels[hover]}</b>
          <div><i className="db-sw" style={{ background: "var(--m-tv)" }} />Zasáhne TV<span>{formatPct(tv[hover])}</span></div>
          <div><i className="db-sw" style={{ background: "var(--m-inc)" }} />Navíc ostatní média<span>{formatPct(inc[hover])}</span></div>
          <div className="db-tip-sum">Zasáhne celkem<span>{formatPct(tv[hover] + inc[hover])}</span></div>
          <div><i className="db-sw db-sw-line" />Od začátku plánu<span>{formatPct(cum[hover])}</span></div>
          <div className="db-tip-sum">Uvidí v průměru<span>{fmtF(freq[hover])}</span></div>
        </div>
      )}

      <button className="db-tablebtn" onClick={() => setTable((t) => !t)} aria-expanded={table}>
        {table ? "Skrýt tabulku" : "Zobrazit jako tabulku"}
      </button>
      {table && (
        <div className="db-tablewrap">
          <table className="db-table">
            <thead><tr><th>Měsíc</th><th>Zasáhne TV</th><th>Navíc ostatní</th><th>Celkem</th><th>Od začátku</th><th>Frekvence</th></tr></thead>
            <tbody>
              {labels.map((l, i) => (
                <tr key={l}><td>{l}</td><td>{formatPct(tv[i])}</td><td>{formatPct(inc[i])}</td>
                  <td>{formatPct(tv[i] + inc[i])}</td><td>{formatPct(cum[i])}</td><td>{fmtF(freq[i])}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
