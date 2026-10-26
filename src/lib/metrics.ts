/**
 * Poměrové ukazatele se nezadávají, počítají se.
 *
 * CPM, CPC, CPA, CTR i ROAS jsou podíly čerpání a absolutních čísel. Dřív je
 * klient vyplňoval ručně — tedy počítal na kalkulačce to, co aplikace ví.
 * Teď se zadá jen čerpání a základní čísla (imprese, kliky, konverze, tržby)
 * a podíly se dopočítají za každý měsíc. Uložené ruční hodnoty u poměrových
 * ukazatelů se ignorují: platí, co plyne z čísel.
 *
 * Ukazatel se pozná podle názvu (jako costKind). Chybí-li u položky základní
 * ukazatel, který poměr potřebuje (CPM bez impresí), nabídne se k vyplnění
 * a založí se při prvním zápisu.
 */

export type BaseKey = "impressions" | "clicks" | "conversions" | "revenue";
export type DerivedKey = "CPM" | "CPC" | "CPA" | "CTR" | "ROAS";

export const BASE: Record<BaseKey, { name: string; unit: string; match: RegExp }> = {
  impressions: { name: "Imprese", unit: "", match: /impres|impression|zobrazení/i },
  clicks: { name: "Kliky", unit: "", match: /klik|click/i },
  conversions: { name: "Konverze", unit: "", match: /konverz|conversion|objednáv/i },
  revenue: { name: "Tržby", unit: "Kč", match: /tržb|obrat|revenue/i },
};

type Inputs = { spend: number | null } & Partial<Record<BaseKey, number | null>>;

export const DERIVED: Record<DerivedKey, {
  match: RegExp;
  needs: BaseKey[];
  unit: string;
  /** čím se počítá — do nápovědy */
  formula: string;
  compute: (x: Inputs) => number | null;
}> = {
  CPM: {
    match: /\bcpm\b/i, needs: ["impressions"], unit: "Kč", formula: "čerpání ÷ imprese × 1 000",
    compute: ({ spend, impressions }) => (spend != null && impressions ? (spend / impressions) * 1000 : null),
  },
  CPC: {
    match: /\bcpc\b/i, needs: ["clicks"], unit: "Kč", formula: "čerpání ÷ kliky",
    compute: ({ spend, clicks }) => (spend != null && clicks ? spend / clicks : null),
  },
  CPA: {
    match: /\bcpa\b|cena za konverzi/i, needs: ["conversions"], unit: "Kč", formula: "čerpání ÷ konverze",
    compute: ({ spend, conversions }) => (spend != null && conversions ? spend / conversions : null),
  },
  CTR: {
    match: /\bctr\b/i, needs: ["clicks", "impressions"], unit: "%", formula: "kliky ÷ imprese × 100",
    compute: ({ clicks, impressions }) => (clicks != null && impressions ? (clicks / impressions) * 100 : null),
  },
  ROAS: {
    match: /\broas\b/i, needs: ["revenue"], unit: "×", formula: "tržby ÷ čerpání",
    compute: ({ spend, revenue }) => (spend && revenue != null ? revenue / spend : null),
  },
};

/** Je ukazatel poměrový (počítaný)? */
export function derivedOf(name: string): DerivedKey | null {
  for (const k of Object.keys(DERIVED) as DerivedKey[]) if (DERIVED[k].match.test(name)) return k;
  return null;
}

/** Je ukazatel základní (zadává se)? Poměrový nikdy není základní, i kdyby název seděl. */
export function baseOf(name: string): BaseKey | null {
  if (derivedOf(name)) return null;
  for (const k of Object.keys(BASE) as BaseKey[]) if (BASE[k].match.test(name)) return k;
  return null;
}

export type ResolvedMetric = {
  /** null = základní ukazatel, který zatím neexistuje — založí se prvním zápisem */
  id: string | null;
  name: string;
  unit: string;
  kind: "cumulative" | "rate_low" | "rate_high";
  base: BaseKey | null;
  derived: DerivedKey | null;
  /** null = nevyplněno / nejde spočítat */
  actual: Record<string, number | null>;
  target: Record<string, number>;
};

/**
 * Ukazatele jedné položky: uložené, doplněné o chybějící základní a s dopočtem
 * poměrových. Pořadí: zadávané (uložené, pak doplněné), nakonec počítané.
 */
export function resolveMetrics(input: {
  months: string[];
  metrics: Array<{ id: string; name: string; unit: string; kind: "cumulative" | "rate_low" | "rate_high" }>;
  actualOf: (metricId: string, month: string) => number | null;
  targetOf: (metricId: string, month: string) => number;
  spendOf: (month: string) => number | null;
}): ResolvedMetric[] {
  const { months, metrics, actualOf, targetOf, spendOf } = input;
  const own: ResolvedMetric[] = metrics.map((m) => ({
    id: m.id, name: m.name, unit: m.unit, kind: m.kind,
    base: baseOf(m.name), derived: derivedOf(m.name),
    actual: Object.fromEntries(months.map((mo) => [mo, actualOf(m.id, mo)])),
    target: Object.fromEntries(months.map((mo) => [mo, targetOf(m.id, mo)])),
  }));

  const needed = new Set(own.flatMap((m) => (m.derived ? DERIVED[m.derived].needs : [])));
  const present = new Set(own.map((m) => m.base).filter(Boolean) as BaseKey[]);
  const virtual: ResolvedMetric[] = [...needed].filter((b) => !present.has(b)).map((b) => ({
    id: null, name: BASE[b].name, unit: BASE[b].unit, kind: "cumulative", base: b, derived: null,
    actual: Object.fromEntries(months.map((mo) => [mo, null])),
    target: Object.fromEntries(months.map((mo) => [mo, 0])),
  }));

  const inputs = [...own.filter((m) => !m.derived), ...virtual];
  const baseValue = (b: BaseKey, mo: string) => inputs.find((m) => m.base === b)?.actual[mo] ?? null;

  const derived = own.filter((m) => m.derived).map((m) => {
    const d = DERIVED[m.derived!];
    return {
      ...m,
      unit: m.unit || d.unit,
      actual: Object.fromEntries(months.map((mo) => {
        const x: Inputs = { spend: spendOf(mo) };
        for (const b of d.needs) x[b] = baseValue(b, mo);
        const v = d.compute(x);
        return [mo, v != null && Number.isFinite(v) ? v : null];
      })),
    };
  });
  return [...inputs, ...derived];
}
