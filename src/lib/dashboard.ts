import type { ChannelType, PlanUnit } from "@/db/schema";
import { derive, combineReach, reachFromGrp } from "@/lib/crossmedia";
import { monthsBetween } from "@/lib/period";
import { canSeePlan, canSeeTactic, type Principal } from "@/lib/permissions";
import { getPlan, loadPlan, crossContext, getThemes, sharesByTactic, type CrossContext } from "@/lib/queries";

/**
 * Data pro přehled plánu — jedno načtení, všechny pohledy z něj.
 *
 * Zásah se nikdy nesčítá přes měsíce ani přes bloky: kumulativní zásah
 * „od začátku do měsíce m" se počítá znovu z GRP nasčítaných do m, stejně
 * jako zásah za celé období. Součet měsíčních zásahů by vyšel přes sto procent.
 * Všechno je modelový odhad, ne měření.
 */

export type MonthPoint = {
  month: string;
  cost: number;
  costByType: Partial<Record<ChannelType, number>>;
  /** kontakty = impressions (u TV TRP × universum / 100) po blocích */
  contactsByBlock: Record<string, number>;
  grp: number;
  /** zásah samotné TV v měsíci a čistý zásah všech médií */
  tvReach: number;
  net: number;
  /** kumulativně od začátku období do tohoto měsíce */
  cumNet: number;
  /** průměrný počet kontaktů na zasaženého v měsíci */
  frequency: number;
};

export type BlockSummary = {
  id: string;
  name: string;
  cost: number;
  costByMonth: Record<string, number>;
  contacts: number;
  net: number;
  frequency: number;
  /** část rozpočtu bez údaje o doručení — z ní se zásah spočítat nedá */
  costWithoutDelivery: number;
};

/** Tematická oblast — částky, kontakty i GRP taktiky se dělí jejím podílem. */
export type ThemeSummary = {
  id: string;
  name: string;
  cost: number;
  costByMonth: Record<string, number>;
  contacts: number;
  net: number;
  frequency: number;
  costWithoutDelivery: number;
};

export const UNASSIGNED = "__nezarazeno";

export type Dashboard = {
  months: string[];
  themes: ThemeSummary[];
  universe: number;
  points: MonthPoint[];
  blocks: BlockSummary[];
  total: { cost: number; net: number; frequency: number; grp: number; contacts: number; tvShare: number };
  costByType: Array<{ type: ChannelType; cost: number }>;
  /** náklady, ke kterým v plánu chybí GRP/TRP ani impressions */
  noDelivery: Array<{ channel: string; type: ChannelType; cost: number }>;
};

type Row = Awaited<ReturnType<typeof loadPlan>>["rows"][number];
type Budget = Awaited<ReturnType<typeof loadPlan>>["budgets"][number];

/** GRP po nosičích → čistý zásah přes Sainsburyho skládání s koeficienty. */
function netFromGrp(grpByType: Map<ChannelType, number>, ctx: CrossContext) {
  const parts = [...grpByType.entries()].map(([channelType, grp]) => ({
    channelType, reach: grp > 0 ? reachFromGrp(grp, ctx.curveOf(channelType, null)) : 0,
  }));
  return { ...combineReach(parts, ctx.dup), parts };
}

