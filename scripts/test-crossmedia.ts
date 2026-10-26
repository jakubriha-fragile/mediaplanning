/**
 * Testy cross-mediálních přepočtů. Běží bez databáze: `npm run test:cross`.
 *
 * Hlídají hlavně to, že přepočty jsou vratné — zadám rozpočet, přečtu GRP,
 * zadám ten GRP a musím dostat zpátky stejný rozpočet. Bez toho by plánovač
 * nemohl přepínat řídicí jednotku a věřit, že se mu čísla nerozjedou.
 */
import {
  derive, combineReach, incrementalReach, reachFromGrp, grpForReach,
  effectiveReach, duplicationOf, DEFAULT_CURVE, isGrpPriced, kFromMeasured,
} from "../src/lib/crossmedia";
import { periodLabel } from "../src/lib/period";
import { costKind } from "../src/lib/costKind";
import { shortName, displayName } from "../src/lib/displayName";
import { resolveMetrics, derivedOf, baseOf } from "../src/lib/metrics";

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`  ✓ ${name}`);
};
const close = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

const U = 3_200_000; // Ženy 25–54 + muži, modelové universum

console.log("\nPřepočty jednotek");

// TV: obchoduje se na GRP, CPP 32 000 Kč
const tv = derive({ channelType: "TV", driver: "budget", driverValue: 6_400_000, unitPrice: 32_000, universe: U });
ok("TV: rozpočet → GRP", close(tv.grp, 200), `${tv.grp}`);
ok("TV: GRP → impressions", close(tv.impressions, (200 * U) / 100), `${tv.impressions}`);
ok("TV: zásah je kladný a pod stropem", tv.reach > 0 && tv.reach < DEFAULT_CURVE.TV.rMax);
ok("TV: GRP = zásah × frekvence", close(tv.reach * 100 * tv.frequency, tv.grp, 1e-9));

// zpětně: zadám GRP a musím dostat stejný rozpočet
const tvBack = derive({ channelType: "TV", driver: "grp", driverValue: tv.grp, unitPrice: 32_000, universe: U });
ok("TV: přepočet je vratný (rozpočet)", close(tvBack.budget, 6_400_000));
ok("TV: přepočet je vratný (zásah)", close(tvBack.reach, tv.reach));

// Digital: CPT 180 Kč
const dig = derive({ channelType: "Digital", driver: "budget", driverValue: 1_800_000, unitPrice: 180, universe: U });
ok("Digital: rozpočet → impressions", close(dig.impressions, 10_000_000), `${dig.impressions}`);
ok("Digital: impressions → GRP", close(dig.grp, (10_000_000 / U) * 100));
const digBack = derive({ channelType: "Digital", driver: "impressions", driverValue: dig.impressions, unitPrice: 180, universe: U });
ok("Digital: přepočet je vratný", close(digBack.budget, 1_800_000));

ok("TV a rádio se obchodují na GRP", isGrpPriced("TV") && isGrpPriced("Rádio"));
ok("OOH a digital na CPT", !isGrpPriced("OOH") && !isGrpPriced("Digital"));

console.log("\nChybějící vstupy");
const noPrice = derive({ channelType: "TV", driver: "budget", driverValue: 1_000_000, unitPrice: 0, universe: U });
ok("bez ceny se nehádá, hlásí chybějící cenu", noPrice.missing === "price" && noPrice.grp === 0);
const noUni = derive({ channelType: "OOH", driver: "budget", driverValue: 1_000_000, unitPrice: 120, universe: 0 });
ok("bez universa spočítá impressions, ale ne zásah", noUni.impressions > 0 && noUni.reach === 0 && noUni.missing === "universe");
const empty = derive({ channelType: "TV", driver: "budget", driverValue: 0, unitPrice: 32_000, universe: U });
ok("nulový vstup dá nuly", empty.budget === 0 && empty.reach === 0);

console.log("\nKřivka zásahu");
ok("nula GRP = nula zásahu", reachFromGrp(0, DEFAULT_CURVE.TV) === 0);
ok("křivka roste", reachFromGrp(200, DEFAULT_CURVE.TV) > reachFromGrp(100, DEFAULT_CURVE.TV));
ok("křivka se sytí", reachFromGrp(400, DEFAULT_CURVE.TV) - reachFromGrp(300, DEFAULT_CURVE.TV)
   < reachFromGrp(200, DEFAULT_CURVE.TV) - reachFromGrp(100, DEFAULT_CURVE.TV));
ok("nepřekročí strop média", reachFromGrp(100_000, DEFAULT_CURVE.Kino) <= DEFAULT_CURVE.Kino.rMax);
ok("obrácená křivka vrací původní GRP", close(grpForReach(reachFromGrp(250, DEFAULT_CURVE.TV), DEFAULT_CURVE.TV), 250, 1e-6));
ok("nedosažitelný zásah = nekonečno GRP", grpForReach(0.99, DEFAULT_CURVE.Kino) === Infinity);

