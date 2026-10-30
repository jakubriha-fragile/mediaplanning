import { eq, asc } from "drizzle-orm";
import { db } from "@/db";
import {
  campaigns, messageLines, tactics, tacticBudgets, tacticBudgetWeeks, actualSpends,
  accountNotes, metrics, metricTargets, metricActuals, users,
  clients, plans, targetGroups, reachCurves, duplications, channelTypeEnum, themes, tacticThemes, rateCards,
  type ChannelType, type PlanUnit,
} from "@/db/schema";
import { monthsBetween, weeksOfPeriod } from "@/lib/period";
import { costKind } from "@/lib/costKind";
import { displayName } from "@/lib/displayName";
import { resolveMetrics, type ResolvedMetric } from "@/lib/metrics";
import { can, canSeePlan, canSeeTactic, channelGroupOf, type Principal } from "@/lib/permissions";
import {
  derive, combineReach, DEFAULT_CURVE, DEFAULT_DUPLICATION, dupKey, UNCALIBRATED_SOURCE,
  type Curve, type Derived,
} from "@/lib/crossmedia";

const byMonth = <T extends { month: string }>(rows: T[], months: string[], pick: (r: T) => number) =>
  Object.fromEntries(months.map((m) => [m, pick(rows.find((r) => r.month === m) ?? ({ month: m } as T)) || 0]));

export async function getUser(id: string) {
  const [u] = await db.select().from(users).where(eq(users.id, id));
  return u;
}

// ------------------------------------------------------------- klienti a plány

export async function getClients() {
  return db.select().from(clients).where(eq(clients.active, true)).orderBy(asc(clients.name));
}

export async function getPlans(clientId?: string) {
  const rows = await db
    .select({
      id: plans.id, name: plans.name, clientId: plans.clientId,
      clientName: clients.name,
      periodStart: plans.periodStart, periodEnd: plans.periodEnd,
      status: plans.status, targetGroupId: plans.targetGroupId,
      granularity: plans.granularity,
      position: plans.position,
    })
    .from(plans)
    .innerJoin(clients, eq(plans.clientId, clients.id))
    .orderBy(asc(clients.name), asc(plans.position), asc(plans.periodStart));
  return clientId ? rows.filter((p) => p.clientId === clientId) : rows;
}

export async function getPlan(planId: string) {
  const [row] = await db
    .select({
      id: plans.id, name: plans.name, clientId: plans.clientId, clientName: clients.name,
      periodStart: plans.periodStart, periodEnd: plans.periodEnd,
      status: plans.status, targetGroupId: plans.targetGroupId, currency: plans.currency,
      freqLimit: plans.freqLimit,
      granularity: plans.granularity,
    })
    .from(plans)
    .innerJoin(clients, eq(plans.clientId, clients.id))
    .where(eq(plans.id, planId));
  return row ?? null;
}

/**
 * Plány, které uživatel smí otevřít. Stránky berou nabídku plánů VŽDY odsud —
 * getPlans() vrací i plány cizích klientů a sám nic nefiltruje.
 */
export async function getVisiblePlans(me: Principal | null) {
  const all = await getPlans();
  return all.filter((p) => canSeePlan(me, p.id));
}

/** Když uživatel nic nevybral: poslední plán, který právě běží, jinak nejnovější. */
export function defaultPlanId(visible: Array<{ id: string; status: string }>): string | null {
  if (!visible.length) return null;
  return (visible.find((p) => p.status === "live") ?? visible[visible.length - 1]).id;
}

/** Vybraný plán z adresy, pokud ho uživatel smí vidět; jinak výchozí. */
export function pickPlan(visible: Array<{ id: string; status: string }>, wanted?: string): string | null {
  return (wanted && visible.some((p) => p.id === wanted) ? wanted : null) ?? defaultPlanId(visible);
}

export async function getTargetGroups() {
  return db.select().from(targetGroups).orderBy(asc(targetGroups.position), asc(targetGroups.name));
}

// ------------------------------------------------------- cross-mediální vstupy

