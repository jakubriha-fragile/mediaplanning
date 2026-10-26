"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setActualSpend, setPlannedBudget, setMetricActual, setBaseMetricActual } from "@/lib/actions";
import { DERIVED, type ResolvedMetric } from "@/lib/metrics";
import { kc, num, parseNum } from "@/lib/period";
import type { FillRow } from "@/lib/queries";

type Status = "done" | "missing" | "later" | "none";

/** Stav jednoho údaje: vyplněno, chybí (měsíc už běží nebo proběhl), zatím neprobíhá, nic k vyplnění. */
function statusOf(row: FillRow, m: string, current: string): Status {
  const c = row.months[m];
  if (!c.canActual) return "none";
  if (c.actual !== null) return "done";
  if (!c.planned) return "none"; // nic se neplánovalo — nikdo nic nedluží
  return m <= current ? "missing" : "later";
}

const STATUS: Record<Status, { label: string; cls: string }> = {
  done: { label: "✓ vyplněno", cls: "s-ok" },
  missing: { label: "chybí", cls: "s-bad" },
  later: { label: "zatím neprobíhá", cls: "s-idle" },
  none: { label: "—", cls: "s-idle" },
};

/**
 * Stránka K vyplnění: jen položky, kam smí uživatel zapisovat, po měsících.
 * Jedno pole = jedno číslo, ukládá se samo při opuštění pole. Nic dalšího
 * se tu rozhodovat nemusí — zbytek dopočítá aplikace.
 */
