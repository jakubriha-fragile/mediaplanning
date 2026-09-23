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
import { and, eq, desc, asc, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  tactics, messageLines, campaigns, tacticBudgets, metrics, metricTargets,
  actualSpends, metricActuals, accountNotes, grants, users, changeLog,
  type Area,
} from "@/db/schema";
import { currentPrincipal } from "@/lib/auth";
import { assertCan, canManageUsers, PermissionError } from "@/lib/permissions";
import { MONTH_LABEL, QUARTER, kc, num } from "@/lib/months";
import {
  pushUndo, popUndo, listUndo, snapshotPositions,
  undoCreatedTactic, undoCreatedCampaign, type UndoOp,
} from "@/lib/undo";

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

    const label = `Rozpočet ${channel} / ${MONTH_LABEL[month] ?? month}: ${kc(before?.planned ?? 0)} → ${kc(planned)}`;
    await pushUndo(me!.id, label, [{ t: "budget", tacticId, month, planned: before?.planned ?? 0 }]);
    await log(me!.id, "plan", [label]);
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

    const label = `Cíl ${metric.name} ${channel} / ${MONTH_LABEL[month] ?? month}: ${num(before?.target ?? 0) || "—"} → ${num(target) || "—"}`;
    await pushUndo(me!.id, label, [{ t: "metricTarget", metricId, month, target: before?.target ?? 0 }]);
    await log(me!.id, "plan", [label]);
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

    const label = `Čerpání ${channel} / ${MONTH_LABEL[month] ?? month}: ${kc(before?.amount ?? 0)} → ${kc(amount)}`;
    await pushUndo(me!.id, label, [{ t: "actual", tacticId, month, amount: before?.amount ?? 0 }]);
    await log(me!.id, "actuals", [label]);
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

    const label = `Realita ${metric.name} ${channel} / ${MONTH_LABEL[month] ?? month}: ${num(before?.value ?? 0) || "—"} → ${num(value) || "—"}`;
    await pushUndo(me!.id, label, [{ t: "metricActual", metricId, month, value: before?.value ?? 0 }]);
    await log(me!.id, "actuals", [label]);
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

    const label = `Poznámka accountu ${channel} / ${MONTH_LABEL[month] ?? month}: „${text || "—"}“`;
    await pushUndo(me!.id, label, [{ t: "note", tacticId, month, text: before?.text ?? "" }]);
    await log(me!.id, "actuals", [label]);
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

// ----------------------------------------------------------------- struktura plánu

const tacticPatch = z.object({
  tacticId: z.string().min(1),
  channel: z.string().max(120).optional(),
  mediaType: z.enum(["Paid", "Owned", "Earned"]).optional(),
  messageLineId: z.string().min(1).optional(),
});

