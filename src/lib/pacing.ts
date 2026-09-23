/**
 * Výpočty pacingu — zadání §6. Převzato z odladěného prototypu, neměnit bez domluvy.
 *
 * Klíčový rozdíl, na kterém lidé chybují:
 *   kumulativní ukazatele se poměřují s časem (v půlce měsíce čekáme 50 % rozpočtu),
 *   poměrové ukazatele NIKDY (v půlce měsíce má být CPM rovnou na cílové hodnotě).
 */

import type { MetricKind } from "@/db/schema";

export type Status = "ok" | "warn" | "bad" | "idle";

export type Verdict = {
  status: Status;
  label: string;
  /** plnění vůči očekávání (kumulativní) nebo vůči plánu (poměrové); null = nelze určit */
  ratio: number | null;
  /** kolik už mělo být načerpáno k referenčnímu datu */
  expected: number;
  /** odchylka od plánu v procentech, jen u poměrových */
  deviation: number | null;
};

const MONTH_BOUNDS: Record<string, [string, string]> = {};
function bounds(month: string): [Date, Date] {
  if (!MONTH_BOUNDS[month]) {
    const [y, m] = month.split("-").map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1));
    const to = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));
    MONTH_BOUNDS[month] = [from.toISOString(), to.toISOString()];
  }
  const [a, b] = MONTH_BOUNDS[month];
  return [new Date(a), new Date(b)];
}

/** Podíl měsíce, který k referenčnímu datu uplynul. 0 = ještě nezačal, 1 = skončil. */
export function elapsed(month: string, now: Date = new Date()): number {
  const [from, to] = bounds(month);
  if (now <= from) return 0;
  if (now >= to) return 1;
  return (now.getTime() - from.getTime()) / (to.getTime() - from.getTime());
}

export function monthState(month: string, now: Date = new Date()): "before" | "live" | "after" {
  const e = elapsed(month, now);
  return e <= 0 ? "before" : e >= 1 ? "after" : "live";
}

const IDLE = (label: string): Verdict => ({ status: "idle", label, ratio: null, expected: 0, deviation: null });

/**
 * Kumulativní ukazatel: rozpočet, reach, konverze.
 * `closed` = všechny dotčené měsíce skončily → porovnáváme proti celému plánu.
 */
export function pacingCumulative(plan: number, actual: number, expected: number, closed: boolean): Verdict {
  if (!plan) return IDLE("bez cíle");
  if (expected <= 0) return IDLE("nezahájeno");
  const ratio = actual / expected;
  if (!actual) {
    return { status: "bad", label: closed ? "nesplněno" : "bez plnění", ratio: 0, expected, deviation: null };
  }
  const v = (status: Status, label: string): Verdict => ({ status, label, ratio, expected, deviation: null });
  if (closed) {
    if (ratio >= 0.95 && ratio <= 1.05) return v("ok", "splněno");
    if (ratio > 1.05) return v("warn", "překročeno");
    if (ratio >= 0.85) return v("warn", "mírně pod plán");
    return v("bad", "nesplněno");
  }
  if (ratio >= 0.9 && ratio <= 1.1) return v("ok", "v plánu");
  if (ratio > 1.1) return v("warn", "předbíhá");
  if (ratio >= 0.75) return v("warn", "mírný skluz");
  return v("bad", "skluz");
}

/**
 * Poměrový ukazatel: CPM, CPA, CTR, ROAS.
 * S časem se nepoměřuje — nekumuluje se. Porovnání přímo s plánem + odchylka v %.
 */
export function pacingRate(target: number, actual: number, kind: "rate_low" | "rate_high"): Verdict {
  if (!target) return IDLE("bez cíle");
  if (!actual) return IDLE("bez dat");
  const ratio = kind === "rate_low" ? target / actual : actual / target;
  const deviation = (actual - target) / target;
  const v = (status: Status, label: string): Verdict => ({ status, label, ratio, expected: target, deviation });
  if (ratio >= 1) return v("ok", "plní plán");
  if (ratio >= 0.9) return v("warn", "těsně neplní");
  return v("bad", "neplní plán");
}

export type MonthlyPair = { month: string; plan: number; actual: number };

/** Rozpočet nebo kumulativní metrika přes jeden či více měsíců. */
export function aggregateCumulative(rows: MonthlyPair[], now: Date = new Date()): Verdict & { plan: number; actual: number } {
  const plan = rows.reduce((s, r) => s + r.plan, 0);
  const actual = rows.reduce((s, r) => s + r.actual, 0);
  const expected = rows.reduce((s, r) => s + r.plan * elapsed(r.month, now), 0);
  const closed = rows.length > 0 && rows.every((r) => monthState(r.month, now) === "after");
  return { ...pacingCumulative(plan, actual, expected, closed), plan, actual };
}

/**
 * Poměrová metrika přes více měsíců. Sčítat nejde, proto vážený průměr
 * podle skutečného čerpání daného měsíce (zadání §6.2).
 */
export function aggregateRate(
  rows: Array<{ month: string; target: number; actual: number; spend: number }>,
  kind: "rate_low" | "rate_high",
): Verdict & { plan: number; actual: number; blended: boolean } {
  const weighted = (subset: Array<{ value: number; spend: number }>) => {
    if (!subset.length) return 0;
    const totalWeight = subset.reduce((s, x) => s + (x.spend || 1), 0);
    return subset.reduce((s, x) => s + x.value * (x.spend || 1), 0) / totalWeight;
  };
  const withTarget = rows.filter((r) => r.target > 0).map((r) => ({ value: r.target, spend: r.spend }));
  const withActual = rows.filter((r) => r.actual > 0).map((r) => ({ value: r.actual, spend: r.spend }));
  const plan = weighted(withTarget);
  const actual = weighted(withActual);
  return { ...pacingRate(plan, actual, kind), plan, actual, blended: withActual.length > 1 };
}

export function verdictFor(
  kind: MetricKind,
  rows: Array<{ month: string; target: number; actual: number; spend: number }>,
  now: Date = new Date(),
): Verdict & { plan: number; actual: number; blended?: boolean } {
  if (kind === "cumulative") {
    return aggregateCumulative(
      rows.map((r) => ({ month: r.month, plan: r.target, actual: r.actual })),
      now,
    );
  }
  return aggregateRate(rows, kind);
}

// ------------------------------------------------------------------ odvozené ukazatele

/**
 * Index rozmělnění sdělení (0–1) z Herfindahl-Hirschmanova indexu.
 * 0 = sdělení běží jen v jednom typu média, 1 = rovnoměrně napříč Paid/Owned/Earned.
 */
export function dilutionIndex(paid: number, owned: number, earned: number): number {
  const total = paid + owned + earned;
  if (!total) return 0;
  const hhi = (paid / total) ** 2 + (owned / total) ** 2 + (earned / total) ** 2;
  return Math.max(0, Math.min(1, 1.5 * (1 - hhi)));
}

/** Efektivní počet sdělení na kanálu = 1 / HHI podílů. */
export function effectiveMessageCount(shares: number[]): number {
  const total = shares.reduce((s, x) => s + x, 0);
  if (!total) return 0;
  const hhi = shares.reduce((s, x) => s + (x / total) ** 2, 0);
  return hhi ? 1 / hhi : 0;
}
