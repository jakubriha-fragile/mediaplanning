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
  tactics, messageLines, campaigns, plans, clients, targetGroups, tacticBudgets,
  metrics, metricTargets, actualSpends, metricActuals, accountNotes, grants,
  users, changeLog,
  channelTypeEnum, planUnitEnum, mediaTypeEnum,
  type Area, type ChannelType, type PlanUnit,
} from "@/db/schema";
import { currentPrincipal } from "@/lib/auth";
import { assertCan, canManageUsers, PermissionError } from "@/lib/permissions";
import { monthLabel, monthsBetween, periodLabel, shiftYears, kc, num } from "@/lib/period";
import { derive, isGrpPriced } from "@/lib/crossmedia";
import {
  pushUndo, popUndo, listUndo, snapshotPositions, snapshotCampaignOrder,
  undoCreatedTactic, undoCreatedCampaign, undoCreatedLine, type UndoOp,
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

/** Souřadnice taktiky ve všech pěti rozměrech — bez nich nelze rozhodnout o oprávnění. */
async function tacticCoords(tacticId: string) {
  const [row] = await db
    .select({
      mediaType: tactics.mediaType,
      channel: tactics.channel,
      channelType: tactics.channelType,
      targetGroupId: tactics.targetGroupId,
      campaignId: messageLines.campaignId,
      planId: campaigns.planId,
    })
    .from(tactics)
    .innerJoin(messageLines, eq(tactics.messageLineId, messageLines.id))
    .innerJoin(campaigns, eq(messageLines.campaignId, campaigns.id))
    .where(eq(tactics.id, tacticId))
    .limit(1);
  if (!row) throw new Error("Taktika neexistuje");
  return row;
}

/** Ke které kampani patří který plán. */
async function campaignPlan(campaignId: string): Promise<string> {
  const [row] = await db
    .select({ planId: campaigns.planId })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!row) throw new Error("Blok neexistuje");
  return row.planId;
}

/** Universum cílové skupiny taktiky; NULL na taktice = skupina plánu. */
async function universeFor(planId: string, tacticTargetGroupId: string | null): Promise<number> {
  let tgId = tacticTargetGroupId;
  if (!tgId) {
    const [p] = await db.select({ tg: plans.targetGroupId }).from(plans).where(eq(plans.id, planId));
    tgId = p?.tg ?? null;
  }
  if (!tgId) return 0;
  const [tg] = await db.select({ u: targetGroups.universe }).from(targetGroups).where(eq(targetGroups.id, tgId));
  return tg?.u ?? 0;
}

const monthSchema = z.string().regex(/^\d{4}-\d{2}$/);

// ----------------------------------------------------------------- plán

const budgetInput = z.object({
  tacticId: z.string().min(1),
  month: monthSchema,
  /** Čím je měsíc řízený. Ostatní dvě jednotky se dopočítají. */
  driver: z.enum(planUnitEnum.enumValues).default("budget"),
  /** Hodnota v jednotce driveru: Kč, GRP, nebo impressions. */
  value: z.number().min(0).max(100_000_000_000),
  /** CPP u TV a rádia, jinak CPT. Nezadané = ponechat stávající. */
  unitPrice: z.number().min(0).max(10_000_000).optional(),
});

/**
 * Měsíční plán taktiky. Plánovač zadá JEDNO číslo a zbytek se dopočítá —
 * rozpočet v Kč se do databáze ukládá vždy, aby všechny součty i porovnání
 * se skutečností zůstaly na jednom poli.
 */