export type CrossContext = {
  universeOf: (tacticTgId: string | null) => number;
  curveOf: (ct: ChannelType, tacticTgId: string | null) => Curve;
  /** křivka média je z naměřených dat (Kalibrace zásahu), ne předpoklad */
  calibrated: (ct: ChannelType, tacticTgId: string | null) => boolean;
  dup: Record<string, number>;
  /**
   * Jednotková cena pro výpočet: zadaná cena, a když chybí, cena z ceníku
   * klienta. Ceník platí jen pro média zadaná v Kč — ne pro agenturní práci
   * a ne pro smíšené položky, kde by odhad nafoukl doručení i z honorářů.
   */
  priceFor: (row: { channelType: ChannelType; channel: string }, driver: PlanUnit, unitPrice: number) =>
    { unitPrice: number; estimated: boolean };
};

export async function crossContext(planTargetGroupId: string | null, clientId?: string): Promise<CrossContext> {
  const [tgs, curves, dups, rates] = await Promise.all([
    db.select().from(targetGroups),
    db.select().from(reachCurves),
    db.select().from(duplications),
    clientId ? db.select().from(rateCards).where(eq(rateCards.clientId, clientId)) : Promise.resolve([]),
  ]);
  const rateOf = new Map(rates.map((r) => [r.channelType, r.price]));

  const universeById = new Map(tgs.map((t) => [t.id, t.universe]));
  const planUniverse = planTargetGroupId ? universeById.get(planTargetGroupId) ?? 0 : 0;

  const dup = { ...DEFAULT_DUPLICATION };
  for (const d of dups) dup[dupKey(d.typeA, d.typeB)] = d.coef;

  return {
    universeOf: (tgId) => (tgId ? universeById.get(tgId) ?? 0 : planUniverse),
    curveOf: (ct, tgId) => {
      const target = tgId ?? planTargetGroupId;
      // seed do DB zapsal výchozí křivky jako „modelový odhad" — ty nejsou kalibrace,
      // přednost má výchozí hodnota z kódu (ta nese aktuální předpoklady)
      const real = curves.filter((c) => c.source !== UNCALIBRATED_SOURCE);
      const exact = real.find((c) => c.channelType === ct && c.targetGroupId === target);
      const generic = real.find((c) => c.channelType === ct && c.targetGroupId === null);
      const found = exact ?? generic;
      return found ? { rMax: found.rMax, k: found.k } : DEFAULT_CURVE[ct] ?? DEFAULT_CURVE.Digital;
    },
    calibrated: (ct, tgId) => {
      const target = tgId ?? planTargetGroupId;
      return curves.some((c) => c.channelType === ct && c.source !== UNCALIBRATED_SOURCE &&
        (c.targetGroupId === target || c.targetGroupId === null));
    },
    dup,
    priceFor: (row, driver, unitPrice) => {
      if (unitPrice > 0 || driver !== "budget" || costKind(row.channel) !== "media") return { unitPrice, estimated: false };
      const rate = rateOf.get(row.channelType) ?? 0;
      return rate > 0 ? { unitPrice: rate, estimated: true } : { unitPrice, estimated: false };
    },
  };
}

/**
 * Návrh ceníku z plánu: průměrná zadaná cena po nosičích, vážená náklady.
 * Bere jen položky, které cenu opravdu mají (TV z TRP, online z impresí).
 */
export async function impliedRates(planId: string): Promise<Partial<Record<ChannelType, number>>> {
  const { rows, budgets } = await loadPlan(planId);
  const acc = new Map<ChannelType, { cost: number; units: number }>();
  for (const b of budgets) {
    if (b.unitPrice <= 0 || b.driver === "budget" || !b.driverValue || !b.planned) continue;
    const r = rows.find((x) => x.tacticId === b.tacticId);
    if (!r) continue;
    // CPP = Kč / GRP, CPT = Kč / tisíc impresí
    const units = b.driver === "grp" ? b.driverValue : b.driverValue / 1000;
    const cur = acc.get(r.channelType) ?? { cost: 0, units: 0 };
    cur.cost += b.planned;
    cur.units += units;
    acc.set(r.channelType, cur);
  }
  return Object.fromEntries([...acc.entries()].filter(([, v]) => v.units > 0).map(([k, v]) => [k, v.cost / v.units]));
}

/** Ceník klienta po nosičích. */
export async function getRateCard(clientId: string) {
  return db.select().from(rateCards).where(eq(rateCards.clientId, clientId));
}

// ---------------------------------------------------- tematické oblasti

/** Oblasti klienta v pořadí, jak se mají zobrazovat. */
export async function getThemes(clientId: string) {
  return db.select().from(themes).where(eq(themes.clientId, clientId)).orderBy(asc(themes.position), asc(themes.name));
}

