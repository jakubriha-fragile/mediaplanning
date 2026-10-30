import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { syncMonthsFromWeeks } from "@/lib/weeks";
import {
  undoEntries, tactics, tacticBudgets, tacticBudgetWeeks, messageLines, metrics, metricTargets, tacticThemes,
  actualSpends, metricActuals, accountNotes, campaigns,
  type PlanUnit,
} from "@/db/schema";

/**
 * Operace, které umí vrátit stav zpět. Ukládá se PŘED změnou — tedy hodnota,
 * která tam byla. Vrácení pak není „opačná akce", ale prosté zapsání původní
 * hodnoty; díky tomu nezáleží na tom, co se stalo mezitím jinde.
 */
export type UndoOp =
  | { t: "budget"; tacticId: string; month: string; planned: number;
      driver?: PlanUnit; driverValue?: number; unitPrice?: number }
  /** týden plánu po týdnech; `existed: false` = řádek před změnou nebyl, vrácení ho smaže */
  | { t: "budgetWeek"; tacticId: string; week: string; planned: number;
      driver: PlanUnit; driverValue: number; unitPrice: number; existed: boolean }
  | { t: "actual"; tacticId: string; month: string; amount: number }
  | { t: "metricTarget"; metricId: string; month: string; target: number }
  | { t: "metricActual"; metricId: string; month: string; value: number }
  | { t: "note"; tacticId: string; month: string; text: string }
  | { t: "tactic"; tacticId: string; channel: string; mediaType: "Paid" | "Owned" | "Earned"; messageLineId: string; label?: string | null }
  | { t: "line"; id: string; message: string; audience: string; phase: "Awareness" | "Consideration" | "Conversion"; code: string }
  | { t: "positions"; items: Array<{ id: string; position: number; messageLineId: string }> }
  | { t: "dropTactic"; id: string }
  | { t: "dropLine"; id: string }
  | { t: "themes"; tacticId: string; shares: Array<{ themeId: string; share: number }> }
  | { t: "campaignPositions"; items: Array<{ id: string; position: number }> }
  | { t: "dropCampaign"; id: string };

const MAX_STEPS = 10;

export async function pushUndo(userId: string, label: string, ops: UndoOp[]) {
  if (!ops.length) return;
  await db.insert(undoEntries).values({ userId, label, ops: JSON.stringify(ops) });
  const mine = await db
    .select({ id: undoEntries.id })
    .from(undoEntries)
    .where(eq(undoEntries.userId, userId))
    .orderBy(desc(undoEntries.ts));
  for (const old of mine.slice(MAX_STEPS)) {
    await db.delete(undoEntries).where(eq(undoEntries.id, old.id));
  }
}

export async function listUndo(userId: string) {
  return db
    .select({ id: undoEntries.id, ts: undoEntries.ts, label: undoEntries.label })
    .from(undoEntries)
    .where(eq(undoEntries.userId, userId))
    .orderBy(desc(undoEntries.ts))
    .limit(MAX_STEPS);
}

