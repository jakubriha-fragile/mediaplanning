import type { ChannelType, PlanUnit } from "@/db/schema";
import { derive, combineReach, reachFromGrp } from "@/lib/crossmedia";
import { costKind, type CostKind } from "@/lib/costKind";
import { monthsBetween } from "@/lib/period";
import { canSeePlan, canSeeTactic, type Principal } from "@/lib/permissions";
import { getPlan, loadPlan, crossContext, getThemes, sharesByTactic, type CrossContext } from "@/lib/queries";

/**
 * Data pro Přehled — jedno načtení, všechny pohledy z něj.
 *
 * Zásah se nikdy nesčítá přes měsíce ani oblasti: kumulativní zásah, zásah
 * oblasti i scénář se počítají znovu z nasčítaných GRP. Součet zásahů by vyšel
 * přes sto procent. Všechno je modelový odhad, ne měření.
 */

import { UNASSIGNED, SCENARIO_CUT } from "@/lib/dashboardShared";
export { UNASSIGNED, SCENARIO_CUT };

export type MonthPoint = {
  month: string;
  cost: number;
  tvReach: number;
  net: number;
  cumNet: number;
  /** průměrný počet kontaktů na zasaženou ženu ZA TÝDEN (měsíc ÷ počet týdnů v něm) */
  frequency: number;
};

export type MatrixRow = {
  id: string;
  name: string;
  byType: Partial<Record<ChannelType, number>>;
  cost: number;
  net: number;
  /** průměr týdenních frekvencí v měsících, kdy oblast běží */
  weeklyFrequency: number;
};

export type Dashboard = {
  months: string[];
  universe: number;
  freqLimit: number;
  points: MonthPoint[];
  total: {
    cost: number;
    /** rozdělení nákladů podle typu: média s doručením / média bez dat / agenturní práce */
    delivered: number;
    /** z toho doručení odhadnuté z ceníku */
    estimated: number;
    mediaNoData: number;
    fee: number;
    net: number;
    people: number;
    /** průměr týdenních frekvencí přes aktivní měsíce — „žena spot uvidí X× týdně" */
    avgWeeklyFrequency: number;
    costPerPerson: number;
    /** průměrný měsíční přínos ostatních médií k TV (p.b.) */
    avgIncrement: number;
  };
  costByType: Array<{ type: ChannelType; cost: number }>;
  matrix: MatrixRow[];
  matrixTypes: ChannelType[];
  /** položky médií bez doručení, největší první */
  missing: Array<{ channel: string; channelType: ChannelType; cost: number; kind: CostKind }>;
  /** model: co když se TV v přetížených měsících ubere o SCENARIO_CUT */
  scenario: null | {
    months: string[];
    saving: number;
    netBefore: number;
    netAfter: number;
    freqBefore: number;
    freqAfter: number;
  };
};

type Row = Awaited<ReturnType<typeof loadPlan>>["rows"][number];
type Budget = Awaited<ReturnType<typeof loadPlan>>["budgets"][number];
type Cell = {
  row: Row; month: string; kind: CostKind;
  /** hodnoty už vynásobené podílem vybrané oblasti (bez filtru = 1) */
  cost: number; grp: number; delivered: boolean;
  /** doručení odhadnuté z ceníku klienta */
  estimated: boolean;
  shares: Array<{ themeId: string; share: number }>;
};

/**
 * Týdnů v měsíci (dny ÷ 7). Frekvence se ukazuje týdně, protože tak o tlaku
 * mluví plánovači; plán je ale po měsících, takže jde o rovnoměrné rozložení
 * měsíce do týdnů — skutečný průběh uvnitř měsíce z dat neplyne.
 */
function weeksIn(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate() / 7;
}
/** Kontakty na zasaženou ženu za týden. */
const weekly = (grp: number, net: number, month: string) => (net > 0 ? grp / 100 / net / weeksIn(month) : 0);

function netFromGrp(grpByType: Map<ChannelType, number>, ctx: CrossContext) {
  const parts = [...grpByType.entries()].map(([channelType, grp]) => ({
    channelType, reach: grp > 0 ? reachFromGrp(grp, ctx.curveOf(channelType, null)) : 0,
  }));
  return { ...combineReach(parts, ctx.dup), parts };
}

