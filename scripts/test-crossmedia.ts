/**
 * Testy cross-mediálních přepočtů. Běží bez databáze: `npm run test:cross`.
 *
 * Hlídají hlavně to, že přepočty jsou vratné — zadám rozpočet, přečtu GRP,
 * zadám ten GRP a musím dostat zpátky stejný rozpočet. Bez toho by plánovač
 * nemohl přepínat řídicí jednotku a věřit, že se mu čísla nerozjedou.
 */
import {
  derive, combineReach, incrementalReach, reachFromGrp, grpForReach,
  effectiveReach, duplicationOf, DEFAULT_CURVE, isGrpPriced,
} from "../src/lib/crossmedia";

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
import { DEFAULT_DUPLICATION, dupKey } from "../src/lib/crossmedia";
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

console.log(failed ? `\n${failed} testů selhalo\n` : "\nVšechny testy prošly\n");
process.exit(failed ? 1 : 0);
