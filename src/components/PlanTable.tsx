"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  setPlannedBudget, updateTactic, updateMessageLine,
  moveTactic, createTactic, createCampaign, deleteTactic,
} from "@/lib/actions";

export type PlanRow = {
  id: string;
  campaign: string;
  campaignId: string;
  messageLineId: string;
  code: string;
  message: string;
  phase: string;
  audience: string;
  channel: string;
  mediaType: "Paid" | "Owned" | "Earned";
  budgets: Record<string, number>;
  actuals: Record<string, number>;
  /** které měsíce smí tenhle uživatel u téhle taktiky editovat (rozhodl server) */
  editable: Record<string, boolean>;
};

export type CampaignInfo = {
  id: string;
  name: string;
  lines: Array<{ id: string; code: string }>;
};

const kc = (n: number) => Math.round(n).toLocaleString("cs-CZ");
const pct = (n: number) => (n * 100).toFixed(1).replace(".", ",") + " %";
const parse = (s: string) => Number(String(s).replace(/[^\d]/g, "")) || 0;

const CAMP_COLORS = [
  "var(--paid)", "var(--owned)", "var(--earned)", "#c2477e",
  "#5f8b1f", "#8b5fd6", "#b8502a", "#2b7bbf",
];
const PHASES = ["Awareness", "Consideration", "Conversion"] as const;

