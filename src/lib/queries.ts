import { eq, asc } from "drizzle-orm";
import { db } from "@/db";
import {
  campaigns, messageLines, tactics, tacticBudgets, actualSpends,
  accountNotes, metrics, metricTargets, metricActuals, users,
  clients, plans, targetGroups, reachCurves, duplications,
  type ChannelType, type PlanUnit,
} from "@/db/schema";
import { monthsBetween } from "@/lib/period";
import { can, type Principal } from "@/lib/permissions";
import {
  derive, combineReach, DEFAULT_CURVE, DEFAULT_DUPLICATION, dupKey,
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
    })
    .from(plans)
    .innerJoin(clients, eq(plans.clientId, clients.id))
    .where(eq(plans.id, planId));
  return row ?? null;
}

/** Když uživatel nic nevybral: poslední plán, který právě běží, jinak nejnovější. */
export async function defaultPlanId(): Promise<string | null> {
  const all = await getPlans();
  if (!all.length) return null;
  return (all.find((p) => p.status === "live") ?? all[all.length - 1]).id;
}

export async function getTargetGroups() {
  return db.select().from(targetGroups).orderBy(asc(targetGroups.position), asc(targetGroups.name));
}

// ------------------------------------------------------- cross-mediální vstupy

type CrossContext = {
  universeOf: (tacticTgId: string | null) => number;
  curveOf: (ct: ChannelType, tacticTgId: string | null) => Curve;
  dup: Record<string, number>;
};

async function crossContext(planTargetGroupId: string | null): Promise<CrossContext> {
  const [tgs, curves, dups] = await Promise.all([
    db.select().from(targetGroups),
    db.select().from(reachCurves),
    db.select().from(duplications),
  ]);

  const universeById = new Map(tgs.map((t) => [t.id, t.universe]));
  const planUniverse = planTargetGroupId ? universeById.get(planTargetGroupId) ?? 0 : 0;

  const dup = { ...DEFAULT_DUPLICATION };
  for (const d of dups) dup[dupKey(d.typeA, d.typeB)] = d.coef;

  return {
    universeOf: (tgId) => (tgId ? universeById.get(tgId) ?? 0 : planUniverse),
    curveOf: (ct, tgId) => {
      const target = tgId ?? planTargetGroupId;
      const exact = curves.find((c) => c.channelType === ct && c.targetGroupId === target);
      const generic = curves.find((c) => c.channelType === ct && c.targetGroupId === null);
      const found = exact ?? generic;
      return found ? { rMax: found.rMax, k: found.k } : DEFAULT_CURVE[ct] ?? DEFAULT_CURVE.Digital;
    },
    dup,
  };
}

// ------------------------------------------------------------------- plán

/** Jeden plochý dotaz přes celé období — levnější než N+1 i na ročním plánu. */
async function loadPlan(planId: string) {
  const rows = await db
    .select({
      tacticId: tactics.id,
      messageLineId: tactics.messageLineId,
      channel: tactics.channel,
      mediaType: tactics.mediaType,
      channelType: tactics.channelType,
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

  const [budgets, spends, notes, mets] = await Promise.all([
    db.select().from(tacticBudgets),
    db.select().from(actualSpends),
    db.select().from(accountNotes),
    db.select().from(metrics).orderBy(asc(metrics.slot)),
  ]);
  const [targets, mActuals] = await Promise.all([
    db.select().from(metricTargets),
    db.select().from(metricActuals),
  ]);

  const ids = new Set(rows.map((r) => r.tacticId));
  return {
    rows,
    budgets: budgets.filter((b) => ids.has(b.tacticId)),
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
};

export async function getPlanRows(me: Principal, planId: string) {
  const plan = await getPlan(planId);
  if (!plan) return [];
  const months = monthsBetween(plan.periodStart, plan.periodEnd);
  const ctx = await crossContext(plan.targetGroupId);
  const { rows, budgets, spends } = await loadPlan(planId);

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
        const d = derive({
          channelType: r.channelType, driver, driverValue, unitPrice, universe, curve,
        });
        // Uložený rozpočet má přednost — porovnává se se skutečností. Nula ale
        // znamená „ještě nedopočítáno" (import, seed), proto tam pustíme dopočet;
        // u prázdné buňky je dopočet taky nula, takže se nic nerozbije.
        return [m, { ...d, budget: b?.planned || d.budget, driver, driverValue, unitPrice } as PlanCell];
      }),
    );

    return {
      id: r.tacticId,
      campaign: r.campaign,
      campaignId: r.campaignId,
      messageLineId: r.messageLineId,
      code: r.code,
      message: r.message,
      phase: r.phase as string,
      audience: r.audience,
      channel: r.channel,
      mediaType: r.mediaType,
      channelType: r.channelType,
      targetGroupId: r.targetGroupId,
      universe,
      cells,
      budgets: Object.fromEntries(months.map((m) => [m, cells[m].budget])),
      actuals: byMonth(spends.filter((s) => s.tacticId === r.tacticId), months, (s) => s.amount),
      editable: Object.fromEntries(
        months.map((m) => [
          m,
          can(me, "write", {
            area: "plan", mediaType: r.mediaType, planId,
            campaignId: r.campaignId, month: m,
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
export async function getReachSummary(planId: string): Promise<{
  months: ReachSummary[];
  total: ReachSummary;
  universe: number;
  hasUniverse: boolean;
}> {
  const plan = await getPlan(planId);
  const empty: ReachSummary = {
    month: "", net: 0, gross: 0, overlap: 0, people: 0,
    grp: 0, impressions: 0, budget: 0, byType: [],
  };
  if (!plan) return { months: [], total: empty, universe: 0, hasUniverse: false };

  const months = monthsBetween(plan.periodStart, plan.periodEnd);
  const ctx = await crossContext(plan.targetGroupId);
  const { rows, budgets } = await loadPlan(planId);
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
        unitPrice: b.unitPrice,
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
  if (!plan) return [];
  const months = monthsBetween(plan.periodStart, plan.periodEnd);
  const { rows, budgets, spends, notes, mets, targets, mActuals } = await loadPlan(planId);

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
          campaignId: r.campaignId, month: m,
        }),
      ]),
    ),
    budget: byMonth(budgets.filter((b) => b.tacticId === r.tacticId), months, (b) => b.planned),
    spend: byMonth(spends.filter((s) => s.tacticId === r.tacticId), months, (s) => s.amount),
    note: Object.fromEntries(
      months.map((m) => [m, notes.find((n) => n.tacticId === r.tacticId && n.month === m)?.text ?? ""]),
    ),
    metrics: mets
      .filter((mt) => mt.tacticId === r.tacticId)
      .map((mt) => ({
        id: mt.id,
        name: mt.name,
        kind: mt.kind,
        unit: mt.unit,
        target: byMonth(targets.filter((t) => t.metricId === mt.id), months, (t) => t.target),
        actual: byMonth(mActuals.filter((a) => a.metricId === mt.id), months, (a) => a.value),
      })),
  }));
}
