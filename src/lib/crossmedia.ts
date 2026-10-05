/**
 * Cross-mediální přepočty.
 *
 * Offline a online se nedají plánovat vedle sebe, dokud se nesejdou v jedné
 * jednotce. Tou je tady cílová skupina a její velikost (universum):
 *
 *     impressions = GRP × universum / 100
 *     GRP         = zásah % × frekvence
 *     zásah %     = rMax × (1 − e^(−k · GRP/100))      ← křivka zásahu
 *     frekvence   = GRP / zásah %
 *
 * Plánovač zadá JEDNO číslo (rozpočet, GRP, nebo impressions) a zbytek se
 * dopočítá. To je celý smysl — v Excelu se psaly všechny čtyři ručně a musely
 * spolu souhlasit.
 *
 * Model zásahu je modelový odhad, ne měření. Bez panelových dat (single-source)
 * nelze deduplikovat přesně; čísla patří před odesláním klientovi validovat
 * media specialistou.
 */

import type { ChannelType, PlanUnit } from "@/db/schema";

/** Média obchodovaná na GRP (cena za bod), ne na tisíc kontaktů. */
const GRP_PRICED: ChannelType[] = ["TV", "Rádio"];

export const isGrpPriced = (t: ChannelType) => GRP_PRICED.includes(t);

/** Jak se u daného nosiče jmenuje jednotková cena. */
export const priceLabel = (t: ChannelType) => (isGrpPriced(t) ? "CPP" : "CPT");
export const priceHint = (t: ChannelType) =>
  isGrpPriced(t) ? "Kč za jeden GRP" : "Kč za tisíc kontaktů";

export const UNIT_LABEL: Record<PlanUnit, string> = {
  budget: "Rozpočet",
  grp: "GRP",
  impressions: "Impressions",
};

export type Curve = { rMax: number; k: number };

/** Výchozí křivky, než se zkalibrují na panelová data. */
export const DEFAULT_CURVE: Record<ChannelType, Curve> = {
  TV:      { rMax: 0.92, k: 1.05 },
  Rádio:   { rMax: 0.68, k: 0.80 },
  OOH:     { rMax: 0.85, k: 1.30 },
  Print:   { rMax: 0.45, k: 0.70 },
  Kino:    { rMax: 0.22, k: 0.55 },
  Digital: { rMax: 0.78, k: 0.95 },
  Vlastní: { rMax: 0.35, k: 0.60 },
  PR:      { rMax: 0.30, k: 0.50 },
};

/**
 * Duplikace nad rámec nezávislosti. 1,0 = publika se překrývají přesně tak,
 * jak by odpovídalo náhodě. Vyšší číslo = větší reálný překryv = nižší čistý
 * zásah. Stejné médium se sebou samým se překrývá nejvíc.
 */
const DUP_PAIRS: Array<[ChannelType, ChannelType, number]> = [
  // stejný nosič se sebou samým se překrývá nejvíc
  ["TV", "TV", 1.70], ["Rádio", "Rádio", 1.65], ["Vlastní", "Vlastní", 1.60],
  ["Digital", "Digital", 1.55], ["OOH", "OOH", 1.50], ["Print", "Print", 1.40],
  ["PR", "PR", 1.40], ["Kino", "Kino", 1.30],
  // dvojice napříč nosiči
  ["TV", "Rádio", 1.30], ["TV", "Digital", 1.25], ["TV", "Print", 1.20],
  ["TV", "OOH", 1.15], ["TV", "PR", 1.10], ["TV", "Vlastní", 1.05], ["TV", "Kino", 1.05],
  ["Digital", "Vlastní", 1.35], ["Digital", "PR", 1.20], ["Digital", "Rádio", 1.15],
  ["Digital", "OOH", 1.12], ["Digital", "Print", 1.10], ["Digital", "Kino", 1.05],
  ["OOH", "Rádio", 1.18], ["OOH", "Print", 1.08], ["OOH", "Vlastní", 1.05],
  ["OOH", "PR", 1.05], ["OOH", "Kino", 1.05],
  ["Rádio", "PR", 1.10], ["Rádio", "Print", 1.10], ["Rádio", "Vlastní", 1.05], ["Rádio", "Kino", 1.05],
  ["Print", "PR", 1.25], ["Print", "Vlastní", 1.05], ["Print", "Kino", 1.05],
  ["Kino", "Vlastní", 1.02], ["Kino", "PR", 1.02],
  ["Vlastní", "PR", 1.30],
];

