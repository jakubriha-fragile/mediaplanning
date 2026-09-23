import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  undoEntries, tactics, tacticBudgets, messageLines, metrics, metricTargets,
  actualSpends, metricActuals, accountNotes, campaigns,
} from "@/db/schema";

/**
 * Operace, které umí vrátit stav zpět. Ukládá se PŘED změnou — tedy hodnota,
 * která tam byla. Vrácení pak není „opačná akce", ale prosté zapsání původní
 * hodnoty; díky tomu nezáleží na tom, co se stalo mezitím jinde.
 */
export type UndoOp =
  | { t: "budget"; tacticId: string; month: string; planned: number }
  | { t: "actual"; tacticId: string; month: string; amount: number }
  | { t: "metricTarget"; metricId: string; month: string; target: number }
  | { t: "metricActual"; metricId: string; month: string; value: number }
  | { t: "note"; tacticId: string; month: string; text: string }
  | { t: "tactic"; tacticId: string; channel: string; mediaType: "Paid" | "Owned" | "Earned"; messageLineId: string }
  | { t: "line"; id: string; message: string; audience: string; phase: "Awareness" | "Consideration" | "Conversion"; code: string }
  | { t: "positions"; items: Array<{ id: string; position: number; messageLineId: string }> }
  | { t: "dropTactic"; id: string }
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
  for (const op of ops) {
    switch (op.t) {
      case "budget":
        await db.insert(tacticBudgets).values({ tacticId: op.tacticId, month: op.month, planned: op.planned })
          .onConflictDoUpdate({ target: [tacticBudgets.tacticId, tacticBudgets.month], set: { planned: op.planned } });
        break;
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
          .set({ channel: op.channel, mediaType: op.mediaType, messageLineId: op.messageLineId })
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
      case "dropTactic":
        await db.delete(tactics).where(eq(tactics.id, op.id));
        break;
      case "dropCampaign":
        await db.delete(campaigns).where(eq(campaigns.id, op.id));
        break;
    }
  }
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

/** Snímek celého pořadí — potřeba před přetažením, které pořadí přepisuje. */
export async function snapshotPositions(): Promise<UndoOp> {
  const rows = await db
    .select({ id: tactics.id, position: tactics.position, messageLineId: tactics.messageLineId })
    .from(tactics);
  return { t: "positions", items: rows };
}

/** Metriky nové taktiky se smažou kaskádou, stačí smazat taktiku. */
export const undoCreatedTactic = (id: string): UndoOp => ({ t: "dropTactic", id });
export const undoCreatedCampaign = (id: string): UndoOp => ({ t: "dropCampaign", id });
export { metrics };