export function PlanTable({
  rows, campaigns, months, monthLabels, canEditPlan,
}: {
  rows: PlanRow[];
  campaigns: CampaignInfo[];
  months: string[];
  monthLabels: Record<string, string>;
  canEditPlan: boolean;
}) {
  const [data, setData] = useState(rows);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; after: boolean } | null>(null);

  // server je zdroj pravdy — po každé změně se sem vrátí čerstvá data
  useEffect(() => setData(rows), [rows]);

  const [types, setTypes] = useState<Record<string, boolean>>({ Paid: true, Owned: true, Earned: true });
  const [msgSel, setMsgSel] = useState<Set<string>>(new Set());
  const [chanSel, setChanSel] = useState<Set<string>>(new Set());
  const [audSel, setAudSel] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");

  const campOrder = useMemo(() => [...new Set(rows.map((r) => r.campaign))], [rows]);
  const campColor = (name: string) => CAMP_COLORS[campOrder.indexOf(name) % CAMP_COLORS.length];

  const opts = useMemo(() => ({
    msg: [...new Set(rows.map((r) => r.code))].sort((a, b) => a.localeCompare(b, "cs")),
    chan: [...new Set(rows.map((r) => r.channel))].sort((a, b) => a.localeCompare(b, "cs")),
    aud: [...new Set(rows.map((r) => r.audience))].sort((a, b) => a.localeCompare(b, "cs")),
  }), [rows]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.filter((r) => {
      if (!types[r.mediaType]) return false;
      if (msgSel.size && !msgSel.has(r.code)) return false;
      if (chanSel.size && !chanSel.has(r.channel)) return false;
      if (audSel.size && !audSel.has(r.audience)) return false;
      if (!needle) return true;
      return [r.channel, r.code, r.message, r.audience, r.campaign, r.phase]
        .join(" ").toLowerCase().includes(needle);
    });
  }, [data, types, msgSel, chanSel, audSel, q]);

  const anyFilter =
    msgSel.size || chanSel.size || audSel.size || q.trim() || !types.Paid || !types.Owned || !types.Earned;

  const rowTotal = (r: PlanRow) => months.reduce((s, m) => s + r.budgets[m], 0);
  const grand = data.reduce((s, r) => s + rowTotal(r), 0);
  const selTotal = visible.reduce((s, r) => s + rowTotal(r), 0);
  const monthTotal = (m: string) => visible.reduce((s, r) => s + r.budgets[m], 0);
  const axisMax = Math.max(50000, ...data.flatMap((r) => months.map((m) => r.budgets[m])));

  /** Obálka pro server action: optimistická změna, při odmítnutí návrat zpět. */
  function run(optimistic: () => void, rollback: () => void, action: () => Promise<{ ok: boolean; error?: string }>) {
    optimistic();
    startTransition(async () => {
      const res = await action();
      if (!res.ok) { rollback(); setError(res.error ?? "Uložení se nezdařilo."); }
      else setError(null);
    });
  }

  const patchRow = (id: string, patch: Partial<PlanRow>) =>
    setData((d) => d.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  /** Sdělení, cílovka a fáze patří lince — mění se u všech jejích taktik naráz. */
  const patchLine = (lineId: string, patch: Partial<PlanRow>) =>
    setData((d) => d.map((r) => (r.messageLineId === lineId ? { ...r, ...patch } : r)));

  const groups = useMemo(() => {
    const out: Array<{ campaign: string; campaignId: string; rows: PlanRow[] }> = [];
    for (const r of visible) {
      let g = out.find((x) => x.campaign === r.campaign);
      if (!g) out.push((g = { campaign: r.campaign, campaignId: r.campaignId, rows: [] }));
      g.rows.push(r);
    }
    return out;
  }, [visible]);

  const campaignLines = (campaignId: string) =>
    campaigns.find((c) => c.id === campaignId)?.lines ?? [];

  return (
    <div className="panel">
      <div className="toolbar">
        {(["Paid", "Owned", "Earned"] as const).map((ty) => (
          <button key={ty} className="btn" aria-pressed={types[ty]}
            style={types[ty]
              ? { background: `var(--${ty.toLowerCase()}-soft)`, borderColor: `var(--${ty.toLowerCase()})`, borderRadius: 999 }
              : { borderRadius: 999, color: "var(--muted)" }}
            onClick={() => setTypes((t) => ({ ...t, [ty]: !t[ty] }))}>{ty}</button>
        ))}
        <MultiSelect label="Sdělení" options={opts.msg} selected={msgSel} onChange={setMsgSel} />
        <MultiSelect label="Kanál" options={opts.chan} selected={chanSel} onChange={setChanSel} />
        <MultiSelect label="Cílová skupina" options={opts.aud} selected={audSel} onChange={setAudSel} />
        <input placeholder="Hledat…" value={q} onChange={(e) => setQ(e.target.value)}
          style={{ font: "inherit", fontSize: 12, padding: "5px 10px", minWidth: 130, maxWidth: 200,
            border: "1px solid var(--line-strong)", borderRadius: 4, background: "var(--surface)", color: "var(--ink)" }} />
        {anyFilter ? (
          <button className="btn danger" onClick={() => {
            setMsgSel(new Set()); setChanSel(new Set()); setAudSel(new Set());
            setQ(""); setTypes({ Paid: true, Owned: true, Earned: true });
          }}>✕ Zrušit filtry</button>
        ) : null}
        <span className="spacer" />
        {canEditPlan && <NewCampaignButton onCreate={(name) => run(() => {}, () => {}, () => createCampaign({ name }))} />}
        <span className="share">
          {anyFilter ? `${visible.length} z ${data.length} taktik · ` : `${data.length} taktik · `}
          {kc(selTotal)} Kč{pending ? " · ukládám…" : ""}
        </span>
      </div>

      {error && (
        <div className="banner" style={{ margin: 0, borderRadius: 0 }}>
          <span><b>Zápis odmítnut.</b> {error}</span>
        </div>
      )}

      <div className="scroll">
        <table className="plan">
          <thead>
            <tr>
              <th style={{ width: 28 }} />
              <th>Sdělení</th>
              <th>Fáze</th>
              <th>Cílení</th>
              <th>Typ</th>
              <th>Kanál</th>
              {months.map((m) => <th className="r" key={m}>{monthLabels[m] ?? m}</th>)}
              <th className="r">Q4 celkem</th>
              <th className="r">% Q4</th>
              <th style={{ width: 30 }} />
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const gt = g.rows.reduce((s, r) => s + rowTotal(r), 0);
              const lines = campaignLines(g.campaignId);
              return (
                <GroupBlock key={g.campaignId}>
                  <tr className="grp"
                    onDragOver={(e) => { if (dragId) { e.preventDefault(); setDropHint(null); } }}
                    onDrop={(e) => {
                      if (!dragId || !lines[0]) return;
                      e.preventDefault();
                      const id = dragId; setDragId(null);
                      run(() => {}, () => {}, () => moveTactic({ tacticId: id, targetMessageLineId: lines[0].id }));
                    }}>
                    <td colSpan={6} style={{ boxShadow: `inset 3px 0 0 0 ${campColor(g.campaign)}` }}>
                      <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2,
                        background: campColor(g.campaign), marginRight: 7 }} />
                      {g.campaign} <span className="share" style={{ fontWeight: 300 }}>{g.rows.length} taktik</span>
                      {canEditPlan && lines[0] && (
                        <button className="btn" style={{ marginLeft: 10, fontSize: 11, padding: "2px 8px" }}
                          onClick={() => run(() => {}, () => {}, () => createTactic({ messageLineId: lines[0].id }))}>
                          + Taktika
                        </button>
                      )}
                    </td>
                    {months.map((m) => (
                      <td className="r share num" key={m}>
                        {g.rows.reduce((s, r) => s + r.budgets[m], 0) ? kc(g.rows.reduce((s, r) => s + r.budgets[m], 0)) : "–"}
                      </td>
                    ))}
                    <td className="r num">{kc(gt)}</td>
                    <td className="r share num">{grand ? pct(gt / grand) : ""}</td>
                    <td />
                  </tr>

                  {g.rows.map((r) => {
                    const dh = dropHint?.id === r.id ? dropHint : null;
                    return (
                      <tr key={r.id}
                        className={dragId === r.id ? "dragging" : dh ? (dh.after ? "dropAfter" : "dropBefore") : ""}
                        onDragOver={(e) => {
                          if (!dragId || dragId === r.id) return;
                          e.preventDefault();
                          const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setDropHint({ id: r.id, after: e.clientY > box.top + box.height / 2 });
                        }}
                        onDrop={(e) => {
                          if (!dragId || dragId === r.id) return;
                          e.preventDefault();
                          const id = dragId, after = dropHint?.after ?? false;
                          setDragId(null); setDropHint(null);
                          run(() => {}, () => {}, () => moveTactic({ tacticId: id, targetTacticId: r.id, after }));
                        }}>
                        <td style={{ boxShadow: `inset 3px 0 0 0 ${campColor(r.campaign)}`, textAlign: "center" }}>
                          {canEditPlan && (
                            <span className="grip" draggable
                              title="Přetažením změníte pořadí nebo přeřadíte taktiku"
                              onDragStart={() => setDragId(r.id)}
                              onDragEnd={() => { setDragId(null); setDropHint(null); }}>⠿</span>
                          )}
                        </td>

                        <td style={{ maxWidth: 210 }}>
                          <input className="txt" defaultValue={r.message} disabled={!canEditPlan}
                            key={`msg-${r.messageLineId}-${r.message}`}
                            onBlur={(e) => {
                              const v = e.target.value, prev = r.message;
                              if (v === prev) return;
                              run(() => patchLine(r.messageLineId, { message: v }),
                                  () => patchLine(r.messageLineId, { message: prev }),
                                  () => updateMessageLine({ messageLineId: r.messageLineId, message: v }));
                            }} />
                          <div className="share" style={{ paddingLeft: 6 }}>{r.code}</div>
                        </td>

                        <td>
                          <select className="txt" value={r.phase} disabled={!canEditPlan}
                            onChange={(e) => {
                              const v = e.target.value as (typeof PHASES)[number], prev = r.phase;
                              run(() => patchLine(r.messageLineId, { phase: v }),
                                  () => patchLine(r.messageLineId, { phase: prev }),
                                  () => updateMessageLine({ messageLineId: r.messageLineId, phase: v }));
                            }}>
                            {PHASES.map((p) => <option key={p}>{p}</option>)}
                          </select>
                        </td>

                        <td style={{ maxWidth: 150 }}>
                          <input className="txt" defaultValue={r.audience} disabled={!canEditPlan}
                            key={`aud-${r.messageLineId}-${r.audience}`}
                            onBlur={(e) => {
                              const v = e.target.value, prev = r.audience;
                              if (v === prev) return;
                              run(() => patchLine(r.messageLineId, { audience: v }),
                                  () => patchLine(r.messageLineId, { audience: prev }),
                                  () => updateMessageLine({ messageLineId: r.messageLineId, audience: v }));
                            }} />
                        </td>

                        <td>
                          <select className={`txt pill ${r.mediaType}`} value={r.mediaType} disabled={!canEditPlan}
                            style={{ width: 84 }}
                            onChange={(e) => {
                              const v = e.target.value as PlanRow["mediaType"], prev = r.mediaType;
                              run(() => patchRow(r.id, { mediaType: v }),
                                  () => patchRow(r.id, { mediaType: prev }),
                                  () => updateTactic({ tacticId: r.id, mediaType: v }));
                            }}>
                            <option>Paid</option><option>Owned</option><option>Earned</option>
                          </select>
                        </td>

                        <td style={{ minWidth: 150 }}>
                          <input className="txt" defaultValue={r.channel} disabled={!canEditPlan}
                            key={`ch-${r.id}-${r.channel}`} title={r.channel}
                            onBlur={(e) => {
                              const v = e.target.value, prev = r.channel;
                              if (v === prev) return;
                              run(() => patchRow(r.id, { channel: v }), () => patchRow(r.id, { channel: prev }),
                                  () => updateTactic({ tacticId: r.id, channel: v }));
                            }} />
                        </td>

                        {months.map((m) => (
                          <td key={m} className="budgetcell">
                            <BudgetCell
                              value={r.budgets[m]} actual={r.actuals[m]} max={axisMax} type={r.mediaType}
                              disabled={!r.editable[m]}
                              onCommit={(v) => {
                                const prev = r.budgets[m];
                                if (prev === v) return;
                                run(() => patchRow(r.id, { budgets: { ...r.budgets, [m]: v } }),
                                    () => patchRow(r.id, { budgets: { ...r.budgets, [m]: prev } }),
                                    () => setPlannedBudget({ tacticId: r.id, month: m, planned: v }));
                              }} />
                          </td>
                        ))}

                        <td className="r num" style={{ fontWeight: 500 }}>{kc(rowTotal(r))}</td>
                        <td className="r share num">{grand ? pct(rowTotal(r) / grand) : "—"}</td>
                        <td className="r">
                          {canEditPlan && (
                            <button className="rowdel" title="Smazat taktiku"
                              onClick={() => {
                                if (!confirm(`Smazat taktiku „${r.channel}"? Smažou se i její rozpočty a metriky.`)) return;
                                run(() => setData((d) => d.filter((x) => x.id !== r.id)), () => setData(rows),
                                    () => deleteTactic(r.id));
                              }}>×</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </GroupBlock>
              );
            })}
            {!visible.length && (
              <tr><td colSpan={11} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>
                Žádná taktika neodpovídá filtru.
              </td></tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={6}>CELKEM {anyFilter ? "(výběr)" : "Q4"}</td>
              {months.map((m) => <td className="r num" key={m}>{kc(monthTotal(m))}</td>)}
              <td className="r num">{kc(selTotal)}</td>
              <td className="r num">{grand ? pct(selTotal / grand) : "—"}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="note">
        Délka pruhu = investice v měsíci na společném měřítku 0–{kc(axisMax)} Kč, oranžový proužek u dna =
        skutečné čerpání. Barevný proužek u levého okraje řádku = kampaň.
        {canEditPlan && <> Úchyt ⠿ přetažením změní pořadí; přetažení na hlavičku kampaně taktiku přeřadí.</>}
        <br />
        <b>Sdělení, fáze a cílová skupina patří lince sdělení</b>, ne jednotlivé taktice — změna se projeví
        u všech taktik téže linky. Kanál a typ média jsou vlastní každé taktice.
      </div>
    </div>
  );
}

/** Fragment s klíčem — skupina je víc řádků, ne jeden element. */
function GroupBlock({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function BudgetCell({
  value, actual, max, type, disabled, onCommit,
}: {
  value: number; actual: number; max: number;
  type: string; disabled: boolean; onCommit: (v: number) => void;
}) {
  /**
   * Během psaní se hodnota NEFORMÁTUJE — jinak by po každém znaku React pole
   * překreslil a kurzor skočil na konec. Mezery mezi tisíci naskočí až po
   * odkliknutí.
   */
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const shown = editing ? draft : value ? kc(value) : "";
  const w = Math.min(100, (value / max) * 100);
  const aw = Math.min(100, (actual / max) * 100);

  return (
    <div className={`cellbox ${disabled ? "locked" : "editable"} ${value ? "filled" : ""}`}>
      {value > 0 && (
        <div className="cellfill" style={{
          width: `${w}%`,
          background: `var(--${type.toLowerCase()}-fill, var(--${type.toLowerCase()}-soft))`,
        }} />
      )}
      {actual > 0 && (
        <div className="cellspent" title={`čerpáno ${kc(actual)} Kč`} style={{ width: `${aw}%` }} />
      )}
      <input
        className="cell"
        inputMode="numeric"
        disabled={disabled}
        title={disabled ? "K tomuto rozpočtu nemáte oprávnění" : undefined}
        value={shown}
        placeholder="0"
        onFocus={(e) => { setDraft(value ? String(value) : ""); requestAnimationFrame(() => e.target.select()); }}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
        onBlur={() => { if (draft !== null) { onCommit(parse(draft)); setDraft(null); } }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") { setDraft(null); (e.target as HTMLInputElement).blur(); }
        }}
      />
    </div>
  );
}

function NewCampaignButton({ onCreate }: { onCreate: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  if (!open) return <button className="btn primary" onClick={() => setOpen(true)}>+ Nová iniciativa</button>;
  return (
    <form
      style={{ display: "flex", gap: 6 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onCreate(name.trim());
        setName(""); setOpen(false);
      }}
    >
      <input autoFocus placeholder="Název iniciativy" value={name} onChange={(e) => setName(e.target.value)}
        style={{ font: "inherit", fontSize: 12, padding: "5px 10px", border: "1px solid var(--brand)",
          borderRadius: 4, background: "var(--surface)", color: "var(--ink)", minWidth: 170 }} />
      <button className="btn primary" type="submit">Založit</button>
      <button className="btn" type="button" onClick={() => { setOpen(false); setName(""); }}>Zrušit</button>
    </form>
  );
}

function MultiSelect({
  label, options, selected, onChange,
}: { label: string; options: string[]; selected: Set<string>; onChange: (s: Set<string>) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button className="btn" style={{ borderRadius: 999, borderColor: open ? "var(--brand)" : undefined }}
        onClick={() => setOpen((o) => !o)}>
        {label}{" "}
        {selected.size
          ? <b style={{ background: "var(--brand)", color: "#fff", borderRadius: 999, fontSize: 9.5, padding: "0 5px", marginLeft: 4 }}>{selected.size}</b>
          : <span style={{ color: "var(--muted)", fontSize: 10.5 }}>vše</span>}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 50 }} />
          <div style={{ position: "absolute", zIndex: 60, top: "calc(100% + 4px)", left: 0, minWidth: 240,
            background: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: 5,
            boxShadow: "0 6px 20px rgba(0,0,0,.14)" }}>
            <div style={{ display: "flex", gap: 10, padding: "7px 10px", borderBottom: "1px solid var(--line)" }}>
              <button className="btn" style={{ border: "none", padding: 0, fontSize: 11, textDecoration: "underline" }}
                onClick={() => onChange(new Set(options))}>Vybrat vše</button>
              <button className="btn" style={{ border: "none", padding: 0, fontSize: 11, textDecoration: "underline" }}
                onClick={() => onChange(new Set())}>Zrušit</button>
            </div>
            <div style={{ maxHeight: 270, overflow: "auto", padding: 4 }}>
              {options.map((o) => (
                <label key={o} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 7px",
                  borderRadius: 3, cursor: "pointer", fontSize: 12 }}>
                  <input type="checkbox" checked={selected.has(o)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(o); else next.delete(o);
                      onChange(next);
                    }} />
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o}</span>
                </label>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
