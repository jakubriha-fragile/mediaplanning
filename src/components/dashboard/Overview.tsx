"use client";

import { useEffect, useState } from "react";
import type { Dashboard } from "@/lib/dashboard";
import { StackedBars, Legend, type Series } from "./Charts";

const MEDIA: Array<{ key: string; label: string; color: string }> = [
  // pořadí je součást validace palety (sousední dvojice) — neměnit bez nového běhu validátoru
  { key: "TV", label: "TV", color: "var(--m-tv)" },
  { key: "Digital", label: "Online", color: "var(--m-digital)" },
  { key: "Rádio", label: "Rádio", color: "var(--m-radio)" },
  { key: "OOH", label: "OOH a partnerství", color: "var(--m-ooh)" },
  { key: "other", label: "Ostatní", color: "var(--m-other)" },
];
const BLOCK_COLORS = ["var(--b1)", "var(--b2)", "var(--b3)", "var(--b4)", "var(--b5)"];

const mil = (n: number) => (n / 1e6).toLocaleString("cs-CZ", { maximumFractionDigits: n >= 1e7 ? 0 : 1 }) + " mil.";
const kc = (n: number) => Math.round(n).toLocaleString("cs-CZ");
const pct = (n: number) => (n * 100).toFixed(1).replace(".", ",") + " %";
const pct0 = (n: number) => Math.round(n * 100) + " %";
const pp = (n: number) => (n * 100).toFixed(1).replace(".", ",") + " p.b.";
const freq = (n: number) => (n ? n.toFixed(1).replace(".", ",") + "×" : "—");
const LIMIT_KEY = "prehled.frekvence";