/** Podíly oblastí po taktikách — mapa tacticId → [{themeId, share}]. */
export function sharesByTactic(rows: Array<{ tacticId: string; themeId: string; share: number }>) {
  const m = new Map<string, Array<{ themeId: string; share: number }>>();
  for (const r of rows) {
    const list = m.get(r.tacticId) ?? [];
    list.push({ themeId: r.themeId, share: r.share });
    m.set(r.tacticId, list);
  }
  return m;
}

// --------------------------------------------------- koeficienty duplikace

export type DuplicationRow = {
  typeA: ChannelType;
  typeB: ChannelType;
  coef: number;
  defaultCoef: number;
  source: string;
  /** true = hodnota je vlastní, ne výchozí */
  custom: boolean;
};

/** Celá matice dvojic nosičů: výchozí hodnoty přebité tím, co je v databázi. */
export async function getDuplicationRows(): Promise<DuplicationRow[]> {
  const rows = await db.select().from(duplications);
  const types = channelTypeEnum.enumValues;
  const out: DuplicationRow[] = [];
  for (let i = 0; i < types.length; i++) {
    for (let j = i; j < types.length; j++) {
      const key = dupKey(types[i], types[j]);
      const [typeA, typeB] = key.split("|") as [ChannelType, ChannelType];
      const own = rows.find((r) => dupKey(r.typeA, r.typeB) === key);
      const def = DEFAULT_DUPLICATION[key] ?? 1;
      // seed ukládá do databáze i výchozí hodnoty, takže „vlastní" je jen to,
      // co se od výchozí hodnoty opravdu liší
      const custom = !!own && Math.abs(own.coef - def) > 1e-9;
      out.push({ typeA, typeB, coef: own?.coef ?? def, defaultCoef: def, source: own?.source ?? "", custom });
    }
  }
  return out;
}

// ------------------------------------------------------------------- plán

/** Jeden plochý dotaz přes celé období — levnější než N+1 i na ročním plánu. */
export async function loadPlan(planId: string) {
  const rows = await db
    .select({
      tacticId: tactics.id,
      messageLineId: tactics.messageLineId,
      channel: tactics.channel,
      label: tactics.label,
      mediaType: tactics.mediaType,
      channelType: tactics.channelType,
      mediumId: tactics.mediumId,
      platformId: tactics.platformId,
      targetGroupId: tactics.targetGroupId,
      position: tactics.position,
      code: messageLines.code,
      message: messageLines.message,
      phase: messageLines.phase,
      audience: messageLines.audience,
      campaignId: campaigns.id,
      campaign: campaigns.name,
    })
    .from(tactics)
    .innerJoin(messageLines, eq(tactics.messageLineId, messageLines.id))
    .innerJoin(campaigns, eq(messageLines.campaignId, campaigns.id))
    .where(eq(campaigns.planId, planId))
    .orderBy(asc(campaigns.position), asc(campaigns.name), asc(tactics.position));

  const [budgets, spends, notes, mets, weekRows] = await Promise.all([
    db.select().from(tacticBudgets),
    db.select().from(actualSpends),
    db.select().from(accountNotes),
    db.select().from(metrics).orderBy(asc(metrics.slot)),
    db.select().from(tacticBudgetWeeks),
  ]);
  const [targets, mActuals] = await Promise.all([
    db.select().from(metricTargets),
    db.select().from(metricActuals),
  ]);

  const ids = new Set(rows.map((r) => r.tacticId));
  const shares = (await db.select().from(tacticThemes)).filter((x) => ids.has(x.tacticId));
  return {
    rows,
    themeShares: shares,
    budgets: budgets.filter((b) => ids.has(b.tacticId)),
    weeks: weekRows.filter((w) => ids.has(w.tacticId)),
    spends: spends.filter((s) => ids.has(s.tacticId)),
    notes: notes.filter((n) => ids.has(n.tacticId)),
    mets: mets.filter((m) => ids.has(m.tacticId)),
    targets, mActuals,
  };
}

export type PlanCell = Derived & {
  driver: PlanUnit;
  driverValue: number;
  unitPrice: number;
  /** doručení je odhad z ceníku klienta, ne zadaná cena */
  estimated?: boolean;
};