console.log("\nCross-mediální zásah a překryv");
const parts = [
  { channelType: "TV" as const, reach: 0.60 },
  { channelType: "Digital" as const, reach: 0.40 },
  { channelType: "OOH" as const, reach: 0.30 },
];
const c = combineReach(parts);
ok("čistý zásah je nižší než součet", c.net < c.gross, `${c.net} vs ${c.gross}`);
ok("čistý zásah není nižší než nejsilnější médium", c.net >= 0.60);
ok("čistý zásah nepřekročí 100 %", c.net <= 1);
ok("duplikace snižuje zásah pod nezávislost", c.net < c.independent, `${c.net} vs ${c.independent}`);
ok("překryv = součet − čistý zásah", close(c.overlap, c.gross - c.net, 1e-9));

const one = combineReach([{ channelType: "TV", reach: 0.5 }]);
ok("jedno médium: žádný překryv", one.net === 0.5 && one.overlap === 0);
ok("nic nezadáno: nuly", combineReach([]).net === 0);

ok("stejné médium se překrývá víc než dvě různá",
   duplicationOf("TV", "TV") > duplicationOf("TV", "OOH"));
ok("duplikace je symetrická", duplicationOf("TV", "Digital") === duplicationOf("Digital", "TV"));
// pojistka proti překlepu v klíči: tabulka se skládá seřazeně, takže nesprávné
// pořadí by tiše spadlo na 1,0 a model by překryv vůbec nezapočítal
import { DEFAULT_DUPLICATION, dupKey, fitCurve } from "../src/lib/crossmedia";
const TYPES = ["TV", "Rádio", "OOH", "Print", "Kino", "Digital", "Vlastní", "PR"] as const;
ok("všechny klíče tabulky jsou seřazené",
   Object.keys(DEFAULT_DUPLICATION).every((k) => {
     const [a, b] = k.split("|");
     return dupKey(a as never, b as never) === k;
   }));
const missing: string[] = [];
for (let i = 0; i < TYPES.length; i++)
  for (let j = i; j < TYPES.length; j++)
    if (duplicationOf(TYPES[i], TYPES[j]) === 1) missing.push(`${TYPES[i]}×${TYPES[j]}`);
ok("každá dvojice nosičů má koeficient", missing.length === 0, missing.join(", "));
ok("TV×Digital se opravdu najde", duplicationOf("TV", "Digital") === 1.25);

const inc = incrementalReach(parts, { channelType: "Print", reach: 0.2 });
ok("přírůstek je kladný a menší než vlastní zásah média", inc > 0 && inc < 0.2, `${inc}`);
const incSame = incrementalReach(parts, { channelType: "TV", reach: 0.2 });
ok("přírůstek v už použitém médiu je menší než v novém", incSame < inc, `${incSame} vs ${inc}`);

// vlastnosti, na kterých model stojí
const shuffled = combineReach([parts[2], parts[0], parts[1]]);
ok("pořadí vstupu nemění výsledek", close(shuffled.net, c.net, 1e-12));
let mono = true;
let prev = 0;
for (const extra of [0.05, 0.15, 0.3, 0.5]) {
  const n = combineReach([...parts, { channelType: "Print" as const, reach: extra }]).net;
  if (n < prev || n < c.net) mono = false;
  prev = n;
}
ok("přidané médium zásah nikdy nesníží", mono);
ok("čtyři silná média nepřekročí 100 %",
   combineReach([
     { channelType: "TV", reach: 0.9 }, { channelType: "Digital", reach: 0.8 },
     { channelType: "OOH", reach: 0.8 }, { channelType: "Rádio", reach: 0.7 },
   ]).net <= 1);

console.log("\nEfektivní zásah");
ok("3+ kontakty jsou méně než celkový zásah", effectiveReach(0.6, 4, 3) < 0.6);
ok("vyšší frekvence zvedá efektivní zásah",
   effectiveReach(0.6, 6, 3) > effectiveReach(0.6, 3, 3));
ok("1+ kontakt = celý zásah", effectiveReach(0.6, 4, 1) === 0.6);
ok("frekvence 1 = každý právě jednou, 2+ je nula", effectiveReach(0.6, 1, 2) === 0);
ok("2+ ≥ 3+ ≥ 4+", effectiveReach(0.6, 3, 2) >= effectiveReach(0.6, 3, 3) &&
   effectiveReach(0.6, 3, 3) >= effectiveReach(0.6, 3, 4));
