"use client";

import { useMemo, useState, useTransition } from "react";
import { setPlannedBudget } from "@/lib/actions";

export type PlanRow = {
  id: string;
  campaign: string;
  campaignId: string;
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

const kc = (n: number) => Math.round(n).toLocaleString("cs-CZ");
const pct = (n: number) => (n * 100).toFixed(1).replace(".", ",") + " %";
const parse = (s: string) => Number(String(s).replace(/\s/g, "").replace(/[^\d]/g, "")) || 0;

const CAMP_COLORS = [
  "var(--paid)", "var(--owned)", "var(--earned)", "#c2477e",
  "#5f8b1f", "#8b5fd6", "#b8502a", "#2b7bbf",
];

export function PlanTable({
  rows,
  months,
  monthLabels,
}: {
  rows: PlanRow[];
  months: string[];
  monthLabels: Record<string, string>;
}) {
  const [data, setData] = useState(rows);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // filtry — zadání §8
  const [types, setTypes] = useState<Record<string, boolean>>({ Paid: true, Owned: true, Earned: true });
  const [msgSel, setMsgSel] = useState<Set<string>>(new Set());
  const [chanSel, setChanSel] = useState<Set<string>>(new Set());
  const [audSel, setAudSel] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");

  const campOrder = useMemo(() => [...new Set(rows.map((r) => r.campaign))], [rows]);
  const campColor = (name: string) => CAMP_COLORS[campOrder.indexOf(name) % CAMP_COLORS.length];

  const opts = useMemo(
    () => ({
      msg: [...new Set(rows.map((r) => r.code))].sort((a, b) => a.localeCompare(b, "cs")),
      chan: [...new Set(rows.map((r) => r.channel))].sort((a, b) => a.localeCompare(b, "cs")),
      aud: [...new Set(rows.map((r) => r.audience))].sort((a, b) => a.localeCompare(b, "cs")),
    }),
    [rows],
  );

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.filter((r) => {
      if (!types[r.mediaType]) return false;
      if (msgSel.size && !msgSel.has(r.code)) return false;
      if (chanSel.size && !chanSel.has(r.channel)) return false;
      if (audSel.size && !audSel.has(r.audience)) return false;
      if (!needle) return true;
      return [r.channel, r.code, r.message, r.audience, r.campaign, r.phase]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [data, types, msgSel, chanSel, audSel, q]);

  const anyFilter =
    msgSel.size || chanSel.size || audSel.size || q.trim() || !types.Paid || !types.Owned || !types.Earned;

  const rowTotal = (r: PlanRow) => months.reduce((s, m) => s + r.budgets[m], 0);
  const grand = data.reduce((s, r) => s + rowTotal(r), 0);
  const selTotal = visible.reduce((s, r) => s + rowTotal(r), 0);
  const monthTotal = (m: string) => visible.reduce((s, r) => s + r.budgets[m], 0);
  const axisMax = Math.max(50000, ...data.flatMap((r) => months.map((m) => r.budgets[m])));

  function commit(rowId: string, month: string, value: number) {
    const prev = data.find((r) => r.id === rowId)?.budgets[month] ?? 0;
    if (prev === value) return;
    setData((d) => d.map((r) => (r.id === rowId ? { ...r, budgets: { ...r.budgets, [month]: value } } : r)));
    startTransition(async () => {
      const res = await setPlannedBudget({ tacticId: rowId, month, planned: value });
      if (!res.ok) {
        // server odmítl → vracíme hodnotu zpět, aby UI neukazovalo něco, co v databázi není
        setData((d) => d.map((r) => (r.id === rowId ? { ...r, budgets: { ...r.budgets, [month]: prev } } : r)));
        setError(res.error);
      } else {
        setError(null);
      }
    });
  }

  const groups = useMemo(() => {
    const out: Array<{ campaign: string; rows: PlanRow[] }> = [];
    for (const r of visible) {
      let g = out.find((x) => x.campaign === r.campaign);
      if (!g) out.push((g = { campaign: r.campaign, rows: [] }));
      g.rows.push(r);
    }
    return out;
  }, [visible]);

  return (
    <div className="panel">
      <div className="toolbar">
        {(["Paid", "Owned", "Earned"] as const).map((ty) => (
          <button
            key={ty}
            className="btn"
            aria-pressed={types[ty]}
            style={
              types[ty]
                ? { background: `var(--${ty.toLowerCase()}-soft)`, borderColor: `var(--${ty.toLowerCase()})`, borderRadius: 999 }
                : { borderRadius: 999, color: "var(--muted)" }
            }
            onClick={() => setTypes((t) => ({ ...t, [ty]: !t[ty] }))}
          >
            {ty}
          </button>
        ))}
        <MultiSelect label="Sdělení" options={opts.msg} selected={msgSel} onChange={setMsgSel} />
        <MultiSelect label="Kanál" options={opts.chan} selected={chanSel} onChange={setChanSel} />
        <MultiSelect label="Cílová skupina" options={opts.aud} selected={audSel} onChange={setAudSel} />
        <input
          className="field-inline"
          placeholder="Hledat…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{
            font: "inherit", fontSize: 12, padding: "5px 10px", minWidth: 140, maxWidth: 220,
            border: "1px solid var(--line-strong)", borderRadius: 4,
            background: "var(--surface)", color: "var(--ink)",
          }}
        />
        {anyFilter ? (
          <button
            className="btn danger"
            onClick={() => {
              setMsgSel(new Set()); setChanSel(new Set()); setAudSel(new Set());
              setQ(""); setTypes({ Paid: true, Owned: true, Earned: true });
            }}
          >
            ✕ Zrušit filtry
          </button>
        ) : null}
        <span className="spacer" />
        <span className="share">
          {anyFilter ? `${visible.length} z ${data.length} taktik · ` : `${data.length} taktik · `}
          {kc(selTotal)} Kč
          {pending ? " · ukládám…" : ""}
        </span>
      </div>

      {error && (
        <div className="banner" style={{ margin: 0, borderRadius: 0 }}>
          <span><b>Zápis odmítnut.</b> {error}</span>
        </div>
      )}

      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Kampaň / sdělení</th>
              <th>Cílení</th>
              <th>Typ</th>
              <th>Kanál</th>
              {months.map((m) => (
                <th className="r" key={m}>{monthLabels[m] ?? m}</th>
              ))}
              <th className="r">Q4 celkem</th>
              <th className="r">% Q4</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const gt = g.rows.reduce((s, r) => s + rowTotal(r), 0);
              return (
                <>
                  <tr className="grp" key={g.campaign}>
                    <td colSpan={4} style={{ boxShadow: `inset 3px 0 0 0 ${campColor(g.campaign)}` }}>
                      <span
                        style={{
                          display: "inline-block", width: 8, height: 8, borderRadius: 2,
                          background: campColor(g.campaign), marginRight: 7,
                        }}
                      />
                      {g.campaign}{" "}
                      <span className="share" style={{ fontWeight: 300 }}>{g.rows.length} taktik</span>
                    </td>
                    {months.map((m) => (
                      <td className="r share num" key={m}>
                        {g.rows.reduce((s, r) => s + r.budgets[m], 0) ? kc(g.rows.reduce((s, r) => s + r.budgets[m], 0)) : "–"}
                      </td>
                    ))}
                    <td className="r num">{kc(gt)}</td>
                    <td className="r share num">{grand ? pct(gt / grand) : ""}</td>
                  </tr>
                  {g.rows.map((r) => (
                    <tr key={r.id}>
                      <td style={{ maxWidth: 230, boxShadow: `inset 3px 0 0 0 ${campColor(r.campaign)}` }}>
                        <div style={{ fontSize: 12 }}>{r.message}</div>
                        <div className="share">{r.code} · {r.phase}</div>
                      </td>
                      <td className="share" style={{ color: "var(--ink-2)", maxWidth: 150 }}>{r.audience}</td>
                      <td><span className={`pill ${r.mediaType}`}>{r.mediaType}</span></td>
                      <td style={{ minWidth: 140 }} title={r.channel}>{r.channel}</td>
                      {months.map((m) => (
                        <td key={m} style={{ width: 150, padding: "3px 6px" }}>
                          <BudgetCell
                            value={r.budgets[m]}
                            actual={r.actuals[m]}
                            max={axisMax}
                            type={r.mediaType}
                            disabled={!r.editable[m]}
                            onCommit={(v) => commit(r.id, m, v)}
                          />
                        </td>
                      ))}
                      <td className="r num" style={{ fontWeight: 500 }}>{kc(rowTotal(r))}</td>
                      <td className="r share num">{grand ? pct(rowTotal(r) / grand) : "—"}</td>
                    </tr>
                  ))}
                </>
              );
            })}
            {!visible.length && (
              <tr><td colSpan={9} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>
                Žádná taktika neodpovídá filtru.
              </td></tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4}>CELKEM {anyFilter ? "(výběr)" : "Q4"}</td>
              {months.map((m) => (
                <td className="r num" key={m}>{kc(monthTotal(m))}</td>
              ))}
              <td className="r num">{kc(selTotal)}</td>
              <td className="r num">{grand ? pct(selTotal / grand) : "—"}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="note">
        Délka pruhu = investice v měsíci na společném měřítku 0–{kc(axisMax)} Kč, oranžový proužek u dna =
        skutečné čerpání. Barevný proužek u levého okraje řádku = kampaň. Pole, ke kterým nemáte oprávnění,
        jsou zašedlá — o tom, co projde, rozhoduje server, ne prohlížeč.
      </div>
    </div>
  );
}

