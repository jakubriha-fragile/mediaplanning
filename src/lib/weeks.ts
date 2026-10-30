import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { tactics, messageLines, campaigns, plans, tacticBudgets, tacticBudgetWeeks, type PlanUnit } from "@/db/schema";
import { monthsBetween, weeksOfPeriod, type Week } from "@/lib/period";

/**
 * Plán po týdnech — přepočty mezi týdny a měsíci.
 *
 * Týdenní hodnota platí pro dny týdne, které leží v období plánu (u krajních
 * týdnů méně než 7). Do měsíců se dělí podle dnů: týden 29. 3.–4. 4. dá 3/7
 * březnu a 4/7 dubnu. Měsíční řádky v tactic_budget se z týdnů vždy znovu
 * sečtou, takže všechno, co pracuje s měsíci (součty, Výsledky, zásah,
 * oprávnění), funguje beze změny. Součet plánu se při převodu nemění.
 *
 * Volá se jen ze serveru (actions, undo) — oprávnění ověřuje volající.
 */

const inPlanDays = (w: Week) => w.parts.reduce((s, p) => s + p.days, 0);

async function periodOf(tacticId: string) {
  const [row] = await db
    .select({ periodStart: plans.periodStart, periodEnd: plans.periodEnd, granularity: plans.granularity })
    .from(tactics)
    .innerJoin(messageLines, eq(tactics.messageLineId, messageLines.id))
    .innerJoin(campaigns, eq(messageLines.campaignId, campaigns.id))
    .innerJoin(plans, eq(campaigns.planId, plans.id))
    .where(eq(tactics.id, tacticId));
  return row ?? null;
}

/** Sečte týdny taktiky do měsíců a uloží je do tactic_budget (invariant 3: Kč vždy). */
export async function syncMonthsFromWeeks(tacticId: string) {
  const p = await periodOf(tacticId);
  if (!p) return;
  const months = monthsBetween(p.periodStart, p.periodEnd);
  const weeks = weeksOfPeriod(p.periodStart, p.periodEnd);
  const [rows, monthRows] = await Promise.all([
    db.select().from(tacticBudgetWeeks).where(eq(tacticBudgetWeeks.tacticId, tacticId)),
    db.select().from(tacticBudgets).where(eq(tacticBudgets.tacticId, tacticId)),
  ]);
  // řídicí jednotka a cena jsou vlastností řádku — týdny je mají stejné
  const anyWeek = rows.find((r) => r.driverValue > 0 || r.planned > 0) ?? rows[0];
  for (const m of months) {
    let dv = 0, planned = 0;
    for (const w of weeks) {
      const part = w.parts.find((x) => x.month === m);
      const r = part && rows.find((x) => x.week === w.key);
      if (!part || !r) continue;
      const share = part.days / inPlanDays(w);
      dv += r.driverValue * share;
      planned += r.planned * share;
    }
    const before = monthRows.find((x) => x.month === m);
    const driver = (anyWeek?.driver ?? before?.driver ?? "budget") as PlanUnit;
    const unitPrice = anyWeek?.unitPrice ?? before?.unitPrice ?? 0;
    const row = { planned: Math.round(planned), driver, driverValue: dv, unitPrice };
    await db.insert(tacticBudgets).values({ tacticId, month: m, ...row })
      .onConflictDoUpdate({ target: [tacticBudgets.tacticId, tacticBudgets.month], set: row });
  }
}

/**
 * Měsíce → týdny: každý měsíc se rozloží rovnoměrně do svých dnů. Týden přes
 * přelom dostane díl z obou měsíců. Součet plánu zůstane stejný; u přelomových
 * týdnů se měsíce mírně promíchají (týden má jednu hodnotu pro všech 7 dní).
 */
