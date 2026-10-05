"use client";

import { useState } from "react";
import type { ReachSummary } from "@/lib/queries";
import { kc, big, pct, monthShort } from "@/lib/period";
import { effectiveReach, frequencyOf } from "@/lib/crossmedia";

const TYPE_COLOR: Record<string, string> = {
  TV: "#382ea8",
  Rádio: "#0e8f9e",
  OOH: "#b87d0c",
  Print: "#8b5fd6",
  Kino: "#c2477e",
  Digital: "#4a3fc4",
  Vlastní: "#5f8b1f",
  PR: "#b8502a",
};

const freq = (f: number) => (f ? f.toFixed(1).replace(".", ",") + "×" : "—");

/** Kolik kontaktů už se počítá jako účinný zásah — 3+ je zvyk, ne zákon. */
const MIN_CONTACTS = [2, 3, 4, 5] as const;

/**
 * Cross-mediální zásah a překryv.
 *
 * Součet dílčích zásahů není zásah kampaně — část lidí vidí TV i online.
 * Panel ukazuje obojí vedle sebe, aby bylo poznat, kolik se počítá dvakrát.
 */
export function ReachPanel({
  planId, showCalculator, months, total, universe, hasUniverse, targetGroupName,
}: {
  planId: string;
  /** klient kalkulačku nevidí — koeficienty jsou know-how agentury */
  showCalculator: boolean;
  months: ReachSummary[];
  total: ReachSummary;
  universe: number;
  hasUniverse: boolean;
  targetGroupName: string;
}) {
  const [open, setOpen] = useState(true);
  const [minC, setMinC] = useState<number>(3);

  if (!hasUniverse) {
    return (
      <div className="banner info">
        <span>
          <b>Zásah se zatím nepočítá.</b> Plán nemá přiřazenou cílovou skupinu s velikostí
          (universum). Doplňte ji v <a href="/nastaveni">Nastavení</a> — bez ní nejde převést GRP
          na impressions ani spočítat překryv.
        </span>
      </div>
    );
  }

  // frekvence napříč médii = všechny kontakty / čistý zásah; efektivní zásah
  // se počítá z čistého, ne ze součtu médií — jinak by překryv počítal dvakrát
  const totalFreq = frequencyOf(total.grp, total.net);
  const totalEff = effectiveReach(total.net, totalFreq, minC);

  const live = months.filter((m) => m.net > 0);
  const peak = Math.max(0.01, ...months.map((m) => m.gross));
  // prázdné měsíce by jen natahovaly panel — ukazujeme jen ty, kde se plánuje

  return (
    <div className="panel" style={{ borderRadius: "var(--radius)", marginBottom: 10 }}>
      <div className="toolbar">
        <button className="btn" onClick={() => setOpen((o) => !o)} style={{ borderRadius: 999 }}>
          {open ? "▾" : "▸"} Cross-mediální zásah
        </button>
        <span className="share">
          {targetGroupName} · universum {big(universe)} osob
        </span>
        <span className="spacer" />
        {showCalculator && <a className="btn" href={`/kalkulacka?plan=${planId}`} style={{ fontSize: 11, padding: "2px 9px" }}
          title="Otevře Sainsburyho kalkulačku s nosiči tohoto plánu — co kdyby">Otevřít v kalkulačce</a>}
        <span className="share">
          čistý zásah za období <b style={{ color: "var(--brand-ink)" }}>{pct(total.net)}</b>
          {" "}({big(total.people)} osob) · {minC}+ {pct(totalEff)} · překryv {pct(total.overlap)}
        </span>
      </div>

      {open && (
        <>
          <div className="kpis" style={{ margin: 0, border: 0, borderRadius: 0, borderBottom: "1px solid var(--line)" }}>
            <div className="kpi">
              <div className="k">Čistý zásah</div>
              <div className="v num">{pct(total.net)}</div>
              <div className="d num">{big(total.people)} osob</div>
            </div>
            <div className="kpi">
              <div className="k">
                Efektivní zásah{" "}
                <select value={minC} onChange={(e) => setMinC(Number(e.target.value))}
                  title="Kolik kontaktů se počítá jako účinný zásah"
                  style={{ font: "inherit", fontSize: 10.5, border: "1px solid var(--line-strong)",
                    borderRadius: 3, background: "var(--surface)", color: "var(--ink)", padding: "0 2px" }}>
                  {MIN_CONTACTS.map((n) => <option key={n} value={n}>{n}+</option>)}
                </select>
              </div>
              <div className="v num">{pct(totalEff)}</div>
              <div className="d num">{big(totalEff * universe)} osob · frekvence {freq(totalFreq)}</div>
            </div>
            <div className="kpi">
              <div className="k">Součet médií</div>
              <div className="v num">{pct(total.gross)}</div>
              <div className="d">kdyby se nepřekrývala</div>
            </div>
            <div className="kpi">
              <div className="k">Při nezávislosti</div>
              <div className="v num">{pct(total.independent)}</div>
              <div className="d">k = 1 pro všechny dvojice</div>
            </div>
            <div className="kpi">
              <div className="k">Překryv</div>
              <div className="v num">{pct(total.overlap)}</div>
              <div className="d">počítáno dvakrát</div>
            </div>
            <div className="kpi">
              <div className="k">GRP celkem</div>
              <div className="v num">{Math.round(total.grp).toLocaleString("cs-CZ")}</div>
              <div className="d num">{big(total.impressions)} imp.</div>
            </div>
            <div className="kpi">
              <div className="k">Cena za bod zásahu</div>
              <div className="v num">{total.net > 0 ? <>{kc(total.budget / (total.net * 100))}<span className="cur">Kč</span></> : "—"}</div>
              <div className="d">za 1 % čistého zásahu</div>
            </div>
          </div>

          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Nosič</th>
                  <th className="r">GRP</th>
                  <th className="r">Zásah</th>
                  <th className="r">Frekvence</th>
                  <th className="r">Zásah {minC}+</th>
                  <th className="r">Rozpočet (Kč)</th>
                  <th className="r">Podíl rozpočtu</th>
                  <th style={{ width: "32%" }}>Podíl na zásahu</th>
                </tr>
              </thead>
              <tbody>
                {total.byType.map((b) => (
                  <tr key={b.channelType}>
                    <td>
                      <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2,
                        background: TYPE_COLOR[b.channelType] ?? "var(--brand)", marginRight: 7 }} />
                      {b.channelType}
                    </td>
                    <td className="r num">{Math.round(b.grp).toLocaleString("cs-CZ")}</td>
                    <td className="r num">{pct(b.reach)}</td>
                    <td className="r share num">{freq(frequencyOf(b.grp, b.reach))}</td>
                    <td className="r num">{pct(effectiveReach(b.reach, frequencyOf(b.grp, b.reach), minC))}</td>
                    <td className="r num">{kc(b.budget)}</td>
                    <td className="r share num">{total.budget ? pct(b.budget / total.budget) : "—"}</td>
                    <td>
                      <div className="minibar">
                        <div style={{ width: `${Math.min(100, (b.reach / Math.max(0.01, total.gross)) * 100)}%`,
                          background: TYPE_COLOR[b.channelType] ?? "var(--brand)" }} />
                      </div>
                    </td>
                  </tr>
                ))}
                {!total.byType.length && (
                  <tr><td colSpan={8} style={{ padding: 18, textAlign: "center", color: "var(--muted)" }}>
                    Zatím není co počítat — doplňte do plánu rozpočty nebo GRP.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          {live.length > 1 && (
            <div className="scroll" style={{ borderTop: "1px solid var(--line)" }}>
              <table>
                <thead>
                  <tr>
                    <th>Měsíc</th>
                    <th className="r">Čistý zásah</th>
                    <th className="r">Zásah {minC}+</th>
                    <th className="r">Překryv</th>
                    <th className="r">GRP</th>
                    <th className="r">Rozpočet (Kč)</th>
                    <th style={{ width: "40%" }}>Čistý zásah vs. součet médií</th>
                  </tr>
                </thead>
                <tbody>
                  {live.map((m) => (
                    <tr key={m.month}>
                      <td>{monthShort(m.month)}</td>
                      <td className="r num">{m.net ? pct(m.net) : "—"}</td>
                      <td className="r num">{m.net ? pct(effectiveReach(m.net, frequencyOf(m.grp, m.net), minC)) : "—"}</td>
                      <td className="r share num">{m.overlap ? pct(m.overlap) : "—"}</td>
                      <td className="r num">{m.grp ? Math.round(m.grp).toLocaleString("cs-CZ") : "—"}</td>
                      <td className="r num">{m.budget ? kc(m.budget) : "—"}</td>
                      <td>
                        <div className="minibar stack" title={`čistý ${pct(m.net)} · součet ${pct(m.gross)}`}>
                          <div className="gross" style={{ width: `${(m.gross / peak) * 100}%` }} />
                          <div style={{ width: `${(m.net / peak) * 100}%`, background: "var(--brand)" }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="note">
            <b>Jak se to počítá.</b> Z rozpočtu nebo GRP se přes universum cílové skupiny dopočítají
            impressions, z nich křivkou zásahu dílčí zásah každého nosiče. Ty se pak skládají od
            nejsilnějšího média: každé další přidá svůj zásah minus překryv s tím, co už je pokryté.
            Efektivní zásah předpokládá Poissonovo rozdělení kontaktů mezi zasaženými; reálné
            rozdělení bývá šikmější, takže skutečný podíl {minC}+ může vyjít o něco nižší.
            <br />
            <b>Jde o modelový odhad, ne o měření.</b> Přesná deduplikace vyžaduje single-source
            panelová data. Křivky zásahu i duplikační koeficienty jsou zatím výchozí hodnoty —
            koeficienty se upravují v {showCalculator ? <a href="/kalkulacka">Kalkulačce zásahu</a> : "Kalkulačce zásahu"}{" "}
            a před prvním použitím u klienta patří zkalibrovat na panelový zdroj a nechat validovat
            media specialistou.
          </div>
        </>
      )}
    </div>
  );
}