export async function getPlanRows(me: Principal, planId: string) {
  const plan = await getPlan(planId);
  if (!plan || !canSeePlan(me, planId)) return [];
  const months = monthsBetween(plan.periodStart, plan.periodEnd);
  const ctx = await crossContext(plan.targetGroupId, plan.clientId);
  const loaded = await loadPlan(planId);
  const { budgets, spends } = loaded;
  const themeMap = sharesByTactic(loaded.themeShares);
  const rows = loaded.rows.filter((r) => canSeeTactic(me, { planId, mediaType: r.mediaType, campaignId: r.campaignId, channelType: r.channelType, tacticId: r.tacticId }));
  const weeks = plan.granularity === "week" ? weeksOfPeriod(plan.periodStart, plan.periodEnd) : [];

  return rows.map((r) => {
    const universe = ctx.universeOf(r.targetGroupId);
    const curve = ctx.curveOf(r.channelType, r.targetGroupId);
    const mine = budgets.filter((b) => b.tacticId === r.tacticId);

    const cells = Object.fromEntries(
      months.map((m) => {
        const b = mine.find((x) => x.month === m);
        const driver = (b?.driver ?? "budget") as PlanUnit;
        const driverValue = b?.driverValue ?? b?.planned ?? 0;
        const unitPrice = b?.unitPrice ?? 0;
        const price = ctx.priceFor(r, driver, unitPrice);
        const d = derive({
          channelType: r.channelType, driver, driverValue, unitPrice: price.unitPrice, universe, curve,
        });
        // Uložený rozpočet má přednost — porovnává se se skutečností. Nula ale
        // znamená „ještě nedopočítáno" (import, seed), proto tam pustíme dopočet;
        // u prázdné buňky je dopočet taky nula, takže se nic nerozbije.
        return [m, { ...d, budget: b?.planned || d.budget, driver, driverValue, unitPrice, estimated: price.estimated } as PlanCell];
      }),
    );

    // plán po týdnech: buňky týdnů pro tabulku; měsíce (cells) jsou jejich součet
    const weekCells = plan.granularity === "week"
      ? Object.fromEntries(weeks.map((w) => {
          const b = loaded.weeks.find((x) => x.tacticId === r.tacticId && x.week === w.key);
          const driver = (b?.driver ?? cells[months[0]]?.driver ?? "budget") as PlanUnit;
          const driverValue = b?.driverValue ?? 0;
          const unitPrice = b?.unitPrice ?? 0;
          const price = ctx.priceFor(r, driver, unitPrice);
          const d = derive({ channelType: r.channelType, driver, driverValue, unitPrice: price.unitPrice, universe, curve });
          return [w.key, { ...d, budget: b?.planned || d.budget, driver, driverValue, unitPrice, estimated: price.estimated } as PlanCell];
        }))
      : null;
    // týden smí měnit, kdo smí všechny měsíce, do kterých týden zasahuje
    const weekEditable = plan.granularity === "week"
      ? Object.fromEntries(weeks.map((w) => [w.key, w.parts.every((p) => can(me, "write", {
          area: "plan", mediaType: r.mediaType, planId, campaignId: r.campaignId, month: p.month,
          channelType: r.channelType, tacticId: r.tacticId,
        }))]))
      : null;

    return {
      id: r.tacticId,
      weekCells,
      weekEditable,
      campaign: r.campaign,
      campaignId: r.campaignId,
      messageLineId: r.messageLineId,
      code: r.code,
      message: r.message,
      phase: r.phase as string,
      audience: r.audience,
      channel: r.channel,
      label: r.label,
      name: displayName(r),
      mediaType: r.mediaType,
      channelType: r.channelType,
      mediumId: r.mediumId,
      platformId: r.platformId,
      targetGroupId: r.targetGroupId,
      themes: themeMap.get(r.tacticId) ?? [],
      universe,
      cells,
      budgets: Object.fromEntries(months.map((m) => [m, cells[m].budget])),
      actuals: byMonth(spends.filter((s) => s.tacticId === r.tacticId), months, (s) => s.amount),
      editable: Object.fromEntries(
        months.map((m) => [
          m,
          can(me, "write", {
            area: "plan", mediaType: r.mediaType, planId,
            campaignId: r.campaignId, month: m, channelType: r.channelType, tacticId: r.tacticId,
          }),
        ]),
      ),
    };
  });
}

export type PlanRowData = Awaited<ReturnType<typeof getPlanRows>>[number];