export async function monthsToWeeks(tacticId: string) {
  const p = await periodOf(tacticId);
  if (!p) return;
  const weeks = weeksOfPeriod(p.periodStart, p.periodEnd);
  const monthRows = await db.select().from(tacticBudgets).where(eq(tacticBudgets.tacticId, tacticId));
  const daysIn = (m: string) => {
    const [y, mo] = m.split("-").map(Number);
    return new Date(Date.UTC(y, mo, 0)).getUTCDate();
  };
  const first = monthRows.find((r) => r.driverValue > 0 || r.planned > 0) ?? monthRows[0];
  const driver = (first?.driver ?? "budget") as PlanUnit;
  const unitPrice = monthRows.find((r) => r.unitPrice > 0)?.unitPrice ?? 0;

  await db.delete(tacticBudgetWeeks).where(eq(tacticBudgetWeeks.tacticId, tacticId));
  // importované řádky mívají jen Kč — hodnota řídicí jednotky pak chybí
  const target = (m: string) => {
    const r = monthRows.find((x) => x.month === m);
    return { dv: r ? r.driverValue || (r.driver === "budget" ? r.planned : 0) : 0, planned: r?.planned ?? 0 };
  };

  // 1) rovnoměrně podle dnů: týden přes přelom dostane díl z obou měsíců
  const val = new Map<string, { dv: number; planned: number }>();
  for (const w of weeks) {
    let dv = 0, planned = 0;
    for (const part of w.parts) {
      const t = target(part.month);
      dv += (t.dv * part.days) / daysIn(part.month);
      planned += (t.planned * part.days) / daysIn(part.month);
    }
    val.set(w.key, { dv, planned });
  }
  // 2) Přelomový týden má jednu hodnotu pro všech 7 dní, takže by měsíce o kus
  //    promíchal. Nejdřív se přelomové týdny zmenší tak, aby žádný měsíc nedostal
  //    víc, než má mít (měsíc s nulou vedle plného: týden do něj nesmí přetéct)…
  const inside = (w: Week) => w.parts.length === 1;
  const months = monthsBetween(p.periodStart, p.periodEnd);
  const edge = weeks.filter((w) => !inside(w));
  const spill = (m: string, key: "dv" | "planned") => edge.reduce((s, w) => {
    const part = w.parts.find((x) => x.month === m);
    return part ? s + (val.get(w.key)![key] * part.days) / inPlanDays(w) : s;
  }, 0);
  for (const m of months) {
    for (const key of ["dv", "planned"] as const) {
      const b = spill(m, key);
      const t = target(m)[key];
      if (b <= t || b <= 0) continue;
      const f = t / b;
      for (const w of edge) {
        if (w.parts.some((x) => x.month === m)) val.set(w.key, { ...val.get(w.key)!, [key]: val.get(w.key)![key] * f });
      }
    }
  }
  //    …a zbytek každého měsíce dorovnají týdny celé uvnitř něj. Měsíční součty
  //    i součet plánu pak sedí přesně.
  for (const m of months) {
    const own = weeks.filter((w) => inside(w) && w.parts[0].month === m);
    if (!own.length) continue;
    const t = target(m);
    const bDv = spill(m, "dv"), bPl = spill(m, "planned");
    const days = own.reduce((s, w) => s + inPlanDays(w), 0);
    for (const w of own) {
      val.set(w.key, {
        dv: Math.max(0, ((t.dv - bDv) * inPlanDays(w)) / days),
        planned: Math.max(0, ((t.planned - bPl) * inPlanDays(w)) / days),
      });
    }
  }
  const values = [];
  for (const w of weeks) {
    const v = val.get(w.key)!;
    if (v.dv > 0 || v.planned > 0) {
      values.push({ tacticId, week: w.key, driver, driverValue: v.dv, unitPrice, planned: Math.round(v.planned) });
    }
  }
  if (values.length) await db.insert(tacticBudgetWeeks).values(values);
  await syncMonthsFromWeeks(tacticId);
}

/** Taktiky plánu — pro hromadný převod a úklid. */
export async function planTacticIds(planId: string): Promise<string[]> {
  const rows = await db
    .select({ id: tactics.id })
    .from(tactics)
    .innerJoin(messageLines, eq(tactics.messageLineId, messageLines.id))
    .innerJoin(campaigns, eq(messageLines.campaignId, campaigns.id))
    .where(eq(campaigns.planId, planId));
  return rows.map((r) => r.id);
}

/** Smaže týdny mimo období plánu (po zkrácení období) a přepočte měsíce. */
export async function pruneWeeks(planId: string, periodStart: string, periodEnd: string) {
  const keep = new Set(weeksOfPeriod(periodStart, periodEnd).map((w) => w.key));
  const ids = await planTacticIds(planId);
  if (!ids.length) return;
  const rows = await db.select({ id: tacticBudgetWeeks.id, week: tacticBudgetWeeks.week })
    .from(tacticBudgetWeeks).where(inArray(tacticBudgetWeeks.tacticId, ids));
  const drop = rows.filter((r) => !keep.has(r.week)).map((r) => r.id);
  if (drop.length) await db.delete(tacticBudgetWeeks).where(inArray(tacticBudgetWeeks.id, drop));
  for (const id of ids) await syncMonthsFromWeeks(id);
}

/** Jeden týdenní řádek taktiky (nebo null). */
export async function weekRow(tacticId: string, week: string) {
  const [r] = await db.select().from(tacticBudgetWeeks)
    .where(and(eq(tacticBudgetWeeks.tacticId, tacticId), eq(tacticBudgetWeeks.week, week)));
  return r ?? null;
}
