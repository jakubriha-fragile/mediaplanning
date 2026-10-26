"use client";

import { Fragment, useState } from "react";
import type { Mix, MixChannel } from "@/lib/mix";
import { kc, big, pct0 } from "@/lib/period";

const COLOR: Record<string, string> = {
  TV: "var(--m-tv)", Digital: "var(--m-digital)", "Rádio": "var(--m-radio)", OOH: "var(--m-ooh)",
};
const colorOf = (t: string) => COLOR[t] ?? "var(--m-other)";
const LABEL: Record<string, string> = { Digital: "Online", OOH: "OOH a partnerství" };
const labelOf = (t: string) => LABEL[t] ?? t;
const KIND: Record<string, string> = { media: "média", fee: "agenturní práce", mixed: "média + práce" };

const mil = (n: number) => (n / 1_000_000).toLocaleString("cs-CZ", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

/** Doručení tak, jak o něm mluví plánovač: TV a rádio v TRP, online v impresích. */
function delivery(c: MixChannel) {
  if (c.type === "TV" || c.type === "Rádio") return c.grp > 0 ? `${kc(c.grp)} TRP` : "—";
  return c.impressions > 0 ? `${big(c.impressions)} imp.` : "—";
}

/**
 * Finální mix — souhrn plánu ke schválení a sdílení. Jen čtení.
 * Klient nevidí ceny za jednotku (CPP/CPT) ani agenturní rozpad nákladů.
 */
export function MixView({
  mix, planName, period, tgName, status, monthLabels, clientView,
}: {
  mix: Mix;
  planName: string;
  period: string;
  tgName: string;
  status: string;
  monthLabels: Record<string, string>;
  clientView: boolean;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const { total, channels, months } = mix;
  const maxCell = Math.max(1, ...channels.flatMap((c) => months.map((m) => c.byMonth[m] ?? 0)));
  const toggle = (t: string) => setOpen((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  const share = (n: number) => (total.cost ? n / total.cost : 0);

  if (!channels.length) {
    return <div className="banner info"><span><b>V plánu zatím nejsou žádné částky.</b> Finální mix se složí sám, jakmile budou v Plánování rozpočty.</span></div>;
  }

  return (
    <div className="mix">
      <div className="db-head">
        <div>
          <h2 className="db-title">Finální mix</h2>
          <p className="db-meta">{planName} · {period} · cílová skupina {tgName} · stav: {status}</p>
        </div>
        <button className="btn noprint" onClick={() => window.print()}>Tisk / PDF</button>
      </div>

      {mix.partial && (
        <div className="banner info"><span><b>Vidíte jen část plánu.</b> Součty jsou jen za položky, ke kterým máte přístup.</span></div>
      )}

      <div className="mix-kpis">
        <div className="mix-kpi">
          <div className="k">Rozpočet celkem</div>
          <div className="v">{mil(total.cost)}<span className="cur">mil. Kč</span></div>
          <div className="d">{clientView ? "vč. agenturního fee" : `z toho agenturní práce ${mil(total.fee)} mil. Kč`}</div>
        </div>
        {mix.groups.map((g) => (
          <div className="mix-kpi" key={g.group}>
            <div className="k">{g.group === "offline" ? "Offline" : "Online"}</div>
            <div className="v">{pct0(share(g.cost))}</div>
            <div className="d">{mil(g.cost)} mil. Kč</div>
          </div>
        ))}
        <div className="mix-kpi">
          <div className="k">Zásah 1+ za období</div>
          <div className="v">{total.reach > 0 ? pct0(total.reach) : "—"}</div>
          <div className="d">{total.people > 0 ? `≈ ${big(total.people)} lidí · modelový odhad` : "chybí data o doručení"}</div>
        </div>
      </div>

      <div className="db-card">
        <h3>Rozdělení rozpočtu</h3>
        <div className="mix-bar" role="img" aria-label="Podíl médií na rozpočtu">
          {channels.map((c) => (
            <span key={c.type} style={{ width: `${share(c.cost) * 100}%`, background: colorOf(c.type) }}
              title={`${labelOf(c.type)}: ${kc(c.cost)} Kč (${pct0(share(c.cost))})`} />
          ))}
        </div>
        <div className="mix-legend">
          {channels.map((c) => (
            <span key={c.type}><i className="db-sw" style={{ background: colorOf(c.type) }} />{labelOf(c.type)} <b>{pct0(share(c.cost))}</b></span>
          ))}
        </div>
      </div>

      <div className="db-card" style={{ padding: 0 }}>
        <div style={{ padding: "16px 20px 8px" }}>
          <h3>Mediamix a načasování</h3>
          <div className="share">Klikněte na médium pro rozpad na položky. Odstín buňky = výše rozpočtu v měsíci.</div>
        </div>
        <div className="scroll">
          <table className="mixtable">
            <thead>
              <tr>
                <th>Médium</th>
                <th className="r">Rozpočet</th>
                <th className="r">Podíl</th>
                <th className="r">Doručení</th>
                {!clientView && <th className="r" title="CPP u TV a rádia (Kč za GRP), jinak CPT (Kč za tisíc impresí)">Cena / jedn.</th>}
                <th className="r">Zásah 1+</th>
                {months.map((m) => <th key={m} className="c mixm">{monthLabels[m]}</th>)}
              </tr>
            </thead>
            <tbody>
              {(["offline", "online"] as const).map((g) => {
                const list = channels.filter((c) => c.group === g);
                if (!list.length) return null;
                const sum = list.reduce((s, c) => s + c.cost, 0);
                return (
                  <Fragment key={g}>
                    <tr className="grp">
                      <td>{g === "offline" ? "Offline" : "Online"}</td>
                      <td className="r num">{kc(sum)}</td>
                      <td className="r num">{pct0(share(sum))}</td>
                      <td />{!clientView && <td />}<td />
                      {months.map((m) => <td key={m} className="c num share">{(() => {
                        const v = list.reduce((s, c) => s + (c.byMonth[m] ?? 0), 0);
                        return v ? mil(v) : "";
                      })()}</td>)}
                    </tr>
                    {list.map((c) => (
                      <Fragment key={c.type}>
                        <tr className="mixrow" onClick={() => toggle(c.type)} aria-expanded={open.has(c.type)}>
                          <td>
                            <span className="mixcaret">{open.has(c.type) ? "▾" : "▸"}</span>
                            <i className="db-sw" style={{ background: colorOf(c.type) }} />
                            <b style={{ fontWeight: 500 }}>{labelOf(c.type)}</b>
                            <span className="share"> · {c.items.length} {c.items.length === 1 ? "položka" : c.items.length < 5 ? "položky" : "položek"}</span>
                          </td>
                          <td className="r num">{kc(c.cost)} Kč</td>
                          <td className="r num">{pct0(share(c.cost))}</td>
                          <td className="r num">{delivery(c)}</td>
                          {!clientView && <td className="r num">{c.unitPrice ? `${kc(c.unitPrice)} Kč` : "—"}</td>}
                          <td className="r num">{c.reach > 0 ? pct0(c.reach) : "—"}</td>
                          {months.map((m) => {
                            const v = c.byMonth[m] ?? 0;
                            return (
                              <td key={m} className="mixcell" title={v ? `${monthLabels[m]}: ${kc(v)} Kč` : undefined}>
                                {v > 0 && <span style={{ background: `color-mix(in srgb, ${colorOf(c.type)} ${Math.round(18 + 82 * (v / maxCell))}%, transparent)` }} />}
                              </td>
                            );
                          })}
                        </tr>
                        {open.has(c.type) && c.items.map((it) => (
                          <tr key={it.id} className="mixitem">
                            <td>
                              {it.channel}
                              <div className="share">{it.block}{!clientView && it.kind !== "media" ? ` · ${KIND[it.kind]}` : ""}</div>
                            </td>
                            <td className="r num">{kc(it.cost)} Kč</td>
                            <td className="r num share">{pct0(share(it.cost))}</td>
                            <td />{!clientView && <td />}<td />
                            {months.map((m) => {
                              const v = it.byMonth[m] ?? 0;
                              return (
                                <td key={m} className="mixcell" title={v ? `${monthLabels[m]}: ${kc(v)} Kč` : undefined}>
                                  {v > 0 && <span style={{ background: `color-mix(in srgb, ${colorOf(c.type)} ${Math.round(18 + 82 * (v / maxCell))}%, transparent)`, height: 8 }} />}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>Celkem</td>
                <td className="r num">{kc(total.cost)} Kč</td>
                <td className="r num">100 %</td>
                <td />{!clientView && <td />}
                <td className="r num">{total.reach > 0 ? pct0(total.reach) : "—"}</td>
                {months.map((m) => <td key={m} className="c num share">{total.byMonth[m] ? mil(total.byMonth[m]) : ""}</td>)}
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="note">
          Částky v Kč{clientView ? " vč. agenturního fee" : " vč. agenturního fee; měsíční součty v mil. Kč"}.
          Doručení: TV a rádio v TRP cílové skupiny, online v impresích. <b>Zásah 1+ je modelový odhad, ne měření</b> —
          za období se nesčítá po měsících, počítá se z nasčítaných GRP; celkový zásah zohledňuje překryv médií.
        </div>
      </div>

      {mix.themes.length > 1 && (
        <div className="db-card">
          <h3>Na co jdou peníze</h3>
          <div className="share" style={{ marginBottom: 10 }}>Rozpočet podle tematických oblastí; položka pro víc oblastí se dělí podle podílů.</div>
          <div className="mix-themes">
            {mix.themes.map((t) => (
              <div key={t.id || "none"} className="mix-theme">
                <span className="mix-theme-name">{t.name}</span>
                <span className="mix-theme-bar"><span style={{ width: `${share(t.cost) * 100}%` }} /></span>
                <span className="num r" style={{ minWidth: 120 }}>{mil(t.cost)} mil. Kč</span>
                <span className="num share" style={{ minWidth: 40, textAlign: "right" }}>{pct0(share(t.cost))}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!clientView && (
        <div className="banner noprint">
          <span>
            <b>Pracovní podklad.</b> Mediamix, rozpočty i odhad zásahu vyžadují validaci media specialistou před sdílením s klientem.
          </span>
        </div>
      )}
    </div>
  );
}
