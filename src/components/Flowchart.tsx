"use client";

import { useMemo, useState } from "react";
import type { ChannelType } from "@/db/schema";
import type { PlanRow } from "@/components/PlanTable";
import { costKind } from "@/lib/costKind";

/** Týden období plánu: dny po měsících (týden přes přelom se dělí podle dnů). */
export type FlowWeek = { key: string; label: string; title: string; parts: Array<{ month: string; days: number }> };

// Pořadí a barvy nosičů jako v Přehledu (validovaná paleta --m-*, invariant 10)
const TYPE_ORDER: ChannelType[] = ["TV", "Rádio", "Digital", "OOH", "Print", "Kino", "Vlastní", "PR"];
const TYPE_LABEL: Partial<Record<ChannelType, string>> = { Digital: "Digitál" };
const TYPE_COLOR: Partial<Record<ChannelType, string>> = {
  TV: "var(--m-tv)", Digital: "var(--m-digital)", Rádio: "var(--m-radio)", OOH: "var(--m-ooh)",
};
const AGENCY = "__agency";

const daysIn = (m: string) => { const [y, mo] = m.split("-").map(Number); return new Date(Date.UTC(y, mo, 0)).getUTCDate(); };
const kc = (v: number) => Math.round(v).toLocaleString("cs-CZ");

/**
 * Flowchart: co kdy běží a za kolik. Jen čtení — počítá se z rozpočtů plánu,
 * nic se tu nezadává (jedno místo, kde se plánuje, zůstává tabulka).
 * Sloupce jsou vždy týdny: měsíční plán se do týdnů rozloží podle dnů, týdenní
 * ukáže skutečné týdny. Sytost pruhu = Kč v týdnu vůči nejsilnějšímu týdnu plánu.
 */
