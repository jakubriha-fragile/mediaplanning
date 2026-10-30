/**
 * Odhad výsledků položky — podle mediaplánu Fragile (case study, březen 2026).
 *
 * Plánovač zadá k položce předpoklady (CPM, CPC, CTR, konverzní poměr,
 * frekvence, velikost cílové skupiny) a z rozpočtu za období se dopočítá:
 *
 *   imprese  = rozpočet ÷ CPM × 1000            (jen se zadaným CPM)
 *   kliky    = rozpočet ÷ CPC                   (je-li zadané CPC)
 *            = imprese × CTR                    (jinak, je-li CPM a CTR)
 *   imprese  = kliky ÷ CTR                      (bez CPM, ale s CPC a CTR)
 *   CTR      = kliky ÷ imprese                  (nezadané, ale obojí známé)
 *   konverze = kliky × konverzní poměr
 *   CPA      = rozpočet ÷ konverze
 *   zásah    = imprese ÷ frekvence, nejvýš velikost cílové skupiny
 *
 * Zásah je tu jednoduchý odhad za položku jako v Excelu, ne cross-mediální
 * model — ten zůstává v Přehledu pro celý plán. Obojí jsou odhady, ne měření.
 */

export type EstimateInput = {
  budget: number;
  cpm?: number | null;
  cpc?: number | null;
  /** podíl 0–1 */
  ctr?: number | null;
  /** podíl 0–1 */
  cr?: number | null;
  frequency?: number | null;
  audience?: number | null;
};

export type Estimate = {
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  conversions: number | null;
  cpa: number | null;
  reach: number | null;
  /** podíl 0–1 z velikosti cílové skupiny */
  reachPct: number | null;
  /** které hodnoty jsou dopočtené, ne zadané — rozhraní je ukáže šedě */
  derived: { impressions: boolean; clicks: boolean; ctr: boolean };
};

const pos = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

export function estimate(x: EstimateInput): Estimate {
  const b = x.budget > 0 ? x.budget : 0;
  let impressions: number | null = pos(x.cpm) && b ? (b / x.cpm) * 1000 : null;
  let clicks: number | null = pos(x.cpc) && b ? b / x.cpc : null;
  let ctr: number | null = pos(x.ctr) ? x.ctr : null;
  const derived = { impressions: false, clicks: false, ctr: false };

  if (clicks === null && impressions !== null && ctr !== null) { clicks = impressions * ctr; derived.clicks = true; }
  if (impressions === null && clicks !== null && ctr !== null) { impressions = clicks / ctr; derived.impressions = true; }
  if (ctr === null && impressions && clicks !== null) { ctr = clicks / impressions; derived.ctr = true; }

  const conversions = clicks !== null && pos(x.cr) ? clicks * x.cr : null;
  const cpa = conversions ? b / conversions : null;
  let reach: number | null = impressions !== null && pos(x.frequency) ? impressions / x.frequency : null;
  if (reach !== null && pos(x.audience)) reach = Math.min(reach, x.audience);
  const reachPct = reach !== null && pos(x.audience) ? reach / x.audience : null;

  return { impressions, clicks, ctr, conversions, cpa, reach, reachPct, derived };
}

/** Součet odhadů za blok nebo plán: sčítají se objemy, poměry se dopočítají znovu. */
export function sumEstimates(items: Array<{ budget: number; est: Estimate }>) {
  const add = (k: "impressions" | "clicks" | "conversions" | "reach") => {
    const vals = items.map((i) => i.est[k]).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const budget = items.reduce((a, i) => a + i.budget, 0);
  const impressions = add("impressions");
  const clicks = add("clicks");
  const conversions = add("conversions");
  return {
    budget, impressions, clicks, conversions,
    // zásah se přes položky NESČÍTÁ (lidé se překrývají) — v součtu ho neukazujeme
    ctr: impressions && clicks !== null ? clicks / impressions : null,
    cpa: conversions ? budget / conversions : null,
  };
}