export async function applyOps(ops: UndoOp[]) {
  // měsíce se z týdnů přepočítají až po obnovení všech týdnů — jednou na taktiku
  const resync = new Set<string>();
  for (const op of ops) {
    switch (op.t) {
      case "budgetWeek": {
        if (!op.existed) {
          await db.delete(tacticBudgetWeeks)
            .where(and(eq(tacticBudgetWeeks.tacticId, op.tacticId), eq(tacticBudgetWeeks.week, op.week)));
        } else {
          const row = { planned: op.planned, driver: op.driver, driverValue: op.driverValue, unitPrice: op.unitPrice };
          await db.insert(tacticBudgetWeeks).values({ tacticId: op.tacticId, week: op.week, ...row })
            .onConflictDoUpdate({ target: [tacticBudgetWeeks.tacticId, tacticBudgetWeeks.week], set: row });
        }
        resync.add(op.tacticId);
        break;
      }
      case "budget": {
        const row = {
          planned: op.planned,
          driver: op.driver ?? ("budget" as const),
          driverValue: op.driverValue ?? op.planned,
          unitPrice: op.unitPrice ?? 0,
        };
        await db.insert(tacticBudgets).values({ tacticId: op.tacticId, month: op.month, ...row })
          .onConflictDoUpdate({ target: [tacticBudgets.tacticId, tacticBudgets.month], set: row });
        break;
      }
      case "actual":
        await db.insert(actualSpends).values({ tacticId: op.tacticId, month: op.month, amount: op.amount })
          .onConflictDoUpdate({ target: [actualSpends.tacticId, actualSpends.month], set: { amount: op.amount } });
        break;
      case "metricTarget":
        await db.insert(metricTargets).values({ metricId: op.metricId, month: op.month, target: op.target })
          .onConflictDoUpdate({ target: [metricTargets.metricId, metricTargets.month], set: { target: op.target } });
        break;
      case "metricActual":
        await db.insert(metricActuals).values({ metricId: op.metricId, month: op.month, value: op.value })
          .onConflictDoUpdate({ target: [metricActuals.metricId, metricActuals.month], set: { value: op.value } });
        break;
      case "note":
        if (!op.text.trim()) {
          await db.delete(accountNotes)
            .where(and(eq(accountNotes.tacticId, op.tacticId), eq(accountNotes.month, op.month)));
        } else {
          await db.insert(accountNotes).values({ tacticId: op.tacticId, month: op.month, text: op.text })
            .onConflictDoUpdate({ target: [accountNotes.tacticId, accountNotes.month], set: { text: op.text } });
        }
        break;
      case "tactic":
        await db.update(tactics)
          .set({
            channel: op.channel, mediaType: op.mediaType, messageLineId: op.messageLineId,
            // starší záznamy krátký název neznají — ty ho nechají být
            ...(op.label !== undefined ? { label: op.label } : {}),
          })
          .where(eq(tactics.id, op.tacticId));
        break;
      case "line":
        await db.update(messageLines)
          .set({ message: op.message, audience: op.audience, phase: op.phase, code: op.code })
          .where(eq(messageLines.id, op.id));
        break;
      case "positions":
        for (const it of op.items) {
          await db.update(tactics)
            .set({ position: it.position, messageLineId: it.messageLineId })
            .where(eq(tactics.id, it.id));
        }
        break;
      case "campaignPositions":
        for (const it of op.items) {
          await db.update(campaigns).set({ position: it.position }).where(eq(campaigns.id, it.id));
        }
        break;
      case "dropTactic":
        await db.delete(tactics).where(eq(tactics.id, op.id));
        break;
      case "themes":
        // původní rozdělení se zapíše celé znovu — i když bylo prázdné
        await db.delete(tacticThemes).where(eq(tacticThemes.tacticId, op.tacticId));
        if (op.shares.length) await db.insert(tacticThemes).values(op.shares.map((x) => ({ tacticId: op.tacticId, ...x })));
        break;
      case "dropLine":
        await db.delete(messageLines).where(eq(messageLines.id, op.id));
        break;
      case "dropCampaign":
        await db.delete(campaigns).where(eq(campaigns.id, op.id));
        break;
    }
  }
  for (const id of resync) await syncMonthsFromWeeks(id);
}

/** Operace posledního kroku bez provedení — aby šlo nejdřív ověřit oprávnění. */
export async function peekUndo(userId: string): Promise<UndoOp[] | null> {
  const [entry] = await db
    .select({ ops: undoEntries.ops })
    .from(undoEntries)
    .where(eq(undoEntries.userId, userId))
    .orderBy(desc(undoEntries.ts))
    .limit(1);
  return entry ? (JSON.parse(entry.ops) as UndoOp[]) : null;
}

export async function popUndo(userId: string) {
  const [entry] = await db
    .select()
    .from(undoEntries)
    .where(eq(undoEntries.userId, userId))
    .orderBy(desc(undoEntries.ts))
    .limit(1);
  if (!entry) return null;
  await applyOps(JSON.parse(entry.ops) as UndoOp[]);
  await db.delete(undoEntries).where(eq(undoEntries.id, entry.id));
  return entry.label;
}

/** Snímek pořadí taktik jednoho plánu — potřeba před přetažením, které pořadí přepisuje. */
export async function snapshotPositions(planId: string): Promise<UndoOp> {
  const rows = await db
    .select({ id: tactics.id, position: tactics.position, messageLineId: tactics.messageLineId })
    .from(tactics)
    .innerJoin(messageLines, eq(tactics.messageLineId, messageLines.id))
    .innerJoin(campaigns, eq(messageLines.campaignId, campaigns.id))
    .where(eq(campaigns.planId, planId));
  return { t: "positions", items: rows };
}

export async function snapshotCampaignOrder(planId: string): Promise<UndoOp> {
  const rows = await db
    .select({ id: campaigns.id, position: campaigns.position })
    .from(campaigns)
    .where(eq(campaigns.planId, planId));
  return { t: "campaignPositions", items: rows };
}

/** Metriky nové taktiky se smažou kaskádou, stačí smazat taktiku. */
export const undoCreatedTactic = (id: string): UndoOp => ({ t: "dropTactic", id });
export const undoCreatedLine = (id: string): UndoOp => ({ t: "dropLine", id });
export const undoCreatedCampaign = (id: string): UndoOp => ({ t: "dropCampaign", id });
export { metrics };
