import { eq, asc } from "drizzle-orm";
import { db } from "@/db";
import {
  campaigns, messageLines, tactics, tacticBudgets, actualSpends,
  accountNotes, metrics, metricTargets, metricActuals, users,
} from "@/db/schema";
import { MONTHS, QUARTER } from "@/lib/months";
import { can, type Principal } from "@/lib/permissions";

const byMonth = <T extends { month: string; }>(rows: T[], pick: (r: T) => number) =>
  Object.fromEntries(MONTHS.map((m) => [m, pick(rows.find((r) => r.month === m) ?? ({ month: m } as T)) || 0]));

export async function getUser(id: string) {
  const [u] = await db.select().from(users).where(eq(users.id, id));
  return u;
}

/** Jeden plochý dotaz přes celý kvartál — na 32 taktik je to levnější než N+1. */
async function loadQuarter() {
  const rows = await db
    .select({
      tacticId: tactics.id,
      messageLineId: tactics.messageLineId,
      channel: tactics.channel,
      mediaType: tactics.mediaType,
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
    .where(eq(campaigns.quarter, QUARTER))
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

  return { rows, budgets, spends, notes, mets, targets, mActuals };
}

export async function getPlanRows(me: Principal) {
  const { rows, budgets, spends } = await loadQuarter();
  return rows.map((r) => ({
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
    budgets: byMonth(budgets.filter((b) => b.tacticId === r.tacticId), (b) => b.planned),
    actuals: byMonth(spends.filter((s) => s.tacticId === r.tacticId), (s) => s.amount),
    editable: Object.fromEntries(
      MONTHS.map((m) => [
        m,
        can(me, "write", { area: "plan", mediaType: r.mediaType, campaignId: r.campaignId, month: m }),
      ]),
    ),
  }));
}

/** Kampaně a jejich linky — pro přiřazování taktik a zakládání nových. */
export async function getCampaignTree() {
  const rows = await db
    .select({
      id: campaigns.id, name: campaigns.name,
      lineId: messageLines.id, code: messageLines.code,
    })
    .from(campaigns)
    .leftJoin(messageLines, eq(messageLines.campaignId, campaigns.id))
    .where(eq(campaigns.quarter, QUARTER))
    .orderBy(asc(campaigns.position), asc(campaigns.name), asc(messageLines.code));

  const out: Array<{ id: string; name: string; lines: Array<{ id: string; code: string }> }> = [];
  for (const r of rows) {
    let c = out.find((x) => x.id === r.id);
    if (!c) out.push((c = { id: r.id, name: r.name, lines: [] }));
    if (r.lineId) c.lines.push({ id: r.lineId, code: r.code! });
  }
  return out;
}

export async function getPerfRows(me: Principal) {
  const { rows, budgets, spends, notes, mets, targets, mActuals } = await loadQuarter();
  return rows.map((r) => ({
    id: r.tacticId,
    channel: r.channel,
    mediaType: r.mediaType,
    campaign: r.campaign,
    code: r.code,
    message: r.message,
    audience: r.audience,
    editable: Object.fromEntries(
      MONTHS.map((m) => [
        m,
        can(me, "write", { area: "actuals", mediaType: r.mediaType, campaignId: r.campaignId, month: m }),
      ]),
    ),
    budget: byMonth(budgets.filter((b) => b.tacticId === r.tacticId), (b) => b.planned),
    spend: byMonth(spends.filter((s) => s.tacticId === r.tacticId), (s) => s.amount),
    note: Object.fromEntries(
      MONTHS.map((m) => [m, notes.find((n) => n.tacticId === r.tacticId && n.month === m)?.text ?? ""]),
    ),
    metrics: mets
      .filter((mt) => mt.tacticId === r.tacticId)
      .map((mt) => ({
        id: mt.id,
        name: mt.name,
        kind: mt.kind,
        unit: mt.unit,
        target: byMonth(targets.filter((t) => t.metricId === mt.id), (t) => t.target),
        actual: byMonth(mActuals.filter((a) => a.metricId === mt.id), (a) => a.value),
      })),
  }));
}
