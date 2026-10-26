"use client";

import { Fragment, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  setActualSpend, setPlannedBudget, setMetricActual, setMetricTarget, setBaseMetricActual,
  setAccountNote, createMetric, deleteMetric, undoLast,
} from "@/lib/actions";
import { DERIVED, type ResolvedMetric } from "@/lib/metrics";
import { verdictFor, monthState, elapsed, type Verdict } from "@/lib/pacing";
import { kc, num, pct0, parseNum } from "@/lib/period";
import type { FillRow } from "@/lib/queries";

type Filter = "all" | "todo" | "late";
const ALL = "all";
const GLYPH: Record<string, string> = { ok: "✓", warn: "!", bad: "▲", idle: "·" };

/**
 * Výsledky — plnění plánu a vyplňování skutečnosti na jednom místě.
 *
 * Nahoře je, co chce pozornost (co chybí vyplnit, co je ve skluzu, kolik je
 * načerpáno), pod tím měsíce a položky. Kdo smí zapisovat, má u položky pole;
 * kdo ne, vidí hodnoty. Klient i agentura mají stejné rozložení, liší se jen
 * tím, co smí měnit — klient navíc nevidí cíle ukazatelů jako pole ani správu
 * ukazatelů a komentář agentury jen čte.
 */
export function Results({
  rows, months, monthLabels, currentMonth, clientView, undoLabel,
}: {
  rows: FillRow[];
  months: string[];
  monthLabels: Record<string, string>;
  /** dnešní měsíc „2026-10" — co je starší nebo stejné, má být vyplněné */
  currentMonth: string;
  clientView: boolean;
  undoLabel: string | null;
}) {
  const router = useRouter();
  const [data, setData] = useState(rows);
  // po uložení přijdou ze serveru čerstvá data — dopočtené CPA/CPM, nové ukazatele
  useEffect(() => setData(rows), [rows]);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState<"all" | "offline" | "online">("all");
  const [adding, setAdding] = useState<string | null>(null);
  const now = useMemo(() => new Date(), []);

  const writable = data.some((r) => months.some((m) => r.months[m].canActual || r.months[m].canPlan));
  const missingIn = (r: FillRow, m: string) => {
    const c = r.months[m];
    return c.canActual && c.actual === null && c.planned > 0 && m <= currentMonth;
  };
  const missingCount = (m: string) => data.filter((r) => missingIn(r, m)).length;
  const totalMissing = months.reduce((s, m) => s + missingCount(m), 0);

  // výchozí měsíc: poslední, který už běží a je v něm co vyplnit; jinak první s plánem
  const firstUseful = useMemo(() => {
    const running = months.filter((m) => m <= currentMonth && data.some((r) => r.months[m].planned));
    if (running.length) return running[running.length - 1];
    return months.find((m) => data.some((r) => r.months[m].planned)) ?? months[0];
    // jen při prvním vykreslení — pak už volí uživatel
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [sel, setSel] = useState<string>(firstUseful);
  // klient s něčím k vyplnění začne na „chybí", ostatní na všem
  const [filter, setFilter] = useState<Filter>(clientView && totalMissing > 0 ? "todo" : "all");

  const single = sel !== ALL ? sel : null;
  const active = single ? [single] : months;

  const budgetVerdict = (r: FillRow) => verdictFor("cumulative",
    active.map((m) => ({ month: m, target: r.months[m].planned, actual: r.months[m].actual ?? 0, spend: r.months[m].actual ?? 0 })), now);
  const metricVerdict = (r: FillRow, mt: ResolvedMetric) => verdictFor(mt.kind,
    active.map((m) => ({ month: m, target: mt.target[m] ?? 0, actual: mt.actual[m] ?? 0, spend: r.months[m].actual ?? 0 })), now);
  const isLate = (r: FillRow) =>
    budgetVerdict(r).status === "bad" || r.metrics.some((mt) => metricVerdict(r, mt).status === "bad");
  const isTodo = (r: FillRow) => active.some((m) => missingIn(r, m));

  const inPeriod = (r: FillRow) => active.some((m) => r.months[m].planned > 0 || r.months[m].actual !== null);
  const base = data.filter((r) =>
    (group === "all" || (group === "online") === r.online) &&
    (!q || `${r.name} ${r.channel} ${r.block}`.toLowerCase().includes(q.toLowerCase())));
  const shown = base.filter((r) =>
    filter === "todo" ? isTodo(r) : filter === "late" ? isLate(r) : inPeriod(r));
  const lateCount = base.filter((r) => inPeriod(r) && isLate(r)).length;
  const blocks = [...new Set(shown.map((r) => r.block))];

  const planSum = base.reduce((s, r) => s + active.reduce((a, m) => a + r.months[m].planned, 0), 0);
  const actSum = base.reduce((s, r) => s + active.reduce((a, m) => a + (r.months[m].actual ?? 0), 0), 0);
  const expSum = base.reduce((s, r) => s + active.reduce((a, m) => a + r.months[m].planned * elapsed(m, now), 0), 0);
  const hasBoth = data.some((r) => r.online) && data.some((r) => !r.online);

  const patch = (id: string, m: string, p: Partial<FillRow["months"][string]>) =>
    setData((d) => d.map((r) => (r.id === id ? { ...r, months: { ...r.months, [m]: { ...r.months[m], ...p } } } : r)));
  const save = (key: string | null, run: () => Promise<{ ok: boolean; error?: string }>, undo: () => void = () => router.refresh()) => {
    start(async () => {
      const res = await run();
      if (!res.ok) { undo(); setError(res.error ?? "Uložení se nezdařilo."); return; }
      setError(null);
      if (key) setSaved(key);
      router.refresh();
    });
  };

  if (!data.length) {
    return (
      <div className="banner info">
        <span>
          <b>Zatím tu nic není.</b>{" "}
          {clientView ? "Jakmile vám agentura přidělí položky, objeví se tady." : "V plánu nejsou žádné položky, které byste viděli."}
        </span>
      </div>
    );
  }

  const monthStatus = single
    ? monthState(single, now) === "before" ? "zatím neprobíhá" : monthState(single, now) === "after" ? "uzavřený měsíc" : `běží · uplynulo ${pct0(elapsed(single, now))}`
    : "souhrn za celé období — zapisuje se po měsících";

  return (
    <div className="res">
      {/* co chce pozornost */}
      <div className="res-cards">
        {writable && (
          <button className={`res-card ${totalMissing ? "bad" : "ok"}`}
            onClick={() => {
              if (!totalMissing) return;
              setFilter("todo");
              const first = months.find((m) => missingCount(m) > 0);
              if (first) setSel(first);
            }}>
            <span className="k">Chybí vyplnit</span>
            <span className="v">{totalMissing || "nic"}</span>
            <span className="d">{totalMissing ? "údajů za měsíce, které už běží nebo proběhly — zobrazit" : "za proběhlé měsíce máte vše vyplněno"}</span>
          </button>
        )}
        <button className={`res-card ${lateCount ? "bad" : "ok"}`} onClick={() => lateCount && setFilter("late")}>
          <span className="k">Ve skluzu</span>
          <span className="v">{lateCount || "nic"}</span>
          <span className="d">{lateCount ? `${lateCount === 1 ? "položka" : lateCount < 5 ? "položky" : "položek"} pod 75 % očekávání nebo mimo cíl — zobrazit` : "nic není výrazně pod plánem"}</span>
        </button>
        <div className="res-card plain">
          <span className="k">Čerpáno {single ? monthLabels[single] : "za období"}</span>
          <span className="v">{kc(actSum)}<small> Kč</small></span>
          <span className="d">z plánu {kc(planSum)} Kč{expSum > 0 ? ` · ${pct0(actSum / expSum)} očekávání k dnešku` : ""}</span>
        </div>
      </div>

      <div className="fill-months" role="tablist" aria-label="Měsíc">
        {months.map((m) => {
          const miss = missingCount(m);
          const any = data.some((r) => r.months[m].planned > 0);
          return (
            <button key={m} role="tab" aria-selected={m === sel} className={`fill-month ${m === sel ? "on" : ""} ${any ? "" : "empty"}`}
              onClick={() => { setSel(m); setSaved(null); }}>
              {monthLabels[m]}
              {miss > 0 && <span className="fill-badge">{miss}</span>}
            </button>
          );
        })}
        <button role="tab" aria-selected={sel === ALL} className={`fill-month ${sel === ALL ? "on" : ""}`} onClick={() => setSel(ALL)}>
          Celé období
        </button>
      </div>

      <div className="panel" style={{ borderRadius: "var(--radius)" }}>
        <div className="toolbar">
          <div className="seg">
            {([["all", "Vše"], ["todo", "Chybí vyplnit"], ["late", "Ve skluzu"]] as Array<[Filter, string]>)
              .filter(([f]) => f !== "todo" || writable)
              .map(([f, l]) => <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{l}</button>)}
          </div>
          {hasBoth && (
            <div className="seg">
              {(["all", "offline", "online"] as const).map((g) => (
                <button key={g} className={group === g ? "on" : ""} onClick={() => setGroup(g)}>
                  {g === "all" ? "Offline i online" : g === "offline" ? "Offline" : "Online"}
                </button>
              ))}
            </div>
          )}
          <input className="access-select" style={{ minWidth: 200 }} placeholder="Hledat položku…" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="share">{monthStatus}</span>
          <span className="spacer" />
          {pending && <span className="saving"><span className="spinner" />ukládám…</span>}
          {!clientView && (
            <button className="btn" disabled={!undoLabel || pending} title={undoLabel ? `Zpět: ${undoLabel}` : "Není co vrátit"}
              onClick={() => save(null, undoLast)}>↶ Zpět</button>
          )}
        </div>

        {error && <div className="banner" style={{ margin: 0, borderRadius: 0 }}><span><b>Neuloženo.</b> {error}</span></div>}

        <div className="scroll">
          <table className="restable">
            <thead>
              <tr>
                <th>Položka</th>
                <th className="r" style={{ width: 130 }}>Plán</th>
                <th className="r realhead" style={{ width: 220 }}>Skutečnost</th>
                <th style={{ width: 150 }}>Průběh</th>
                <th style={{ width: 130 }}>Stav</th>
                <th style={{ width: 220 }}>{clientView ? "Komentář agentury" : "Komentář"}</th>
              </tr>
            </thead>
            <tbody>
              {blocks.map((b) => (
                <Fragment key={b}>
                  <tr className="grp"><td colSpan={6}>{b}</td></tr>
                  {shown.filter((r) => r.block === b).map((r) => {
                    const bv = budgetVerdict(r);
                    const c = single ? r.months[single] : null;
                    const plan = active.reduce((s, m) => s + r.months[m].planned, 0);
                    const actual = active.reduce((s, m) => s + (r.months[m].actual ?? 0), 0);
                    const todo = single ? missingIn(r, single) : false;
                    const showMetrics = r.metrics.length > 0 || (r.canManageMetrics && !clientView);
                    return (
                      <Fragment key={r.id}>
                        <tr className={todo ? "res-todo" : ""}>
                          <td>
                            <div style={{ fontWeight: 500 }} title={r.name !== r.channel ? r.channel : undefined}>{r.name}</div>
                            <div className="share">{r.channelType}</div>
                          </td>
                          <td className="r num">
                            {c && c.canPlan && c.driver === "budget" && clientView
                              ? <MoneyInput value={c.planned} label={`Plán ${r.name}`} saved={saved === `${r.id}|plan`}
                                  onCommit={(v) => {
                                    const before = c.planned;
                                    patch(r.id, single!, { planned: v });
                                    save(`${r.id}|plan`, () => setPlannedBudget({ tacticId: r.id, month: single!, driver: "budget", value: v }),
                                      () => patch(r.id, single!, { planned: before }));
                                  }} />
                              : plan ? `${kc(plan)} Kč` : "—"}
                          </td>
                          <td className="r">
                            {c && c.canActual ? (
                              <div className="res-act">
                                {c.actual === null && (
                                  <button className="linkbtn" type="button" title="Zapsat 0 Kč — v tomto měsíci se nic neutratilo"
                                    onClick={() => { patch(r.id, single!, { actual: 0 }); save(`${r.id}|act`, () => setActualSpend({ tacticId: r.id, month: single!, amount: 0 })); }}>
                                    nečerpáno
                                  </button>
                                )}
                                <MoneyInput value={c.actual} label={`Skutečnost ${r.name}`} saved={saved === `${r.id}|act`}
                                  onCommit={(v) => {
                                    const before = c.actual;
                                    patch(r.id, single!, { actual: v });
                                    save(`${r.id}|act`, () => setActualSpend({ tacticId: r.id, month: single!, amount: Math.round(v) }),
                                      () => patch(r.id, single!, { actual: before }));
                                  }} />
                              </div>
                            ) : <span className="num">{c ? (c.actual !== null ? `${kc(c.actual)} Kč` : "—") : actual ? `${kc(actual)} Kč` : "—"}</span>}
                          </td>
                          <td><Meter v={bv} plan={plan} actual={actual} /></td>
                          <td>
                            {todo
                              ? <span className="pill s-bad"><b className="g">!</b>chybí vyplnit</span>
                              : <Pill v={bv} />}
                          </td>
                          <td>
                            {c && !clientView && c.canActual ? (
                              <input className="txt res-note" key={`${r.id}|${single}|${c.note}`} defaultValue={c.note}
                                placeholder="proč se liší od plánu"
                                onBlur={(e) => {
                                  const t = e.target.value;
                                  if (t === c.note) return;
                                  patch(r.id, single!, { note: t });
                                  save(null, () => setAccountNote({ tacticId: r.id, month: single!, text: t }));
                                }} />
                            ) : (
                              <span className="share">
                                {c ? c.note || "—" : months.filter((m) => r.months[m].note).map((m) => `${monthLabels[m]}: ${r.months[m].note}`).join(" · ") || "—"}
                              </span>
                            )}
                          </td>
                        </tr>
                        {showMetrics && (
                          <tr className="res-metrics">
                            <td colSpan={6}>
                              <span className="share">Výsledky</span>
                              {r.metrics.map((mt) => (
                                <MetricChip key={mt.id ?? `v-${mt.base}`} r={r} mt={mt} single={single}
                                  verdict={metricVerdict(r, mt)} clientView={clientView} saved={saved}
                                  onActual={(v) => {
                                    setData((d) => d.map((x) => x.id !== r.id ? x : {
                                      ...x, metrics: x.metrics.map((y) => y !== mt ? y : { ...y, actual: { ...y.actual, [single!]: v } }),
                                    }));
                                    save(`${mt.id ?? mt.base}|${r.id}`, () => mt.id
                                      ? setMetricActual({ metricId: mt.id, month: single!, value: v })
                                      : setBaseMetricActual({ tacticId: r.id, base: mt.base!, month: single!, value: v }));
                                  }}
                                  onTarget={(v) => save(null, () => setMetricTarget({ metricId: mt.id!, month: single!, target: v }))}
                                  onDelete={() => {
                                    if (!confirm(`Smazat ukazatel „${mt.name}" u ${r.name} včetně všech cílů a skutečnosti? Nejde vrátit.`)) return;
                                    save(null, () => deleteMetric(mt.id!));
                                  }} />
                              ))}
                              {r.canManageMetrics && !clientView && (
                                adding === r.id
                                  ? <NewMetric onCancel={() => setAdding(null)}
                                      onSave={(m) => save(null, async () => {
                                        const res = await createMetric({ tacticId: r.id, ...m });
                                        if (res.ok) setAdding(null);
                                        return res;
                                      })} />
                                  : <button className="linkbtn res-add" onClick={() => setAdding(r.id)}>+ ukazatel</button>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </Fragment>
              ))}
              {!shown.length && (
                <tr><td colSpan={6} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>
                  {filter === "todo" ? "Tady nic nechybí." : filter === "late" ? "Nic není ve skluzu." : "V tomto období tu nic neběží."}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="note">
          <b>Skutečnost</b> = kolik se v měsíci opravdu utratilo; „nečerpáno" zapíše nulu — i to je odpověď.
          Ukládá se samo po opuštění pole. <b>Průběh</b> poměřuje čerpání s uplynulým časem: v plánu 90–110 %,
          skluz pod 75 % očekávání; v první čtvrtině měsíce se nulové čerpání za skluz nepovažuje.
          Poměrové ukazatele (CPM, CPA, CTR, ROAS) se nezadávají — spočítají se z čerpání a čísel vedle a s časem
          se nepoměřují, porovnávají se rovnou s cílem.
          {!clientView && <> Komentář skluz nezhasíná, jen zaznamená, že o odchylce víte.</>}
        </div>
      </div>
    </div>
  );
}

function MetricChip({
  r, mt, single, verdict, clientView, saved, onActual, onTarget, onDelete,
}: {
  r: FillRow; mt: ResolvedMetric; single: string | null; verdict: Verdict & { plan: number; actual: number };
  clientView: boolean; saved: string | null;
  onActual: (v: number) => void; onTarget: (v: number) => void; onDelete: () => void;
}) {
  const c = single ? r.months[single] : null;
  const unit = mt.unit ? ` ${mt.unit}` : "";
  const value = single ? mt.actual[single] : verdict.actual || null;
  const target = single ? mt.target[single] : verdict.plan;
  const canTarget = !!single && !clientView && !!mt.id && r.months[single].canPlan;
  return (
    <span className={`res-chip ${verdict.status !== "idle" ? `s-${verdict.status}` : ""}`}
      title={mt.derived ? `Počítá se: ${DERIVED[mt.derived].formula}` : undefined}>
      <span className="res-chip-name">{mt.name}</span>
      {mt.derived || !c?.canActual ? (
        <b className="num">{value != null && value !== 0 ? `${num(Math.round(value * 100) / 100) || "0"}${unit}` : mt.derived ? "spočte se" : "—"}</b>
      ) : (
        <NumInput value={mt.actual[single!]} label={`${mt.name} ${r.name}`} onCommit={onActual} saved={saved === `${mt.id ?? mt.base}|${r.id}`} />
      )}
      {canTarget ? (
        <span className="share">cíl <NumInput small value={mt.target[single!] || null} label={`Cíl ${mt.name} ${r.name}`} onCommit={onTarget} /></span>
      ) : target ? <span className="share">cíl {num(Math.round(target * 100) / 100)}{unit}</span> : null}
      {!mt.id && <span className="share">(potřebuje ho {r.metrics.filter((x) => x.derived && DERIVED[x.derived].needs.includes(mt.base!)).map((x) => x.name).join(", ")})</span>}
      {!clientView && r.canManageMetrics && mt.id && (
        <button className="res-chip-x" title="Smazat ukazatel" onClick={onDelete}>×</button>
      )}
    </span>
  );
}

function Meter({ v, plan, actual }: { v: Verdict; plan: number; actual: number }) {
  if (!plan) return <span className="share">—</span>;
  const w = Math.min(100, (actual / plan) * 100);
  const mark = v.expected > 0 ? Math.min(100, (v.expected / plan) * 100) : null;
  return (
    <div>
      <div className="meter">
        <i className={`s-${v.status}`} style={{ width: `${w.toFixed(0)}%` }} />
        {mark !== null && <u style={{ left: `${mark.toFixed(0)}%` }} />}
      </div>
      <div className="share">{pct0(actual / plan)} plánu{v.expected > 0 && v.expected < plan ? ` · čekáno ${kc(v.expected)}` : ""}</div>
    </div>
  );
}

function Pill({ v }: { v: Verdict }) {
  return <span className={`pill s-${v.status}`}><b className="g">{GLYPH[v.status]}</b>{v.label}</span>;
}

function MoneyInput({ value, onCommit, saved, label }: { value: number | null; onCommit: (v: number) => void; saved: boolean; label: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <span className={`money ${saved ? "saved" : ""}`}>
      <input
        aria-label={label}
        inputMode="numeric"
        className="moneyin"
        placeholder="zadejte částku"
        value={draft ?? (value === null ? "" : kc(value))}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft === null) return;
          const t = draft.trim();
          setDraft(null);
          // prázdné pole nic nemaže — omylem vymazané číslo se tak neztratí
          if (!t) return;
          const v = parseNum(t);
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

function NumInput({ value, onCommit, label, saved = false, small = false }: {
  value: number | null; onCommit: (v: number) => void; label: string; saved?: boolean; small?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      aria-label={label}
      inputMode="decimal"
      className={`moneyin ${saved ? "saved" : ""}`}
      style={{ width: small ? 80 : 110 }}
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

/** Nový ukazatel: název, jednotka a jak se vyhodnocuje. */
function NewMetric({ onSave, onCancel }: {
  onSave: (m: { name: string; unit: string; kind: "cumulative" | "rate_low" | "rate_high" }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const [kind, setKind] = useState<"cumulative" | "rate_low" | "rate_high">("cumulative");
  return (
    <span className="res-new">
      <input className="moneyin" style={{ width: 150, textAlign: "left" }} autoFocus placeholder="název, např. Kliky" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="moneyin" style={{ width: 80, textAlign: "left" }} placeholder="jednotka" value={unit} onChange={(e) => setUnit(e.target.value)} />
      <select className="moneyin" style={{ width: "auto", textAlign: "left" }} value={kind} onChange={(e) => setKind(e.target.value as never)}>
        <option value="cumulative">načítá se (imprese, kliky, konverze)</option>
        <option value="rate_low">poměr, nižší = lépe (CPM, CPA)</option>
        <option value="rate_high">poměr, vyšší = lépe (CTR, ROAS)</option>
      </select>
      <button className="btn primary" disabled={!name.trim()} onClick={() => onSave({ name: name.trim(), unit: unit.trim(), kind })}>Přidat</button>
      <button className="btn" onClick={onCancel}>Zrušit</button>
    </span>
  );
}
