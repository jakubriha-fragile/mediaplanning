/**
 * Období plánu. Dřív byly měsíce zadrátované na Q4 2026 — teď se odvozují
 * z `plan.periodStart` a `plan.periodEnd`, takže kvartál i celý rok jsou
 * jen jiné hodnoty téhož.
 */

export type Month = string; // "2027-03"

const NAMES = [
  "Leden", "Únor", "Březen", "Duben", "Květen", "Červen",
  "Červenec", "Srpen", "Září", "Říjen", "Listopad", "Prosinec",
];
const SHORT = ["Led", "Úno", "Bře", "Dub", "Kvě", "Čvn", "Čvc", "Srp", "Zář", "Říj", "Lis", "Pro"];

export function parseMonth(m: Month): { year: number; month: number } {
  const [y, mo] = m.split("-");
  return { year: Number(y), month: Number(mo) };
}

export function monthLabel(m: Month): string {
  const { month } = parseMonth(m);
  return NAMES[month - 1] ?? m;
}

export function monthShort(m: Month): string {
  const { month } = parseMonth(m);
  return SHORT[month - 1] ?? m;
}

/** Měsíce období včetně obou krajů. */
export function monthsBetween(start: Month, end: Month): Month[] {
  const a = parseMonth(start);
  const b = parseMonth(end);
  const out: Month[] = [];
  let y = a.year;
  let m = a.month;
  // pojistka proti obrácenému nebo poškozenému období
  for (let guard = 0; guard < 120; guard++) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (y === b.year && m === b.month) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    if (y > b.year || (y === b.year && m > b.month)) break;
  }
  return out;
}

export function quarterOf(m: Month): string {
  const { year, month } = parseMonth(m);
  return `${year}-Q${Math.ceil(month / 3)}`;
}

export function quarterLabel(q: string): string {
  const [y, qq] = q.split("-");
  return `${qq} ${y}`;
}

/** Měsíce seskupené po kvartálech — pro sbalitelné sloupce v tabulce. */
export function quarterGroups(months: Month[]): Array<{ key: string; label: string; months: Month[] }> {
  const out: Array<{ key: string; label: string; months: Month[] }> = [];
  for (const m of months) {
    const q = quarterOf(m);
    let g = out.find((x) => x.key === q);
    if (!g) out.push((g = { key: q, label: quarterLabel(q), months: [] }));
    g.months.push(m);
  }
  return out;
}

/** Název období, jak se píše do hlavičky: „Q4 2026" nebo „Rok 2027". */
export function periodLabel(start: Month, end: Month): string {
  const a = parseMonth(start);
  const b = parseMonth(end);
  if (a.year === b.year && a.month === 1 && b.month === 12) return `Rok ${a.year}`;
  if (start === end) return `${monthLabel(start)} ${a.year}`;
  // „Q4" jen pro celý kvartál — listopad–prosinec se dřív tvářil jako Q4
  if (a.year === b.year && a.month % 3 === 1 && b.month === a.month + 2) return quarterLabel(quarterOf(start));
  if (a.year === b.year) return `${monthShort(start)}–${monthShort(end)} ${a.year}`;
  return `${monthShort(start)} ${a.year} – ${monthShort(end)} ${b.year}`;
}

/**
 * Titulek plánu do hlavičky. Plán pojmenovaný podle období („Q4 2026") se
 * ukáže jen tak; vlastní název („Vánoce 2027") dostane období do závorky,
 * aby bylo vidět, kdy běží.
 */
export function planTitle(p: { name: string; periodStart: string; periodEnd: string }): string {
  const label = periodLabel(p.periodStart, p.periodEnd);
  return p.name === label ? label : `${p.name} (${label})`;
}

/** Posun období o daný počet let — pro založení příštího roku z letošního. */
export function shiftYears(m: Month, by: number): Month {
  const { year, month } = parseMonth(m);
  return `${year + by}-${String(month).padStart(2, "0")}`;
}

export const kc = (n: number) => Math.round(n).toLocaleString("cs-CZ");
export const pct = (n: number) => (n * 100).toFixed(1).replace(".", ",") + " %";
export const pct0 = (n: number) => Math.round(n * 100) + " %";
export const num = (n: number) =>
  !n ? "" : Math.abs(n) >= 1000 ? kc(n) : String(Math.round(n * 100) / 100).replace(".", ",");
