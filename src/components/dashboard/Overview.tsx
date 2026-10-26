"use client";

import { useState, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { Dashboard } from "@/lib/dashboard";
import { SCENARIO_CUT, UNASSIGNED } from "@/lib/dashboardShared";
import { updatePlan } from "@/lib/actions";
import type { ChannelType } from "@/db/schema";
import { ReachFrequency } from "./Charts";

const TYPE_LABEL: Partial<Record<ChannelType, string>> = {
  TV: "TV", Digital: "Online a social", Rádio: "Rádio", OOH: "OOH a partnerství",
  Print: "Tisk", Kino: "Kino", Vlastní: "Vlastní kanály", PR: "PR",
};
const tl = (t: ChannelType) => TYPE_LABEL[t] ?? t;

const mil = (n: number) => (n / 1e6).toLocaleString("cs-CZ", { maximumFractionDigits: n >= 1e7 ? 0 : 1 }) + " mil.";
const kc = (n: number) => Math.round(n).toLocaleString("cs-CZ");
const pct = (n: number) => (n * 100).toFixed(1).replace(".", ",") + " %";
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
  data, monthLabels, planId, tgName, periodName, themes, canEdit, filter,
}: {
  data: Dashboard;
  monthLabels: Record<string, string>;
  planId: string;
  tgName: string;
  periodName: string;
  themes: Array<{ id: string; name: string }>;
  canEdit: boolean;
  filter: { themeId: string | null; channelType: ChannelType | null };
}) {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const [limitDraft, setLimitDraft] = useState(String(data.freqLimit));
  const [allTodos, setAllTodos] = useState(false);

  const setFilter = (key: "oblast" | "medium", value: string | null) => {
    const q = new URLSearchParams(sp.toString());
    if (value) q.set(key, value); else q.delete(key);
    router.push(`${path}?${q}`, { scroll: false });
  };
  const saveLimit = () => {
    const v = Math.round(Number(limitDraft.replace(",", ".")));
    if (!v || v < 1 || v === data.freqLimit) { setLimitDraft(String(data.freqLimit)); return; }
    start(async () => { await updatePlan({ planId, freqLimit: v }); router.refresh(); });
  };

  const { points, total, freqLimit: limit } = data;
  const live = points.filter((p) => p.cost > 0);
  const labels = points.map((p) => monthLabels[p.month]);
  const over = points.filter((p) => p.frequency > limit);
  const media = total.cost - total.fee;
  const coverage = media > 0 ? total.delivered / media : 1;
  const themeName = themes.find((t) => t.id === filter.themeId)?.name;
  const subject = themeName ? `Oblast ${themeName}` : filter.channelType ? tl(filter.channelType) : "Kampaň";
  const topTypes = data.costByType.slice(0, 3).map((x) => `${tl(x.type)} ${pct0(x.cost / (total.cost || 1))}`).join(" · ");

  // -------------------------------------------------------------- co s tím
  type Todo = { title: string; text: React.ReactNode; alert?: boolean; href?: string; cta?: string };
  const todos: Todo[] = [];
  const sc = data.scenario;
  if (sc) {
    todos.push({
      alert: true,
      title: `Ubrat TV v ${sc.months.length} ${sc.months.length === 1 ? "přetíženém měsíci" : "přetížených měsících"}`,
      text: <>Zasažená žena ji v nich uvidí v průměru {freq(sc.freqBefore)} týdně. Model: o {Math.round(SCENARIO_CUT * 100)} % méně TRP v těchto měsících
        uvolní <b>{mil(sc.saving)} Kč</b>, frekvence klesne na {freq(sc.freqAfter)} týdně a zásah
        {Math.abs(sc.netAfter - sc.netBefore) < 0.0005 ? " zůstane prakticky stejný" : ` se změní o ${pp(sc.netAfter - sc.netBefore)}`}.</>,
      href: `/kalkulacka?plan=${planId}`, cta: "Ověřit v kalkulačce",
    });
  }
  const hasTv = data.costByType.some((x) => x.type === "TV");
  const hasOther = data.costByType.some((x) => x.type !== "TV" && x.cost > 0);
  if (hasTv && hasOther && total.avgIncrement < 0.01) {
    todos.push({
      alert: true,
      title: "Ostatní média k TV skoro nic nepřidávají",
      text: <>Navíc jen {pp(total.avgIncrement)} za měsíc. Buď TV už cílovku pokrývá, nebo je překryv TV s ostatními
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
  if (over.length && live.length > over.length) {
    const calm = live.filter((p) => p.frequency <= limit && p.frequency > 0).sort((a, b) => a.frequency - b.frequency)[0];
    if (calm) todos.push({
      title: `${monthLabels[calm.month]} je nejklidnější měsíc (${freq(calm.frequency)} týdně)`,
      text: <>Sem jde přesunout tlak z přetížených měsíců, aniž by se překročila hranice {limit}× týdně.</>,
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

  return (
    <div className={`db ${pending ? "db-pending" : ""}`}>
      {/* první obrazovka: věta + tři čísla */}
      <section className="db-hero">
        <div className="db-card db-lead">
          <p>
            {subject} zasáhne <b>{pct0(total.net)}</b> {tgName.toLowerCase().startsWith("ženy") ? "žen" : "lidí z cílové skupiny"}
            {" "}{tgName.replace(/^Ženy\s*/, "")}
            <span className="db-muted"> ({mil(total.people)})</span>.
            {" "}Zasažená {tgName.toLowerCase().startsWith("ženy") ? "žena" : "osoba"} ji uvidí v průměru
            {" "}<b>{freq(total.avgWeeklyFrequency)} týdně</b>.
          </p>
          <span className="db-sub">{periodName} · modelový odhad <Help>Zásah = kolik lidí z cílové skupiny uvidí reklamu aspoň jednou.
            Lidé, kteří vidí víc médií, se počítají jen jednou. Frekvence = kolikrát ji zasažený člověk uvidí za týden
            (měsíční kontakty rozložené rovnoměrně do týdnů). {data.tvCalibrated
              ? "Zásah TV vychází z naměřených vln TV nákupu."
              : "Zásah TV je zatím předpoklad (téměř celá cílovka), dokud nepřijdou data od TV nákupu."}</Help></span>
          {/* filtry patří k větě, kterou mění — ne do samostatné lišty nad stránkou */}
          <div className="db-filters">
            <span className="db-muted">Zobrazit</span>
            <select aria-label="Oblast" value={filter.themeId ?? ""} onChange={(e) => setFilter("oblast", e.target.value || null)}>
              <option value="">všechny oblasti</option>
              {themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <select aria-label="Médium" value={filter.channelType ?? ""} onChange={(e) => setFilter("medium", e.target.value || null)}>
              <option value="">všechna média</option>
              {data.matrixTypes.map((t) => <option key={t} value={t}>{tl(t)}</option>)}
            </select>
            {(filter.themeId || filter.channelType) && (
              <button className="linkbtn" onClick={() => router.push(`${path}?plan=${planId}`, { scroll: false })}>zrušit filtr</button>
            )}
          </div>
        </div>
        <div className="db-card db-kpi">
          <span className="db-label">Rozpočet včetně fee</span>
          <span className="db-big">{mil(total.cost)}<span className="cur">Kč</span></span>
          <span className="db-sub">{topTypes}</span>
        </div>
        <div className="db-card db-kpi">
          <span className="db-label">Náklad na zasaženou osobu <Help>Celý rozpočet včetně fee děleno počtem
            zasažených lidí za období. Nejlepší číslo pro srovnání oblastí a médií mezi sebou.</Help></span>
          <span className="db-big">{total.costPerPerson ? kc(total.costPerPerson) : "—"}<span className="cur">Kč</span></span>
          <span className="db-sub">za celé období</span>
        </div>
        <div className={`db-card db-kpi ${over.length ? "is-alert" : ""}`}>
          <span className="db-label">Měsíce s přehlcením</span>
          <span className="db-big">{over.length} z {live.length}</span>
          <span className="db-sub">frekvence nad {limit}× týdně</span>
        </div>
      </section>

      <div className="db-main">
        <section className="db-card">
          <div className="db-cardhead">
            <div>
              <h3>Zásah a frekvence po měsících</h3>
              <p className="db-note">Nahoře kolik lidí reklama zasáhne, dole kolikrát ji zasažený uvidí za týden.
                Šedý pás je rozumná frekvence, oranžově kontakty navíc.</p>
            </div>
            <label className="db-limit">Rozumná frekvence za týden do
              {canEdit ? (
                <input value={limitDraft} inputMode="numeric" onChange={(e) => setLimitDraft(e.target.value)}
                  onBlur={saveLimit} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
              ) : <b>{limit}</b>}×
              <Help>Hranici nastavuje plánovač pro celý plán, všichni pak vidí stejná doporučení.</Help>
            </label>
          </div>
          <div className="db-legend">
            <span><i className="db-sw" style={{ background: "var(--m-tv)" }} />Zasáhne TV</span>
            <span><i className="db-sw" style={{ background: "var(--m-inc)" }} />Navíc díky ostatním médiím</span>
            <span><i className="db-sw db-sw-line" />Od začátku plánu</span>
            <span><i className="db-sw" style={{ background: "var(--bad-pure)" }} />Kontakty nad rozumnou frekvencí</span>
          </div>
          <ReachFrequency
            caption="Zásah a frekvence po měsících"
            labels={labels}
            tv={points.map((p) => p.tvReach)}
            inc={points.map((p) => Math.max(0, p.net - p.tvReach))}
            cum={points.map((p) => p.cumNet)}
            freq={points.map((p) => p.frequency)}
            limit={limit}
            formatPct={pct}
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
          ) : <p className="db-note">Plán je vyvážený: žádné přetížení ani chybějící data.</p>}
          {todos.length > 3 && (
            <button className="linkbtn" style={{ marginTop: 12 }} onClick={() => setAllTodos((v) => !v)}>
              {allTodos ? "méně" : `další doporučení (${todos.length - 3})`}
            </button>
          )}
        </section>
      </div>

      {/* matice je pro hledání souvislostí, ne pro první pohled — otevře se sama, když je vybraná oblast */}
      <details className="db-card db-fold" open={!!filter.themeId}>
        <summary>
          Kam jdou peníze — oblasti × média
          {topTheme && <span className="db-muted"> · nejvíc {topTheme.name} ({pct0(topTheme.cost / (total.cost || 1))})</span>}
        </summary>
        <p className="db-note">Klik na oblast vyfiltruje celý přehled.</p>
        <div className="db-tablewrap">
          <table className="db-table db-matrix">
            <thead>
              <tr>
                <th>Oblast</th>
                {data.matrixTypes.map((t) => <th key={t}>{tl(t)}</th>)}
                <th>Celkem</th><th>Podíl</th>
                <th>Zásah <Help>Za celé období, jen z médií s doručením.</Help></th>
                <th>Frekvence za týden</th>
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
                  <td>{pct0(r.cost / (total.cost || 1))}</td>
                  <td>{r.net ? pct0(r.net) : "—"}</td>
                  <td className={r.weeklyFrequency > limit ? "db-warncell" : ""}>{freq(r.weeklyFrequency)}</td>
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
              <li>Frekvence je za týden: měsíční kontakty rozložené rovnoměrně do týdnů (plán je po měsících).</li>
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