function sumGrp(cells: Cell[], weight: (c: Cell) => number = () => 1) {
  const map = new Map<ChannelType, number>();
  for (const c of cells) {
    const w = weight(c);
    if (c.grp > 0 && w > 0) map.set(c.row.channelType, (map.get(c.row.channelType) ?? 0) + c.grp * w);
  }
  return map;
}
const total = (m: Map<ChannelType, number>) => [...m.values()].reduce((a, b) => a + b, 0);

export async function getDashboard(
  me: Principal,
  planId: string,
  filter: { themeId?: string | null; channelType?: ChannelType | null } = {},
): Promise<Dashboard | null> {
  const plan = await getPlan(planId);
  if (!plan || !canSeePlan(me, planId)) return null;
  const months = monthsBetween(plan.periodStart, plan.periodEnd);
  const ctx = await crossContext(plan.targetGroupId, plan.clientId);
  const loaded = await loadPlan(planId);
  const rows = loaded.rows.filter((r) => canSeeTactic(me, { planId, mediaType: r.mediaType, campaignId: r.campaignId }));
  const universe = ctx.universeOf(null);
  const shareMap = sharesByTactic(loaded.themeShares);
  const themeList = await getThemes(plan.clientId);

  const byKey = new Map<string, Budget>();
  for (const b of loaded.budgets) byKey.set(`${b.tacticId}|${b.month}`, b);

  // všechny buňky plánu bez filtru — matice oblastí je potřebuje celé
  const all: Cell[] = [];
  for (const r of rows) {
    const shares = shareMap.get(r.tacticId)?.length ? shareMap.get(r.tacticId)! : [{ themeId: UNASSIGNED, share: 1 }];
    const kind = costKind(r.channel);
    for (const m of months) {
      const b = byKey.get(`${r.tacticId}|${m}`);
      if (!b) continue;
      const price = ctx.priceFor(r, b.driver as PlanUnit, b.unitPrice);
      const d = derive({
        channelType: r.channelType, driver: b.driver as PlanUnit, driverValue: b.driverValue,
        unitPrice: price.unitPrice, universe: ctx.universeOf(r.targetGroupId),
        curve: ctx.curveOf(r.channelType, r.targetGroupId),
      });
      const cost = b.planned || d.budget;
      if (!cost && !d.grp) continue;
      all.push({ row: r, month: m, kind, cost, grp: d.grp, delivered: d.grp > 0, estimated: price.estimated && d.grp > 0, shares });
    }
  }

  // filtr: médium buňky vyřadí, oblast je převáží podílem
  const cells: Cell[] = all
    .filter((c) => !filter.channelType || c.row.channelType === filter.channelType)
    .map((c) => {
      if (!filter.themeId) return c;
      const sh = c.shares.find((x) => x.themeId === filter.themeId)?.share ?? 0;
      return { ...c, cost: c.cost * sh, grp: c.grp * sh };
    })
    .filter((c) => c.cost > 0 || c.grp > 0);

  const monthOf = (m: string) => cells.filter((c) => c.month === m);
  const points: MonthPoint[] = months.map((m, i) => {
    const g = sumGrp(monthOf(m));
    const net = netFromGrp(g, ctx);
    const cum = netFromGrp(sumGrp(cells.filter((c) => months.indexOf(c.month) <= i)), ctx);
    return {
      month: m,
      cost: monthOf(m).reduce((a, c) => a + c.cost, 0),
      tvReach: net.parts.find((p) => p.channelType === "TV")?.reach ?? 0,
      net: net.net,
      cumNet: cum.net,
      frequency: weekly(total(g), net.net, m),
    };
  });

  const period = netFromGrp(sumGrp(cells), ctx);
  const cost = cells.reduce((a, c) => a + c.cost, 0);
  const fee = cells.filter((c) => c.kind === "fee").reduce((a, c) => a + c.cost, 0);
  const delivered = cells.filter((c) => c.kind !== "fee" && c.delivered).reduce((a, c) => a + c.cost, 0);
  const live = points.filter((p) => p.net > 0);
  const withTv = points.filter((p) => p.tvReach > 0);
  const people = period.net * universe;

  // ---------------------------------------------- scénář: méně TV v přetížení
  const limit = plan.freqLimit;
  const over = points.filter((p) => p.frequency > limit).map((p) => p.month);
  let scenario: Dashboard["scenario"] = null;
  if (over.length) {
    const cut = (c: Cell) => (c.row.channelType === "TV" && over.includes(c.month) ? 1 - SCENARIO_CUT : 1);
    const after = netFromGrp(sumGrp(cells, cut), ctx);
    const freqIn = (w: (c: Cell) => number) => {
      const fs = over.map((m) => {
        const g = sumGrp(monthOf(m), w);
        return weekly(total(g), netFromGrp(g, ctx).net, m);
      });
      return fs.reduce((a, b) => a + b, 0) / fs.length;
    };
    scenario = {
      months: over,
      saving: cells.filter((c) => c.row.channelType === "TV" && over.includes(c.month)).reduce((a, c) => a + c.cost, 0) * SCENARIO_CUT,
      netBefore: period.net,
      netAfter: after.net,
      freqBefore: freqIn(() => 1),
      freqAfter: freqIn(cut),
    };
  }

  // ------------------------------------------- matice oblasti × média (bez filtru oblasti)
  const forMatrix = all.filter((c) => !filter.channelType || c.row.channelType === filter.channelType);
  const themeIds = [...new Set(forMatrix.flatMap((c) => c.shares.map((s) => s.themeId)))];
  const matrix: MatrixRow[] = themeIds.map((id) => {
    const w = (c: Cell) => c.shares.find((s) => s.themeId === id)?.share ?? 0;
    const mine = forMatrix.filter((c) => w(c) > 0);
    const byType: MatrixRow["byType"] = {};
    for (const c of mine) byType[c.row.channelType] = (byType[c.row.channelType] ?? 0) + c.cost * w(c);
    const freqs = months.map((m) => {
      const g = sumGrp(mine.filter((c) => c.month === m), w);
      return weekly(total(g), netFromGrp(g, ctx).net, m);
    }).filter((f) => f > 0);
    return {
      id,
      name: id === UNASSIGNED ? "Nezařazeno" : themeList.find((t) => t.id === id)?.name ?? "?",
      byType,
      cost: mine.reduce((a, c) => a + c.cost * w(c), 0),
      net: netFromGrp(sumGrp(mine, w), ctx).net,
      weeklyFrequency: freqs.length ? freqs.reduce((a, b) => a + b, 0) / freqs.length : 0,
    };
  }).sort((a, b) => b.cost - a.cost);

  const typeMap = new Map<ChannelType, number>();
  for (const c of cells) typeMap.set(c.row.channelType, (typeMap.get(c.row.channelType) ?? 0) + c.cost);

  const missingMap = new Map<string, { channel: string; channelType: ChannelType; cost: number; kind: CostKind }>();
  for (const c of cells) {
    if (c.kind === "fee" || c.delivered) continue;
    const cur = missingMap.get(c.row.tacticId) ?? { channel: c.row.channel, channelType: c.row.channelType, cost: 0, kind: c.kind };
    cur.cost += c.cost;
    missingMap.set(c.row.tacticId, cur);
  }

  return {
    months,
    universe,
    freqLimit: limit,
    points,
    total: {
      cost,
      delivered,
      estimated: cells.filter((c) => c.kind !== "fee" && c.estimated).reduce((a, c) => a + c.cost, 0),
      mediaNoData: cost - fee - delivered,
      fee,
      net: period.net,
      people,
      avgWeeklyFrequency: live.length ? live.reduce((a, p) => a + p.frequency, 0) / live.length : 0,
      costPerPerson: people > 0 ? cost / people : 0,
      avgIncrement: withTv.length ? withTv.reduce((a, p) => a + Math.max(0, p.net - p.tvReach), 0) / withTv.length : 0,
    },
    costByType: [...typeMap.entries()].map(([type, c]) => ({ type, cost: c })).sort((a, b) => b.cost - a.cost),
    matrix,
    matrixTypes: [...new Set(forMatrix.map((c) => c.row.channelType))]
      .sort((a, b) => (typeMap.get(b) ?? 0) - (typeMap.get(a) ?? 0)),
    missing: [...missingMap.values()].sort((a, b) => b.cost - a.cost),
    scenario,
  };
}