/** Velká čísla zásahu: 2 300 000 → „2,3 mil." */
export const big = (n: number) =>
  !n ? "—"
    : n >= 1_000_000 ? (n / 1_000_000).toFixed(1).replace(".", ",") + " mil."
    : n >= 1_000 ? Math.round(n / 1_000) + " tis."
    : String(Math.round(n));
/** Číslo z pole, jak ho lidé píšou: „1 250 000", „12,5", „1 250 000 Kč". Prázdné = 0. */
export const parseNum = (s: string) =>
  Number(String(s).replace(/\s/g, "").replace(",", ".").replace(/[^\d.]/g, "")) || 0;

/**
 * Týdnů v měsíci (dny ÷ 7). Frekvence se všude ukazuje týdně, protože tak
 * o tlaku mluví plánovači; plán je po měsících, takže jde o rovnoměrné
 * rozložení měsíce do týdnů — skutečný průběh uvnitř měsíce z dat neplyne.
 */
export function weeksIn(month: Month): number {
  const { year, month: m } = parseMonth(month);
  return new Date(Date.UTC(year, m, 0)).getUTCDate() / 7;
}

/** Týdnů v celém období (součet měsíců). */
export const weeksOf = (months: Month[]) => months.reduce((s, m) => s + weeksIn(m), 0);

// ------------------------------------------------------------------ týdny

/**
 * Týden plánu: pondělí–neděle, klíč = datum pondělí („2027-02-01").
 * `parts` říká, kolik dní týdne padne do kterého měsíce plánu — týden přes
 * přelom se dělí podle dnů (rozhodnutí zadavatele, říjen 2026; odpovídá
 * řádku „Days" a „Dec II" v Excelu BENU). Dny mimo období plánu se nepočítají.
 */
export type Week = {
  key: string;
  /** číslo týdne podle ISO 8601 */
  num: number;
  label: string;
  parts: Array<{ month: Month; days: number }>;
};

const DAY = 86_400_000;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const monthOf = (d: Date): Month => isoDate(d).slice(0, 7);

/** Číslo týdne podle ISO 8601 (týden patří roku, kde leží jeho čtvrtek). */
export function isoWeekNumber(monday: Date): number {
  const thu = new Date(monday.getTime() + 3 * DAY);
  const jan1 = Date.UTC(thu.getUTCFullYear(), 0, 1);
  return Math.floor((thu.getTime() - jan1) / DAY / 7) + 1;
}

export function weeksOfPeriod(start: Month, end: Month): Week[] {
  const a = parseMonth(start);
  const b = parseMonth(end);
  const first = new Date(Date.UTC(a.year, a.month - 1, 1));
  const last = new Date(Date.UTC(b.year, b.month, 0));
  // pondělí na začátku prvního týdne (getUTCDay: 0 = neděle)
  const mon = new Date(first.getTime() - ((first.getUTCDay() + 6) % 7) * DAY);
  const out: Week[] = [];
  for (let w = mon; w <= last; w = new Date(w.getTime() + 7 * DAY)) {
    const parts: Week["parts"] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(w.getTime() + i * DAY);
      if (d < first || d > last) continue;
      const m = monthOf(d);
      const p = parts.find((x) => x.month === m);
      if (p) p.days++; else parts.push({ month: m, days: 1 });
    }
    const num = isoWeekNumber(w);
    out.push({ key: isoDate(w), num, label: `T${num}`, parts });
  }
  return out;
}

/** „1.–7. 2." — rozsah týdne do nápovědy. */
export function weekRange(key: string): string {
  const d = new Date(key + "T00:00:00Z");
  const e = new Date(d.getTime() + 6 * DAY);
  const f = (x: Date) => `${x.getUTCDate()}. ${x.getUTCMonth() + 1}.`;
  return d.getUTCMonth() === e.getUTCMonth() ? `${d.getUTCDate()}.–${f(e)}` : `${f(d)} – ${f(e)}`;
}

/** Měsíc, pod který se týden zobrazuje (kde leží většina jeho dnů v plánu). */
export const weekHome = (w: Week): Month => [...w.parts].sort((x, y) => y.days - x.days)[0]?.month ?? "";

/** Měsíce, do kterých zasahují dny týdne (bez ohledu na období plánu). */
export function weekMonths(key: string): Month[] {
  const d = new Date(key + "T00:00:00Z");
  const out = new Set<Month>();
  for (let i = 0; i < 7; i++) out.add(monthOf(new Date(d.getTime() + i * DAY)));
  return [...out];
}
