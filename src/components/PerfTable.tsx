"use client";

import { useMemo, useState, useTransition } from "react";
import { setActualSpend, setMetricActual, setAccountNote } from "@/lib/actions";
import { verdictFor, monthState, elapsed, type Verdict } from "@/lib/pacing";

export type PerfMetric = {
  id: string;
  name: string;
  kind: "cumulative" | "rate_low" | "rate_high";
  unit: string;
  target: Record<string, number>;
  actual: Record<string, number>;
};

export type PerfRow = {
  id: string;
  channel: string;
  mediaType: "Paid" | "Owned" | "Earned";
  campaign: string;
  code: string;
  message: string;
  audience: string;
  editable: Record<string, boolean>;
  budget: Record<string, number>;
  spend: Record<string, number>;
  note: Record<string, string>;
  metrics: PerfMetric[];
};

const kc = (n: number) => Math.round(n).toLocaleString("cs-CZ");
const num = (n: number) =>
  !n ? "" : Math.abs(n) >= 1000 ? kc(n) : String(Math.round(n * 100) / 100).replace(".", ",");
const pct0 = (n: number) => Math.round(n * 100) + " %";
const parseInt_ = (s: string) => Number(String(s).replace(/\s/g, "").replace(/[^\d]/g, "")) || 0;
const parseF = (s: string) => Number(String(s).replace(/\s/g, "").replace(",", ".").replace(/[^\d.]/g, "")) || 0;
const GLYPH: Record<string, string> = { ok: "✓", warn: "!", bad: "▲", idle: "·" };

const KIND_LABEL: Record<string, string> = {
  cumulative: "kumulativní",
  rate_low: "nižší = lépe",
  rate_high: "vyšší = lépe",
};