// useknutý Poisson: frekvence 4 ⇒ λ ≈ 3,92, P(≥3 | ≥1) ≈ 0,765
ok("frekvence 4: 3+ ≈ 76,5 % zasažených", Math.abs(effectiveReach(1, 4, 3) - 0.765) < 0.005);
// netruncovaný vzorec tu dával 0,191 — dvojnásobek
ok("nízká frekvence 1,5: 3+ kolem 10 %, ne 19 %", Math.abs(effectiveReach(1, 1.5, 3) - 0.101) < 0.005);
ok("efektivní zásah nepřekročí zásah", effectiveReach(0.6, 30, 3) <= 0.6);

console.log("\nSainsbury — shoda s kalkulačkou v Excelu");
{
  // list „Vstupy" kalkulačky Sainsbury: TV 69 %, Online 45 %, OOH 30 %, Rádio 20 %
  const parts = [
    { channelType: "TV" as const, reach: 0.69 }, { channelType: "Digital" as const, reach: 0.45 },
    { channelType: "OOH" as const, reach: 0.30 }, { channelType: "Rádio" as const, reach: 0.20 },
  ];
  const k: Record<string, number> = {
    [dupKey("TV", "Digital")]: 0.9, [dupKey("TV", "OOH")]: 0.95, [dupKey("Digital", "OOH")]: 0.95,
  };
  const c = combineReach(parts, k);
  ok("výsledek 93,22 % jako v Excelu", close(c.net, 0.9322346, 1e-6), `${c.net}`);
  ok("nezávislost 90,45 % jako v Excelu", close(c.independent, 0.90452, 1e-6), `${c.independent}`);
  ok("kroky: druhý krok 86,06 %", close(c.steps[1].cumulative, 0.86055, 1e-6));
  ok("kroky: poslední kumulativ = výsledek", c.steps[c.steps.length - 1].cumulative === c.net);
  ok("kroky: nezávislost v posledním kroku = independent", close(c.steps[3].independent, c.independent, 1e-12));
  ok("kroky: přírůstky dají dohromady čistý zásah",
     close(c.steps.reduce((s, x) => s + x.increment, 0), c.net, 1e-12));
}

console.log("\nZpětný dopočet koeficientu");
{
  const r = kFromMeasured(0.69, 0.45, 0.83);
  ok("TV 69 % + Online 45 % → 83 % dá k ≈ 0,998", r.ok && close(r.k, 0.998389694, 1e-6));
  const back = r.ok ? combineReach([{ channelType: "TV", reach: 0.69 }, { channelType: "Digital", reach: 0.45 }],
    { [dupKey("TV", "Digital")]: r.k }).net : 0;
  ok("dopočtené k vrátí naměřený společný zásah", close(back, 0.83, 1e-9), `${back}`);
  ok("společný zásah pod silnějším médiem se odmítne", !kFromMeasured(0.69, 0.45, 0.6).ok);
  ok("společný zásah nad součtem se odmítne", !kFromMeasured(0.3, 0.2, 0.6).ok);
}

console.log("\nNázvy období");
{
  ok("říjen–prosinec = Q4 2026", periodLabel("2026-10", "2026-12") === "Q4 2026");
  ok("leden–prosinec = Rok 2027", periodLabel("2027-01", "2027-12") === "Rok 2027");
  ok("listopad–prosinec NENÍ Q4", periodLabel("2027-11", "2027-12") === "Lis–Pro 2027", periodLabel("2027-11", "2027-12"));
  ok("jeden měsíc = Prosinec 2027", periodLabel("2027-12", "2027-12") === "Prosinec 2027", periodLabel("2027-12", "2027-12"));
  ok("přes přelom roku", periodLabel("2027-11", "2028-02") === "Lis 2027 – Úno 2028", periodLabel("2027-11", "2028-02"));
}

console.log("\nTyp nákladu (agenturní práce vs. média)");
{
  ok("„Always-on Social Media fee“ je honorář", costKind("Always-on Social Media fee") === "fee");
  ok("„TikTok always on (médiá)“ jsou média", costKind("TikTok always on (médiá)") === "media");
  ok("„Gen Z obsah - always-on (ag. práce)“ je honorář", costKind("Gen Z obsah - always-on (ag. práce)") === "fee");
  ok("„SOLERO (ag. práce, influ & CC, médiá)“ je smíšené", costKind("SOLERO (ag. práce, influ & CC, médiá)") === "mixed");
  ok("ambasador je honorář", costKind("BENU Longevity - ambasádor") === "fee");
  ok("TV spot jsou média", costKind("TV – hlavní brandový spot") === "media");
  ok("partnerství / event / OOH je smíšené", costKind("Partnerství / event / OOH (bude upřesněno)") === "mixed");
}

