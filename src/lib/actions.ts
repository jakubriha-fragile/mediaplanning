"use server";

/**
 * Server actions — jediná cesta, kterou se do databáze zapisuje.
 *
 * Každá akce nejdřív zjistí souřadnice dotčeného záznamu (typ média, kampaň,
 * měsíc, oblast) a teprve pak se ptá engine oprávnění. Bez toho by granularita
 * z §5.2 byla jen dekorace v UI.
 *
 * Změny se logují automaticky porovnáním hodnoty před a po zápisu (zadání §7).
 */

import { revalidatePath } from "next/cache";
import { and, eq, desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  tactics, messageLines, campaigns, tacticBudgets, metrics, metricTargets,
  actualSpends, metricActuals, accountNotes, grants, users, changeLog,
  type Area,
} from "@/db/schema";
import { currentPrincipal } from "@/lib/auth";
import { assertCan, canManageUsers, PermissionError } from "@/lib/permissions";
import { MONTH_LABEL, kc, num } from "@/lib/months";

export type Result = { ok: true } | { ok: false; error: string };

function fail(e: unknown): Result {
  if (e instanceof PermissionError) return { ok: false, error: e.message };
  console.error(e);
  return { ok: false, error: "Uložení se nezdařilo." };
}

async function log(userId: string | null, area: Area, items: string[]) {
  if (!items.length) return;
  await db.insert(changeLog).values({ userId, area, items });
}

/** Souřadnice taktiky ve všech čtyřech rozměrech — bez nich nelze rozhodnout o oprávnění. */
async function tacticCoords(tacticId: string) {
  const [row] = await db
    .select({
      mediaType: tactics.mediaType,
      channel: tactics.channel,
      campaignId: messageLines.campaignId,
    })
    .from(tactics)
    .innerJoin(messageLines, eq(tactics.messageLineId, messageLines.id))
    .where(eq(tactics.id, tacticId))
    .limit(1);
  if (!row) throw new Error("Taktika neexistuje");
  return row;
}

const monthSchema = z.string().regex(/^\d{4}-\d{2}$/);

// ----------------------------------------------------------------- plán

const budgetInput = z.object({
  tacticId: z.string().min(1),
  month: monthSchema,
  planned: z.number().int().min(0).max(1_000_000_000),
});

