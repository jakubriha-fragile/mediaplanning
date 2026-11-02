import type { ChannelType, PlanUnit } from "@/db/schema";
import { media as mediaTable } from "@/db/schema";
import { db } from "@/db";
import { derive, combineReach, reachByType } from "@/lib/crossmedia";
import { costKind, type CostKind } from "@/lib/costKind";
import { monthsBetween } from "@/lib/period";
import { canSeePlan, canSeeTactic, type Principal } from "@/lib/permissions";
import { getPlan, loadPlan, crossContext, getThemes, sharesByTactic, type CrossContext } from "@/lib/queries";

/**
 * Data pro Přehled — jedno načtení, všechny pohledy z něj.
 *
 * Zásah se nikdy nesčítá přes měsíce, média ani oblasti: kumulativní zásah,
 * zásah typu média i oblasti se počítají znovu z GRP položek (reachByType —
 * křivka, nebo zadaná frekvence, stejně jako v Plánu). Součet zásahů by vyšel
 * přes sto procent. Všechno je modelový odhad, ne měření.
 *
 * Přehled je po měsících a v absolutních číslech (osoby, Kč) — procenta
 * a frekvence za měsíc jen v úvodní větě (zadavatel, listopad 2026).
 */

import { UNASSIGNED } from "@/lib/dashboardShared";
export { UNASSIGNED };

export type MonthPoint = {
  month: string;
  cost: number;
  /** útrata po propozicích (campaignId → Kč) */
  byCampaign: Record<string, number>;
  tvReach: number;
  /** zásah měsíce (podíl 0–1) */
  net: number;
  /** zásah od začátku plánu do konce měsíce */
  cumNet: number;
  /** průměrný počet kontaktů na zasaženou osobu ZA MĚSÍC */
  frequency: number;
};

export type TypeRow = {
  /** typ média, nebo „__fee" pro agenturní práci */
  key: string;
  type: ChannelType | null;
  cost: number;
  byMonth: Record<string, number>;
  /** zásah za období jen z tohoto typu (podíl 0–1); agenturní práce 0 */
  reach: number;
  media: Array<{ name: string; cost: number; byMonth: Record<string, number>; reach: number }>;
};

export type MatrixRow = {
  id: string;
  name: string;
  byType: Partial<Record<ChannelType, number>>;
  cost: number;
  net: number;
  /** průměr měsíčních frekvencí v měsících, kdy oblast běží */
  monthlyFrequency: number;
};

export type Dashboard = {
  months: string[];
  universe: number;
  /** zásah TV je z naměřených dat TV nákupu, ne předpoklad */
  tvCalibrated: boolean;
  points: MonthPoint[];
  /** propozice v pořadí plánu (jen viditelné) */
  campaigns: Array<{ id: string; name: string; cost: number }>;
  /** sdělení pro filtr */
  lines: Array<{ id: string; code: string; message: string; campaignId: string }>;
  byType: TypeRow[];
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
    /** průměr měsíčních frekvencí přes měsíce se zásahem — „žena reklamu uvidí X× za měsíc" */
    avgMonthlyFrequency: number;
    /** průměrný měsíční přínos ostatních médií k TV (p.b.) */
    avgIncrement: number;
  };
  costByType: Array<{ type: ChannelType; cost: number }>;
  matrix: MatrixRow[];
  matrixTypes: ChannelType[];
  /** položky médií bez doručení, největší první */
  missing: Array<{ channel: string; channelType: ChannelType; cost: number; kind: CostKind }>;
};

type Row = Awaited<ReturnType<typeof loadPlan>>["rows"][number];
type Cell = {
  row: Row; month: string; kind: CostKind;
  /** hodnoty už vynásobené podílem vybrané oblasti (bez filtru = 1) */
  cost: number; grp: number; delivered: boolean;
  /** doručení odhadnuté z ceníku klienta */
  estimated: boolean;
  shares: Array<{ themeId: string; share: number }>;
};

/**
 * Zásah buněk: GRP se sečtou po položkách, položky jdou přes reachByType
 * (křivka, nebo zadaná frekvence) a nosiče se složí combineReach.
 */
