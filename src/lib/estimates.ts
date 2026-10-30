/**
 * Odhad výsledků položky — inspirováno mediaplánem Fragile (case study, březen 2026),
 * ale bez zdvojených vstupů. Cena (CPM/CPC) je ve sloupci Cena a doručení z ní
 * počítá plán; zásah počítá model z GRP. Tady se k doručení přidá jen:
 *
 *   kliky    = imprese × CTR                    (položka na CPM)
 *   imprese  = kliky ÷ CTR                      (položka na CPC)
 *   konverze = kliky × konverzní poměr
 *   CPA      = rozpočet ÷ konverze
 *
 * CTR a konverzní poměr se berou z položky, a když tam nejsou, z výchozích
 * hodnot platformy (Nastavení → Média a platformy).
 */

export type EstimateInput = {
  budget: number;
  /** doručení z plánu: imprese u CPM, kliky u CPC (druhé je null) */
  impressions?: number | null;
  clicks?: number | null;
  /** podíl 0–1 */
  ctr?: number | null;
  /** podíl 0–1 */
  cr?: number | null;
};

export type Estimate = {
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  conversions: number | null;
  cpa: number | null;
  /** které hodnoty jsou dopočtené přes CTR, ne z ceny — rozhraní je ukáže kurzívou */
  derived: { impressions: boolean; clicks: boolean };
};

const pos = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

export function estimate(x: EstimateInput): Estimate {
  const b = x.budget > 0 ? x.budget : 0;
  let impressions: number | null = pos(x.impressions) ? x.impressions : null;
  let clicks: number | null = pos(x.clicks) ? x.clicks : null;
  let ctr: number | null = pos(x.ctr) ? x.ctr : null;
  const derived = { impressions: false, clicks: false };

  if (clicks === null && impressions !== null && ctr !== null) { clicks = impressions * ctr; derived.clicks = true; }
  if (impressions === null && clicks !== null && ctr !== null) { impressions = clicks / ctr; derived.impressions = true; }
  if (ctr === null && impressions && clicks !== null) ctr = clicks / impressions;

  const conversions = clicks !== null && pos(x.cr) ? clicks * x.cr : null;
  const cpa = conversions && b ? b / conversions : null;
  return { impressions, clicks, ctr, conversions, cpa, derived };
}

/** Součet odhadů za blok nebo plán: sčítají se objemy, poměry se dopočítají znovu. */
export function sumEstimates(items: Array<{ budget: number; est: Estimate }>) {
  const add = (k: "impressions" | "clicks" | "conversions") => {
    const vals = items.map((i) => i.est[k]).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const impressions = add("impressions");
  const clicks = add("clicks");
  const conversions = add("conversions");
  // CPA jen z položek, které konverze mají — jinak by do něj spadly i rozpočty TV
  const convBudget = items.filter((i) => i.est.conversions !== null).reduce((a, i) => a + i.budget, 0);
  return {
    impressions, clicks, conversions,
    // zásah se přes položky NESČÍTÁ (lidé se překrývají) — v součtu ho neukazujeme
    cpa: conversions ? convBudget / conversions : null,
  };
}
