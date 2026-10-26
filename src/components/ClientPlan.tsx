"use client";

import { Fragment, useState } from "react";
import { kc } from "@/lib/period";

export type ClientPlanRow = {
  id: string;
  /** krátký název; plný je v `full` */
  name: string;
  full: string;
  block: string;
  channelType: string;
  online: boolean;
  budgets: Record<string, number>;
};

const CH_LABEL: Record<string, string> = { Digital: "Online", OOH: "OOH" };

/**
 * Plán, jak ho čte klient: položky, měsíce, částky. Nic se tu nezadává
 * (od toho je K vyplnění), takže žádná pole, filtry ani agenturní kódy —
 * jen tabulka, kterou jde přečíst bez výkladu.
 */
export function ClientPlan({ rows, months, monthLabels }: {
  rows: ClientPlanRow[];
  months: string[];
  monthLabels: Record<string, string>;
}) {
  const [group, setGroup] = useState<"all" | "offline" | "online">("all");
  const [q, setQ] = useState("");
  const hasBoth = rows.some((r) => r.online) && rows.some((r) => !r.online);
  const shown = rows.filter((r) =>
    (group === "all" || (group === "online") === r.online) &&
    (!q || `${r.name} ${r.full} ${r.block}`.toLowerCase().includes(q.toLowerCase())));
  const blocks = [...new Set(shown.map((r) => r.block))];
  const total = (r: ClientPlanRow) => months.reduce((s, m) => s + (r.budgets[m] ?? 0), 0);
  const max = Math.max(1, ...shown.flatMap((r) => months.map((m) => r.budgets[m] ?? 0)));
  const sum = shown.reduce((s, r) => s + total(r), 0);

  return (
    <div className="panel" style={{ borderRadius: "var(--radius)" }}>
      <div className="toolbar">
        {hasBoth && (
          <div className="seg">
            {(["all", "offline", "online"] as const).map((g) => (
              <button key={g} className={group === g ? "on" : ""} onClick={() => setGroup(g)}>
                {g === "all" ? "Vše" : g === "offline" ? "Offline" : "Online"}
              </button>
            ))}
          </div>
        )}
        {rows.length > 12 && (
          <input className="access-select" style={{ minWidth: 200 }} placeholder="Hledat položku…" value={q} onChange={(e) => setQ(e.target.value)} />
        )}
        <span className="spacer" />
        <span className="share">{shown.length} {shown.length === 1 ? "položka" : shown.length < 5 ? "položky" : "položek"} · {kc(sum)} Kč</span>
      </div>
      <div className="scroll">
        <table className="cplan">
          <thead>
            <tr>
              <th className="cplan-name">Položka</th>
              <th>Médium</th>
              {months.map((m) => <th key={m} className="r">{monthLabels[m]}</th>)}
              <th className="r">Celkem (Kč)</th>
            </tr>
          </thead>
          <tbody>
            {blocks.map((b) => {
              const list = shown.filter((r) => r.block === b);
              return (
                <Fragment key={b}>
                  <tr className="grp">
                    <td className="cplan-name">{b}</td>
                    <td />
                    {months.map((m) => {
                      const v = list.reduce((s, r) => s + (r.budgets[m] ?? 0), 0);
                      return <td key={m} className="r num share">{v ? kc(v) : ""}</td>;
                    })}
                    <td className="r num">{kc(list.reduce((s, r) => s + total(r), 0))}</td>
                  </tr>
                  {list.map((r) => (
                    <tr key={r.id}>
                      <td className="cplan-name" title={r.full !== r.name ? r.full : undefined}>{r.name}</td>
                      <td><span className={`pill ${r.online ? "s-ok" : "ph"}`}>{CH_LABEL[r.channelType] ?? r.channelType}</span></td>
                      {months.map((m) => {
                        const v = r.budgets[m] ?? 0;
                        return (
                          <td key={m} className="r num cplan-cell"
                            style={v ? { background: `color-mix(in srgb, var(--brand-soft) ${Math.round(25 + 75 * (v / max))}%, transparent)` } : undefined}>
                            {v ? kc(v) : ""}
                          </td>
                        );
                      })}
                      <td className="r num"><b style={{ fontWeight: 500 }}>{kc(total(r))}</b></td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
            {!shown.length && (
              <tr><td colSpan={months.length + 3} style={{ padding: 22, textAlign: "center", color: "var(--muted)" }}>Nic nenalezeno.</td></tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td className="cplan-name">Celkem</td>
              <td />
              {months.map((m) => {
                const v = shown.reduce((s, r) => s + (r.budgets[m] ?? 0), 0);
                return <td key={m} className="r num">{v ? kc(v) : ""}</td>;
              })}
              <td className="r num">{kc(sum)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="note">Částky v Kč vč. agenturního fee. Odstín buňky = výše rozpočtu v měsíci.</div>
    </div>
  );
}