/** Kampaně a jejich linky — pro přiřazování taktik a zakládání nových. */
export async function getCampaignTree(planId: string) {
  const rows = await db
    .select({
      id: campaigns.id, name: campaigns.name,
      lineId: messageLines.id, code: messageLines.code,
    })
    .from(campaigns)
    .leftJoin(messageLines, eq(messageLines.campaignId, campaigns.id))
    .where(eq(campaigns.planId, planId))
    .orderBy(asc(campaigns.position), asc(campaigns.name), asc(messageLines.code));

  const out: Array<{ id: string; name: string; lines: Array<{ id: string; code: string }> }> = [];
  for (const r of rows) {
    let c = out.find((x) => x.id === r.id);
    if (!c) out.push((c = { id: r.id, name: r.name, lines: [] }));
    if (r.lineId) c.lines.push({ id: r.lineId, code: r.code! });
  }
  return out;
}

// ------------------------------------------------------- cross-mediální souhrn

export type ReachSummary = {
  month: string;
  net: number;
  gross: number;
  overlap: number;
  /** čistý zásah při nezávislosti (k = 1) — srovnání jako v kalkulačce */
  independent: number;
  people: number;
  grp: number;
  impressions: number;
  budget: number;
  byType: Array<{ channelType: ChannelType; reach: number; grp: number; budget: number }>;
};

/**
 * Čistý zásah a překryv za každý měsíc a za celé období.
 *
 * Za období se zásahy NESČÍTAJÍ — kombinují se stejným modelem jako napříč
 * médii, jinak by roční zásah vyšel přes sto procent. Je to modelový odhad,
 * ne měření; před sdílením s klientem patří validovat media specialistou.
 */
export async function getReachSummary(me: Principal, planId: string): Promise<{
  months: ReachSummary[];
  total: ReachSummary;
  universe: number;
  hasUniverse: boolean;
}> {
  const plan = await getPlan(planId);
  const empty: ReachSummary = {
    month: "", net: 0, gross: 0, overlap: 0, independent: 0, people: 0,
    grp: 0, impressions: 0, budget: 0, byType: [],
  };
  if (!plan) return { months: [], total: empty, universe: 0, hasUniverse: false };

  const months = monthsBetween(plan.periodStart, plan.periodEnd);
  const ctx = await crossContext(plan.targetGroupId, plan.clientId);
  const loaded = await loadPlan(planId);
  const { budgets } = loaded;
  // jen taktiky, které uživatel vidí — jinak by souhrn prozradil zbytek plánu
  const rows = canSeePlan(me, planId)
    ? loaded.rows.filter((r) => canSeeTactic(me, { planId, mediaType: r.mediaType, campaignId: r.campaignId, channelType: r.channelType, tacticId: r.tacticId }))
    : [];
  const universe = ctx.universeOf(null);

  const perMonth: ReachSummary[] = months.map((m) => {
    // uvnitř měsíce se nejdřív sečtou GRP po nosičích, teprve pak se hledá zásah:
    // dvě digitální taktiky nejsou dvě nezávislá média
    const grpByType = new Map<ChannelType, { grp: number; budget: number }>();
    let impressions = 0;
    let budget = 0;

    for (const r of rows) {
      const b = budgets.find((x) => x.tacticId === r.tacticId && x.month === m);
      if (!b || !b.driverValue) continue;
      const u = ctx.universeOf(r.targetGroupId);
      const d = derive({
        channelType: r.channelType,
        driver: b.driver as PlanUnit,
        driverValue: b.driverValue,
        unitPrice: ctx.priceFor(r, b.driver as PlanUnit, b.unitPrice).unitPrice,
        universe: u,
        curve: ctx.curveOf(r.channelType, r.targetGroupId),
      });
      const cur = grpByType.get(r.channelType) ?? { grp: 0, budget: 0 };
      cur.grp += d.grp;
      cur.budget += b.planned || d.budget;
      grpByType.set(r.channelType, cur);
      impressions += d.impressions;
      budget += b.planned || d.budget;
    }

    const byType = [...grpByType.entries()].map(([channelType, v]) => {
      const curve = ctx.curveOf(channelType, null);
      return {
        channelType,
        grp: v.grp,
        budget: v.budget,
        reach: v.grp > 0 ? curve.rMax * (1 - Math.exp(-curve.k * (v.grp / 100))) : 0,
      };
    });

    const c = combineReach(byType.map((b) => ({ channelType: b.channelType, reach: b.reach })), ctx.dup);
    return {
      month: m,
      net: c.net,
      gross: c.gross,
      overlap: c.overlap,
      independent: c.independent,
      people: c.net * universe,
      grp: byType.reduce((s, b) => s + b.grp, 0),
      impressions,
      budget,
      byType: byType.sort((a, b) => b.budget - a.budget),
    };
  });

  // za období: GRP se po nosičích sečtou a zásah se hledá z celkového objemu
  const totalGrp = new Map<ChannelType, { grp: number; budget: number }>();
  for (const m of perMonth) {
    for (const b of m.byType) {
      const cur = totalGrp.get(b.channelType) ?? { grp: 0, budget: 0 };
      cur.grp += b.grp;
      cur.budget += b.budget;
      totalGrp.set(b.channelType, cur);
    }
  }
  const totalByType = [...totalGrp.entries()].map(([channelType, v]) => {
    const curve = ctx.curveOf(channelType, null);
    return {
      channelType, grp: v.grp, budget: v.budget,
      reach: v.grp > 0 ? curve.rMax * (1 - Math.exp(-curve.k * (v.grp / 100))) : 0,
    };
  });
  const tc = combineReach(totalByType.map((b) => ({ channelType: b.channelType, reach: b.reach })), ctx.dup);

  return {
    months: perMonth,
    total: {
      month: "",
      net: tc.net,
      gross: tc.gross,
      overlap: tc.overlap,
      independent: tc.independent,
      people: tc.net * universe,
      grp: totalByType.reduce((s, b) => s + b.grp, 0),
      impressions: perMonth.reduce((s, m) => s + m.impressions, 0),
      budget: perMonth.reduce((s, m) => s + m.budget, 0),
      byType: totalByType.sort((a, b) => b.budget - a.budget),
    },
    universe,
    hasUniverse: universe > 0,
  };
}

