"use client";

import { useState, useTransition } from "react";
import { saveTargetGroup } from "@/lib/actions";
import { kc } from "@/lib/period";

export type TargetGroupRow = {
  id: string;
  name: string;
  universe: number;
  source: string;
  note: string;
};

/**
 * Universum je ta hodnota, na které stojí celé cross-mediální plánování.
 * Dokud je špatně, je špatně i zásah, frekvence a převod GRP na impressions —
 * proto je editovatelná a u každé skupiny je vidět zdroj.
 */
export function TargetGroups({ rows, canEdit }: { rows: TargetGroupRow[]; canEdit: boolean }) {
  const [data, setData] = useState(rows);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const save = (r: TargetGroupRow, patch: Partial<TargetGroupRow>) => {
    const next = { ...r, ...patch };
    setData((d) => d.map((x) => (x.id === r.id ? next : x)));
    startTransition(async () => {
      const res = await saveTargetGroup({
        id: next.id, name: next.name, universe: next.universe,
        source: next.source, note: next.note, clientId: null,
      });
      if (!res.ok) { setData(rows); setError(res.error ?? "Uložení se nezdařilo."); }
      else setError(null);
    });
  };

  return (
    <div className="panel" style={{ borderRadius: "var(--radius)", marginBottom: 16 }}>
      <div className="toolbar">
        <b style={{ fontSize: 13 }}>Cílové skupiny a universa</b>
        <span className="spacer" />
        {pending && <span className="saving"><span className="spinner" />ukládám…</span>}
        {canEdit && !adding && (
          <button className="btn" onClick={() => setAdding(true)}>+ Přidat skupinu</button>
        )}
      </div>

      {error && <div className="banner" style={{ margin: 0, borderRadius: 0 }}><span><b>Zápis odmítnut.</b> {error}</span></div>}

      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Název</th>
              <th className="r" style={{ width: 150 }}>Universum (osob)</th>
              <th>Zdroj</th>
              <th>Poznámka</th>
            </tr>
          </thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.id}>
                <td>
                  <input className="txt" defaultValue={r.name} disabled={!canEdit}
                    onBlur={(e) => e.target.value !== r.name && save(r, { name: e.target.value })} />
                </td>
                <td className="r">
                  <input className="cell num" inputMode="numeric" disabled={!canEdit}
                    defaultValue={r.universe ? kc(r.universe) : ""}
                    style={{ textAlign: "right" }}
                    onFocus={(e) => { e.target.value = String(r.universe || ""); e.target.select(); }}
                    onBlur={(e) => {
                      const v = Number(e.target.value.replace(/[^\d]/g, "")) || 0;
                      e.target.value = v ? kc(v) : "";
                      if (v !== r.universe) save(r, { universe: v });
                    }} />
                </td>
                <td style={{ maxWidth: 280 }}>
                  <input className="txt" defaultValue={r.source} disabled={!canEdit} placeholder="odkud číslo je"
                    onBlur={(e) => e.target.value !== r.source && save(r, { source: e.target.value })} />
                </td>
                <td style={{ maxWidth: 240 }}>
                  <input className="txt" defaultValue={r.note} disabled={!canEdit}
                    onBlur={(e) => e.target.value !== r.note && save(r, { note: e.target.value })} />
                </td>
              </tr>
            ))}
            {adding && (
              <NewRow
                onCancel={() => setAdding(false)}
                onSave={(name, universe) => {
                  setAdding(false);
                  startTransition(async () => {
                    const res = await saveTargetGroup({ name, universe, clientId: null, source: "", note: "" });
                    if (!res.ok) setError(res.error ?? "Založení se nezdařilo.");
                  });
                }} />
            )}
          </tbody>
        </table>
      </div>

      <div className="note">
        Universum = kolik lidí v cílové skupině celkem je. Z něj se počítá převod mezi GRP
        a impressions i čistý zásah — bez něj plán ukáže jen peníze.
        <br />
        <b>Výchozí hodnoty jsou odhady z veřejné demografie</b>, ne panelová data. Než s plánem
        půjdete ke klientovi, nahraďte je čísly ze zdroje, který používáte (Nielsen Admosphere,
        SKMO), a uveďte ho do sloupce Zdroj.
      </div>
    </div>
  );
}

function NewRow({ onSave, onCancel }: { onSave: (n: string, u: number) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [uni, setUni] = useState("");
  return (
    <tr>
      <td>
        <input className="txt" autoFocus placeholder="např. Ženy 25–44" value={name}
          onChange={(e) => setName(e.target.value)} />
      </td>
      <td className="r">
        <input className="cell num" inputMode="numeric" placeholder="0" value={uni}
          style={{ textAlign: "right" }}
          onChange={(e) => setUni(e.target.value.replace(/[^\d]/g, ""))} />
      </td>
      <td colSpan={2}>
        <button className="btn primary" disabled={!name.trim()}
          onClick={() => onSave(name.trim(), Number(uni) || 0)}>Založit</button>
        <button className="btn" style={{ marginLeft: 6 }} onClick={onCancel}>Zrušit</button>
      </td>
    </tr>
  );
}