function BudgetCell({
  value, actual, max, type, disabled, onCommit,
}: {
  value: number; actual: number; max: number;
  type: string; disabled: boolean; onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value ? kc(value) : "0");
  const w = Math.min(100, (value / max) * 100);
  const aw = Math.min(100, (actual / max) * 100);
  return (
    <div
      style={{
        position: "relative", height: 26, borderRadius: 3, overflow: "hidden",
        background: value ? "var(--surface-2)" : "transparent",
        border: value ? "1px solid transparent" : "1px dashed var(--line-strong)",
      }}
    >
      {value > 0 && (
        <div style={{
          position: "absolute", inset: "0 auto 0 0", width: `${w}%`,
          background: `var(--${type.toLowerCase()}-fill, var(--${type.toLowerCase()}-soft))`,
        }} />
      )}
      {actual > 0 && (
        <div title={`čerpáno ${kc(actual)} Kč`} style={{
          position: "absolute", left: 0, bottom: 0, height: 3, width: `${aw}%`,
          background: "var(--bad-pure)", borderRadius: "0 1px 1px 0",
        }} />
      )}
      <input
        className="cell"
        inputMode="numeric"
        disabled={disabled}
        title={disabled ? "K tomuto rozpočtu nemáte oprávnění" : undefined}
        value={shown}
        onChange={(e) => setDraft(kc(parse(e.target.value)))}
        onBlur={() => { if (draft !== null) { onCommit(parse(draft)); setDraft(null); } }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        style={{ position: "relative", height: "100%", border: "none", background: "transparent" }}
      />
    </div>
  );
}

function MultiSelect({
  label, options, selected, onChange,
}: {
  label: string; options: string[]; selected: Set<string>; onChange: (s: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button
        className="btn"
        style={{ borderRadius: 999, borderColor: open ? "var(--brand)" : undefined }}
        onClick={() => setOpen((o) => !o)}
      >
        {label}{" "}
        {selected.size ? (
          <b style={{
            background: "var(--brand)", color: "#fff", borderRadius: 999,
            fontSize: 9.5, padding: "0 5px", marginLeft: 4,
          }}>{selected.size}</b>
        ) : (
          <span style={{ color: "var(--muted)", fontSize: 10.5 }}>vše</span>
        )}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 50 }} />
          <div style={{
            position: "absolute", zIndex: 60, top: "calc(100% + 4px)", left: 0, minWidth: 240,
            background: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: 5,
            boxShadow: "0 6px 20px rgba(0,0,0,.14)",
          }}>
            <div style={{ display: "flex", gap: 10, padding: "7px 10px", borderBottom: "1px solid var(--line)" }}>
              <button className="btn" style={{ border: "none", padding: 0, fontSize: 11, textDecoration: "underline" }}
                onClick={() => onChange(new Set(options))}>Vybrat vše</button>
              <button className="btn" style={{ border: "none", padding: 0, fontSize: 11, textDecoration: "underline" }}
                onClick={() => onChange(new Set())}>Zrušit</button>
            </div>
            <div style={{ maxHeight: 270, overflow: "auto", padding: 4 }}>
              {options.map((o) => (
                <label key={o} style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "4px 7px",
                  borderRadius: 3, cursor: "pointer", fontSize: 12,
                }}>
                  <input
                    type="checkbox"
                    checked={selected.has(o)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      e.target.checked ? next.add(o) : next.delete(o);
                      onChange(next);
                    }}
                  />
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