// ------------------------------------------------------------------- plnění

export async function getPerfRows(me: Principal, planId: string) {
  const plan = await getPlan(planId);
  if (!plan || !canSeePlan(me, planId)) return [];
  const months = monthsBetween(plan.periodStart, plan.periodEnd);
  const loaded = await loadPlan(planId);
  const { budgets, spends, notes, mets, targets, mActuals } = loaded;
  const rows = loaded.rows.filter((r) => canSeeTactic(me, { planId, mediaType: r.mediaType, campaignId: r.campaignId, channelType: r.channelType, tacticId: r.tacticId }));

  return rows.map((r) => ({
    id: r.tacticId,
    channel: r.channel,
    mediaType: r.mediaType,
    channelType: r.channelType,
    campaign: r.campaign,
    code: r.code,
    message: r.message,
    audience: r.audience,
    editable: Object.fromEntries(
      months.map((m) => [
        m,
        can(me, "write", {
          area: "actuals", mediaType: r.mediaType, planId,
          campaignId: r.campaignId, month: m, channelType: r.channelType, tacticId: r.tacticId,
        }),
      ]),
    ),
    /** smí měnit plán (cíle ukazatelů) — v Plnění se zadávají cíle KPI */
    planEditable: Object.fromEntries(
      months.map((m) => [
        m,
        can(me, "write", {
          area: "plan", mediaType: r.mediaType, planId,
          campaignId: r.campaignId, month: m, channelType: r.channelType, tacticId: r.tacticId,
        }),
      ]),
    ),
    /** smí přidávat a mazat ukazatele (plán taktiky napříč měsíci) */
    canManageMetrics: can(me, "write", {
      area: "plan", mediaType: r.mediaType, planId,
      campaignId: r.campaignId, month: null, channelType: r.channelType, tacticId: r.tacticId,
    }),
    budget: byMonth(budgets.filter((b) => b.tacticId === r.tacticId), months, (b) => b.planned),
    spend: byMonth(spends.filter((s) => s.tacticId === r.tacticId), months, (s) => s.amount),
    note: Object.fromEntries(
      months.map((m) => [m, notes.find((n) => n.tacticId === r.tacticId && n.month === m)?.text ?? ""]),
    ),
    // poměrové ukazatele (CPM, CPA…) se dopočítají z čerpání a základních čísel
    metrics: tacticMetrics(r.tacticId, months, loaded).map((mt) => ({
      ...mt,
      actual: Object.fromEntries(months.map((m) => [m, mt.actual[m] ?? 0])),
    })),
  }));
}