export function dupKey(a: ChannelType, b: ChannelType): string {
  return [a, b].sort().join("|");
}

/**
 * Duplikace nad rámec nezávislosti pro dvojici nosičů. 1,0 = publika se
 * překrývají přesně tak, jak by odpovídalo náhodě. Vyšší číslo = větší reálný
 * překryv = nižší čistý zásah. Klíče skládá dupKey, aby nešlo splést pořadí.
 */
export const DEFAULT_DUPLICATION: Record<string, number> = Object.fromEntries(
  DUP_PAIRS.map(([a, b, v]) => [dupKey(a, b), v]),
);

export function duplicationOf(
  a: ChannelType,
  b: ChannelType,
  table: Record<string, number> = DEFAULT_DUPLICATION,
): number {
  return table[dupKey(a, b)] ?? 1;
}

/** Zásah jako podíl 0–1 pro daný objem GRP. */
export function reachFromGrp(grp: number, curve: Curve): number {
  if (grp <= 0) return 0;
  return curve.rMax * (1 - Math.exp(-curve.k * (grp / 100)));
}

/** Kolik GRP je potřeba na daný zásah — obrácená křivka, pro plánování od cíle. */
export function grpForReach(reach: number, curve: Curve): number {
  if (reach <= 0) return 0;
  if (reach >= curve.rMax) return Infinity;
  return (-100 / curve.k) * Math.log(1 - reach / curve.rMax);
}

export type TacticInput = {
  channelType: ChannelType;
  driver: PlanUnit;
  driverValue: number;
  unitPrice: number;
  universe: number;
  curve?: Curve;
};

export type Derived = {
  budget: number;
  grp: number;
  impressions: number;
  /** podíl 0–1 */
  reach: number;
  /** počet zasažených osob */
  reachPeople: number;
  frequency: number;
  /** co chybí k dopočtu — pro srozumitelné hlášky v rozhraní */
  missing: null | "price" | "universe";
};

const EMPTY: Derived = {
  budget: 0, grp: 0, impressions: 0, reach: 0, reachPeople: 0, frequency: 0, missing: null,
};

/**
 * Z jednoho zadaného čísla dopočítá zbytek.
 * Pořadí je vždy: dostat se na impressions → z nich GRP → z GRP zásah a frekvence.
 */
export function derive(t: TacticInput): Derived {
  const { channelType, driver, driverValue: v, unitPrice: p, universe: U } = t;
  const curve = t.curve ?? DEFAULT_CURVE[channelType] ?? DEFAULT_CURVE.Digital;
  const grpPriced = isGrpPriced(channelType);

  if (!v || v <= 0) return EMPTY;

  let budget = 0;
  let grp = 0;
  let impressions = 0;

  if (driver === "budget") {
    budget = v;
    if (p <= 0) return { ...EMPTY, budget, missing: "price" };
    if (grpPriced) {
      grp = budget / p;
      impressions = U > 0 ? (grp * U) / 100 : 0;
    } else {
      impressions = (budget / p) * 1000;
      grp = U > 0 ? (impressions / U) * 100 : 0;
    }
  } else if (driver === "grp") {
    grp = v;
    impressions = U > 0 ? (grp * U) / 100 : 0;
    budget = grpPriced ? grp * p : (impressions / 1000) * p;
  } else {
    impressions = v;
    grp = U > 0 ? (impressions / U) * 100 : 0;
    budget = grpPriced ? grp * p : (impressions / 1000) * p;
  }

  if (U <= 0) {
    return { budget, grp: 0, impressions, reach: 0, reachPeople: 0, frequency: 0, missing: "universe" };
  }

  const reach = reachFromGrp(grp, curve);
  const frequency = reach > 0 ? grp / (reach * 100) : 0;

  return {
    budget,
    grp,
    impressions,
    reach,
    reachPeople: reach * U,
    frequency,
    missing: p <= 0 && driver === "budget" ? "price" : null,
  };
}

