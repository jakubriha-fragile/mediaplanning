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
  if (a.year === b.year && quarterOf(start) === quarterOf(end)) return quarterLabel(quarterOf(start));
  if (a.year === b.year) return `${monthShort(start)}–${monthShort(end)} ${a.year}`;
  return `${monthShort(start)} ${a.year} – ${monthShort(end)} ${b.year}`;
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