export async function setPlannedBudget(raw: z.input<typeof budgetInput>): Promise<Result> {
  try {
    const { tacticId, month, driver, value, unitPrice } = budgetInput.parse(raw);
    const me = await currentPrincipal();
    const { mediaType, campaignId, planId, channel, channelType, targetGroupId } =
      await tacticCoords(tacticId);

    assertCan(me, "write", { area: "plan", mediaType, planId, campaignId, month });

    const [before] = await db
      .select()
      .from(tacticBudgets)
      .where(and(eq(tacticBudgets.tacticId, tacticId), eq(tacticBudgets.month, month)));

    const price = unitPrice ?? before?.unitPrice ?? 0;
    const universe = await universeFor(planId, targetGroupId);
    const d = derive({ channelType, driver, driverValue: value, unitPrice: price, universe });
    const planned = Math.round(d.budget);

    const same =
      (before?.planned ?? 0) === planned &&
      (before?.driver ?? "budget") === driver &&
      (before?.driverValue ?? 0) === value &&
      (before?.unitPrice ?? 0) === price;
    if (same) return { ok: true };

    await db
      .insert(tacticBudgets)
      .values({ tacticId, month, planned, driver, driverValue: value, unitPrice: price })
      .onConflictDoUpdate({
        target: [tacticBudgets.tacticId, tacticBudgets.month],
        set: { planned, driver, driverValue: value, unitPrice: price },
      });

    const unit = driver === "budget" ? "" : driver === "grp" ? " GRP" : " imp.";
    const label =
      driver === "budget"
        ? `Rozpočet ${channel} / ${monthLabel(month)}: ${kc(before?.planned ?? 0)} → ${kc(planned)}`
        : `${driver === "grp" ? "GRP" : "Impressions"} ${channel} / ${monthLabel(month)}: ` +
          `${num(before?.driverValue ?? 0) || "—"}${unit} → ${num(value) || "—"}${unit} (${kc(planned)} Kč)`;

    await pushUndo(me!.id, label, [{
      t: "budget", tacticId, month,
      planned: before?.planned ?? 0,
      driver: before?.driver ?? "budget",
      driverValue: before?.driverValue ?? 0,
      unitPrice: before?.unitPrice ?? 0,
    }]);
    await log(me!.id, "plan", [label]);
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Jednotková cena (CPP/CPT) pro taktiku a měsíc — přepočítá rozpočet. */
export async function setUnitPrice(raw: { tacticId: string; month: string; unitPrice: number }): Promise<Result> {
  try {
    const { tacticId, month } = raw;
    const unitPrice = Math.max(0, Number(raw.unitPrice) || 0);
    const me = await currentPrincipal();
    const { mediaType, campaignId, planId, channel, channelType, targetGroupId } =
      await tacticCoords(tacticId);
    assertCan(me, "write", { area: "plan", mediaType, planId, campaignId, month });

    const [before] = await db
      .select()
      .from(tacticBudgets)
      .where(and(eq(tacticBudgets.tacticId, tacticId), eq(tacticBudgets.month, month)));
    if ((before?.unitPrice ?? 0) === unitPrice) return { ok: true };

    const driver = before?.driver ?? "budget";
    const value = before?.driverValue ?? 0;
    const universe = await universeFor(planId, targetGroupId);
    const planned = Math.round(
      derive({ channelType, driver, driverValue: value, unitPrice, universe }).budget,
    );

    await db
      .insert(tacticBudgets)
      .values({ tacticId, month, planned, driver, driverValue: value, unitPrice })
      .onConflictDoUpdate({
        target: [tacticBudgets.tacticId, tacticBudgets.month],
        set: { planned, unitPrice },
      });

    const label = `${isGrpPriced(channelType) ? "CPP" : "CPT"} ${channel} / ${monthLabel(month)}: ` +
      `${num(before?.unitPrice ?? 0) || "—"} → ${num(unitPrice) || "—"} Kč`;
    await pushUndo(me!.id, label, [{
      t: "budget", tacticId, month,
      planned: before?.planned ?? 0, driver, driverValue: value,
      unitPrice: before?.unitPrice ?? 0,
    }]);
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
    const { mediaType, campaignId, planId, channel } = await tacticCoords(metric.tacticId);

    assertCan(me, "write", { area: "plan", mediaType, planId, campaignId, month });

    const [before] = await db
      .select()
      .from(metricTargets)
      .where(and(eq(metricTargets.metricId, metricId), eq(metricTargets.month, month)));
    if ((before?.target ?? 0) === target) return { ok: true };

    await db
      .insert(metricTargets)
      .values({ metricId, month, target })
      .onConflictDoUpdate({ target: [metricTargets.metricId, metricTargets.month], set: { target } });

    const label = `Cíl ${metric.name} ${channel} / ${monthLabel(month)}: ${num(before?.target ?? 0) || "—"} → ${num(target) || "—"}`;
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
    const { mediaType, campaignId, planId, channel } = await tacticCoords(tacticId);

    // Tohle je ta věta, kvůli které se aplikace staví:
    // klient s grantem jen na Paid sem u Owned taktiky neprojde.
    assertCan(me, "write", { area: "actuals", mediaType, planId, campaignId, month });

    const [before] = await db
      .select()
      .from(actualSpends)
      .where(and(eq(actualSpends.tacticId, tacticId), eq(actualSpends.month, month)));
    if ((before?.amount ?? 0) === amount) return { ok: true };

    await db
      .insert(actualSpends)
      .values({ tacticId, month, amount })
      .onConflictDoUpdate({ target: [actualSpends.tacticId, actualSpends.month], set: { amount } });

    const label = `Čerpání ${channel} / ${monthLabel(month)}: ${kc(before?.amount ?? 0)} → ${kc(amount)}`;
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
    const { mediaType, campaignId, planId, channel } = await tacticCoords(metric.tacticId);

    assertCan(me, "write", { area: "actuals", mediaType, planId, campaignId, month });

    const [before] = await db
      .select()
      .from(metricActuals)
      .where(and(eq(metricActuals.metricId, metricId), eq(metricActuals.month, month)));
    if ((before?.value ?? 0) === value) return { ok: true };

    await db
      .insert(metricActuals)
      .values({ metricId, month, value })
      .onConflictDoUpdate({ target: [metricActuals.metricId, metricActuals.month], set: { value } });

    const label = `Realita ${metric.name} ${channel} / ${monthLabel(month)}: ${num(before?.value ?? 0) || "—"} → ${num(value) || "—"}`;
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
    const { mediaType, campaignId, planId, channel } = await tacticCoords(tacticId);

    assertCan(me, "write", { area: "actuals", mediaType, planId, campaignId, month });

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

    const label = `Poznámka accountu ${channel} / ${monthLabel(month)}: „${text || "—"}“`;
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
  /** Prázdné = všechny plány. U klienta to skoro vždy chcete vyplnit. */
  planId: z.string().nullable().default(null),
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
    const plan = data.planId
      ? (await db.select().from(plans).where(eq(plans.id, data.planId)))[0]
      : null;
    // kampaň z jiného plánu by vytvořila grant, který nikdy na nic nesedne
    if (campaign && data.planId && campaign.planId !== data.planId) {
      return { ok: false, error: "Vybraná kampaň není v tomto plánu." };
    }

    await db.insert(grants).values({ ...data, note: data.note || null });
    await log(me!.id, "plan", [
      `Přiděleno oprávnění ${user?.email ?? data.userId}: ${data.area}/${data.level} · ` +
        `${plan?.name ?? "všechny plány"} · ${data.mediaType ?? "všechny typy"} · ` +
        `${campaign?.name ?? "všechny kampaně"} · ` +
        `${data.month ? monthLabel(data.month) : "všechny měsíce"}`,
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
    assertCan(me, "write", { area: "plan", mediaType: before.mediaType, planId: before.planId, campaignId: before.campaignId, month: null });
    // …a pokud se mění typ média nebo kampaň, i na CÍLOVÉ, ať se přes úpravu neobchází grant
    if (data.mediaType && data.mediaType !== before.mediaType) {
      assertCan(me, "write", { area: "plan", mediaType: data.mediaType, planId: before.planId, campaignId: before.campaignId, month: null });
    }
    if (data.messageLineId) {
      const [line] = await db.select().from(messageLines).where(eq(messageLines.id, data.messageLineId));
      if (!line) throw new Error("Linka sdělení neexistuje");
      if (line.campaignId !== before.campaignId) {
        assertCan(me, "write", { area: "plan", mediaType: before.mediaType, planId: before.planId, campaignId: line.campaignId, month: null });
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

    assertCan(me, "write", { area: "plan", mediaType: null, planId: await campaignPlan(line.campaignId), campaignId: line.campaignId, month: null });

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

/**
 * Přetažení taktiky.
 *
 * Přesun do jiného bloku NESMÍ taktice přepsat sdělení, fázi ani cílovku —
 * to byla chyba předchozí verze, kdy taktika převzala hodnoty cílové linky.
 * Místo toho se v cílovém bloku najde linka se stejnými hodnotami, a když
 * neexistuje, založí se její kopie. Taktika si tak nese své údaje s sebou.
 */
export async function moveTactic(raw: {
  tacticId: string;
  targetTacticId?: string;
  after?: boolean;
  targetCampaignId?: string;
}): Promise<Result> {
  try {
    const me = await currentPrincipal();
    const before = await tacticCoords(raw.tacticId);
    assertCan(me, "write", { area: "plan", mediaType: before.mediaType, planId: before.planId, campaignId: before.campaignId, month: null });

    const all = await db
      .select({ id: tactics.id, position: tactics.position, messageLineId: tactics.messageLineId })
      .from(tactics)
      .orderBy(asc(tactics.position));
    const moving = all.find((t) => t.id === raw.tacticId);
    if (!moving) throw new Error("Taktika neexistuje");

    const [currentLine] = await db.select().from(messageLines).where(eq(messageLines.id, moving.messageLineId));

    // do kterého bloku se přesouvá?
    let targetCampaignId = raw.targetCampaignId ?? null;
    if (!targetCampaignId && raw.targetTacticId) {
      const [row] = await db
        .select({ campaignId: messageLines.campaignId })
        .from(tactics)
        .innerJoin(messageLines, eq(tactics.messageLineId, messageLines.id))
        .where(eq(tactics.id, raw.targetTacticId));
      targetCampaignId = row?.campaignId ?? null;
    }

    let newLineId = moving.messageLineId;
    if (targetCampaignId && targetCampaignId !== currentLine.campaignId) {
      assertCan(me, "write", { area: "plan", mediaType: before.mediaType, planId: before.planId, campaignId: targetCampaignId, month: null });

      const existing = await db
        .select()
        .from(messageLines)
        .where(and(eq(messageLines.campaignId, targetCampaignId), eq(messageLines.message, currentLine.message)));
      const same = existing.find(
        (l) => l.phase === currentLine.phase && l.audience === currentLine.audience,
      );
      if (same) {
        newLineId = same.id;
      } else {
        // kopie linky i s jejími hodnotami; kód doplníme, ať je v bloku jedinečný
        const taken = await db
          .select({ code: messageLines.code })
          .from(messageLines)
          .where(eq(messageLines.campaignId, targetCampaignId));
        let code = currentLine.code, n = 2;
        while (taken.some((t) => t.code === code)) code = `${currentLine.code}-${n++}`;
        const [copy] = await db
          .insert(messageLines)
          .values({
            campaignId: targetCampaignId,
            code,
            message: currentLine.message,
            phase: currentLine.phase,
            audience: currentLine.audience,
          })
          .returning();
        newLineId = copy.id;
      }
    }

    await pushUndo(me!.id, `Přesun taktiky ${before.channel}`, [
      await snapshotPositions(),
      { t: "tactic", tacticId: moving.id, channel: before.channel, mediaType: before.mediaType, messageLineId: moving.messageLineId },
    ]);

    const rest = all.filter((t) => t.id !== raw.tacticId);
    let index = rest.length;
    if (raw.targetTacticId) {
      const at = rest.findIndex((t) => t.id === raw.targetTacticId);
      if (at >= 0) index = raw.after ? at + 1 : at;
    } else if (targetCampaignId) {
      // na začátek cílového bloku
      const lines = await db
        .select({ id: messageLines.id })
        .from(messageLines)
        .where(eq(messageLines.campaignId, targetCampaignId));
      const ids = new Set(lines.map((l) => l.id));
      const at = rest.findIndex((t) => ids.has(t.messageLineId));
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

/** Přetažení celého bloku — mění se jen pořadí kampaní. */
export async function moveCampaign(raw: {
  campaignId: string;
  targetCampaignId: string;
  after?: boolean;
}): Promise<Result> {
  try {
    const me = await currentPrincipal();
    const planId = await campaignPlan(raw.campaignId);
    assertCan(me, "write", { area: "plan", mediaType: null, planId, campaignId: null, month: null });

    const all = await db
      .select({ id: campaigns.id, name: campaigns.name, position: campaigns.position })
      .from(campaigns)
      .where(eq(campaigns.planId, planId))
      .orderBy(asc(campaigns.position), asc(campaigns.name));

    const moving = all.find((c) => c.id === raw.campaignId);
    if (!moving || raw.campaignId === raw.targetCampaignId) return { ok: true };

    await pushUndo(me!.id, `Přesun bloku ${moving.name}`, [await snapshotCampaignOrder(planId)]);

    const rest = all.filter((c) => c.id !== raw.campaignId);
    const at = rest.findIndex((c) => c.id === raw.targetCampaignId);
    rest.splice(at < 0 ? rest.length : raw.after ? at + 1 : at, 0, moving);

    for (const [i, c] of rest.entries()) {
      await db.update(campaigns).set({ position: i }).where(eq(campaigns.id, c.id));
    }

    await log(me!.id, "plan", [`Přesunut blok ${moving.name}`]);
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Smazání bloku. Prázdný jde rovnou, s taktikami až po potvrzení z UI. */
export async function deleteCampaign(campaignId: string, confirmWithContent = false): Promise<Result> {
  try {
    const me = await currentPrincipal();
    assertCan(me, "write", { area: "plan", mediaType: null, planId: await campaignPlan(campaignId), campaignId, month: null });

    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
    if (!c) return { ok: true };

    const inside = await db
      .select({ id: tactics.id })
      .from(tactics)
      .innerJoin(messageLines, eq(tactics.messageLineId, messageLines.id))
      .where(eq(messageLines.campaignId, campaignId));

    if (inside.length && !confirmWithContent) {
      return { ok: false, error: `Blok „${c.name}" obsahuje ${inside.length} taktik. Smazání je nutné potvrdit.` };
    }

    await db.delete(campaigns).where(eq(campaigns.id, campaignId));
    await log(me!.id, "plan", [
      inside.length
        ? `Smazán blok „${c.name}" včetně ${inside.length} taktik (nelze vrátit zpět)`
        : `Smazán prázdný blok „${c.name}"`,
    ]);
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

/**
 * Založí taktiku i s rozpočtovými řádky a metrikami. Měsíce se berou
 * z období plánu — dřív tu byl zadrátovaný Q4 2026, takže taktika přidaná
 * do plánu 2027 dostala nulové řádky za rok 2026 a žádné za vlastní období.
 */
async function insertTactic(
  line: typeof messageLines.$inferSelect,
  channel: string,
  mediaType: "Paid" | "Owned" | "Earned",
) {
  const [plan] = await db
    .select({ periodStart: plans.periodStart, periodEnd: plans.periodEnd })
    .from(campaigns)
    .innerJoin(plans, eq(campaigns.planId, plans.id))
    .where(eq(campaigns.id, line.campaignId))
    .limit(1);
  if (!plan) throw new Error("Blok neexistuje");

  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${tactics.position}), -1)` })
    .from(tactics);

  const [t] = await db
    .insert(tactics)
    .values({ messageLineId: line.id, channel, mediaType, position: Number(max) + 1 })
    .returning();

  await db.insert(tacticBudgets).values(
    monthsBetween(plan.periodStart, plan.periodEnd).map((month) => ({ tacticId: t.id, month, planned: 0 })),
  );
  // sada metrik podle fáze linky — stejná logika jako v seedu
  const brand = line.phase === "Awareness";
  await db.insert(metrics).values([
    { tacticId: t.id, name: brand ? "Reach" : "Konverze", kind: "cumulative" as const, unit: "", slot: 0 },
    { tacticId: t.id, name: brand ? "CPM" : "CPA", kind: "rate_low" as const, unit: "Kč", slot: 1 },
  ]);
  return t;
}

/** Nová taktika pod danou linkou sdělení. Rozpočty začínají na nule. */
export async function createTactic(raw: z.input<typeof newTactic>): Promise<Result> {
  try {
    const data = newTactic.parse(raw);
    const me = await currentPrincipal();
    const [line] = await db.select().from(messageLines).where(eq(messageLines.id, data.messageLineId));
    if (!line) throw new Error("Linka sdělení neexistuje");

    assertCan(me, "write", { area: "plan", mediaType: data.mediaType, planId: await campaignPlan(line.campaignId), campaignId: line.campaignId, month: null });

    const t = await insertTactic(line, data.channel, data.mediaType);

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
    assertCan(me, "write", { area: "plan", mediaType: before.mediaType, planId: before.planId, campaignId: before.campaignId, month: null });
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
  planId: z.string().min(1),
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
    assertCan(me, "write", { area: "plan", mediaType: null, planId: data.planId, campaignId: null, month: null });

    const [{ max }] = await db
      .select({ max: sql<number>`coalesce(max(${campaigns.position}), -1)` })
      .from(campaigns)
      .where(eq(campaigns.planId, data.planId));
    const [c] = await db
      .insert(campaigns)
      .values({ name: data.name, planId: data.planId, position: Number(max) + 1 })
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
  /** Bez kódu se dopočítá z kódů bloku: BENU-1, BENU-2 → BENU-3. */
  code: z.string().max(60).optional(),
  message: z.string().max(200).default("Nové sdělení"),
  phase: z.enum(["Awareness", "Consideration", "Conversion"]).default("Awareness"),
  audience: z.string().max(120).default("—"),
});

/** Další volný kód linky v bloku. Unikátnost (kód × blok) hlídá i index. */
function nextLineCode(campaignName: string, existing: string[]): string {
  const base =
    existing.map((c) => c.match(/^(.*)-\d+$/)?.[1]).find(Boolean) ??
    (campaignName.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 12) || "NOVA");
  const taken = new Set(existing);
  let n = existing.length + 1;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Nová linka sdělení i s první taktikou. Prázdná linka by v tabulce nebyla
 * vidět — řádky jsou taktiky — a plánovač by neměl kde začít psát.
 */
export async function createMessageLine(raw: z.input<typeof newLine>): Promise<Result> {
  try {
    const data = newLine.parse(raw);
    const me = await currentPrincipal();
    assertCan(me, "write", { area: "plan", mediaType: null, planId: await campaignPlan(data.campaignId), campaignId: data.campaignId, month: null });

    const [camp] = await db.select({ name: campaigns.name }).from(campaigns).where(eq(campaigns.id, data.campaignId));
    const existing = await db
      .select({ code: messageLines.code })
      .from(messageLines)
      .where(eq(messageLines.campaignId, data.campaignId));
    const code = data.code?.trim() || nextLineCode(camp.name, existing.map((r) => r.code));

    const [line] = await db.insert(messageLines).values({ ...data, code }).returning();
    await insertTactic(line, "Nový kanál", "Paid");

    // smazáním linky padnou kaskádou i její taktika, rozpočty a metriky
    await pushUndo(me!.id, `Přidána linka sdělení ${code}`, [undoCreatedLine(line.id)]);
    await log(me!.id, "plan", [`Přidána linka sdělení ${code}`]);
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

// ----------------------------------------------------------- plány a klienti

const newPlan = z.object({
  clientId: z.string().min(1),
  name: z.string().min(1).max(120),
  periodStart: monthSchema,
  periodEnd: monthSchema,
  targetGroupId: z.string().min(1).nullable().default(null),
  /** Odkud zkopírovat strukturu — bloky, sdělení a taktiky. Čísla se nekopírují. */
  copyFromPlanId: z.string().min(1).nullable().default(null),
});

/**
 * Založení plánu. Kopie ze stávajícího přenese STRUKTURU, ne čísla: bloky,
 * linky sdělení a taktiky i s nastavením nosiče a cílové skupiny, ale rozpočty
 * a metriky zůstanou prázdné. Nový rok se tak nerozjede z loňských částek.
 */
export async function createPlan(raw: z.input<typeof newPlan>): Promise<Result & { planId?: string }> {
  try {
    const data = newPlan.parse(raw);
    const me = await currentPrincipal();
    if (!canManageUsers(me)) {
      // zakládat plány smí administrátor nebo kdokoli s právem měnit plán napříč
      assertCan(me, "write", { area: "plan", mediaType: null, planId: null, campaignId: null, month: null });
    }
    if (monthsBetween(data.periodStart, data.periodEnd).length < 1) {
      return { ok: false, error: "Období je prázdné nebo obrácené." };
    }

    const [{ max }] = await db
      .select({ max: sql<number>`coalesce(max(${plans.position}), -1)` })
      .from(plans)
      .where(eq(plans.clientId, data.clientId));

    const [plan] = await db
      .insert(plans)
      .values({
        clientId: data.clientId,
        name: data.name,
        periodStart: data.periodStart,
        periodEnd: data.periodEnd,
        targetGroupId: data.targetGroupId,
        position: Number(max) + 1,
      })
      .returning();

    let copied = 0;
    const newMonths = monthsBetween(data.periodStart, data.periodEnd);
    if (data.copyFromPlanId) {
      const srcCampaigns = await db
        .select()
        .from(campaigns)
        .where(eq(campaigns.planId, data.copyFromPlanId))
        .orderBy(asc(campaigns.position));

      for (const c of srcCampaigns) {
        const [nc] = await db
          .insert(campaigns)
          .values({ planId: plan.id, name: c.name, position: c.position })
          .returning();

        const srcLines = await db.select().from(messageLines).where(eq(messageLines.campaignId, c.id));
        for (const l of srcLines) {
          const [nl] = await db
            .insert(messageLines)
            .values({
              campaignId: nc.id, code: l.code, message: l.message,
              phase: l.phase, audience: l.audience,
            })
            .returning();

          const srcTactics = await db
            .select().from(tactics)
            .where(eq(tactics.messageLineId, l.id))
            .orderBy(asc(tactics.position));
          for (const t of srcTactics) {
            const [nt] = await db.insert(tactics).values({
              messageLineId: nl.id, channel: t.channel, mediaType: t.mediaType,
              channelType: t.channelType, targetGroupId: t.targetGroupId,
              position: t.position, note: t.note,
            }).returning();

            // Ceník se přenáší, objemy ne. CPP a CPT je sazba, ne rozhodnutí
            // o rozpočtu — bez ní by se nový rok nedal hned počítat.
            const srcBudgets = await db
              .select().from(tacticBudgets)
              .where(eq(tacticBudgets.tacticId, t.id));
            const price = srcBudgets.map((b) => b.unitPrice).find((v) => v > 0) ?? 0;
            const driver = (srcBudgets[0]?.driver as PlanUnit) ?? "budget";
            if (price > 0 || driver !== "budget") {
              await db.insert(tacticBudgets).values(
                newMonths.map((month) => ({
                  tacticId: nt.id, month, planned: 0,
                  driver, driverValue: 0, unitPrice: price,
                })),
              );
            }
            copied++;
          }
        }
      }
    }

    const label =
      `Založen plán „${data.name}" (${periodLabel(data.periodStart, data.periodEnd)})` +
      (copied ? `, zkopírováno ${copied} taktik bez čísel` : "");
    await log(me!.id, "plan", [label]);
    revalidatePath("/");
    return { ok: true, planId: plan.id };
  } catch (e) {
    return fail(e);
  }
}

/** Rychlá varianta: tentýž plán o rok dál. */
export async function copyPlanToNextYear(planId: string, years = 1): Promise<Result & { planId?: string }> {
  try {
    const [src] = await db.select().from(plans).where(eq(plans.id, planId));
    if (!src) return { ok: false, error: "Plán neexistuje." };
    const start = shiftYears(src.periodStart, years);
    const end = shiftYears(src.periodEnd, years);
    return await createPlan({
      clientId: src.clientId,
      name: periodLabel(start, end),
      periodStart: start,
      periodEnd: end,
      targetGroupId: src.targetGroupId,
      copyFromPlanId: planId,
    });
  } catch (e) {
    return fail(e);
  }
}

const planPatch = z.object({
  planId: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  status: z.enum(["draft", "approved", "live", "closed"]).optional(),
  targetGroupId: z.string().min(1).nullable().optional(),
});

export async function updatePlan(raw: z.input<typeof planPatch>): Promise<Result> {
  try {
    const data = planPatch.parse(raw);
    const me = await currentPrincipal();
    assertCan(me, "write", { area: "plan", mediaType: null, planId: data.planId, campaignId: null, month: null });

    const [before] = await db.select().from(plans).where(eq(plans.id, data.planId));
    if (!before) return { ok: false, error: "Plán neexistuje." };

    const patch: Record<string, unknown> = {};
    const items: string[] = [];
    if (data.name && data.name !== before.name) { patch.name = data.name; items.push(`Plán přejmenován: ${before.name} → ${data.name}`); }
    if (data.status && data.status !== before.status) { patch.status = data.status; items.push(`Plán ${before.name}: stav ${before.status} → ${data.status}`); }
    if (data.targetGroupId !== undefined && data.targetGroupId !== before.targetGroupId) {
      patch.targetGroupId = data.targetGroupId;
      items.push(`Plán ${before.name}: změněna výchozí cílová skupina`);
    }
    if (!items.length) return { ok: true };

    await db.update(plans).set(patch).where(eq(plans.id, data.planId));
    await log(me!.id, "plan", items);
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ------------------------------------------------------- cross-mediální vrstva

const tacticMedia = z.object({
  tacticId: z.string().min(1),
  channelType: z.enum(channelTypeEnum.enumValues).optional(),
  targetGroupId: z.string().min(1).nullable().optional(),
});

/** Nosič a cílová skupina taktiky — mění, podle čeho se počítá zásah. */
export async function setTacticMedia(raw: z.input<typeof tacticMedia>): Promise<Result> {
  try {
    const data = tacticMedia.parse(raw);
    const me = await currentPrincipal();
    const before = await tacticCoords(data.tacticId);
    assertCan(me, "write", {
      area: "plan", mediaType: before.mediaType, planId: before.planId,
      campaignId: before.campaignId, month: null,
    });

    const patch: Record<string, unknown> = {};
    const items: string[] = [];
    if (data.channelType && data.channelType !== before.channelType) {
      patch.channelType = data.channelType;
      items.push(`Nosič ${before.channel}: ${before.channelType} → ${data.channelType}`);
    }
    if (data.targetGroupId !== undefined && data.targetGroupId !== before.targetGroupId) {
      patch.targetGroupId = data.targetGroupId;
      items.push(`Cílová skupina ${before.channel} změněna`);
    }
    if (!items.length) return { ok: true };

    await db.update(tactics).set(patch).where(eq(tactics.id, data.tacticId));

    // Změna nosiče mění jednotku ceny (CPP ↔ CPT) i křivku zásahu, takže se
    // musí přepočítat rozpočty všech měsíců — jinak by v plánu zůstala částka
    // spočítaná podle předchozího nosiče.
    if (patch.channelType || patch.targetGroupId !== undefined) {
      const rows = await db.select().from(tacticBudgets).where(eq(tacticBudgets.tacticId, data.tacticId));
      const channelType = (patch.channelType as ChannelType) ?? before.channelType;
      const tgId = (patch.targetGroupId as string | null | undefined) !== undefined
        ? (patch.targetGroupId as string | null)
        : before.targetGroupId;
      const universe = await universeFor(before.planId, tgId);
      for (const r of rows) {
        const planned = Math.round(
          derive({
            channelType, driver: r.driver as PlanUnit, driverValue: r.driverValue,
            unitPrice: r.unitPrice, universe,
          }).budget,
        );
        if (planned !== r.planned) {
          await db.update(tacticBudgets).set({ planned }).where(eq(tacticBudgets.id, r.id));
        }
      }
    }

    await log(me!.id, "plan", items);
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

const tgInput = z.object({
  id: z.string().min(1).optional(),
  clientId: z.string().min(1).nullable().default(null),
  name: z.string().min(1).max(120),
  universe: z.number().int().min(0).max(20_000_000),
  source: z.string().max(200).default(""),
  note: z.string().max(400).default(""),
});

/** Cílová skupina a její universum. Bez universa nejde spočítat zásah. */
export async function saveTargetGroup(raw: z.input<typeof tgInput>): Promise<Result> {
  try {
    const data = tgInput.parse(raw);
    const me = await currentPrincipal();
    if (!canManageUsers(me)) {
      assertCan(me, "write", { area: "plan", mediaType: null, planId: null, campaignId: null, month: null });
    }

    if (data.id) {
      const [before] = await db.select().from(targetGroups).where(eq(targetGroups.id, data.id));
      await db.update(targetGroups)
        .set({ name: data.name, universe: data.universe, source: data.source, note: data.note })
        .where(eq(targetGroups.id, data.id));
      await log(me!.id, "plan", [
        `Cílová skupina ${data.name}: universum ${kc(before?.universe ?? 0)} → ${kc(data.universe)}`,
      ]);
    } else {
      const [{ max }] = await db
        .select({ max: sql<number>`coalesce(max(${targetGroups.position}), -1)` })
        .from(targetGroups);
      await db.insert(targetGroups).values({ ...data, position: Number(max) + 1 });
      await log(me!.id, "plan", [`Založena cílová skupina ${data.name} (${kc(data.universe)} osob)`]);
    }
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Řídicí jednotka a jednotková cena se nastavují na celý řádek, ne na buňku —
 * plánovač nepřepíná GRP a rozpočet měsíc po měsíci. Jeden zápis přes celé
 * období místo dvanácti kol tam a zpět.
 */
export async function setRowUnit(raw: {
  tacticId: string;
  driver?: PlanUnit;
  unitPrice?: number;
}): Promise<Result> {
  try {
    const me = await currentPrincipal();
    const { mediaType, campaignId, planId, channel, channelType, targetGroupId } =
      await tacticCoords(raw.tacticId);

    const plan = await db.select().from(plans).where(eq(plans.id, planId));
    const months = monthsBetween(plan[0].periodStart, plan[0].periodEnd);
    // na řádek smí sáhnout jen ten, kdo smí všechny jeho měsíce
    for (const m of months) {
      assertCan(me, "write", { area: "plan", mediaType, planId, campaignId, month: m });
    }

    const rows = await db.select().from(tacticBudgets).where(eq(tacticBudgets.tacticId, raw.tacticId));
    const universe = await universeFor(planId, targetGroupId);

    const before = rows[0];
    const driver = raw.driver ?? (before?.driver as PlanUnit) ?? "budget";
    const unitPrice = raw.unitPrice ?? before?.unitPrice ?? 0;

    const undo = rows.map((r) => ({
      t: "budget" as const, tacticId: r.tacticId, month: r.month,
      planned: r.planned, driver: r.driver as PlanUnit,
      driverValue: r.driverValue, unitPrice: r.unitPrice,
    }));

    for (const m of months) {
      const r = rows.find((x) => x.month === m);
      // při změně jednotky se hodnota převede, ať z plánu nezmizí peníze:
      // z rozpočtu na GRP se dosadí dopočítané GRP a naopak
      let value = r?.driverValue ?? 0;
      if (r && raw.driver && raw.driver !== r.driver) {
        const cur = derive({
          channelType, driver: r.driver as PlanUnit, driverValue: r.driverValue,
          unitPrice: r.unitPrice, universe,
        });
        value = raw.driver === "budget" ? cur.budget
          : raw.driver === "grp" ? cur.grp
          : cur.impressions;
      }
      const planned = Math.round(derive({ channelType, driver, driverValue: value, unitPrice, universe }).budget);
      await db
        .insert(tacticBudgets)
        .values({ tacticId: raw.tacticId, month: m, planned, driver, driverValue: value, unitPrice })
        .onConflictDoUpdate({
          target: [tacticBudgets.tacticId, tacticBudgets.month],
          set: { planned, driver, driverValue: value, unitPrice },
        });
    }

    const items: string[] = [];
    if (raw.driver && raw.driver !== before?.driver) {
      items.push(`Řídicí jednotka ${channel}: ${before?.driver ?? "budget"} → ${raw.driver}`);
    }
    if (raw.unitPrice !== undefined && raw.unitPrice !== before?.unitPrice) {
      items.push(`${isGrpPriced(channelType) ? "CPP" : "CPT"} ${channel}: ` +
        `${num(before?.unitPrice ?? 0) || "—"} → ${num(unitPrice) || "—"} Kč`);
    }
    if (!items.length) return { ok: true };

    await pushUndo(me!.id, items[0], undo);
    await log(me!.id, "plan", items);
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
