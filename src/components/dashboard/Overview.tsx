"use client";

import { useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { Dashboard } from "@/lib/dashboard";
import { UNASSIGNED } from "@/lib/dashboardShared";
import { CAMP_COLORS } from "@/lib/campColors";
import type { ChannelType } from "@/db/schema";
import { SpendReach } from "./Charts";

const TYPE_LABEL: Partial<Record<ChannelType, string>> = {
  TV: "TV", Digital: "Online a social", Rádio: "Rádio", OOH: "OOH a partnerství",
  Print: "Tisk", Kino: "Kino", Vlastní: "Vlastní kanály", PR: "PR",
};
const tl = (t: ChannelType) => TYPE_LABEL[t] ?? t;

const mil = (n: number) => (n / 1e6).toLocaleString("cs-CZ", { maximumFractionDigits: n >= 1e7 ? 0 : 1 }) + " mil.";
const kc = (n: number) => Math.round(n).toLocaleString("cs-CZ");
/** Kč v tabulkách a grafu: tisíce, od milionu miliony — vždy s jednotkou */
const kcShort = (n: number) => (!n ? "0" : n >= 1e6 ? mil(n) : `${Math.round(n / 1000).toLocaleString("cs-CZ")} tis.`);
/** osoby: Přehled je v absolutních číslech, procenta jen v úvodní větě */
const people = (n: number) => (!n ? "—" : n >= 1e6 ? `${(n / 1e6).toLocaleString("cs-CZ", { maximumFractionDigits: 2 })} mil. osob` : `${Math.round(n / 1000).toLocaleString("cs-CZ")} tis. osob`);
const pct0 = (n: number) => Math.round(n * 100) + " %";
const pp = (n: number) => `${n < 0 ? "−" : ""}${Math.abs(n * 100).toFixed(1).replace(".", ",")} p.b.`;
const freq = (n: number) => (n ? n.toFixed(1).replace(".", ",") + "×" : "—");

/** Pojem s vysvětlením za otazníkem — na stránce nezabírá místo. */
function Help({ children }: { children: React.ReactNode }) {
  return (
    <span className="db-help" tabIndex={0} aria-label="Vysvětlení">
      ?<span role="tooltip">{children}</span>
    </span>
  );
}

export function Overview({
  data, monthLabels, planId, tgName, periodName, themes, filter,
}: {
  data: Dashboard;
  monthLabels: Record<string, string>;
  planId: string;
  tgName: string;
  periodName: string;
  themes: Array<{ id: string; name: string }>;
  filter: { themeId: string | null; channelType: ChannelType | null; campaignId: string | null; lineId: string | null };
}) {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const [allTodos, setAllTodos] = useState(false);
  const [openTypes, setOpenTypes] = useState<Set<string>>(new Set());

  const setFilter = (key: "oblast" | "medium" | "propozice" | "sdeleni", value: string | null) => {
    const q = new URLSearchParams(sp.toString());
    if (value) q.set(key, value); else q.delete(key);
    // jiná propozice = sdělení z ní už nemusí platit
    if (key === "propozice") q.delete("sdeleni");
    router.push(`${path}?${q}`, { scroll: false });
  };

  const { total } = data;
  const points = data.points;
  const labels = points.map((p) => monthLabels[p.month]);
  const media = total.cost - total.fee;
  const coverage = media > 0 ? total.delivered / media : 1;
  const themeName = themes.find((t) => t.id === filter.themeId)?.name;
  const campName = data.campaigns.find((c) => c.id === filter.campaignId)?.name;
  const line = data.lines.find((l) => l.id === filter.lineId);
  const subject = line ? `Sdělení ${line.message}` : campName ? `Propozice ${campName}`
    : themeName ? `Oblast ${themeName}` : filter.channelType ? tl(filter.channelType) : "Plán";
  const topTypes = data.costByType.slice(0, 3).map((x) => `${tl(x.type)} ${kcShort(x.cost)} Kč`).join(" · ");
  const women = tgName.toLowerCase().startsWith("ženy");
  const anyFilter = filter.themeId || filter.channelType || filter.campaignId || filter.lineId;

  // propozice v grafu: barvy podle pořadí v plánu (stejně jako proužek v Plánu)
  const series = data.campaigns.filter((c) => c.cost > 0).map((c) => ({
    key: c.id, label: c.name, color: CAMP_COLORS[data.campaigns.indexOf(c) % CAMP_COLORS.length],
  }));

  // -------------------------------------------------------------- co s tím
  type Todo = { title: string; text: React.ReactNode; alert?: boolean; href?: string; cta?: string };
  const todos: Todo[] = [];
  const hasTv = data.costByType.some((x) => x.type === "TV");
  const hasOther = data.costByType.some((x) => x.type !== "TV" && x.cost > 0);
  if (hasTv && hasOther && total.avgIncrement < 0.01) {
    todos.push({
      alert: true,
      title: "Ostatní média k TV skoro nic nepřidávají",
      text: <>Navíc jen {pp(total.avgIncrement)} cílové skupiny za měsíc. Buď TV už cílovku pokrývá, nebo je překryv TV s ostatními
        médii v modelu nastavený příliš přísně.</>,
      href: `/kalkulacka?plan=${planId}`, cta: "Zkontrolovat koeficienty",
    });
  }
  if (total.mediaNoData > 0) {
    todos.push({
      title: `Doplnit doručení k ${mil(total.mediaNoData)} Kč`,
      text: <>Bez GRP nebo impresí se do zásahu nepočítají: {data.missing.slice(0, 3).map((m) => m.channel).join(", ")}
        {data.missing.length > 3 ? ` a dalších ${data.missing.length - 3}` : ""}. Stačí cena za kontakt v ceníku.</>,
      href: `/kalkulacka?plan=${planId}#cenik`, cta: "Doplnit ceník",
    });
  }
  const unassigned = data.matrix.find((m) => m.name === "Nezařazeno");
  if (unassigned && unassigned.cost > 0) {
    todos.push({
      title: `${mil(unassigned.cost)} Kč bez tematické oblasti`,
      text: <>V matici níž se nepočítají k žádné oblasti. Doplňte je v Plánu, sloupec Oblast.</>,
      href: `/?plan=${planId}`, cta: "Otevřít plán",
    });
  }

  const maxCell = Math.max(1, ...data.matrix.flatMap((r) => Object.values(r.byType).map((v) => v ?? 0)));
  const topTheme = [...data.matrix].filter((r) => r.id !== UNASSIGNED).sort((a, b) => b.cost - a.cost)[0];
  const months = data.months;

  return (
    <div className="db">
      {/* první obrazovka: věta (jediné místo s procenty a frekvencí) + rozpočet */}
      <section className="db-hero db-hero2">
        <div className="db-card db-lead">
          <p>
            {subject} zasáhne <b>{pct0(total.net)}</b> {women ? "žen" : "lidí z cílové skupiny"}
            {" "}{tgName.replace(/^Ženy\s*/, "")}
            <span className="db-muted"> ({people(total.people)})</span>.
            {" "}Zasažená {women ? "žena" : "osoba"} reklamu uvidí v průměru
            {" "}<b>{freq(total.avgMonthlyFrequency)} za měsíc</b>.
          </p>
          <span className="db-sub">{periodName} · modelový odhad <Help>Zásah = kolik lidí z cílové skupiny uvidí reklamu aspoň jednou
            za celé období. Lidé, kteří vidí víc médií, se počítají jen jednou. Frekvence = kolikrát reklamu zasažený člověk uvidí
            za měsíc (průměr přes měsíce, kdy kampaň běží). U digitálu se zásah počítá ze zadané frekvence, jinak z křivky. {data.tvCalibrated
              ? "Zásah TV vychází z naměřených vln TV nákupu."
              : "Zásah TV je zatím předpoklad (téměř celá cílovka), dokud nepřijdou data od TV nákupu."}</Help></span>
          {/* filtry patří k větě, kterou mění — ne do samostatné lišty nad stránkou */}
          <div className="db-filters">
            <span className="db-muted">Zobrazit</span>
            <select aria-label="Propozice" value={filter.campaignId ?? ""} onChange={(e) => setFilter("propozice", e.target.value || null)}>
              <option value="">všechny propozice</option>
              {data.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select aria-label="Sdělení" value={filter.lineId ?? ""} onChange={(e) => setFilter("sdeleni", e.target.value || null)}>
              <option value="">všechna sdělení</option>
              {data.lines.filter((l) => !filter.campaignId || l.campaignId === filter.campaignId).map((l) => (
                <option key={l.id} value={l.id}>{l.code} · {l.message}</option>
              ))}
            </select>
            <select aria-label="Oblast" value={filter.themeId ?? ""} onChange={(e) => setFilter("oblast", e.target.value || null)}>
              <option value="">všechny oblasti</option>
              {themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <select aria-label="Médium" value={filter.channelType ?? ""} onChange={(e) => setFilter("medium", e.target.value || null)}>
              <option value="">všechna média</option>
              {data.matrixTypes.map((t) => <option key={t} value={t}>{tl(t)}</option>)}
            </select>
            {anyFilter && (
              <button className="linkbtn" onClick={() => router.push(`${path}?plan=${planId}`, { scroll: false })}>zrušit filtr</button>
            )}
          </div>
        </div>
        <div className="db-card db-kpi">
          <span className="db-label">Rozpočet včetně fee</span>
          <span className="db-big">{mil(total.cost)}<span className="cur">Kč</span></span>
          <span className="db-sub">{topTypes}</span>
        </div>
      </section>

      <div className="db-main">
        <section className="db-card">
          <div className="db-cardhead">
            <div>
              <h3>Útrata a zásah po měsících</h3>
              <p className="db-note">Sloupce: kolik se v měsíci utratí, po propozicích. Čára: kolik lidí z cílové skupiny reklama
                v měsíci zasáhne (pravá osa). Zásah se přes měsíce nesčítá — „od začátku plánu“ je v nápovědě.</p>
            </div>
          </div>
          <div className="db-legend">
            {series.map((s) => <span key={s.key}><i className="db-sw" style={{ background: s.color }} />{s.label}</span>)}
            <span><i className="db-sw db-sw-reach" />Zasáhne v měsíci</span>
          </div>
          <SpendReach
            caption="Útrata po propozicích a zásah po měsících"
            labels={labels}
            series={series}
            values={points.map((p) => p.byCampaign)}
            reach={points.map((p) => p.net * data.universe)}
            cum={points.map((p) => p.cumNet * data.universe)}
            formatKc={kcShort}
            formatPeople={people}
          />
        </section>

        <section className="db-card">
          <h3>Co s tím</h3>
          <p className="db-note">Doporučení se počítají z plánu a modelu zásahu.</p>
          {todos.length ? (
            <ul className="db-todos">
              {(allTodos ? todos : todos.slice(0, 3)).map((t) => (
                <li key={t.title} className={t.alert ? "is-alert" : ""}>
                  <b>{t.title}</b>
                  <span>{t.text}</span>
                  {t.href && <a href={t.href}>{t.cta} →</a>}
                </li>
              ))}
            </ul>
          ) : <p className="db-note">Nic k řešení: média mají doručení a položky oblast.</p>}
          {todos.length > 3 && (
            <button className="linkbtn" style={{ marginTop: 12 }} onClick={() => setAllTodos((v) => !v)}>
              {allTodos ? "méně" : `další doporučení (${todos.length - 3})`}
            </button>
          )}
        </section>
      </div>

      {/* kolik jde do TV, kolik do onlinu… — po měsících, se zásahem typu média */}
      <section className="db-card">
        <h3>Podle typu médií</h3>
        <p className="db-note">Útrata po měsících a zásah za celé období. Zásah typu média počítá jen s ním samotným —
          zásahy se nesčítají (lidé vidí víc médií). Kliknutím na typ rozbalíte jednotlivá média.</p>
        <div className="db-tablewrap">
          <table className="db-table db-types">
            <thead>
              <tr>
                <th>Typ média</th>
                {months.map((m) => <th key={m} className="db-num">{monthLabels[m]}</th>)}
                <th className="db-num">Celkem Kč</th>
                <th className="db-num">Zásah za období</th>
              </tr>
            </thead>
            <tbody>
              {data.byType.map((t) => {
                const isOpen = openTypes.has(t.key);
                const name = t.type ? tl(t.type) : "Agenturní práce";
                return [
                  <tr key={t.key} className="db-typerow" onClick={() => setOpenTypes((o) => {
                    const n = new Set(o); if (n.has(t.key)) n.delete(t.key); else n.add(t.key); return n;
                  })}>
                    <td><b>{t.media.length > 1 || t.media[0]?.name !== "bez média" ? (isOpen ? "▾ " : "▸ ") : ""}{name}</b></td>
                    {months.map((m) => <td key={m} className="db-num">{t.byMonth[m] ? kcShort(t.byMonth[m]) : "—"}</td>)}
                    <td className="db-num"><b>{kc(t.cost)}</b></td>
                    <td className="db-num">{t.type ? people(t.reach * data.universe) : "—"}</td>
                  </tr>,
                  ...(isOpen ? t.media.map((md) => (
                    <tr key={`${t.key}-${md.name}`} className="db-sub">
                      <td>{md.name}</td>
                      {months.map((m) => <td key={m} className="db-num">{md.byMonth[m] ? kcShort(md.byMonth[m]) : "—"}</td>)}
                      <td className="db-num">{kc(md.cost)}</td>
                      <td className="db-num">{t.type ? people(md.reach * data.universe) : "—"}</td>
                    </tr>
                  )) : []),
                ];
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>Celkem</td>
                {months.map((m) => {
                  const v = points.find((p) => p.month === m)?.cost ?? 0;
                  return <td key={m} className="db-num">{v ? kcShort(v) : "—"}</td>;
                })}
                <td className="db-num">{kc(total.cost)}</td>
                <td className="db-num">{people(total.people)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {/* matice je pro hledání souvislostí, ne pro první pohled — otevře se sama, když je vybraná oblast */}
      <details className="db-card db-fold" open={!!filter.themeId}>
        <summary>
          Kam jdou peníze — oblasti × média
          {topTheme && <span className="db-muted"> · nejvíc {topTheme.name} ({mil(topTheme.cost)} Kč)</span>}
        </summary>
        <p className="db-note">Klik na oblast vyfiltruje celý přehled.</p>
        <div className="db-tablewrap">
          <table className="db-table db-matrix">
            <thead>
              <tr>
                <th>Oblast</th>
                {data.matrixTypes.map((t) => <th key={t}>{tl(t)}</th>)}
                <th>Celkem</th>
                <th>Zásah <Help>Za celé období, jen z médií s doručením.</Help></th>
              </tr>
            </thead>
            <tbody>
              {data.matrix.map((r) => (
                <tr key={r.id} className={filter.themeId === r.id ? "is-on" : ""}
                  onClick={() => r.id !== UNASSIGNED && setFilter("oblast", filter.themeId === r.id ? null : r.id)}>
                  <td><b>{r.name}</b></td>
                  {data.matrixTypes.map((t) => {
                    const v = r.byType[t] ?? 0;
                    const a = v / maxCell;
                    return (
                      <td key={t} className="db-cell">
                        {v > 0 ? <span style={{ background: `color-mix(in srgb, var(--m-tv) ${Math.round(8 + 72 * a)}%, transparent)`,
                          color: a > 0.55 ? "#fff" : undefined }}>{mil(v)}</span> : <span className="db-muted">—</span>}
                      </td>
                    );
                  })}
                  <td><b>{mil(r.cost)}</b></td>
                  <td>{r.net ? people(r.net * data.universe) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <details className="db-card db-drawer">
        <summary>Jak to počítáme, předpoklady a slovníček</summary>
        <div className="db-grid3">
          <div>
            <h4>Odkud jsou čísla</h4>
            <ul className="db-list">
              <li>Náklady jsou včetně agenturního fee. Agenturní práce ({mil(total.fee)} Kč) zásah nemá a do „chybějících dat" se nepočítá.</li>
              <li>TV z TRP v cílové skupině kampaně, online z plánovaných impresí.</li>
              <li>Zásah: křivka zásahu každého média a Sainsburyho skládání s koeficienty překryvu.</li>
            </ul>
          </div>
          <div>
            <h4>Předpoklady</h4>
            <ul className="db-list">
              <li>Cílová skupina {tgName}, {mil(data.universe)} osob.</li>
              <li>Koeficienty překryvu a křivky zásahu ostatních médií jsou výchozí odhady, ne kalibrovaná data.</li>
              <li>Frekvence je za měsíc: kontakty měsíce ÷ zasažení v měsíci, průměr přes měsíce, kdy kampaň běží.</li>
              <li>{data.tvCalibrated
                ? "Zásah TV: z naměřených vln TV nákupu (Kalkulačka → Kalibrace zásahu)."
                : "Zásah TV: předpoklad, že TV zasáhne téměř celou cílovku (rozhodnutí zadavatele, říjen 2026), dokud nepřijdou data od TV nákupu."}</li>
            </ul>
          </div>
          <div>
            <h4>Úplnost dat</h4>
            <p className="db-note" style={{ margin: "0 0 6px" }}>
              Model počítá se <b>{pct0(coverage)}</b> mediálního rozpočtu
              {total.estimated > 0 ? `, z toho ${pct0(total.estimated / (media || 1))} odhadem z ceníku` : ""}.
              {total.mediaNoData > 0 && <> <a href={`/kalkulacka?plan=${planId}#cenik`}>Doplnit ceník →</a></>}
            </p>
            <ul className="db-list">
              {data.missing.slice(0, 6).map((m) => (
                <li key={m.channel}>{m.channel} <span className="db-muted">({mil(m.cost)} Kč{m.kind === "mixed" ? ", práce i média dohromady" : ""})</span></li>
              ))}
              {!data.missing.length && <li>Nic — všechna média mají GRP nebo imprese.</li>}
            </ul>
          </div>
        </div>
        <h4>Slovníček</h4>
        <dl className="db-gloss">
          <dt>Zásah</dt><dd>Kolik procent cílové skupiny reklamu uvidí aspoň jednou.</dd>
          <dt>Frekvence</dt><dd>Kolikrát ji zasažený člověk v průměru uvidí.</dd>
          <dt>TRP / GRP</dt><dd>Součet sledovanosti spotů v procentech cílové skupiny. 100 TRP = tolik kontaktů, kolik má cílová skupina lidí.</dd>
          <dt>Překryv</dt><dd>Lidé, kteří vidí víc médií. Model je počítá jen jednou.</dd>
        </dl>
        <p className="db-disclaimer"><b>Modelový odhad, ne měření.</b> Přesná deduplikace vyžaduje single-source panelová data.
          Před sdílením s klientem patří čísla validovat media specialistou.</p>
      </details>
    </div>
  );
}