/** Kanál, typ média nebo přeřazení taktiky pod jinou linku sdělení. */
export async function updateTactic(raw: z.input<typeof tacticPatch>): Promise<Result> {
  try {
    const data = tacticPatch.parse(raw);
    const me = await currentPrincipal();
    const before = await tacticCoords(data.tacticId);

    // oprávnění se ptáme na PŮVODNÍ souřadnice…
    assertCan(me, "write", { area: "plan", mediaType: before.mediaType, campaignId: before.campaignId, month: null });
    // …a pokud se mění typ média nebo kampaň, i na CÍLOVÉ, ať se přes úpravu neobchází grant
    if (data.mediaType && data.mediaType !== before.mediaType) {
      assertCan(me, "write", { area: "plan", mediaType: data.mediaType, campaignId: before.campaignId, month: null });
    }
    if (data.messageLineId) {
      const [line] = await db.select().from(messageLines).where(eq(messageLines.id, data.messageLineId));
      if (!line) throw new Error("Linka sdělení neexistuje");
      if (line.campaignId !== before.campaignId) {
        assertCan(me, "write", { area: "plan", mediaType: before.mediaType, campaignId: line.campaignId, month: null });
      }
    }

    const items: string[] = [];
    if (data.channel !== undefined && data.channel !== before.channel) {
      items.push(`Kanál: „${before.channel}" → „${data.channel}"`);
    }
    if (data.mediaType && data.mediaType !== before.mediaType) {
      items.push(`Typ média ${before.channel}: ${before.mediaType} → ${data.mediaType}`);
    }
    if (!items.length && !data.messageLineId) return { ok: true };

    const [full] = await db.select().from(tactics).where(eq(tactics.id, data.tacticId));
    await pushUndo(me!.id, items[0] ?? `Přeřazena taktika ${before.channel}`, [
      { t: "tactic", tacticId: full.id, channel: full.channel, mediaType: full.mediaType, messageLineId: full.messageLineId },
    ]);

    await db
      .update(tactics)
      .set({
        ...(data.channel !== undefined ? { channel: data.channel } : {}),
        ...(data.mediaType ? { mediaType: data.mediaType } : {}),
        ...(data.messageLineId ? { messageLineId: data.messageLineId } : {}),
      })
      .where(eq(tactics.id, data.tacticId));

    await log(me!.id, "plan", items.length ? items : [`Přeřazena taktika ${before.channel}`]);
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

const linePatch = z.object({
  messageLineId: z.string().min(1),
  message: z.string().max(200).optional(),
  audience: z.string().max(120).optional(),
  phase: z.enum(["Awareness", "Consideration", "Conversion"]).optional(),
  code: z.string().max(60).optional(),
});

/** Sdělení, cílovka a fáze se mění na lince — projeví se u všech jejích taktik. */
export async function updateMessageLine(raw: z.input<typeof linePatch>): Promise<Result> {
  try {
    const data = linePatch.parse(raw);
    const me = await currentPrincipal();
    const [line] = await db.select().from(messageLines).where(eq(messageLines.id, data.messageLineId));
    if (!line) throw new Error("Linka sdělení neexistuje");

    assertCan(me, "write", { area: "plan", mediaType: null, campaignId: line.campaignId, month: null });

    const items: string[] = [];
    const pairs: Array<[keyof typeof data, string, string | null]> = [
      ["message", "Sdělení", line.message],
      ["audience", "Cílová skupina", line.audience],
      ["phase", "Fáze", line.phase],
      ["code", "Kód", line.code],
    ];
    for (const [key, label, old] of pairs) {
      const next = data[key];
      if (next !== undefined && next !== old) items.push(`${label} ${line.code}: „${old}" → „${next}"`);
    }
    if (!items.length) return { ok: true };

    await pushUndo(me!.id, items[0], [
      { t: "line", id: line.id, message: line.message, audience: line.audience, phase: line.phase, code: line.code },
    ]);

    await db
      .update(messageLines)
      .set({
        ...(data.message !== undefined ? { message: data.message } : {}),
        ...(data.audience !== undefined ? { audience: data.audience } : {}),
        ...(data.phase ? { phase: data.phase } : {}),
        ...(data.code !== undefined ? { code: data.code } : {}),
      })
      .where(eq(messageLines.id, data.messageLineId));

    await log(me!.id, "plan", items);
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Přetažení: přesun taktiky na jinou pozici, případně pod jinou linku sdělení. */
export async function moveTactic(raw: {
  tacticId: string;
  targetTacticId?: string;
  after?: boolean;
  targetMessageLineId?: string;
}): Promise<Result> {
  try {
    const me = await currentPrincipal();
    const before = await tacticCoords(raw.tacticId);
    assertCan(me, "write", { area: "plan", mediaType: before.mediaType, campaignId: before.campaignId, month: null });

    const all = await db
      .select({ id: tactics.id, position: tactics.position, messageLineId: tactics.messageLineId })
      .from(tactics)
      .orderBy(asc(tactics.position));

    const moving = all.find((t) => t.id === raw.tacticId);
    if (!moving) throw new Error("Taktika neexistuje");

    // Přetažení mezi řádky POUZE mění pořadí. Do jiné kampaně se taktika
    // přesune jen upuštěním na hlavičku kampaně — jinak by řádek nečekaně
    // zmizel do jiného bloku a uživatel by ho hledal.
    const newLineId = raw.targetMessageLineId ?? moving.messageLineId;

    // přesun do jiné kampaně musí projít kontrolou i na cílové straně
    if (newLineId !== moving.messageLineId) {
      const [line] = await db.select().from(messageLines).where(eq(messageLines.id, newLineId));
      if (!line) throw new Error("Cílová linka neexistuje");
      if (line.campaignId !== before.campaignId) {
        assertCan(me, "write", { area: "plan", mediaType: before.mediaType, campaignId: line.campaignId, month: null });
      }
    }

    await pushUndo(me!.id, `Přesun taktiky ${before.channel}`, [await snapshotPositions()]);

    const rest = all.filter((t) => t.id !== raw.tacticId);
    let index = rest.length;
    if (raw.targetTacticId) {
      const at = rest.findIndex((t) => t.id === raw.targetTacticId);
      if (at >= 0) index = raw.after ? at + 1 : at;
    } else if (raw.targetMessageLineId) {
      const at = rest.findIndex((t) => t.messageLineId === raw.targetMessageLineId);
      index = at >= 0 ? at : rest.length;
    }
    rest.splice(index, 0, { ...moving, messageLineId: newLineId });

    for (const [i, t] of rest.entries()) {
      await db
        .update(tactics)
        .set({ position: i, ...(t.id === raw.tacticId ? { messageLineId: newLineId } : {}) })
        .where(eq(tactics.id, t.id));
    }

    await log(me!.id, "plan", [`Přesunuta taktika ${before.channel}`]);
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

const newTactic = z.object({
  messageLineId: z.string().min(1),
  channel: z.string().max(120).default("Nový kanál"),
  mediaType: z.enum(["Paid", "Owned", "Earned"]).default("Paid"),
});

/** Nová taktika pod danou linkou sdělení. Rozpočty začínají na nule. */
export async function createTactic(raw: z.input<typeof newTactic>): Promise<Result> {
  try {
    const data = newTactic.parse(raw);
    const me = await currentPrincipal();
    const [line] = await db.select().from(messageLines).where(eq(messageLines.id, data.messageLineId));
    if (!line) throw new Error("Linka sdělení neexistuje");

    assertCan(me, "write", { area: "plan", mediaType: data.mediaType, campaignId: line.campaignId, month: null });

    const [{ max }] = await db
      .select({ max: sql<number>`coalesce(max(${tactics.position}), -1)` })
      .from(tactics);

    const [t] = await db
      .insert(tactics)
      .values({
        messageLineId: data.messageLineId,
        channel: data.channel,
        mediaType: data.mediaType,
        position: Number(max) + 1,
      })
      .returning();

    await db.insert(tacticBudgets).values(
      ["2026-10", "2026-11", "2026-12"].map((month) => ({ tacticId: t.id, month, planned: 0 })),
    );
    // sada metrik podle fáze linky — stejná logika jako v seedu
    const brand = line.phase === "Awareness";
    await db.insert(metrics).values([
      { tacticId: t.id, name: brand ? "Reach" : "Konverze", kind: "cumulative" as const, unit: "", slot: 0 },
      { tacticId: t.id, name: brand ? "CPM" : "CPA", kind: "rate_low" as const, unit: "Kč", slot: 1 },
    ]);

    await pushUndo(me!.id, `Přidána taktika „${data.channel}"`, [undoCreatedTactic(t.id)]);
    await log(me!.id, "plan", [`Přidána taktika „${data.channel}" pod ${line.code}`]);
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteTactic(tacticId: string): Promise<Result> {
  try {
    const me = await currentPrincipal();
    const before = await tacticCoords(tacticId);
    assertCan(me, "write", { area: "plan", mediaType: before.mediaType, campaignId: before.campaignId, month: null });
    // smazání zpět vrátit neumíme (kaskádou padnou i rozpočty a metriky),
    // proto zásobník raději vyprázdníme, ať se uživatel nespoléhá
    await db.delete(tactics).where(eq(tactics.id, tacticId));
    await log(me!.id, "plan", [`Smazána taktika „${before.channel}" (nelze vrátit zpět)`]);
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

const newCampaign = z.object({
  name: z.string().min(1).max(120),
  message: z.string().max(200).default("Nové sdělení"),
  phase: z.enum(["Awareness", "Consideration", "Conversion"]).default("Awareness"),
  audience: z.string().max(120).default("—"),
});

/** Nová iniciativa: kampaň + první linka sdělení, aby pod ni šlo rovnou věšet taktiky. */
export async function createCampaign(raw: z.input<typeof newCampaign>): Promise<Result> {
  try {
    const data = newCampaign.parse(raw);
    const me = await currentPrincipal();
    // zakládat kampaně smí jen ten, kdo smí měnit plán napříč
    assertCan(me, "write", { area: "plan", mediaType: null, campaignId: null, month: null });

    const [c] = await db
      .insert(campaigns)
      .values({ name: data.name, client: "BENU", quarter: QUARTER })
      .returning();

    const code = data.name.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 12) + "-1";
    await db.insert(messageLines).values({
      campaignId: c.id,
      code: code || "NOVA-1",
      message: data.message,
      phase: data.phase,
      audience: data.audience,
    });

    await pushUndo(me!.id, `Založen blok „${data.name}"`, [undoCreatedCampaign(c.id)]);
    await log(me!.id, "plan", [`Založen blok „${data.name}"`]);
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

const newLine = z.object({
  campaignId: z.string().min(1),
  code: z.string().max(60),
  message: z.string().max(200).default("Nové sdělení"),
  phase: z.enum(["Awareness", "Consideration", "Conversion"]).default("Awareness"),
  audience: z.string().max(120).default("—"),
});

export async function createMessageLine(raw: z.input<typeof newLine>): Promise<Result> {
  try {
    const data = newLine.parse(raw);
    const me = await currentPrincipal();
    assertCan(me, "write", { area: "plan", mediaType: null, campaignId: data.campaignId, month: null });
    await db.insert(messageLines).values(data);
    await log(me!.id, "plan", [`Přidána linka sdělení ${data.code}`]);
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ----------------------------------------------------------------- vrácení zpět

/** Posledních 10 kroků aktuálního uživatele, nejnovější první. */
export async function myUndoStack() {
  const me = await currentPrincipal();
  if (!me) return [];
  return listUndo(me.id);
}

/** Vrátí poslední krok. Zapisuje původní hodnoty, takže nezáleží na tom,
 *  co se mezitím stalo jinde — nevrací se „opačná akce", ale stav. */
export async function undoLast(): Promise<Result & { label?: string }> {
  try {
    const me = await currentPrincipal();
    if (!me) throw new PermissionError("Nejste přihlášen.");
    const label = await popUndo(me.id);
    if (!label) return { ok: false, error: "Není co vrátit." };
    await log(me.id, "plan", [`Vráceno zpět: ${label}`]);
    revalidatePath("/");
    revalidatePath("/plneni");
    return { ok: true, label };
  } catch (e) {
    return fail(e);
  }
}
