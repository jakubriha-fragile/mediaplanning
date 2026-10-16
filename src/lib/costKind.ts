/**
 * Typ nákladu podle názvu položky: média, agenturní práce, nebo obojí naráz.
 *
 * Proč: agenturní práce z principu žádný zásah nemá, takže nepatří mezi
 * „chybějící data". Dokud plán nemá typ nákladu jako samostatný údaj, poznává
 * se z formulací, které se v plánech BENU skutečně používají. Smíšené řádky
 * („ag. práce, influ & CC, médiá") rozdělit nejde — počítají se jako média
 * bez doručení, protože nějaká média v nich jsou.
 */
export type CostKind = "media" | "fee" | "mixed";

// ambasador a event jsou honoráře, ne nákup médií — zásah se z nich nepočítá
const FEE = /(ag\.\s*pr[aá]ce|agenturn|\bfee\b|nat[aá]čen|v[ií]cepr[aá]ce|ad-hoc|vendor obsah|oc posty|content creators|ambas[aá]d|\bevent\b)/i;
// jen česky s diakritikou — anglické „Social Media fee" je honorář, ne média
const MEDIA = /(médi[aá]|promo budget|\bmeta\b|přefakturace)/i;

export function costKind(name: string): CostKind {
  const fee = FEE.test(name);
  const media = MEDIA.test(name);
  if (fee && media) return "mixed";
  if (fee) return "fee";
  return "media";
}
