export const QUARTER = "2026-Q4";
export const MONTHS = ["2026-10", "2026-11", "2026-12"] as const;
export type Month = (typeof MONTHS)[number];

export const MONTH_LABEL: Record<string, string> = {
  "2026-10": "Říjen",
  "2026-11": "Listopad",
  "2026-12": "Prosinec",
};

export const kc = (n: number) => Math.round(n).toLocaleString("cs-CZ");
export const pct = (n: number) => (n * 100).toFixed(1).replace(".", ",") + " %";
export const pct0 = (n: number) => Math.round(n * 100) + " %";
export const num = (n: number) =>
  !n ? "" : Math.abs(n) >= 1000 ? kc(n) : String(Math.round(n * 100) / 100).replace(".", ",");
