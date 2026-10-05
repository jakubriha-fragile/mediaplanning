"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveDuplication, resetDuplication } from "@/lib/actions";
import { K_MIN, K_MAX } from "@/lib/crossmedia";
import type { DuplicationRow } from "@/lib/queries";

const kTxt = (k: number) => k.toFixed(2).replace(".", ",");
const parseK = (s: string) => Number(String(s).replace(/\s/g, "").replace(",", "."));

/** Jednou větou, co hodnota znamená — plánovač nemusí znát teorii. */
function meaning(k: number) {
  if (Math.abs(k - 1) < 0.005) return "nezávislá publika";
  return k < 1 ? "publika se doplňují" : "publika se překrývají";
}

/**
 * Koeficienty duplikace pro všechny dvojice nosičů. Platí pro všechny plány —
 * změna se hned propíše do panelu zásahu v každém plánu, proto je u každé
 * vlastní hodnoty vidět výchozí a zdroj, a jde vrátit jedním klikem.
 */
export function DuplicationTable({ rows, canEdit }: { rows: DuplicationRow[]; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, { coef: string; source: string }>>({});
  const [onlyCustom, setOnlyCustom] = useState(false);

  const key = (r: DuplicationRow) => `${r.typeA}|${r.typeB}`;
  // nejdřív dvojice napříč nosiči, ty plánovač ladí nejčastěji
  const sorted = [...rows].sort((a, b) =>
    Number(a.typeA === a.typeB) - Number(b.typeA === b.typeB) || a.typeA.localeCompare(b.typeA, "cs") || a.typeB.localeCompare(b.typeB, "cs"));
  const shown = onlyCustom ? sorted.filter((r) => r.custom) : sorted;
  const customCount = rows.filter((r) => r.custom).length;

  const commit = (r: DuplicationRow) => {
    const d = draft[key(r)];
    if (!d) return;
    const coef = parseK(d.coef);
    if (!Number.isFinite(coef) || coef < K_MIN || coef > K_MAX) {
      setError(`Koeficient musí být mezi ${kTxt(K_MIN)} a ${kTxt(K_MAX)}.`);
      return;
    }
    if (coef === r.coef && d.source === r.source) {
      setDraft(({ [key(r)]: _, ...rest }) => rest);
      return;
    }
    start(async () => {
      const res = await saveDuplication({ typeA: r.typeA, typeB: r.typeB, coef, source: d.source });
      if (!res.ok) { setError(res.error); return; }
      setError(null);
      setDraft(({ [key(r)]: _, ...rest }) => rest);
      router.refresh();
    });
  };

  return (
    <div className="panel" style={{ borderRadius: "var(--radius)", marginBottom: 12 }}>
      <div className="toolbar">
        <b style={{ fontSize: 13 }}>Koeficienty duplikace (Sainsburyho k)</b>
        <span className="share">platí pro všechny plány · {customCount ? `${customCount} vlastních` : "zatím jen výchozí hodnoty"}</span>
        <span className="spacer" />
        {pending && <span className="saving"><span className="spinner" />ukládám…</span>}
        <label className="share">
          <input type="checkbox" checked={onlyCustom} onChange={(e) => setOnlyCustom(e.target.checked)} /> jen upravené
        </label>
      </div>

      {error && <div className="banner" style={{ margin: 0, borderRadius: 0 }}><span><b>Neuloženo.</b> {error}</span></div>}

      <div className="scroll" style={{ maxHeight: 460 }}>
        <table>
          <thead>
            <tr>
              <th>Dvojice nosičů</th>
              <th className="r" style={{ width: 90 }}>k</th>
              <th className="r" style={{ width: 80 }}>Výchozí</th>
              <th>Význam</th>
              <th>Zdroj</th>
              <th style={{ width: 90 }} />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const d = draft[key(r)];
              const coefTxt = d?.coef ?? kTxt(r.coef);
              const live = Number.isFinite(parseK(coefTxt)) ? parseK(coefTxt) : r.coef;
              const edit = (p: Partial<{ coef: string; source: string }>) =>
                setDraft((x) => ({ ...x, [key(r)]: { coef: coefTxt, source: d?.source ?? r.source, ...p } }));
              return (
                <tr key={key(r)}>
                  <td>
                    {r.typeA === r.typeB ? <>{r.typeA} <span className="share">uvnitř nosiče</span></> : <>{r.typeA} × {r.typeB}</>}
                  </td>
                  <td className="r">
                    <input className="txt num" style={{ textAlign: "right", width: 64, fontWeight: r.custom ? 500 : undefined }}
                      value={coefTxt} disabled={!canEdit} inputMode="decimal"
                      onChange={(e) => edit({ coef: e.target.value })}
                      onBlur={() => commit(r)}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                  </td>
                  <td className="r share num">{kTxt(r.defaultCoef)}</td>
                  <td className="share">{meaning(live)}</td>
                  <td>
                    <input className="txt" style={{ width: "100%", minWidth: 180 }} placeholder={canEdit ? "odkud hodnota je" : ""}
                      value={d?.source ?? r.source} disabled={!canEdit}
                      onChange={(e) => edit({ source: e.target.value })}
                      onBlur={() => commit(r)}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                  </td>
                  <td>
                    {canEdit && r.custom && (
                      <button className="btn" style={{ fontSize: 11, padding: "1px 8px" }} title="Vrátit na výchozí hodnotu"
                        onClick={() => start(async () => {
                          const res = await resetDuplication({ typeA: r.typeA, typeB: r.typeB });
                          if (!res.ok) setError(res.error); else { setError(null); router.refresh(); }
                        })}>↺ výchozí</button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!shown.length && (
              <tr><td colSpan={6} style={{ padding: 18, textAlign: "center", color: "var(--muted)" }}>
                Žádný koeficient zatím není upravený.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="note">
        Výchozí hodnoty jsou odhad z veřejných dat, ne měření — před použitím u klienta patří zkalibrovat
        na single-source panel a nechat validovat media specialistou. Kalibrovaná hodnota se uloží i se
        zdrojem a změna se zapíše do historie.
      </div>
    </div>
  );
}
