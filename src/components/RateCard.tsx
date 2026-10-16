"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveRate } from "@/lib/actions";
import type { ChannelType } from "@/db/schema";

export type RateRow = {
  channelType: ChannelType;
  label: string;
  unit: "CPP" | "CPT";
  price: number | null;
  source: string;
  /** průměrná cena z položek plánu, které ji mají */
  suggested: number | null;
  /** kolik Kč v plánu čeká na cenu (média bez doručení) */
  waiting: number;
};

const kc = (n: number) => Math.round(n).toLocaleString("cs-CZ");
const mil = (n: number) => (n / 1e6).toLocaleString("cs-CZ", { maximumFractionDigits: 1 }) + " mil.";
const parse = (s: string) => Number(String(s).replace(/\s/g, "").replace(",", ".")) || 0;

/**
 * Ceník klienta. Položky zadané jen v Kč dostanou z něj odhad doručení —
 * v Plánu i v Přehledu označený jako odhad. Zadaná cena u položky má vždy přednost.
 */
export function RateCard({ planId, rows, canEdit }: { planId: string; rows: RateRow[]; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const commit = (r: RateRow, value: string, source = r.source) => {
    const price = value.trim() === "" ? null : parse(value);
    if (price !== null && price <= 0) { setError("Cena musí být kladné číslo."); return; }
    if (price === r.price && source === r.source) return;
    start(async () => {
      const res = await saveRate({ planId, channelType: r.channelType, price, source });
      if (!res.ok) setError(res.error); else { setError(null); router.refresh(); }
    });
  };

  return (
    <div className="panel" id="cenik" style={{ borderRadius: "var(--radius)", marginBottom: 12 }}>
      <div className="toolbar">
        <b style={{ fontSize: 13 }}>Ceník pro odhad doručení</b>
        <span className="share">cena za kontakt podle média · platí pro všechny plány klienta</span>
        <span className="spacer" />
        {pending && <span className="saving"><span className="spinner" />ukládám…</span>}
      </div>
      {error && <div className="banner" style={{ margin: 0, borderRadius: 0 }}><span>{error}</span></div>}
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Médium</th><th>Jednotka</th><th className="r" style={{ width: 130 }}>Cena (Kč)</th>
              <th className="r">Návrh z plánu</th><th className="r">Čeká na cenu</th><th>Zdroj</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const key = r.channelType;
              const shown = draft[key] ?? (r.price ? String(Math.round(r.price * 100) / 100).replace(".", ",") : "");
              return (
                <tr key={key}>
                  <td>{r.label}</td>
                  <td className="share">{r.unit === "CPP" ? "CPP · Kč za 1 GRP" : "CPT · Kč za 1 000 impresí"}</td>
                  <td className="r">
                    <input className="txt num" style={{ textAlign: "right", width: 110, border: "1px solid var(--line-strong)" }}
                      value={shown} disabled={!canEdit} inputMode="decimal" placeholder="—"
                      onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                      onBlur={(e) => { commit(r, e.target.value); setDraft(({ [key]: _, ...rest }) => rest); }}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                  </td>
                  <td className="r">
                    {r.suggested ? (
                      <>
                        <span className="num">{kc(r.suggested)}</span>
                        {canEdit && r.price === null && (
                          <button className="btn" style={{ marginLeft: 8, fontSize: 11, padding: "1px 8px" }}
                            onClick={() => commit(r, String(Math.round(r.suggested!)), "Průměr z položek plánu")}>Použít</button>
                        )}
                      </>
                    ) : <span className="share">—</span>}
                  </td>
                  <td className="r num" style={{ color: r.waiting && !r.price ? "var(--bad)" : undefined }}>
                    {r.waiting ? `${mil(r.waiting)} Kč` : "—"}
                  </td>
                  <td>
                    <input className="txt" disabled={!canEdit} defaultValue={r.source} placeholder={canEdit ? "odkud cena je" : ""}
                      key={`${key}-${r.source}`}
                      onBlur={(e) => { if (e.target.value !== r.source && r.price) commit(r, String(r.price), e.target.value); }} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="note">
        Stačí zadat cenu za kontakt — u položek, které mají v plánu jen Kč, se doručení dopočítá a zásah je pak
        označený jako odhad. Agenturní práce odhad nedostane. Cena zadaná přímo u položky má vždy přednost.
      </div>
    </div>
  );
}