// ------------------------------------------------------------- zásah a překryv

export type ReachPart = { channelType: ChannelType; reach: number };

export type Combined = {
  /** čistý zásah 0–1 po odečtení překryvu */
  net: number;
  /** součet dílčích zásahů, jako by se nepřekrývaly */
  gross: number;
  /** gross − net, tedy kolik zásahu se počítá dvakrát */
  overlap: number;
  /** čistý zásah při čisté nezávislosti — kontrolní číslo */
  independent: number;
};

/**
 * Skládání zásahu napříč médii.
 *
 * Při nezávislosti platí Sainsbury: R = 1 − Π(1 − rᵢ). Jenže publika médií se
 * reálně překrývají VÍC, než by odpovídalo náhodě, takže nezávislost čistý
 * zásah nadhodnocuje. Proto se média přidávají postupně od nejsilnějšího a
 * překryv každého dalšího se násobí koeficientem kᵢⱼ:
 *
 *     překryv = min(rᵢ, R, k̄ · rᵢ · R)
 *     R       = R + rᵢ − překryv
 *
 * Model je monotónní — každé přidané médium zásah zvýší, nikdy nesníží — a
 * drží se mezi nejsilnějším jednotlivým médiem a sto procenty. Koeficienty
 * patří zkalibrovat na panelová data; dokud se tak nestane, je to kvalifikovaný
 * odhad, ne měření.
 */
export function combineReach(
  parts: ReachPart[],
  dup: Record<string, number> = DEFAULT_DUPLICATION,
): Combined {
  const live = parts.filter((p) => p.reach > 0).sort((a, b) => b.reach - a.reach);
  if (live.length === 0) return { net: 0, gross: 0, overlap: 0, independent: 0 };

  const gross = live.reduce((s, p) => s + p.reach, 0);
  const independent = 1 - live.reduce((s, p) => s * (1 - p.reach), 1);

  // Média se přidávají od nejsilnějšího. Každé další přinese svůj zásah minus
  // to, co už je pokryté — a překryv je kᵢⱼ-krát větší, než by dala náhoda.
  const included: ReachPart[] = [live[0]];
  let net = live[0].reach;

  for (let i = 1; i < live.length; i++) {
    const p = live[i];
    // průměrná duplikace vůči tomu, co už v mixu je, vážená zásahem
    let wsum = 0;
    let w = 0;
    for (const q of included) {
      wsum += duplicationOf(p.channelType, q.channelType, dup) * q.reach;
      w += q.reach;
    }
    const kBar = w > 0 ? wsum / w : 1;

    // překryv nemůže být větší než menší z obou zásahů
    const overlap = Math.min(p.reach, net, kBar * p.reach * net);
    net = Math.min(1, net + p.reach - overlap);
    included.push(p);
  }

  return { net, gross, overlap: Math.max(0, gross - net), independent };
}

/**
 * Přírůstek čistého zásahu, který přidá jedna taktika navíc.
 * Tohle je číslo, které plánovač reálně hledá: „co mi udělá dalších 300 tisíc
 * do OOH" — ne celkový zásah, ale rozdíl.
 */
export function incrementalReach(
  base: ReachPart[],
  added: ReachPart,
  dup: Record<string, number> = DEFAULT_DUPLICATION,
): number {
  const before = combineReach(base, dup).net;
  const after = combineReach([...base, added], dup).net;
  return Math.max(0, after - before);
}

/** Efektivní zásah: podíl skupiny zasažený aspoň n×, odhad z Poissonova rozdělení. */
export function effectiveReach(reach: number, frequency: number, minContacts = 3): number {
  if (reach <= 0 || frequency <= 0) return 0;
  if (minContacts <= 1) return reach;
  let cum = 0;
  let term = Math.exp(-frequency);
  for (let i = 0; i < minContacts; i++) {
    if (i > 0) term *= frequency / i;
    cum += term;
  }
  return reach * Math.max(0, 1 - cum);
}