export function Overview({
  data, monthLabels, planId, tgName, periodName, showCalculator,
}: {
  data: Dashboard;
  monthLabels: Record<string, string>;
  planId: string;
  tgName: string;
  periodName: string;
  showCalculator: boolean;
}) {
  // Hranice přehlcení je rozhodnutí plánovače, ne konstanta — pamatuje se
  // jen v prohlížeči (pohodlí jednoho uživatele, ne sdílené nastavení).
  const [limit, setLimit] = useState(10);
  useEffect(() => {
    try { const v = Number(localStorage.getItem(LIMIT_KEY)); if (v > 0) setLimit(v); } catch { /* bez úložiště */ }
  }, []);
  const saveLimit = (v: number) => {
    setLimit(v);
    try { localStorage.setItem(LIMIT_KEY, String(v)); } catch { /* bez úložiště */ }
  };

  const { points, total, blocks } = data;
  const live = points.filter((p) => p.cost > 0);
  const labels = points.map((p) => monthLabels[p.month]);

  // ---------------------------------------------------------- hlavní zjištění
  const noDelCost = data.noDelivery.reduce((a, x) => a + x.cost, 0);
  const noDelTypes = [...new Set(data.noDelivery.map((x) => x.type === "Digital" ? "online a social" : x.type === "OOH" ? "partnerství a OOH" : x.type === "TV" ? "TV bez TRP" : x.type.toLowerCase()))];
  const withTv = points.filter((p) => p.tvReach > 0);
  const avgInc = withTv.length ? withTv.reduce((a, p) => a + (p.net - p.tvReach), 0) / withTv.length : 0;
  const peak = points.reduce((m, p) => (p.frequency > m.frequency ? p : m), points[0]);
  const over = points.filter((p) => p.frequency > limit);
  const noTv = live.filter((p) => p.tvReach === 0).map((p) => monthLabels[p.month]);
  const firstCum = points.find((p) => p.cumNet > 0)?.cumNet ?? 0;

  const findings: Array<{ title: string; text: React.ReactNode; alert?: boolean }> = [
    {
      title: "Rozpočet",
      text: <>Plán {periodName} stojí <b>{mil(total.cost)} Kč</b> včetně fee. <b>{pct0(total.tvShare)}</b> jde do TV —
        celý plán stojí na televizi a ostatní média ji doplňují.</>,
    },
    {
      title: "Zásah",
      text: <>Model odhaduje čistý zásah <b>{pct(total.net)}</b> cílové skupiny ({tgName}) za celé období.
        Už v prvním měsíci je to {pct(firstCum)}
        {firstCum >= total.net * 0.85 ? " — další měsíce tedy přidávají hlavně frekvenci, ne nové lidi." : "."}</>,
    },
    {
      title: "Frekvence",
      alert: over.length > 0,
      text: over.length
        ? <>V <b>{over.length} z {live.length} měsíců</b> přesahuje průměrná frekvence hranici {limit}×,
            nejvíc v měsíci {monthLabels[peak.month]} ({freq(peak.frequency)}). Tady je prostor ubrat tlak
            nebo ho přesunout do slabších měsíců.</>
        : <>Průměrná frekvence nepřekročí hranici {limit}× v žádném měsíci; nejvyšší je {monthLabels[peak.month]} ({freq(peak.frequency)}).</>,
    },
    {
      title: "Přírůstek",
      alert: withTv.length > 0 && avgInc < 0.02,
      text: <>Ostatní média přidávají k TV v průměru <b>+{pp(avgInc)}</b> čistého zásahu za měsíc
        {avgInc < 0.02 ? " — TV už cílovku pokrývá skoro celou, nebo ostatním médiím chybí data o doručení (viz níže)." : "."}</>,
    },
    ...(noDelCost > 0 ? [{
      title: "Chybí data",
      alert: true,
      text: <>U <b>{mil(noDelCost)} Kč ({pct0(noDelCost / total.cost)})</b> chybí GRP nebo imprese ({noDelTypes.join(", ")}).
        Do zásahu se nepočítají, takže skutečný zásah je spíš vyšší.</>,
    }] : []),
    ...(noTv.length ? [{
      title: "Pauza TV",
      text: <>Bez TV: {noTv.join(", ")}. V těchto měsících drží zásah jen ostatní média.</>,
    }] : []),
  ];

  // ------------------------------------------------------------------- grafy
  const presentTypes = new Set(data.costByType.map((x) => x.type as string));
  const mediaSeries: Series[] = MEDIA.filter((m) => m.key === "other"
    ? data.costByType.some((x) => !MEDIA.some((mm) => mm.key === x.type))
    : presentTypes.has(m.key));
  const costBars = points.map((p, i) => {
    const values: Record<string, number> = {};
    for (const [t, v] of Object.entries(p.costByType)) {
      const k = MEDIA.some((m) => m.key === t) ? t : "other";
      values[k] = (values[k] ?? 0) + (v ?? 0);
    }
    return { label: labels[i], values };
  });

  const reachSeries: Series[] = [
    { key: "tv", label: "Zásah TV", color: "var(--m-tv)" },
    { key: "inc", label: "Přírůstek ostatních médií", color: "var(--m-inc)" },
  ];
  const reachBars = points.map((p, i) => ({ label: labels[i], values: { tv: p.tvReach, inc: Math.max(0, p.net - p.tvReach) } }));

  const freqSeries: Series[] = [
    { key: "ok", label: "Průměrná frekvence", color: "var(--m-tv)" },
    { key: "over", label: `Nad hranicí ${limit}× (čárkovaná čára)`, color: "var(--bad-pure)" },
  ];
  const freqBars = points.map((p, i) => ({
    label: labels[i],
    values: (p.frequency > limit ? { over: p.frequency } : { ok: p.frequency }) as Record<string, number>,
  }));

  const contactBlocks = blocks.filter((b) => b.contacts > 0).sort((a, b) => b.contacts - a.contacts);
  const shownBlocks = contactBlocks.slice(0, 4);
  const blockSeries: Series[] = [
    ...shownBlocks.map((b, i) => ({ key: b.id, label: b.name, color: BLOCK_COLORS[i] })),
    ...(contactBlocks.length > 4 ? [{ key: "rest", label: "Ostatní bloky", color: BLOCK_COLORS[4] }] : []),
  ];
  const contactBars = points.map((p, i) => {
    const values: Record<string, number> = {};
    for (const [id, v] of Object.entries(p.contactsByBlock)) {
      const k = shownBlocks.some((b) => b.id === id) ? id : "rest";
      values[k] = (values[k] ?? 0) + v;
    }
    return { label: labels[i], values };
  });
  const blocksWithoutContacts = blocks.filter((b) => b.contacts === 0 && b.cost > 0);

  const maxBlockMonth = Math.max(1, ...blocks.flatMap((b) => Object.values(b.costByMonth)));

  return (
    <div className="db">
      <section className="db-head">
        <div>
          <h2 className="db-title">Přehled plánu</h2>
          <p className="db-meta">
            {periodName} · {tgName} · universum {mil(data.universe)} osob · {blocks.length} bloků
          </p>
        </div>
        {showCalculator && (
          <a className="btn" href={`/kalkulacka?plan=${planId}`}>Otevřít v kalkulačce zásahu</a>
        )}
      </section>

      <section className="db-card">
        <h3>Hlavní zjištění</h3>
        <ul className="db-findings">
          {findings.map((f) => (
            <li key={f.title} className={f.alert ? "is-alert" : ""}>
              <span className="db-fname">{f.title}</span>
              <span>{f.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="db-kpis">
        <Kpi label="Rozpočet vč. fee" value={mil(total.cost)} unit="Kč" sub={`${live.length} měsíců s aktivitou`} />
        <Kpi label="Podíl TV" value={pct0(total.tvShare)} sub={`${mil(total.cost * total.tvShare)} Kč`} />
        <Kpi label="Čistý zásah za období" value={pct(total.net)} sub={`${mil(total.net * data.universe)} osob · model`} />
        <Kpi label="Nejvyšší frekvence v měsíci" value={freq(peak.frequency)} sub={monthLabels[peak.month]} alert={peak.frequency > limit} />
        <Kpi label="Kontakty celkem" value={mil(total.contacts)} sub="TV v TRP + online imprese" />
        <Kpi label="Bez dat o zásahu" value={mil(noDelCost)} unit="Kč" sub={total.cost ? `${pct0(noDelCost / total.cost)} rozpočtu` : ""} alert={noDelCost > 0} />
      </section>

      <section className="db-card">
        <div className="db-cardhead">
          <div>
            <h3>Zásah v čase</h3>
            <p className="db-note">Čistý zásah po Sainsburyho skládání médií: tmavě TV, světle co k ní přidají ostatní média.
              Čára je kumulativní zásah od začátku období.</p>
          </div>
        </div>
        <Legend series={reachSeries} extra={<span><i className="db-sw db-sw-line" />Kumulativní zásah</span>} />
        <StackedBars
          caption="Měsíční čistý zásah: TV a přírůstek ostatních médií, s kumulativním zásahem"
          bars={reachBars} series={reachSeries} format={pct} axisFormat={pct0} maxValue={1} totalLabel="Čistý zásah"
          line={{ label: "Kumulativní zásah", values: points.map((p) => p.cumNet) }}
          tooltipExtra={(i) => <div className="db-tip-sum">Frekvence<span>{freq(points[i].frequency)}</span></div>}
        />
      </section>

      <div className="db-grid2">
        <section className="db-card">
          <h3>Investice po měsících</h3>
          <p className="db-note">Náklady včetně fee podle média.</p>
          <Legend series={mediaSeries} />
          <StackedBars caption="Měsíční investice podle média" bars={costBars} series={mediaSeries}
            format={(v) => `${kc(v)} Kč`} axisFormat={(v) => (v ? mil(v) : "0")} />
        </section>

        <section className="db-card">
          <div className="db-cardhead">
            <div>
              <h3>Frekvence a přehlcení</h3>
              <p className="db-note">Průměrný počet kontaktů na zasaženého za měsíc, přes všechna sdělení.</p>
            </div>
            <label className="db-limit">
              Hranice
              <input type="number" min={1} max={50} value={limit} onChange={(e) => saveLimit(Math.max(1, Number(e.target.value) || 1))} />×
            </label>
          </div>
          <Legend series={freqSeries} />
          <StackedBars caption="Měsíční frekvence s hranicí přehlcení" bars={freqBars} series={freqSeries}
            format={freq} axisFormat={(v) => `${Math.round(v)}×`}
            threshold={{ value: limit, label: `hranice ${limit}×` }} />
        </section>
      </div>

      <section className="db-card">
        <h3>Kontakty po blocích</h3>
        <p className="db-note">
          Imprese, u TV přepočtené z TRP. Brand a produktové řady jdou rozlišit jen tam, kde má plán doručení po blocích.
          {blocksWithoutContacts.length > 0 && <> Bez údaje o kontaktech: {blocksWithoutContacts.map((b) => b.name).join(", ")}.</>}
        </p>
        <Legend series={blockSeries} />
        <StackedBars caption="Měsíční kontakty podle bloku" bars={contactBars} series={blockSeries}
          format={(v) => `${mil(v)} kontaktů`} axisFormat={(v) => (v ? mil(v) : "0")} />
      </section>

      <section className="db-card">
        <h3>Bloky a produktové řady</h3>
        <p className="db-note">Náklady po měsících jako flowchart — sytější buňka, vyšší investice. Zásah a frekvence za celé období, jen z médií s doručením.</p>
        <div className="db-tablewrap">
          <table className="db-table db-blocks">
            <thead>
              <tr>
                <th>Blok</th><th>Náklady</th><th>Podíl</th>
                {points.map((p) => <th key={p.month} className="db-mcol">{monthLabels[p.month]}</th>)}
                <th>Kontakty</th><th>Zásah za období</th><th>Frekvence za období</th><th>Bez dat o zásahu</th>
              </tr>
            </thead>
            <tbody>
              {blocks.map((b) => (
                <tr key={b.id}>
                  <td>{b.name}</td>
                  <td>{kc(b.cost)}</td>
                  <td>{pct0(b.cost / (total.cost || 1))}</td>
                  {points.map((p) => {
                    const v = b.costByMonth[p.month] ?? 0;
                    const a = v / maxBlockMonth;
                    return (
                      <td key={p.month} className="db-heat" title={v ? `${b.name} · ${monthLabels[p.month]}: ${kc(v)} Kč` : undefined}>
                        {v > 0 && <span style={{ opacity: 0.15 + 0.85 * Math.sqrt(a) }} />}
                      </td>
                    );
                  })}
                  <td>{b.contacts ? mil(b.contacts) : "—"}</td>
                  <td>{b.net ? pct(b.net) : "—"}</td>
                  <td>{freq(b.frequency)}</td>
                  <td className={b.costWithoutDelivery ? "db-warncell" : ""}>{b.costWithoutDelivery ? kc(b.costWithoutDelivery) : "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Celkem</td><td>{kc(total.cost)}</td><td>100 %</td>
                {points.map((p) => <td key={p.month} className="db-mcol">{p.cost ? mil(p.cost) : "—"}</td>)}
                <td>{mil(total.contacts)}</td><td>{pct(total.net)}</td><td>{freq(total.frequency)}</td><td>{kc(noDelCost)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <div className="db-grid3">
        <section className="db-card">
          <h3>Odkud jsou čísla</h3>
          <ul className="db-list">
            <li>Náklady jsou <b>včetně agenturního fee</b>, tak jak jsou v plánu.</li>
            <li>Kontakty: TV z TRP v cílové skupině kampaně, online z plánovaných impresí.</li>
            <li>Zásah: křivka zásahu každého média a Sainsburyho skládání s koeficienty duplikace.</li>
          </ul>
        </section>
        <section className="db-card">
          <h3>Předpoklady</h3>
          <ul className="db-list">
            <li>Cílová skupina <b>{tgName}</b>, universum {mil(data.universe)} osob.</li>
            <li>Křivky zásahu a koeficienty duplikace jsou výchozí odhady, ne kalibrovaná data.</li>
            <li>Frekvence je průměr za měsíc; skutečné rozdělení kontaktů bývá nerovnoměrnější.</li>
          </ul>
        </section>
        <section className="db-card">
          <h3>Otevřené body</h3>
          <ul className="db-list">
            {data.noDelivery.slice(0, 4).map((x) => (
              <li key={x.channel}><b>{x.channel}</b>: chybí GRP nebo imprese ({mil(x.cost)} Kč).</li>
            ))}
            {data.noDelivery.length > 4 && <li>…a dalších {data.noDelivery.length - 4} položek bez doručení.</li>}
            <li>Zkalibrovat křivku TV na reálný report zásahu.</li>
          </ul>
        </section>
      </div>

      <p className="db-disclaimer">
        <b>Modelový odhad, ne měření.</b> Přesná deduplikace vyžaduje single-source panelová data.
        Před sdílením s klientem patří čísla validovat media specialistou.
      </p>
    </div>
  );
}

function Kpi({ label, value, unit, sub, alert }: { label: string; value: string; unit?: string; sub?: string; alert?: boolean }) {
  return (
    <div className={`db-card db-kpi ${alert ? "is-alert" : ""}`}>
      <span className="db-label">{label}</span>
      <span className="db-big">{value}{unit && <span className="cur">{unit}</span>}</span>
      {sub && <span className="db-sub">{sub}</span>}
    </div>
  );
}