export async function setPlannedBudget(raw: z.input<typeof budgetInput>): Promise<Result> {
  try {
    const { tacticId, month, planned } = budgetInput.parse(raw);
    const me = await currentPrincipal();
    const { mediaType, campaignId, channel } = await tacticCoords(tacticId);

    assertCan(me, "write", { area: "plan", mediaType, campaignId, month });

    const [before] = await db
      .select()
      .from(tacticBudgets)
      .where(and(eq(tacticBudgets.tacticId, tacticId), eq(tacticBudgets.month, month)));
    if ((before?.planned ?? 0) === planned) return { ok: true };

    await db
      .insert(tacticBudgets)
      .values({ tacticId, month, planned })
      .onConflictDoUpdate({ target: [tacticBudgets.tacticId, tacticBudgets.month], set: { planned } });

    await log(me!.id, "plan", [
      `Rozpočet ${channel} / ${MONTH_LABEL[month] ?? month}: ${kc(before?.planned ?? 0)} → ${kc(planned)}`,
    ]);
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

const metricTargetInput = z.object({
  metricId: z.string().min(1),
  month: monthSchema,
  target: z.number().min(0),
});

export async function setMetricTarget(raw: z.input<typeof metricTargetInput>): Promise<Result> {
  try {
    const { metricId, month, target } = metricTargetInput.parse(raw);
    const me = await currentPrincipal();
    const [metric] = await db.select().from(metrics).where(eq(metrics.id, metricId));
    if (!metric) throw new Error("Metrika neexistuje");
    const { mediaType, campaignId, channel } = await tacticCoords(metric.tacticId);

    assertCan(me, "write", { area: "plan", mediaType, campaignId, month });

    const [before] = await db
      .select()
      .from(metricTargets)
      .where(and(eq(metricTargets.metricId, metricId), eq(metricTargets.month, month)));
    if ((before?.target ?? 0) === target) return { ok: true };

    await db
      .insert(metricTargets)
      .values({ metricId, month, target })
      .onConflictDoUpdate({ target: [metricTargets.metricId, metricTargets.month], set: { target } });

    await log(me!.id, "plan", [
      `Cíl ${metric.name} ${channel} / ${MONTH_LABEL[month] ?? month}: ${num(before?.target ?? 0) || "—"} → ${num(target) || "—"}`,
    ]);
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ----------------------------------------------------------------- skutečnost

const actualInput = z.object({
  tacticId: z.string().min(1),
  month: monthSchema,
  amount: z.number().int().min(0).max(1_000_000_000),
});

export async function setActualSpend(raw: z.input<typeof actualInput>): Promise<Result> {
  try {
    const { tacticId, month, amount } = actualInput.parse(raw);
    const me = await currentPrincipal();
    const { mediaType, campaignId, channel } = await tacticCoords(tacticId);

    // Tohle je ta věta, kvůli které se aplikace staví:
    // klient s grantem jen na Paid sem u Owned taktiky neprojde.
    assertCan(me, "write", { area: "actuals", mediaType, campaignId, month });

    const [before] = await db
      .select()
      .from(actualSpends)
      .where(and(eq(actualSpends.tacticId, tacticId), eq(actualSpends.month, month)));
    if ((before?.amount ?? 0) === amount) return { ok: true };

    await db
      .insert(actualSpends)
      .values({ tacticId, month, amount })
      .onConflictDoUpdate({ target: [actualSpends.tacticId, actualSpends.month], set: { amount } });

    await log(me!.id, "actuals", [
      `Čerpání ${channel} / ${MONTH_LABEL[month] ?? month}: ${kc(before?.amount ?? 0)} → ${kc(amount)}`,
    ]);
    revalidatePath("/plneni");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

const metricActualInput = z.object({
  metricId: z.string().min(1),
  month: monthSchema,
  value: z.number().min(0),
});

export async function setMetricActual(raw: z.input<typeof metricActualInput>): Promise<Result> {
  try {
    const { metricId, month, value } = metricActualInput.parse(raw);
    const me = await currentPrincipal();
    const [metric] = await db.select().from(metrics).where(eq(metrics.id, metricId));
    if (!metric) throw new Error("Metrika neexistuje");
    const { mediaType, campaignId, channel } = await tacticCoords(metric.tacticId);

    assertCan(me, "write", { area: "actuals", mediaType, campaignId, month });

    const [before] = await db
      .select()
      .from(metricActuals)
      .where(and(eq(metricActuals.metricId, metricId), eq(metricActuals.month, month)));
    if ((before?.value ?? 0) === value) return { ok: true };

    await db
      .insert(metricActuals)
      .values({ metricId, month, value })
      .onConflictDoUpdate({ target: [metricActuals.metricId, metricActuals.month], set: { value } });

    await log(me!.id, "actuals", [
      `Realita ${metric.name} ${channel} / ${MONTH_LABEL[month] ?? month}: ${num(before?.value ?? 0) || "—"} → ${num(value) || "—"}`,
    ]);
    revalidatePath("/plneni");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

const noteInput = z.object({
  tacticId: z.string().min(1),
  month: monthSchema,
  text: z.string().max(500),
});

/** Poznámka odchylku vysvětluje, ale stav zůstává červený (zadání §6.3). */
export async function setAccountNote(raw: z.input<typeof noteInput>): Promise<Result> {
  try {
    const { tacticId, month, text } = noteInput.parse(raw);
    const me = await currentPrincipal();
    const { mediaType, campaignId, channel } = await tacticCoords(tacticId);

    assertCan(me, "write", { area: "actuals", mediaType, campaignId, month });

    const [before] = await db
      .select()
      .from(accountNotes)
      .where(and(eq(accountNotes.tacticId, tacticId), eq(accountNotes.month, month)));
    if ((before?.text ?? "") === text) return { ok: true };

    if (text.trim() === "") {
      await db.delete(accountNotes).where(and(eq(accountNotes.tacticId, tacticId), eq(accountNotes.month, month)));
    } else {
      await db
        .insert(accountNotes)
        .values({ tacticId, month, text })
        .onConflictDoUpdate({ target: [accountNotes.tacticId, accountNotes.month], set: { text } });
    }

    await log(me!.id, "actuals", [
      `Poznámka accountu ${channel} / ${MONTH_LABEL[month] ?? month}: „${text || "—"}“`,
    ]);
    revalidatePath("/plneni");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ----------------------------------------------------------------- správa uživatelů

const grantInput = z.object({
  userId: z.string().min(1),
  area: z.enum(["plan", "actuals", "assets"]),
  level: z.enum(["read", "write"]),
  mediaType: z.enum(["Paid", "Owned", "Earned"]).nullable(),
  campaignId: z.string().nullable(),
  month: monthSchema.nullable(),
  note: z.string().max(200).optional(),
});

export async function addGrant(raw: z.input<typeof grantInput>): Promise<Result> {
  try {
    const me = await currentPrincipal();
    if (!canManageUsers(me)) throw new PermissionError("Oprávnění smí měnit jen administrátor.");
    const data = grantInput.parse(raw);

    const [user] = await db.select().from(users).where(eq(users.id, data.userId));
    const campaign = data.campaignId
      ? (await db.select().from(campaigns).where(eq(campaigns.id, data.campaignId)))[0]
      : null;

    await db.insert(grants).values({ ...data, note: data.note || null });
    await log(me!.id, "plan", [
      `Přiděleno oprávnění ${user?.email ?? data.userId}: ${data.area}/${data.level} · ` +
        `${data.mediaType ?? "všechny typy"} · ${campaign?.name ?? "všechny kampaně"} · ` +
        `${data.month ? MONTH_LABEL[data.month] : "všechny měsíce"}`,
    ]);
    revalidatePath("/sprava");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function removeGrant(grantId: string): Promise<Result> {
  try {
    const me = await currentPrincipal();
    if (!canManageUsers(me)) throw new PermissionError("Oprávnění smí měnit jen administrátor.");
    const [g] = await db
      .select({ area: grants.area, level: grants.level, email: users.email })
      .from(grants)
      .innerJoin(users, eq(grants.userId, users.id))
      .where(eq(grants.id, grantId));
    await db.delete(grants).where(eq(grants.id, grantId));
    await log(me!.id, "plan", [`Odebráno oprávnění ${g?.email ?? grantId} (${g?.area}/${g?.level})`]);
    revalidatePath("/sprava");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

const inviteInput = z.object({
  email: z.string().email(),
  name: z.string().max(120).optional(),
  role: z.enum(["ADMIN", "PLANNER", "ACCOUNT", "CLIENT", "VIEWER"]),
});

export async function inviteUser(raw: z.input<typeof inviteInput>): Promise<Result> {
  try {
    const me = await currentPrincipal();
    if (!canManageUsers(me)) throw new PermissionError("Uživatele smí zvát jen administrátor.");
    const data = inviteInput.parse(raw);
    const email = data.email.toLowerCase();

    await db
      .insert(users)
      .values({ email, name: data.name || null, role: data.role })
      .onConflictDoUpdate({ target: users.email, set: { role: data.role, active: true } });

    await log(me!.id, "plan", [`Pozván uživatel ${email} v roli ${data.role}`]);
    revalidatePath("/sprava");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function setUserActive(userId: string, active: boolean): Promise<Result> {
  try {
    const me = await currentPrincipal();
    if (!canManageUsers(me)) throw new PermissionError("Uživatele smí měnit jen administrátor.");
    if (userId === me!.id) throw new PermissionError("Nemůžete deaktivovat sám sebe.");
    const [u] = await db.update(users).set({ active }).where(eq(users.id, userId)).returning();
    await log(me!.id, "plan", [`${active ? "Aktivován" : "Deaktivován"} uživatel ${u?.email ?? userId}`]);
    revalidatePath("/sprava");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Posledních N záznamů historie pro výpis ve správě. */
export async function recentChanges(limit = 40) {
  return db
    .select({
      id: changeLog.id,
      ts: changeLog.ts,
      area: changeLog.area,
      items: changeLog.items,
      userName: users.name,
      userEmail: users.email,
    })
    .from(changeLog)
    .leftJoin(users, eq(changeLog.userId, users.id))
    .orderBy(desc(changeLog.ts))
    .limit(limit);
}