function netOf(cells: Cell[], ctx: CrossContext, weight: (c: Cell) => number = () => 1) {
  const byRow = new Map<string, { row: Row; grp: number }>();
  for (const c of cells) {
    const g = c.grp * weight(c);
    if (!(g > 0)) continue;
    const cur = byRow.get(c.row.tacticId) ?? { row: c.row, grp: 0 };
    cur.grp += g;
    byRow.set(c.row.tacticId, cur);
  }
  const parts = reachByType([...byRow.values()].map(({ row, grp }) => ({
    channelType: row.channelType, grp, curve: ctx.curveOf(row.channelType, null), freq: ctx.freqFor(row),
  })), ctx.dup);
  const grp = parts.reduce((a, p) => a + p.grp, 0);
  return { ...combineReach(parts, ctx.dup), parts, grp };
}

const FEE = "__fee";

export async function getDashboard(
  me: Principal,
  planId: string,
  filter: { themeId?: string | null; channelType?: ChannelType | null; campaignId?: string | null; lineId?: string | null } = {},
): Promise<Dashboard | null> {
  const plan = await getPlan(planId);
  if (!plan || !canSeePlan(me, planId)) return null;
  const months = monthsBetween(plan.periodStart, plan.periodEnd);
  const ctx = await crossContext(plan.targetGroupId, plan.clientId);
  const loaded = await loadPlan(planId);
  const visibleRows = loaded.rows.filter((r) => canSeeTactic(me, { planId, mediaType: r.mediaType, campaignId: r.campaignId, channelType: r.channelType, tacticId: r.tacticId }));
  const universe = ctx.universeOf(null);
  const shareMap = sharesByTactic(loaded.themeShares);
  const [themeList, mediaNames] = await Promise.all([
    getThemes(plan.clientId),
    db.select({ id: mediaTable.id, name: mediaTable.name }).from(mediaTable),
  ]);
  const mediumName = new Map(mediaNames.map((m) => [m.id, m.name]));

  // propozice a sdělení pro filtr — z viditelných řádků, v pořadí plánu
  const campaigns: Dashboard["campaigns"] = [];
  const lines: Dashboard["lines"] = [];
  for (const r of visibleRows) {
    if (!campaigns.some((c) => c.id === r.campaignId)) campaigns.push({ id: r.campaignId, name: r.campaign, cost: 0 });
    if (!lines.some((l) => l.id === r.messageLineId)) lines.push({ id: r.messageLineId, code: r.code, message: r.message, campaignId: r.campaignId });
  }
  const rows = visibleRows.filter((r) =>
    (!filter.campaignId || r.campaignId === filter.campaignId) && (!filter.lineId || r.messageLineId === filter.lineId));

  const byKey = new Map(loaded.budgets.map((b) => [`${b.tacticId}|${b.month}`, b]));

  // všechny buňky (bez filtru oblasti a média) — matice oblastí je potřebuje celé
  const all: Cell[] = [];
  for (const r of rows) {
    const shares = shareMap.get(r.tacticId)?.length ? shareMap.get(r.tacticId)! : [{ themeId: UNASSIGNED, share: 1 }];
    const kind = costKind(r.channel);
    for (const m of months) {
      const b = byKey.get(`${r.tacticId}|${m}`);
      if (!b) continue;
      const price = ctx.priceFor(r, b.driver as PlanUnit, b.unitPrice);
      const d = derive({
        channelType: r.channelType, pricing: r.pricing, ctr: ctx.ctrFor(r), driver: b.driver as PlanUnit, driverValue: b.driverValue,
        unitPrice: price.unitPrice, universe: ctx.universeOf(r.targetGroupId),
        curve: ctx.curveOf(r.channelType, r.targetGroupId),
      });
      const cost = b.planned || d.budget;
      if (!cost && !d.grp) continue;
      all.push({ row: r, month: m, kind, cost, grp: d.grp, delivered: d.grp > 0 || d.clicks > 0, estimated: price.estimated && d.grp > 0, shares });
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
    const mine = monthOf(m);
    const net = netOf(mine, ctx);
    const cum = netOf(cells.filter((c) => months.indexOf(c.month) <= i), ctx);
    const byCampaign: Record<string, number> = {};
    for (const c of mine) byCampaign[c.row.campaignId] = (byCampaign[c.row.campaignId] ?? 0) + c.cost;
    return {
      month: m,
      cost: mine.reduce((a, c) => a + c.cost, 0),
      byCampaign,
      tvReach: net.parts.find((p) => p.channelType === "TV")?.reach ?? 0,
      net: net.net,
      cumNet: cum.net,
      frequency: net.net > 0 ? net.grp / 100 / net.net : 0,
    };
  });
  for (const c of campaigns) c.cost = points.reduce((a, p) => a + (p.byCampaign[c.id] ?? 0), 0);

  // ------------------------------------------- rozpad podle typu média (a média v něm)
  const typeKeys = [...new Set(cells.map((c) => (c.kind === "fee" ? FEE : c.row.channelType)))];
  const byType: TypeRow[] = typeKeys.map((key) => {
    const mine = cells.filter((c) => (c.kind === "fee" ? FEE : c.row.channelType) === key);
    const byMonth = (cs: Cell[]) => Object.fromEntries(months.map((m) => [m, cs.filter((c) => c.month === m).reduce((a, c) => a + c.cost, 0)]));
    const names = [...new Set(mine.map((c) => (c.row.mediumId ? mediumName.get(c.row.mediumId) : null) ?? "bez média"))];
    return {
      key,
      type: key === FEE ? null : (key as ChannelType),
      cost: mine.reduce((a, c) => a + c.cost, 0),
      byMonth: byMonth(mine),
      reach: key === FEE ? 0 : netOf(mine, ctx).net,
      media: names.map((name) => {
        const ms = mine.filter((c) => ((c.row.mediumId ? mediumName.get(c.row.mediumId) : null) ?? "bez média") === name);
        return { name, cost: ms.reduce((a, c) => a + c.cost, 0), byMonth: byMonth(ms), reach: key === FEE ? 0 : netOf(ms, ctx).net };
      }).sort((a, b) => b.cost - a.cost),
    };
  }).sort((a, b) => (a.key === FEE ? 1 : b.key === FEE ? -1 : b.cost - a.cost));

  const period = netOf(cells, ctx);
  const cost = cells.reduce((a, c) => a + c.cost, 0);
  const fee = cells.filter((c) => c.kind === "fee").reduce((a, c) => a + c.cost, 0);
  const delivered = cells.filter((c) => c.kind !== "fee" && c.delivered).reduce((a, c) => a + c.cost, 0);
  const withTv = points.filter((p) => p.tvReach > 0);
  const liveF = points.filter((p) => p.net > 0);

  // ------------------------------------------- matice oblasti × média (bez filtru oblasti)
  const forMatrix = all.filter((c) => !filter.channelType || c.row.channelType === filter.channelType);
  const themeIds = [...new Set(forMatrix.flatMap((c) => c.shares.map((s) => s.themeId)))];
  const matrix: MatrixRow[] = themeIds.map((id) => {
    const w = (c: Cell) => c.shares.find((s) => s.themeId === id)?.share ?? 0;
    const mine = forMatrix.filter((c) => w(c) > 0);
    const byT: MatrixRow["byType"] = {};
    for (const c of mine) byT[c.row.channelType] = (byT[c.row.channelType] ?? 0) + c.cost * w(c);
    const freqs = months.map((m) => {
      const n = netOf(mine.filter((c) => c.month === m), ctx, w);
      return n.net > 0 ? n.grp / 100 / n.net : 0;
    }).filter((f) => f > 0);
    return {
      id,
      name: id === UNASSIGNED ? "Nezařazeno" : themeList.find((t) => t.id === id)?.name ?? "?",
      byType: byT,
      cost: mine.reduce((a, c) => a + c.cost * w(c), 0),
      net: netOf(mine, ctx, w).net,
      monthlyFrequency: freqs.length ? freqs.reduce((a, b) => a + b, 0) / freqs.length : 0,
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
    tvCalibrated: ctx.calibrated("TV", null),
    points,
    campaigns,
    lines,
    byType,
    total: {
      cost,
      delivered,
      estimated: cells.filter((c) => c.kind !== "fee" && c.estimated).reduce((a, c) => a + c.cost, 0),
      mediaNoData: cost - fee - delivered,
      fee,
      net: period.net,
      people: period.net * universe,
      avgMonthlyFrequency: liveF.length ? liveF.reduce((a, p) => a + p.frequency, 0) / liveF.length : 0,
      avgIncrement: withTv.length ? withTv.reduce((a, p) => a + Math.max(0, p.net - p.tvReach), 0) / withTv.length : 0,
    },
    costByType: [...typeMap.entries()].map(([type, c]) => ({ type, cost: c })).sort((a, b) => b.cost - a.cost),
    matrix,
    matrixTypes: [...new Set(forMatrix.map((c) => c.row.channelType))]
      .sort((a, b) => (typeMap.get(b) ?? 0) - (typeMap.get(a) ?? 0)),
    missing: [...missingMap.values()].sort((a, b) => b.cost - a.cost),
  };
}