export function PerfTable({
  rows, months, monthLabels,
}: { rows: PerfRow[]; months: string[]; monthLabels: Record<string, string> }) {
  const [data, setData] = useState(rows);
  const [sel, setSel] = useState<string>("all");
  const [onlyAlert, setOnlyAlert] = useState(false);
  const [asOf, setAsOf] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const now = useMemo(() => (asOf ? new Date(asOf + "T12:00:00") : new Date()), [asOf]);
  const active = sel === "all" ? months : [sel];

  const budgetVerdict = (r: PerfRow): Verdict & { plan: number; actual: number } =>
    verdictFor("cumulative", active.map((m) => ({ month: m, target: r.budget[m], actual: r.spend[m], spend: r.spend[m] })), now) as never;

  const metricVerdict = (r: PerfRow, mt: PerfMetric) =>
    verdictFor(mt.kind, active.map((m) => ({ month: m, target: mt.target[m], actual: mt.actual[m], spend: r.spend[m] })), now);

  const isAlert = (r: PerfRow) =>
    budgetVerdict(r).status === "bad" || r.metrics.some((mt) => metricVerdict(r, mt).status === "bad");

  const visible = data
    .filter((r) => active.some((m) => r.budget[m] > 0 || r.spend[m] > 0))
    .filter((r) => (onlyAlert ? isAlert(r) : true));

  const planSum = data.reduce((s, r) => s + active.reduce((a, m) => a + r.budget[m], 0), 0);
  const actSum = data.reduce((s, r) => s + active.reduce((a, m) => a + r.spend[m], 0), 0);
  const expSum = data.reduce((s, r) => s + active.reduce((a, m) => a + r.budget[m] * elapsed(m, now), 0), 0);

  function save<T>(optimistic: () => void, rollback: () => void, run: () => Promise<{ ok: boolean; error?: string }>) {
    optimistic();
    startTransition(async () => {
      const res = await run();
      if (!res.ok) { rollback(); setError(res.error ?? "Uložení se nezdařilo."); }
      else setError(null);
    });
  }

  const single = active.length === 1 ? active[0] : null;

  return (
    <div className="panel">
      <div className="toolbar">
        <span className="share">Měsíc</span>
        {[{ k: "all", l: "Q4 celkem" }, ...months.map((m) => ({ k: m, l: monthLabels[m] ?? m }))].map((o) => (
          <button key={o.k} className="btn" aria-pressed={sel === o.k}
            style={{ borderRadius: 999, ...(sel === o.k ? { borderColor: "var(--brand)", color: "var(--brand-ink)", fontWeight: 500 } : { color: "var(--muted)" }) }}
            onClick={() => setSel(o.k)}>{o.l}</button>
        ))}
        {single && (
          <span className={`pill ${monthState(single, now) === "live" ? "s-ok" : "s-idle"}`}>
            {monthState(single, now) === "before" ? "nezahájeno"
              : monthState(single, now) === "after" ? "uzavřeno"
              : `běží · uplynulo ${pct0(elapsed(single, now))}`}
          </span>
        )}
        <span className="share">Stav k datu</span>
        <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)}
          style={{ font: "inherit", fontSize: 12, padding: "4px 8px", border: "1px solid var(--line-strong)", borderRadius: 4, background: "var(--surface)", color: "var(--ink)" }} />
        <button className="btn" onClick={() => setAsOf("")}>dnes</button>
        <button className="btn" aria-pressed={onlyAlert} style={{ borderRadius: 999, ...(onlyAlert ? { borderColor: "var(--bad)", color: "var(--bad)" } : {}) }}
          onClick={() => setOnlyAlert((v) => !v)}>jen ve skluzu</button>
        <span className="spacer" />
        <span className="share">
          plán {kc(planSum)} · čerpáno {kc(actSum)}
          {expSum > 0 ? ` · ${pct0(actSum / expSum)} očekávání` : ""}
          {pending ? " · ukládám…" : ""}
        </span>
      </div>

      {error && <div className="banner" style={{ margin: 0, borderRadius: 0 }}><span><b>Zápis odmítnut.</b> {error}</span></div>}

      {!single && (
        <div className="note" style={{ borderTop: "none", borderBottom: "1px solid var(--line)" }}>
          Souhrn za celé Q4 — skutečnost se zadává po měsících, přepněte na konkrétní měsíc.
          Poměrové ukazatele nejde sčítat, proto se zobrazují jako průměr vážený skutečným čerpáním měsíce.
        </div>
      )}

      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Taktika</th><th>Ukazatel</th><th className="r">Plán / cíl</th>
              <th className="r">Skutečnost</th><th>Průběh</th><th>Stav</th><th>Poznámka accountu</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const bv = budgetVerdict(r);
              const rowSpan = 1 + r.metrics.length;
              const canEdit = single ? r.editable[single] : false;
              return (
                <>
                  <tr key={r.id} style={{ borderTop: "2px solid var(--line-strong)" }}>
                    <td rowSpan={rowSpan} style={{ verticalAlign: "top", paddingTop: 9, maxWidth: 210 }}>
                      <div className="share">{r.campaign}</div>
                      <b>{r.channel}</b> <span className={`pill ${r.mediaType}`}>{r.mediaType}</span>
                      <div className="share">{r.code} · {r.message}</div>
                      <div className="share">{r.audience}</div>
                    </td>
                    <td style={{ background: "var(--surface-2)" }}>
                      <b>Rozpočet</b> <span className="share">(Kč, kumulativní)</span>
                    </td>
                    <td className="r num">{kc(bv.plan)}</td>
                    <td style={{ width: 120 }}>
                      {single ? (
                        <input className="cell" inputMode="numeric" disabled={!canEdit}
                          title={!canEdit ? "K tomuto čerpání nemáte oprávnění" : undefined}
                          defaultValue={r.spend[single] ? kc(r.spend[single]) : ""}
                          placeholder="0"
                          onBlur={(e) => {
                            const v = parseInt_(e.target.value);
                            const prev = r.spend[single];
                            if (v === prev) return;
                            save(
                              () => setData((d) => d.map((x) => x.id === r.id ? { ...x, spend: { ...x.spend, [single]: v } } : x)),
                              () => { setData((d) => d.map((x) => x.id === r.id ? { ...x, spend: { ...x.spend, [single]: prev } } : x)); e.target.value = prev ? kc(prev) : ""; },
                              () => setActualSpend({ tacticId: r.id, month: single, amount: v }),
                            );
                          }} />
                      ) : <span className="num">{kc(bv.actual)}</span>}
                    </td>
                    <td style={{ width: 120 }}>
                      <Meter v={bv} plan={bv.plan} />
                      <div className="share">
                        {bv.plan ? pct0(bv.actual / bv.plan) : "—"} plánu
                        {bv.expected > 0 ? ` · čekáno ${kc(bv.expected)}` : ""}
                      </div>
                    </td>
                    <td><Pill v={bv} /></td>
                    <td rowSpan={rowSpan} style={{ verticalAlign: "top", paddingTop: 9, minWidth: 160 }}>
                      {single ? (
                        <input className="txt" disabled={!canEdit} placeholder="poznámka accountu"
                          defaultValue={r.note[single]}
                          onBlur={(e) => {
                            const t = e.target.value; const prev = r.note[single];
                            if (t === prev) return;
                            save(
                              () => setData((d) => d.map((x) => x.id === r.id ? { ...x, note: { ...x.note, [single]: t } } : x)),
                              () => { e.target.value = prev; },
                              () => setAccountNote({ tacticId: r.id, month: single, text: t }),
                            );
                          }} />
                      ) : (
                        <span className="share">
                          {months.filter((m) => r.note[m]).map((m) => `${monthLabels[m]}: ${r.note[m]}`).join(" · ") || "—"}
                        </span>
                      )}
                    </td>
                  </tr>
                  {r.metrics.map((mt) => {
                    const v = metricVerdict(r, mt);
                    return (
                      <tr key={mt.id}>
                        <td style={{ paddingLeft: 16 }}>
                          {mt.name} <span className="share">{mt.unit}</span>
                          <div className="share">{KIND_LABEL[mt.kind]}</div>
                        </td>
                        <td className="r num">{v.plan ? num(Math.round(v.plan * 100) / 100) : "—"}</td>
                        <td>
                          {single ? (
                            <input className="cell" inputMode="decimal" disabled={!canEdit} placeholder="realita"
                              defaultValue={num(mt.actual[single])}
                              onBlur={(e) => {
                                const val = parseF(e.target.value); const prev = mt.actual[single];
                                if (val === prev) return;
                                save(
                                  () => setData((d) => d.map((x) => x.id === r.id ? {
                                    ...x, metrics: x.metrics.map((y) => y.id === mt.id ? { ...y, actual: { ...y.actual, [single]: val } } : y),
                                  } : x)),
                                  () => { e.target.value = num(prev); },
                                  () => setMetricActual({ metricId: mt.id, month: single, value: val }),
                                );
                              }} />
                          ) : <span className="num">{v.actual ? num(Math.round(v.actual * 100) / 100) : "—"}</span>}
                        </td>
                        <td><Meter v={v} plan={v.plan} />
                          <div className="share">
                            {v.ratio === null ? "—"
                              : mt.kind === "cumulative" ? `${pct0(v.ratio)} očekávání`
                              : `${v.deviation! > 0 ? "+" : v.deviation! < 0 ? "−" : ""}${Math.round(Math.abs(v.deviation!) * 100)} % vs. plán`}
                            {"blended" in v && (v as { blended?: boolean }).blended ? " · vážený průměr" : ""}
                          </div>
                        </td>
                        <td><Pill v={v} /></td>
                      </tr>
                    );
                  })}
                </>
              );
            })}
            {!visible.length && (
              <tr><td colSpan={7} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>
                {onlyAlert ? "Žádná taktika není ve skluzu." : "V tomto období neběží žádná taktika."}
              </td></tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>CELKEM {sel === "all" ? "Q4" : monthLabels[sel]}</td>
              <td className="r num">{kc(planSum)}</td>
              <td className="r num">{kc(actSum)}</td>
              <td colSpan={3} className="share">
                {expSum > 0 ? `očekáváno k datu ${kc(Math.round(expSum))} Kč` : "období ještě nezačalo"}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="note">
        <b>Jak se počítá stav.</b> Kumulativní ukazatele (rozpočet, reach, konverze) se poměřují s časem:
        očekávání = cíl × podíl uplynulého období. V plánu 90–110 %, mírný skluz 75–110 %, <b>skluz pod 75 %</b>.
        Poměrové ukazatele (CPM, CPA, CTR, ROAS) se s časem nepoměřují — porovnávají se rovnou s plánem.
        Poznámka accountu skluz <b>nezhasíná</b>, jen zaznamená, že o odchylce víte.
      </div>
    </div>
  );
}

function Meter({ v, plan }: { v: Verdict; plan: number }) {
  const w = v.ratio === null ? 0 : Math.min(100, v.ratio * 100);
  const mark = plan && v.expected > 0 ? Math.min(100, (v.expected / plan) * 100) : null;
  return (
    <div className="meter">
      <i className={`s-${v.status}`} style={{ width: `${w.toFixed(0)}%` }} />
      {mark !== null && <u style={{ left: `${mark.toFixed(0)}%` }} />}
    </div>
  );
}

function Pill({ v }: { v: Verdict }) {
  return (
    <span className={`pill s-${v.status}`}>
      <b className="g">{GLYPH[v.status]}</b>
      {v.label}
    </span>
  );
}