export async function getDashboard(me: Principal, planId: string): Promise<Dashboard | null> {
  const plan = await getPlan(planId);
  if (!plan || !canSeePlan(me, planId)) return null;
  const months = monthsBetween(plan.periodStart, plan.periodEnd);
  const ctx = await crossContext(plan.targetGroupId);
  const loaded = await loadPlan(planId);
  const rows = loaded.rows.filter((r) => canSeeTactic(me, { planId, mediaType: r.mediaType, campaignId: r.campaignId }));
  const universe = ctx.universeOf(null);

  const byKey = new Map<string, Budget>();
  for (const b of loaded.budgets) byKey.set(`${b.tacticId}|${b.month}`, b);

  // jeden průchod: dopočet jednotek každé taktiky v každém měsíci
  type Cell = { row: Row; month: string; cost: number; grp: number; impressions: number; delivered: boolean };
  const cells: Cell[] = [];
  for (const r of rows) {
    for (const m of months) {
      const b = byKey.get(`${r.tacticId}|${m}`);
      if (!b) continue;
      const d = derive({
        channelType: r.channelType, driver: b.driver as PlanUnit, driverValue: b.driverValue,
        unitPrice: b.unitPrice, universe: ctx.universeOf(r.targetGroupId),
        curve: ctx.curveOf(r.channelType, r.targetGroupId),
      });
      const cost = b.planned || d.budget;
      if (!cost && !d.grp) continue;
      cells.push({ row: r, month: m, cost, grp: d.grp, impressions: d.impressions, delivered: d.grp > 0 });
    }
  }

  const grpUpTo = (pred: (c: Cell) => boolean) => {
    const map = new Map<ChannelType, number>();
    for (const c of cells) if (pred(c) && c.grp > 0) map.set(c.row.channelType, (map.get(c.row.channelType) ?? 0) + c.grp);
    return map;
  };

  const points: MonthPoint[] = months.map((m, i) => {
    const mine = cells.filter((c) => c.month === m);
    const costByType: MonthPoint["costByType"] = {};
    const contactsByBlock: Record<string, number> = {};
    for (const c of mine) {
      costByType[c.row.channelType] = (costByType[c.row.channelType] ?? 0) + c.cost;
      if (c.impressions > 0) contactsByBlock[c.row.campaignId] = (contactsByBlock[c.row.campaignId] ?? 0) + c.impressions;
    }
    const monthGrp = grpUpTo((c) => c.month === m);
    const net = netFromGrp(monthGrp, ctx);
    const cum = netFromGrp(grpUpTo((c) => months.indexOf(c.month) <= i), ctx);
    const grp = [...monthGrp.values()].reduce((a, b) => a + b, 0);
    return {
      month: m,
      cost: mine.reduce((a, c) => a + c.cost, 0),
      costByType,
      contactsByBlock,
      grp,
      tvReach: net.parts.find((p) => p.channelType === "TV")?.reach ?? 0,
      net: net.net,
      cumNet: cum.net,
      frequency: net.net > 0 ? grp / 100 / net.net : 0,
    };
  });

  const blockIds = [...new Set(rows.map((r) => r.campaignId))];
  const blocks: BlockSummary[] = blockIds.map((id) => {
    const mine = cells.filter((c) => c.row.campaignId === id);
    const g = grpUpTo((c) => c.row.campaignId === id);
    const net = netFromGrp(g, ctx);
    const grp = [...g.values()].reduce((a, b) => a + b, 0);
    const costByMonth: Record<string, number> = {};
    for (const c of mine) costByMonth[c.month] = (costByMonth[c.month] ?? 0) + c.cost;
    return {
      id,
      name: rows.find((r) => r.campaignId === id)!.campaign,
      cost: mine.reduce((a, c) => a + c.cost, 0),
      costByMonth,
      contacts: mine.reduce((a, c) => a + c.impressions, 0),
      net: net.net,
      frequency: net.net > 0 ? grp / 100 / net.net : 0,
      costWithoutDelivery: mine.filter((c) => !c.delivered).reduce((a, c) => a + c.cost, 0),
    };
  });

  // ---------------------------------------------------- tematické oblasti
  const themeList = await getThemes(plan.clientId);
  const shareMap = sharesByTactic(loaded.themeShares);
  const sharesOf = (tacticId: string) => {
    const s = shareMap.get(tacticId);
    return s && s.length ? s : [{ themeId: UNASSIGNED, share: 1 }];
  };
  const themeIds = [...new Set(cells.flatMap((c) => sharesOf(c.row.tacticId).map((x) => x.themeId)))];
  const themeSummaries: ThemeSummary[] = themeIds.map((id) => {
    const g = new Map<ChannelType, number>();
    const costByMonth: Record<string, number> = {};
    let cost = 0, contacts = 0, noDelivery = 0;
    for (const c of cells) {
      const sh = sharesOf(c.row.tacticId).find((x) => x.themeId === id)?.share ?? 0;
      if (!sh) continue;
      cost += c.cost * sh;
      contacts += c.impressions * sh;
      if (!c.delivered) noDelivery += c.cost * sh;
      costByMonth[c.month] = (costByMonth[c.month] ?? 0) + c.cost * sh;
      // GRP se dělí podílem: polovina spotu pro oblast = polovina jeho tlaku
      if (c.grp > 0) g.set(c.row.channelType, (g.get(c.row.channelType) ?? 0) + c.grp * sh);
    }
    const net = netFromGrp(g, ctx);
    const grp = [...g.values()].reduce((a, b) => a + b, 0);
    return {
      id,
      name: id === UNASSIGNED ? "Nezařazeno" : themeList.find((t) => t.id === id)?.name ?? "?",
      cost, costByMonth, contacts,
      net: net.net,
      frequency: net.net > 0 ? grp / 100 / net.net : 0,
      costWithoutDelivery: noDelivery,
    };
  });
  const order = (id: string) => id === UNASSIGNED ? 1e9 : themeList.findIndex((t) => t.id === id);
  themeSummaries.sort((a, b) => order(a.id) - order(b.id));

  const totalGrp = grpUpTo(() => true);
  const total = netFromGrp(totalGrp, ctx);
  const grpSum = [...totalGrp.values()].reduce((a, b) => a + b, 0);
  const cost = cells.reduce((a, c) => a + c.cost, 0);

  const typeMap = new Map<ChannelType, number>();
  for (const c of cells) typeMap.set(c.row.channelType, (typeMap.get(c.row.channelType) ?? 0) + c.cost);

  const noDel = new Map<string, { channel: string; type: ChannelType; cost: number }>();
  for (const c of cells) {
    if (c.delivered) continue;
    const k = c.row.tacticId;
    const cur = noDel.get(k) ?? { channel: c.row.channel, type: c.row.channelType, cost: 0 };
    cur.cost += c.cost;
    noDel.set(k, cur);
  }

  return {
    months,
    themes: themeSummaries,
    universe,
    points,
    blocks: blocks.sort((a, b) => b.cost - a.cost),
    total: {
      cost,
      net: total.net,
      frequency: total.net > 0 ? grpSum / 100 / total.net : 0,
      grp: grpSum,
      contacts: cells.reduce((a, c) => a + c.impressions, 0),
      tvShare: cost ? (typeMap.get("TV") ?? 0) / cost : 0,
    },
    costByType: [...typeMap.entries()].map(([type, c]) => ({ type, cost: c })).sort((a, b) => b.cost - a.cost),
    noDelivery: [...noDel.values()].sort((a, b) => b.cost - a.cost),
  };
}
