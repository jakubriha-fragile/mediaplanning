"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { combineReach, dupKey, kFromMeasured, K_MIN, K_MAX, type ReachPart } from "@/lib/crossmedia";
import { saveDuplication } from "@/lib/actions";
import { pct, big } from "@/lib/period";
import type { ChannelType } from "@/db/schema";

export type CalcSource = {
  planId: string;
  month: string | null;
  label: string;
  months: Array<{ value: string; label: string }>;
  universe: number;
  targetGroupName: string;
  parts: Array<{ channelType: ChannelType; reach: number; grp: number }>;
};

const CHANNEL_TYPES: ChannelType[] = ["TV", "Rádio", "OOH", "Print", "Kino", "Digital", "Vlastní", "PR"];

type Row = { id: number; label: string; channelType: ChannelType; reach: string };

/** „69", „69,5" i „69 %" → 0,69 / 0,695. Prázdné = médium se nepoužije. */
const parsePct = (s: string) => {
  const n = Number(String(s).replace(/\s|%/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100) / 100 : 0;
};
const showPct = (r: number) => (r ? (Math.round(r * 1000) / 10).toString().replace(".", ",") : "");
const kTxt = (k: number | null) => (k === null ? "—" : k.toFixed(2).replace(".", ","));
const pp = (d: number) => `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(1).replace(".", ",")} p.b.`;

const inputStyle: React.CSSProperties = {
  font: "inherit", fontSize: 12.5, padding: "4px 8px", border: "1px solid var(--line-strong)",
  borderRadius: 4, background: "var(--surface)", color: "var(--ink)",
};

let seq = 0;
const rowsFrom = (source: CalcSource | null): Row[] =>
  source && source.parts.length
    ? source.parts.map((p) => ({ id: ++seq, label: p.channelType, channelType: p.channelType, reach: showPct(p.reach) }))
    // výchozí příklad z kalkulačky v Excelu, ať je hned co zkoušet
    : [
        { id: ++seq, label: "TV", channelType: "TV", reach: "69" },
        { id: ++seq, label: "Online", channelType: "Digital", reach: "45" },
        { id: ++seq, label: "OOH", channelType: "OOH", reach: "30" },
        { id: ++seq, label: "Rádio", channelType: "Rádio", reach: "20" },
      ];

/**
 * Sekvenční Sainsburyho kombinace zásahu — stejná matematika jako panel
 * zásahu v plánu (combineReach), jen se zásahy zadávají nebo upravují ručně.
 */
export function ReachCalculator({
  plans, source, dup, canCalibrate,
}: {
  plans: Array<{ id: string; label: string }>;
  source: CalcSource | null;
  dup: Array<{ typeA: ChannelType; typeB: ChannelType; coef: number }>;
  canCalibrate: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(() => rowsFrom(source));
  const [touched, setTouched] = useState(false);
  const [universe, setUniverse] = useState(source?.universe ? String(source.universe) : "3300000");

  const table = useMemo(() => Object.fromEntries(dup.map((d) => [dupKey(d.typeA, d.typeB), d.coef])), [dup]);
  const parts: ReachPart[] = rows
    .map((r) => ({ channelType: r.channelType, reach: parsePct(r.reach), label: r.label || r.channelType }))
    .filter((p) => p.reach > 0);
  const c = combineReach(parts, table);
  const naive = Math.min(1, c.gross);
  const U = Number(universe.replace(/\D/g, "")) || 0;

  const patch = (id: number, p: Partial<Row>) => {
    setTouched(true);
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
  };
  const go = (plan: string, mesic: string) => {
    const q = new URLSearchParams();
    if (plan) q.set("plan", plan);
    if (plan && mesic) q.set("mesic", mesic);
    router.push(`/kalkulacka${q.size ? `?${q}` : ""}`);
  };

  return (
    <>
      <div className="panel" style={{ borderRadius: "var(--radius)", marginBottom: 12 }}>
        <div className="toolbar">
          <b style={{ fontSize: 13 }}>Kalkulačka cross-mediálního zásahu</b>
          <span className="share">Sainsburyho model, sekvenční kombinace</span>
          <span className="spacer" />
          <label className="share">
            Načíst z plánu{" "}
            <select value={source?.planId ?? ""} onChange={(e) => go(e.target.value, "")} style={inputStyle}>
              <option value="">— ruční zadání —</option>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          {source && (
            <select value={source.month ?? ""} onChange={(e) => go(source.planId, e.target.value)} style={inputStyle}>
              <option value="">celé období</option>
              {source.months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          )}
        </div>

        {source && (
          <div className="banner info" style={{ margin: 0, borderRadius: 0 }}>
            <span>
              {source.parts.length ? (
                <>Zásahy nosičů načtené z plánu <b>{source.label}</b> · {source.targetGroupName}.</>
              ) : (
                <>Plán <b>{source.label}</b> zatím nemá v tomto období žádný zásah — doplňte rozpočty nebo GRP,
                  nebo zadejte média ručně.</>
              )}
              {touched && <> Hodnoty jste upravili ručně — do plánu se nic nezapisuje.</>}
              {" "}
              {touched && (
                <button className="btn" style={{ fontSize: 11, padding: "1px 8px" }}
                  onClick={() => { setRows(rowsFrom(source)); setTouched(false); }}>
                  Vrátit hodnoty z plánu
                </button>
              )}
            </span>
          </div>
        )}

        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Médium</th>
                <th>Nosič</th>
                <th className="r" style={{ width: 110 }}>Zásah R<sub>i</sub> (%)</th>
                <th style={{ width: 30 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><input className="txt" value={r.label} placeholder="název"
                    onChange={(e) => patch(r.id, { label: e.target.value })} /></td>
                  <td>
                    <select className="txt" value={r.channelType}
                      title="Podle nosiče se vybírá koeficient duplikace"
                      onChange={(e) => patch(r.id, { channelType: e.target.value as ChannelType })}>
                      {CHANNEL_TYPES.map((t) => <option key={t}>{t}</option>)}
                    </select>
                  </td>
                  <td className="r"><input className="txt num" style={{ textAlign: "right", width: 80 }}
                    value={r.reach} inputMode="decimal" placeholder="0"
                    onChange={(e) => patch(r.id, { reach: e.target.value })} /></td>
                  <td>
                    <button className="btn danger" style={{ fontSize: 11, padding: "1px 7px" }} title="Odebrat médium"
                      onClick={() => { setTouched(true); setRows((rs) => rs.filter((x) => x.id !== r.id)); }}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="toolbar" style={{ borderTop: "1px solid var(--line)" }}>
          <button className="btn" onClick={() => {
            setTouched(true);
            setRows((rs) => [...rs, { id: ++seq, label: "", channelType: "Digital", reach: "" }]);
          }}>+ Přidat médium</button>
          <span className="spacer" />
          <label className="share">
            Velikost cílové skupiny{" "}
            <input value={universe} onChange={(e) => setUniverse(e.target.value)} inputMode="numeric"
              style={{ ...inputStyle, width: 110, textAlign: "right" }} /> osob
          </label>
        </div>
      </div>

      <div className="kpis">
        <div className="kpi">
          <div className="k">Cross-mediální zásah</div>
          <div className="v num">{pct(c.net)}</div>
          <div className="d num">{U ? `${big(c.net * U)} osob` : "Sainsbury s koeficienty"}</div>
        </div>
        <div className="kpi">
          <div className="k">Nezávislost (k = 1)</div>
          <div className="v num">{pct(c.independent)}</div>
          <div className="d num">rozdíl {pp(c.net - c.independent)}</div>
        </div>
        <div className="kpi">
          <div className="k">Naivní součet</div>
          <div className="v num">{pct(naive)}</div>
          <div className="d num">rozdíl {pp(c.net - naive)}</div>
        </div>
        <div className="kpi">
          <div className="k">Překryv</div>
          <div className="v num">{pct(c.overlap)}</div>
          <div className="d">počítáno dvakrát</div>
        </div>
      </div>

      <div className="panel" style={{ borderRadius: "var(--radius)", marginBottom: 12 }}>
        <div className="toolbar"><b style={{ fontSize: 13 }}>Kombinace krok za krokem</b>
          <span className="share">od nejsilnějšího média</span></div>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Krok</th>
                <th>Médium</th>
                <th className="r">Zásah R<sub>i</sub></th>
                <th className="r" title="Průměr párových koeficientů vůči médiím, která už jsou v mixu, vážený jejich zásahem">k použité</th>
                <th className="r">Kumulativní zásah</th>
                <th className="r">Překryv v kroku</th>
                <th className="r">Přírůstek</th>
                <th className="r">Při nezávislosti</th>
              </tr>
            </thead>
            <tbody>
              {c.steps.map((s, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{s.part.label} <span className="share">{s.part.label !== s.part.channelType ? s.part.channelType : ""}</span></td>
                  <td className="r num">{pct(s.part.reach)}</td>
                  <td className="r num">{kTxt(s.k)}</td>
                  <td className="r num"><b>{pct(s.cumulative)}</b></td>
                  <td className="r share num">{i ? pct(s.overlap) : "—"}</td>
                  <td className="r num">{pct(s.increment)}</td>
                  <td className="r share num">{pct(s.independent)}</td>
                </tr>
              ))}
              {!c.steps.length && (
                <tr><td colSpan={8} style={{ padding: 18, textAlign: "center", color: "var(--muted)" }}>
                  Zadejte zásah aspoň jednoho média.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="note">
          <b>Jak se to počítá.</b> R<sub>1+2</sub> = R<sub>1</sub> + R<sub>2</sub> − k × R<sub>1</sub> × R<sub>2</sub>,
          a výsledek se stejně kombinuje s dalším médiem. k = 1 znamená nezávislá publika, k &lt; 1 publika
          se doplňují, k &gt; 1 se překrývají víc, než by odpovídalo náhodě. Na rozdíl od kalkulačky v Excelu
          tu <b>nezáleží na pořadí</b>: média se řadí od nejsilnějšího a k každého kroku je průměr párových
          koeficientů vůči tomu, co už je v mixu. Překryv nikdy nepřesáhne menší z obou zásahů.
          <br />
          <b>Jde o modelový odhad, ne o měření.</b> Přesná deduplikace vyžaduje single-source panelová data.
          Před sdílením s klientem patří výsledek validovat media specialistou.
        </div>
      </div>

      <KFromData canCalibrate={canCalibrate} table={table} onSaved={() => router.refresh()} />
    </>
  );
}

/** Dopočet koeficientu ze dvou naměřených zásahů a naměřeného společného zásahu. */
function KFromData({
  canCalibrate, table, onSaved,
}: {
  canCalibrate: boolean;
  table: Record<string, number>;
  onSaved: () => void;
}) {
  const [a, setA] = useState<ChannelType>("TV");
  const [b, setB] = useState<ChannelType>("Digital");
  const [ra, setRa] = useState("69");
  const [rb, setRb] = useState("45");
  const [rab, setRab] = useState("83");
  const [src, setSrc] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const res = kFromMeasured(parsePct(ra), parsePct(rb), parsePct(rab));
  const current = table[dupKey(a, b)] ?? 1;
  const outOfRange = res.ok && (res.k < K_MIN || res.k > K_MAX);

  return (
    <div className="panel" style={{ borderRadius: "var(--radius)", marginBottom: 12 }}>
      <div className="toolbar">
        <b style={{ fontSize: 13 }}>Dopočet koeficientu z naměřených dat</b>
        <span className="share">k = (R<sub>A</sub> + R<sub>B</sub> − R<sub>A+B</sub>) / (R<sub>A</sub> × R<sub>B</sub>)</span>
      </div>
      <div style={{ padding: "12px 14px", display: "flex", gap: 14, flexWrap: "wrap", alignItems: "end" }}>
        <label className="share">Nosič A<br />
          <select value={a} onChange={(e) => setA(e.target.value as ChannelType)} style={inputStyle}>
            {CHANNEL_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select></label>
        <label className="share">Zásah A (%)<br />
          <input value={ra} onChange={(e) => setRa(e.target.value)} inputMode="decimal" style={{ ...inputStyle, width: 70 }} /></label>
        <label className="share">Nosič B<br />
          <select value={b} onChange={(e) => setB(e.target.value as ChannelType)} style={inputStyle}>
            {CHANNEL_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select></label>
        <label className="share">Zásah B (%)<br />
          <input value={rb} onChange={(e) => setRb(e.target.value)} inputMode="decimal" style={{ ...inputStyle, width: 70 }} /></label>
        <label className="share">Naměřený společný zásah A+B (%)<br />
          <input value={rab} onChange={(e) => setRab(e.target.value)} inputMode="decimal" style={{ ...inputStyle, width: 70 }} /></label>
        <div>
          <div className="share">Dopočtené k</div>
          <div style={{ fontSize: 22, fontWeight: 200 }} className="num">{res.ok ? kTxt(res.k) : "—"}</div>
        </div>
        <div className="share" style={{ paddingBottom: 4 }}>
          teď platí {a}×{b} = <b>{kTxt(current)}</b>
        </div>
      </div>
      {!res.ok && <div className="banner" style={{ margin: 0, borderRadius: 0 }}><span>{res.error}</span></div>}
      {outOfRange && (
        <div className="banner" style={{ margin: 0, borderRadius: 0 }}>
          <span>Koeficient mimo rozumné meze {kTxt(K_MIN)}–{kTxt(K_MAX)} — skoro jistě jde o chybu v datech, uložit ho nejde.</span>
        </div>
      )}
      {canCalibrate && res.ok && !outOfRange && (
        <div className="toolbar" style={{ borderTop: "1px solid var(--line)" }}>
          <input value={src} onChange={(e) => setSrc(e.target.value)} placeholder="zdroj dat, např. ATO-Nielsen cross-media 2026"
            style={{ ...inputStyle, minWidth: 320 }} />
          <button className="btn primary" disabled={pending} onClick={() => start(async () => {
            const r = await saveDuplication({ typeA: a, typeB: b, coef: Math.round(res.k * 1000) / 1000, source: src });
            setMsg(r.ok ? { ok: true, text: `Uloženo: ${a}×${b} = ${kTxt(res.k)}. Platí pro všechny plány.` }
              : { ok: false, text: r.error });
            if (r.ok) onSaved();
          })}>Uložit jako koeficient {a}×{b}</button>
          {pending && <span className="saving"><span className="spinner" />ukládám…</span>}
          {msg && <span className="share" style={{ color: msg.ok ? "var(--good, inherit)" : "var(--bad)" }}>{msg.text}</span>}
        </div>
      )}
    </div>
  );
}