console.log("\nKrátké názvy položek");
{
  ok("odstřihne „(hradí klient…) (navýšení…)“", shortName("Always-on Social Media promo budget (hradí klient z vlastní karty) (navýšení o 15 000 Kč)") === "Always-on Social Media promo budget");
  ok("odstřihne „ - hradí klient z vlastní karty“ na konci", shortName("Melanom - prevence - médiá (META) - hradí klient z vlastní karty") === "Melanom - prevence - médiá (META)");
  ok("nechá věcnou závorku", shortName("SOLERO (ag. práce, influ & CC, médiá)") === "SOLERO (ag. práce, influ & CC, médiá)");
  ok("odstřihne „(odhad)“", shortName("Vendor obsah & openings (odhad)") === "Vendor obsah & openings");
  ok("TV spot beze změny", shortName("TV spot 30\" – 4 produkty") === "TV spot 30\" – 4 produkty");
  ok("vlastní krátký název má přednost", displayName({ channel: "Akční leták promo budget (hradí klient z vlastní karty)", label: "Leták" }) === "Leták");
  ok("prázdný vlastní název = automaticky", displayName({ channel: "Akční leták promo budget (hradí klient z vlastní karty)", label: "  " }) === "Akční leták promo budget");
}

console.log("\nPoměrové ukazatele se počítají");
{
  ok("CPM je poměrový", derivedOf("CPM") === "CPM" && baseOf("CPM") === null);
  ok("„Imprese“ jsou základní", baseOf("Imprese") === "impressions");
  ok("„CPA (Kč)“ je poměrový", derivedOf("CPA (Kč)") === "CPA");
  ok("Reach není imprese", baseOf("Reach") === null);
  const months = ["2027-02", "2027-03"];
  const store: Record<string, number> = { "i|2027-02": 200000, "k|2027-02": 40, "cpa|2027-02": 999 };
  const res = resolveMetrics({
    months,
    metrics: [
      { id: "i", name: "Imprese", unit: "", kind: "cumulative" },
      { id: "k", name: "Konverze", unit: "", kind: "cumulative" },
      { id: "cpm", name: "CPM", unit: "Kč", kind: "rate_low" },
      { id: "cpa", name: "CPA", unit: "Kč", kind: "rate_low" },
      { id: "ctr", name: "CTR", unit: "%", kind: "rate_high" },
    ],
    actualOf: (id, m) => store[`${id}|${m}`] ?? null,
    targetOf: () => 0,
    spendOf: (m) => (m === "2027-02" ? 10000 : null),
  });
  const get = (n: string) => res.find((x) => x.name === n)!;
  ok("CPM = čerpání ÷ imprese × 1000", get("CPM").actual["2027-02"] === 50);
  ok("CPA = čerpání ÷ konverze (ruční hodnota se ignoruje)", get("CPA").actual["2027-02"] === 250);
  ok("bez čerpání se nepočítá", get("CPM").actual["2027-03"] === null);
  ok("CTR doplní chybějící Kliky k vyplnění", res.some((x) => x.id === null && x.base === "clicks"));
  ok("bez kliků CTR nejde spočítat", get("CTR").actual["2027-02"] === null);
  ok("počítané jsou na konci", res.slice(-3).every((x) => x.derived));
}

console.log("\nKalibrace křivky z naměřených vln");
{
  const fb = { rMax: 0.98, k: 1.5 };
  const one = fitCurve([{ grp: 1800, reach: 0.65 }], fb);
  ok("jedno měření: křivka prochází bodem", one.ok && Math.abs(reachFromGrp(1800, one.curve) - 0.65) < 1e-6);
  ok("jedno měření: strop zůstává z předpokladu", one.ok && one.curve.rMax === 0.98);
  const high = fitCurve([{ grp: 500, reach: 0.985 }], fb);
  ok("bod nad stropem stropem pohne", high.ok && high.curve.rMax > 0.985);
  const truth = { rMax: 0.82, k: 0.9 };
  const pts = [300, 800, 1500, 2500].map((g) => ({ grp: g, reach: reachFromGrp(g, truth) }));
  const many = fitCurve(pts, fb);
  ok("víc měření: najde strop i rychlost", many.ok && Math.abs(many.curve.rMax - 0.82) < 0.01 && Math.abs(many.curve.k - 0.9) < 0.05,
    many.ok ? `${many.curve.rMax.toFixed(3)} / ${many.curve.k.toFixed(3)}` : "");
  ok("víc měření: chyba fitu je malá", many.ok && many.error < 0.005);
  ok("zásah 100 % odmítne", !fitCurve([{ grp: 500, reach: 1 }], fb).ok);
  ok("bez měření odmítne", !fitCurve([], fb).ok);
}

console.log(failed ? `\n${failed} testů selhalo\n` : "\nVšechny testy prošly\n");
process.exit(failed ? 1 : 0);