export function Flowchart({ rows, weeks, monthLabels, weekly, onOpen }: {
  rows: PlanRow[];
  weeks: FlowWeek[];
  monthLabels: Record<string, string>;
  /** plán po týdnech — hodnoty z týdnů, ne rozložením měsíců */
  weekly: boolean;
  /** klik na řádek: otevřít ho v tabulce */
  onOpen: (id: string) => void;
}) {
  const [by, setBy] = useState<"media" | "msg">("media");
  /** čísla v pruzích: rozpočet v tisících Kč, nebo podíl na rozpočtu výběru */
  const [unit, setUnit] = useState<"kc" | "pct">("kc");

  const valueOf = useMemo(() => {
    const cache = new Map<string, number[]>();
    for (const r of rows) {
      cache.set(r.id, weeks.map((w) => weekly
        ? r.weekCells?.[w.key]?.budget ?? 0
        : w.parts.reduce((s, p) => s + (r.budgets[p.month] ?? 0) * p.days / daysIn(p.month), 0)));
    }
    return cache;
  }, [rows, weeks, weekly]);

  const live = rows.filter((r) => valueOf.get(r.id)!.some((v) => v > 0));
  const max = Math.max(1, ...live.flatMap((r) => valueOf.get(r.id)!));
  const typeKey = (r: PlanRow) => (costKind(r.channel) === "media" ? r.channelType : AGENCY);
  const typeIdx = (r: PlanRow) => { const k = typeKey(r); return k === AGENCY ? 99 : TYPE_ORDER.indexOf(k as ChannelType); };

  const groups: Array<{ key: string; label: string; rows: PlanRow[] }> = [];
  if (by === "media") {
    for (const r of [...live].sort((a, b) => typeIdx(a) - typeIdx(b))) {
      const k = typeKey(r);
      let g = groups.find((x) => x.key === k);
      if (!g) groups.push(g = { key: k, label: k === AGENCY ? "Agenturní práce a ostatní" : TYPE_LABEL[k as ChannelType] ?? k, rows: [] });
      g.rows.push(r);
    }
  } else {
    for (const r of live) {
      let g = groups.find((x) => x.key === r.messageLineId);
      if (!g) groups.push(g = { key: r.messageLineId, label: `${r.code} · ${r.message}`, rows: [] });
      g.rows.push(r);
    }
    for (const g of groups) g.rows.sort((a, b) => typeIdx(a) - typeIdx(b));
  }

  // měsíc v hlavičce = měsíc, do kterého týden zasahuje víc dny
  const homeOf = (w: FlowWeek) => [...w.parts].sort((a, b) => b.days - a.days)[0]?.month ?? "";
  const monthSpans: Array<{ month: string; n: number }> = [];
  for (const w of weeks) {
    const m = homeOf(w);
    const last = monthSpans[monthSpans.length - 1];
    if (last?.month === m) last.n++; else monthSpans.push({ month: m, n: 1 });
  }
  const isStart = (i: number) => i === 0 || homeOf(weeks[i]) !== homeOf(weeks[i - 1]);

  const sumOf = (rs: PlanRow[]) => weeks.map((_, i) => rs.reduce((s, r) => s + valueOf.get(r.id)![i], 0));
  const total = (v: number[]) => v.reduce((a, b) => a + b, 0);
  const colorOf = (r: PlanRow) => (typeKey(r) === AGENCY ? "var(--m-other)" : TYPE_COLOR[r.channelType] ?? "var(--m-other)");
  // sytost: odmocnina, aby slabé týdny vedle TV nezmizely
  const shade = (v: number) => Math.round(25 + 75 * Math.sqrt(v / max));

  const grand = live.reduce((s, r) => s + total(valueOf.get(r.id)!), 0) || 1;
  // vždy rozpočet: tisíce Kč (zaokrouhleno), nebo % z rozpočtu výběru
  const fmt = (v: number) => {
    if (!v) return "";
    if (unit === "kc") return Math.max(1, Math.round(v / 1000)).toLocaleString("cs-CZ");
    const p = (v / grand) * 100;
    return p < 0.1 ? "<0,1" : p.toLocaleString("cs-CZ", { maximumFractionDigits: p < 10 ? 1 : 0 });
  };
  const unitLabel = unit === "kc" ? "Rozpočet v tis. Kč" : "Rozpočet v % z celku";
  const sumCells = (v: number[]) => v.map((x, i) => <td key={i} className={`fc-num ${isStart(i) ? "fc-ms" : ""}`} title={x ? `${weeks[i].label} (${weeks[i].title}) · rozpočet ${kc(x)} Kč` : undefined}>{fmt(x)}</td>);

  return (
    <div className="flowchart">
      <div className="fc-bar noprint">
        <span className="share">Seskupit</span>
        <div className="seg" role="radiogroup" aria-label="Seskupení flowchartu">
          <button type="button" role="radio" aria-checked={by === "media"} className={by === "media" ? "on" : ""} onClick={() => setBy("media")}>Podle médií</button>
          <button type="button" role="radio" aria-checked={by === "msg"} className={by === "msg" ? "on" : ""} onClick={() => setBy("msg")}>Sdělení → média</button>
        </div>
        <span className="fc-legend">
          {TYPE_ORDER.filter((t) => TYPE_COLOR[t] && live.some((r) => typeKey(r) === t)).map((t) => (
            <span key={t}><i style={{ background: TYPE_COLOR[t] }} />{TYPE_LABEL[t] ?? t}</span>
          ))}
          <span className="share">čísla = rozpočet v týdnu · sytější = víc peněz · klik otevře řádek v tabulce</span>
        </span>
        <span className="spacer" />
        <span className="share">Rozpočet v</span>
        <div className="seg" role="radiogroup" aria-label="Jednotka rozpočtu">
          <button type="button" role="radio" aria-checked={unit === "kc"} className={unit === "kc" ? "on" : ""} onClick={() => setUnit("kc")}>tis. Kč</button>
          <button type="button" role="radio" aria-checked={unit === "pct"} className={unit === "pct" ? "on" : ""} onClick={() => setUnit("pct")}>%</button>
        </div>
        <button className="btn" onClick={() => window.print()}>Tisk / PDF</button>
      </div>

      <div className="scroll">
        <table className="fc">
          <thead>
            <tr>
              <th className="fc-lab fc-unit">{unitLabel}</th>
              {monthSpans.map((m, i) => <th key={i} colSpan={m.n} className="fc-month fc-ms">{monthLabels[m.month] ?? m.month}</th>)}
              <th className="fc-tot">Rozpočet celkem</th>
            </tr>
            <tr>
              <th className="fc-lab share">týden</th>
              {weeks.map((w, i) => <th key={w.key} className={`fc-wk ${isStart(i) ? "fc-ms" : ""}`} title={w.title}>{w.label.replace(/^T/, "")}</th>)}
              <th />
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const gs = sumOf(g.rows);
              return [
                <tr key={g.key} className="fc-group">
                  <td className="fc-lab">{g.label}</td>
                  {sumCells(gs)}
                  <td className="fc-tot">{unit === "kc" ? `${kc(total(gs))} Kč` : `${fmt(total(gs))} %`}</td>
                </tr>,
                ...g.rows.map((r) => {
                  const v = valueOf.get(r.id)!;
                  return (
                    <tr key={r.id} className="fc-row" onClick={() => onOpen(r.id)} title="Otevřít řádek v tabulce">
                      <td className="fc-lab">
                        <span className="fc-name">{r.name}</span>
                        {by === "media"
                          ? <span className="fc-tag" title={`${r.code} · ${r.campaign}`}>#{r.message}</span>
                          : <span className="fc-tag">{typeKey(r) === AGENCY ? "ag. práce" : TYPE_LABEL[r.channelType] ?? r.channelType}</span>}
                      </td>
                      {v.map((x, i) => (
                        <td key={i} className={isStart(i) ? "fc-ms" : ""}>
                          {x > 0 && (
                            <div className="fc-cell" title={`${r.name} · ${weeks[i].label} (${weeks[i].title}) · #${r.message} · rozpočet ${kc(x)} Kč`}
                              style={{ background: `color-mix(in srgb, ${colorOf(r)} ${shade(x)}%, transparent)`, color: shade(x) > 65 ? "#fff" : "var(--ink)" }}>
                              {fmt(x)}
                            </div>
                          )}
                        </td>
                      ))}
                      <td className="fc-tot">{unit === "kc" ? `${kc(total(v))} Kč` : `${fmt(total(v))} %`}</td>
                    </tr>
                  );
                }),
              ];
            })}
            {!groups.length && (
              <tr><td colSpan={weeks.length + 2} className="share" style={{ padding: 24, textAlign: "center" }}>Ve výběru nejsou žádné řádky s rozpočtem.</td></tr>
            )}
          </tbody>
          <tfoot>
            {(() => {
              const s = sumOf(live);
              return (
                <tr>
                  <td className="fc-lab">Celkem · {unitLabel}</td>
                  {sumCells(s)}
                  <td className="fc-tot">{kc(total(s))} Kč</td>
                </tr>
              );
            })()}
          </tfoot>
        </table>
      </div>
      {!weekly && (
        <div className="note">
          Plán je po měsících — rozpočet měsíce je do týdnů rozložený rovnoměrně podle dnů (týden přes přelom se dělí).
          Skutečné rozložení do týdnů ukáže plán po týdnech (Nastavení plánu). Částky jsou pracovní podklad.
        </div>
      )}
    </div>
  );
}