// ------------------------------------------------------------- k vyplnění

export type FillMonth = {
  planned: number;
  /** čím je měsíc řízený — rozpočet u GRP/impresí se tady přepsat nesmí, změnil by model */
  driver: PlanUnit;
  /** null = ještě nikdo nevyplnil; 0 = vyplněno „nečerpáno" */
  actual: number | null;
  canPlan: boolean;
  canActual: boolean;
  /** komentář agentury k měsíci (vysvětlení odchylky) */
  note: string;
};

export type FillRow = {
  id: string;
  block: string;
  /** krátký název k zobrazení; plný je v `channel` */
  name: string;
  channel: string;
  channelType: ChannelType;
  online: boolean;
  months: Record<string, FillMonth>;
  metrics: ResolvedMetric[];
  /** smí přidávat a mazat ukazatele (plán taktiky napříč měsíci) */
  canManageMetrics: boolean;
};

/** Ukazatele taktiky včetně dopočtu poměrových (viz src/lib/metrics.ts). */
function tacticMetrics(tacticId: string, months: string[], loaded: Awaited<ReturnType<typeof loadPlan>>): ResolvedMetric[] {
  return resolveMetrics({
    months,
    metrics: loaded.mets.filter((mt) => mt.tacticId === tacticId),
    actualOf: (id, m) => loaded.mActuals.find((x) => x.metricId === id && x.month === m)?.value ?? null,
    targetOf: (id, m) => loaded.targets.find((x) => x.metricId === id && x.month === m)?.target ?? 0,
    spendOf: (m) => loaded.spends.find((x) => x.tacticId === tacticId && x.month === m)?.amount ?? null,
  });
}

/**
 * Položky, do kterých uživatel smí něco zapsat — podklad pro stránku K vyplnění.
 * Bere jen taktiky, které vidí, a z nich ty, kde má zápis aspoň v jednom měsíci.
 * Prázdná skutečnost (žádný řádek) se liší od nuly: nula je „nečerpáno".
 */
export async function getFillRows(me: Principal, planId: string): Promise<FillRow[]> {
  const rows = await getResultRows(me, planId);
  return rows.filter((r) => Object.values(r.months).some((c) => c.canPlan || c.canActual));
}

/**
 * Řádky stránky Výsledky: všechny položky, které uživatel vidí, s plánem,
 * skutečností, komentářem a ukazateli po měsících, a u každé buňky jestli
 * do ní smí zapisovat. Plnění i K vyplnění stojí na tomhle jednom zdroji.
 */
export async function getResultRows(me: Principal, planId: string): Promise<FillRow[]> {
  const plan = await getPlan(planId);
  if (!plan || !canSeePlan(me, planId)) return [];
  const months = monthsBetween(plan.periodStart, plan.periodEnd);
  const loaded = await loadPlan(planId);
  const { budgets, spends, notes } = loaded;

  const out: FillRow[] = [];
  for (const r of loaded.rows) {
    const coords = { planId, mediaType: r.mediaType, campaignId: r.campaignId, channelType: r.channelType, tacticId: r.tacticId };
    if (!canSeeTactic(me, coords)) continue;
    const cells = Object.fromEntries(months.map((m) => {
      const b = budgets.find((x) => x.tacticId === r.tacticId && x.month === m);
      const s = spends.find((x) => x.tacticId === r.tacticId && x.month === m);
      return [m, {
        planned: b?.planned ?? 0,
        driver: (b?.driver ?? "budget") as PlanUnit,
        actual: s ? s.amount : null,
        canPlan: can(me, "write", { area: "plan", ...coords, month: m }),
        canActual: can(me, "write", { area: "actuals", ...coords, month: m }),
        note: notes.find((n) => n.tacticId === r.tacticId && n.month === m)?.text ?? "",
      }];
    })) as Record<string, FillMonth>;

    out.push({
      id: r.tacticId,
      block: r.campaign,
      name: displayName(r),
      channel: r.channel,
      channelType: r.channelType,
      online: channelGroupOf(r.channelType) === "online",
      months: cells,
      metrics: tacticMetrics(r.tacticId, months, loaded),
      canManageMetrics: can(me, "write", { area: "plan", ...coords, month: null }),
    });
  }
  return out;
}