export function FillForm({
  rows, months, monthLabels, currentMonth, clientView,
}: {
  rows: FillRow[];
  months: string[];
  monthLabels: Record<string, string>;
  /** dnešní měsíc „2026-10" — co je starší nebo stejné, má být vyplněné */
  currentMonth: string;
  clientView: boolean;
}) {
  const router = useRouter();
  const [data, setData] = useState(rows);
  // po uložení přijdou ze serveru čerstvá data — dopočtené CPA/CPM i nově založené ukazatele
  useEffect(() => setData(rows), [rows]);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState<"all" | "offline" | "online">("all");
  const [onlyMissing, setOnlyMissing] = useState(false);

  // výchozí měsíc: poslední, který už běží a je v něm co vyplnit; jinak první s plánem
  const missingIn = (m: string) => data.filter((r) => statusOf(r, m, currentMonth) === "missing").length;
  const firstUseful = useMemo(() => {
    const running = months.filter((m) => m <= currentMonth && data.some((r) => r.months[m].canActual && r.months[m].planned));
    if (running.length) return running[running.length - 1];
    return months.find((m) => data.some((r) => r.months[m].planned)) ?? months[0];
  }, [months, currentMonth, data]);
  const [month, setMonth] = useState(firstUseful);

  const totalMissing = months.reduce((s, m) => s + missingIn(m), 0);
  const hasBoth = data.some((r) => r.online) && data.some((r) => !r.online);

  const shown = data.filter((r) =>
    (group === "all" || (group === "online") === r.online) &&
    (!q || `${r.name} ${r.channel} ${r.block}`.toLowerCase().includes(q.toLowerCase())) &&
    (!onlyMissing || statusOf(r, month, currentMonth) === "missing") &&
    // řádek bez plánu i bez možnosti zápisu v tomhle měsíci nemá smysl ukazovat
    (r.months[month].planned > 0 || r.months[month].actual !== null || r.months[month].canPlan));

  const patch = (id: string, m: string, p: Partial<FillRow["months"][string]>) =>
    setData((d) => d.map((r) => r.id === id ? { ...r, months: { ...r.months, [m]: { ...r.months[m], ...p } } } : r));

  const save = (key: string, run: () => Promise<{ ok: boolean; error?: string }>, undo: () => void) => {
    start(async () => {
      const res = await run();
      if (!res.ok) { undo(); setError(res.error ?? "Uložení se nezdařilo."); return; }
      setError(null);
      setSaved(key);
      router.refresh();
    });
  };

  if (!data.length) {
    return (
      <div className="banner info">
        <span>
          <b>Nemáte žádné položky k vyplnění.</b>{" "}
          {clientView ? "Jakmile vám agentura přidělí položky, objeví se tady." : "V tomto plánu nemáte oprávnění k zápisu."}
        </span>
      </div>
    );
  }

  return (
    <div className="fill">
      <div className="fill-head">
        <div>
          <div className="fill-title">
            {data.length} {data.length === 1 ? "položka" : data.length < 5 ? "položky" : "položek"} k vyplnění
          </div>
          <div className="share">
            {totalMissing
              ? <><b style={{ color: "var(--bad)" }}>Chybí {totalMissing} {totalMissing === 1 ? "údaj" : totalMissing < 5 ? "údaje" : "údajů"}</b> za měsíce, které už proběhly.</>
              : "Za proběhlé měsíce máte vše vyplněno."}
            {" "}Částky v Kč{clientView ? " vč. agenturního fee" : ""}; ukládá se samo po opuštění pole.
          </div>
        </div>
        <span className="spacer" />
        {pending && <span className="saving"><span className="spinner" />ukládám…</span>}
      </div>

      <div className="fill-months" role="tablist" aria-label="Měsíc">
        {months.map((m) => {
          const miss = missingIn(m);
          const any = data.some((r) => r.months[m].planned > 0);
          return (
            <button key={m} role="tab" aria-selected={m === month} className={`fill-month ${m === month ? "on" : ""} ${any ? "" : "empty"}`}
              onClick={() => { setMonth(m); setSaved(null); }}>
              {monthLabels[m]}
              {miss > 0 && <span className="fill-badge">{miss}</span>}
            </button>
          );
        })}
      </div>

      <div className="fill-tools">
        <input className="access-select" style={{ minWidth: 220 }} placeholder="Hledat položku…" value={q} onChange={(e) => setQ(e.target.value)} />
        {hasBoth && (
          <div className="seg">
            {(["all", "offline", "online"] as const).map((g) => (
              <button key={g} className={group === g ? "on" : ""} onClick={() => setGroup(g)}>
                {g === "all" ? "Vše" : g === "offline" ? "Offline" : "Online"}
              </button>
            ))}
          </div>
        )}
        <label className="picker-item" style={{ padding: 0 }}>
          <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />
          <span>Jen chybějící</span>
        </label>
      </div>

      {error && <div className="banner" style={{ margin: "0 0 10px" }}><span><b>Neuloženo.</b> {error}</span></div>}

      <div className="panel" style={{ borderRadius: "var(--radius)" }}>
        <div className="scroll">
          <table className="filltable">
            <thead>
              <tr>
                <th>Položka</th>
                <th className="r" style={{ width: 170 }}>Plán {monthLabels[month]}</th>
                <th className="r realhead" style={{ width: 210 }}>Skutečnost</th>
                <th style={{ width: 130 }}>Stav</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const c = r.months[month];
                const st = statusOf(r, month, currentMonth);
                const planKey = `${r.id}|${month}|plan`;
                const actKey = `${r.id}|${month}|act`;
                return (
                  <FillRowView key={`${r.id}|${month}`} r={r} month={month} st={st} saved={saved}
                    onPlan={c.canPlan && c.driver === "budget" ? (v) => {
                      const before = c.planned;
                      patch(r.id, month, { planned: v });
                      save(planKey, () => setPlannedBudget({ tacticId: r.id, month, driver: "budget", value: v }), () => patch(r.id, month, { planned: before }));
                    } : null}
                    onActual={c.canActual ? (v) => {
                      const before = c.actual;
                      patch(r.id, month, { actual: v });
                      save(actKey, () => setActualSpend({ tacticId: r.id, month, amount: v }), () => patch(r.id, month, { actual: before }));
                    } : null}
                    onMetric={c.canActual ? (metric, v) => {
                      setData((d) => d.map((x) => x.id !== r.id ? x : {
                        ...x, metrics: x.metrics.map((mt) => mt !== metric ? mt : { ...mt, actual: { ...mt.actual, [month]: v } }),
                      }));
                      // základní ukazatel, který zatím neexistuje, se založí prvním zápisem
                      save(`${metric.id ?? metric.base}|${month}`,
                        () => metric.id
                          ? setMetricActual({ metricId: metric.id, month, value: v })
                          : setBaseMetricActual({ tacticId: r.id, base: metric.base!, month, value: v }),
                        () => router.refresh());
                    } : null}
                    planKey={planKey} actKey={actKey}
                  />
                );
              })}
              {!shown.length && (
                <tr><td colSpan={4} style={{ padding: 22, textAlign: "center", color: "var(--muted)" }}>
                  {onlyMissing ? "V tomto měsíci nic nechybí." : "V tomto měsíci tu nic není k vyplnění."}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="note">
          <b>Skutečnost</b> = kolik se v daném měsíci opravdu utratilo. Když se nic nečerpalo, klikněte na „nečerpáno" —
          nula je taky odpověď a položka přestane svítit jako chybějící.
        </div>
      </div>
    </div>
  );
}

