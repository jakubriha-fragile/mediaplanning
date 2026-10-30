import type { ChannelType, PlanUnit } from "@/db/schema";
import { derive, combineReach, reachFromGrp, isGrpPriced } from "@/lib/crossmedia";
import { costKind, type CostKind } from "@/lib/costKind";
import { displayName } from "@/lib/displayName";
import { monthsBetween } from "@/lib/period";
import { canSeePlan, canSeeTactic, channelGroupOf, seesWholePlan, type ChannelGroup, type Principal } from "@/lib/permissions";
import { getPlan, loadPlan, crossContext, getThemes, sharesByTactic } from "@/lib/queries";

/**
 * Finální mix — výsledek plánu na jedné stránce: kolik jde do kterého média,
 * kdy, co za to plán doručí a na co (oblasti). Je to výstup ke schválení
 * a ke sdílení, ne pracovní tabulka: nic se tu nezadává.
 *
 * Zásah se ani tady nesčítá přes měsíce ani média — počítá se z nasčítaných
 * GRP stejným modelem jako v Přehledu. Je to modelový odhad, ne měření.
 */

export type MixItem = {
  id: string;
  channel: string;
  block: string;
  kind: CostKind;
  cost: number;
  byMonth: Record<string, number>;
};

export type MixChannel = {
  type: ChannelType;
  group: ChannelGroup;
  cost: number;
  byMonth: Record<string, number>;
  /** GRP v cílové skupině plánu (u TV a rádia = TRP z plánu) */
  grp: number;
  impressions: number;
  /** kliky z položek na CPC */
  clicks: number;
  /** modelový zásah 1+ za celé období; 0 = bez doručení */
  reach: number;
  /** průměrná cena: CPP (Kč/GRP) u TV a rádia, jinak CPT (Kč/1000 imp.) — jen z položek s doručením */
  unitPrice: number;
  items: MixItem[];
};

export type Mix = {
  months: string[];
  universe: number;
  total: { cost: number; media: number; fee: number; mixed: number; reach: number; people: number; byMonth: Record<string, number> };
  channels: MixChannel[];
  groups: Array<{ group: ChannelGroup; cost: number }>;
  themes: Array<{ id: string; name: string; cost: number }>;
  /** uživatel vidí jen výsek plánu — souhrny jsou jen za jeho položky */
  partial: boolean;
};

export async function getMix(me: Principal, planId: string): Promise<Mix | null> {
  const plan = await getPlan(planId);
  if (!plan || !canSeePlan(me, planId)) return null;
  const months = monthsBetween(plan.periodStart, plan.periodEnd);
  const [ctx, loaded, themeList] = await Promise.all([
    crossContext(plan.targetGroupId, plan.clientId),
    loadPlan(planId),
    getThemes(plan.clientId),
  ]);
  const shares = sharesByTactic(loaded.themeShares);
  const rows = loaded.rows.filter((r) => canSeeTactic(me, {
    planId, mediaType: r.mediaType, campaignId: r.campaignId, channelType: r.channelType, tacticId: r.tacticId,
  }));
  const universe = ctx.universeOf(null);

  const byType = new Map<ChannelType, MixChannel & { priced: { cost: number; units: number } }>();
  const totalByMonth: Record<string, number> = Object.fromEntries(months.map((m) => [m, 0]));
  const themeCost = new Map<string, number>();
  const kinds = { media: 0, fee: 0, mixed: 0 };

  for (const r of rows) {
    const kind = costKind(r.channel);
    let ch = byType.get(r.channelType);
    if (!ch) {
      ch = {
        type: r.channelType, group: channelGroupOf(r.channelType), cost: 0,
        byMonth: Object.fromEntries(months.map((m) => [m, 0])),
        grp: 0, impressions: 0, clicks: 0, reach: 0, unitPrice: 0, items: [], priced: { cost: 0, units: 0 },
      };
      byType.set(r.channelType, ch);
    }
    const item: MixItem = { id: r.tacticId, channel: displayName(r), block: r.campaign, kind, cost: 0, byMonth: {} };

    for (const m of months) {
      const b = loaded.budgets.find((x) => x.tacticId === r.tacticId && x.month === m);
      if (!b) continue;
      const driver = b.driver as PlanUnit;
      const price = ctx.priceFor(r, driver, b.unitPrice);
      const d = derive({
        channelType: r.channelType, pricing: r.pricing, driver, driverValue: b.driverValue, unitPrice: price.unitPrice,
        universe: ctx.universeOf(r.targetGroupId), curve: ctx.curveOf(r.channelType, r.targetGroupId),
      });
      const cost = b.planned || d.budget;
      if (!cost && !d.grp) continue;
      item.byMonth[m] = cost;
      item.cost += cost;
      ch.byMonth[m] += cost;
      ch.cost += cost;
      ch.grp += d.grp;
      ch.impressions += d.impressions;
      ch.clicks += d.clicks;
      totalByMonth[m] += cost;
      if (d.grp > 0) {
        ch.priced.cost += cost;
        ch.priced.units += isGrpPriced(r.channelType) ? d.grp : d.impressions / 1000;
      }
    }
    if (!item.cost) continue;
    ch.items.push(item);
    kinds[kind] += item.cost;
    const sh = shares.get(r.tacticId) ?? [];
    if (!sh.length) themeCost.set("", (themeCost.get("") ?? 0) + item.cost);
    for (const s of sh) themeCost.set(s.themeId, (themeCost.get(s.themeId) ?? 0) + item.cost * s.share);
  }

  const channels = [...byType.values()]
    .filter((c) => c.cost > 0)
    .map(({ priced, ...c }) => ({
      ...c,
      reach: c.grp > 0 ? reachFromGrp(c.grp, ctx.curveOf(c.type, null)) : 0,
      unitPrice: priced.units > 0 ? priced.cost / priced.units : 0,
      items: c.items.sort((a, b) => b.cost - a.cost),
    }))
    // offline první, uvnitř podle peněz — tak, jak se mix čte v agentuře
    .sort((a, b) => (a.group === b.group ? b.cost - a.cost : a.group === "offline" ? -1 : 1));

  const net = combineReach(channels.filter((c) => c.reach > 0).map((c) => ({ channelType: c.type, reach: c.reach })), ctx.dup).net;
  const cost = channels.reduce((s, c) => s + c.cost, 0);
  const groups = (["offline", "online"] as const)
    .map((g) => ({ group: g, cost: channels.filter((c) => c.group === g).reduce((s, c) => s + c.cost, 0) }))
    .filter((g) => g.cost > 0);
  const themes = [
    ...themeList.map((t) => ({ id: t.id, name: t.name, cost: themeCost.get(t.id) ?? 0 })),
    { id: "", name: "Nezařazeno", cost: themeCost.get("") ?? 0 },
  ].filter((t) => t.cost > 0.5).sort((a, b) => b.cost - a.cost);

  return {
    months,
    universe,
    total: { cost, ...kinds, reach: net, people: net * universe, byMonth: totalByMonth },
    channels,
    groups,
    themes,
    partial: !seesWholePlan(me, planId),
  };
}