function FillRowView({
  r, month, st, saved, onPlan, onActual, onMetric, planKey, actKey,
}: {
  r: FillRow; month: string; st: Status; saved: string | null;
  onPlan: ((v: number) => void) | null;
  onActual: ((v: number) => void) | null;
  onMetric: ((metric: ResolvedMetric, v: number) => void) | null;
  planKey: string; actKey: string;
}) {
  const c = r.months[month];
  return (
    <>
      <tr>
        <td>
          <div style={{ fontWeight: 500 }} title={r.name !== r.channel ? r.channel : undefined}>{r.name}</div>
          <div className="share">{r.block} · {r.channelType}</div>
        </td>
        <td className="r">
          {onPlan
            ? <MoneyInput value={c.planned} onCommit={onPlan} saved={saved === planKey} label={`Plán ${r.channel}`} />
            : <span className="num">{c.planned ? `${kc(c.planned)} Kč` : "—"}</span>}
          {c.canPlan && c.driver !== "budget" && (
            <div className="share" title="Rozpočet se dopočítává z GRP nebo impresí — mění se v Plánování">řízeno {c.driver === "grp" ? "GRP" : "impresemi"}</div>
          )}
        </td>
        <td className="r">
          {onActual ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end" }}>
              {c.actual === null && (
                <button className="linkbtn" type="button" onClick={() => onActual(0)} title="Zapsat 0 Kč — v tomto měsíci se nic neutratilo">nečerpáno</button>
              )}
              <MoneyInput value={c.actual} onCommit={onActual} saved={saved === actKey} label={`Skutečnost ${r.channel}`} />
            </div>
          ) : <span className="num">{c.actual !== null ? `${kc(c.actual)} Kč` : "—"}</span>}
        </td>
        <td><span className={`pill ${STATUS[st].cls}`}>{STATUS[st].label}</span></td>
      </tr>
      {r.metrics.length > 0 && onMetric && (
        <tr className="fill-metrics">
          <td colSpan={4}>
            <span className="share">Výsledky:</span>
            {r.metrics.filter((mt) => !mt.derived).map((mt) => (
              <label key={mt.id ?? mt.base} className="fill-metric">
                <span>{mt.name}{mt.unit ? ` (${mt.unit})` : ""}</span>
                <NumInput value={mt.actual[month]} onCommit={(v) => onMetric(mt, v)} label={`${mt.name} ${r.channel}`} />
                {mt.target[month] ? <span className="share">cíl {num(mt.target[month])}</span> : null}
              </label>
            ))}
            {/* poměrové ukazatele se nezadávají — ukážou se spočtené */}
            {r.metrics.filter((mt) => mt.derived).map((mt) => {
              const v = mt.actual[month];
              const d = DERIVED[mt.derived!];
              return (
                <span key={mt.id ?? mt.name} className="fill-metric fill-derived" title={`Počítá se: ${d.formula}`}>
                  <span>{mt.name}</span>
                  <b>{v != null ? `${num(Math.round(v * 100) / 100) || "0"} ${mt.unit}` : "—"}</b>
                  {v == null && <span className="share">spočte se z čerpání a čísel vlevo</span>}
                  {mt.target[month] ? <span className="share">cíl {num(mt.target[month])}</span> : null}
                </span>
              );
            })}
          </td>
        </tr>
      )}
    </>
  );
}

function MoneyInput({ value, onCommit, saved, label }: { value: number | null; onCommit: (v: number) => void; saved: boolean; label: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === null ? "" : kc(value));
  return (
    <span className={`money ${saved ? "saved" : ""}`}>
      <input
        aria-label={label}
        inputMode="numeric"
        className="moneyin"
        placeholder="zadejte částku"
        value={shown}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft === null) return;
          const trimmed = draft.trim();
          setDraft(null);
          // prázdné pole nic nemaže — omylem vymazané číslo se tak neztratí
          if (!trimmed) return;
          const v = parseNum(trimmed);
          if (v !== value) onCommit(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") { setDraft(null); (e.target as HTMLInputElement).blur(); }
        }}
      />
      <span className="share">Kč</span>
      {saved && <span className="savedmark" aria-label="uloženo">✓</span>}
    </span>
  );
}

function NumInput({ value, onCommit, label }: { value: number | null; onCommit: (v: number) => void; label: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      aria-label={label}
      inputMode="decimal"
      className="moneyin"
      style={{ width: 120 }}
      value={draft ?? (value === null ? "" : num(value) || "0")}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === null) return;
        const t = draft.trim();
        setDraft(null);
        if (!t) return;
        const v = parseNum(t);
        if (v !== value) onCommit(v);
      }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  );
}
