/**
 * Smaže všechny plány klienta kromě vyjmenovaných — úklid testovacích a seedových plánů.
 *
 *   DATABASE_URL=… npx tsx scripts/smazat-plany.ts                  # jen vypíše, co by smazal
 *   DATABASE_URL=… npx tsx scripts/smazat-plany.ts --potvrdit       # opravdu smaže
 *
 * Bez --potvrdit se nic nezapisuje. Mazání je nevratné: kaskádou padnou bloky,
 * taktiky, rozpočty, skutečnost, metriky, oblasti taktik i granty na smazané plány.
 * Do historie změn se zapíše záznam o úklidu.
 */
import "dotenv/config";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as s from "../src/db/schema";

const KEEP = ["Strategický plán 2027"];
const CLIENT_SLUG = "benu";
const confirm = process.argv.includes("--potvrdit");

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Chybí DATABASE_URL.");
  const conn = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(conn, { schema: s });

  const [client] = await db.select().from(s.clients).where(eq(s.clients.slug, CLIENT_SLUG));
  if (!client) throw new Error(`Klient „${CLIENT_SLUG}" neexistuje.`);

  const all = await db.select().from(s.plans).where(eq(s.plans.clientId, client.id));
  const kept = all.filter((p) => KEEP.includes(p.name));
  if (kept.length !== KEEP.length) {
    // pojistka: bez plánu, který má zůstat, raději nic nemazat — překlep v názvu by smazal všechno
    throw new Error(`Plán k zachování nenalezen (${KEEP.join(", ")}). Nic se nesmazalo.`);
  }
  const doomed = all.filter((p) => !KEEP.includes(p.name));

  console.log(`Zůstane: ${kept.map((p) => p.name).join(", ")}`);
  if (!doomed.length) { console.log("Není co mazat."); await conn.end(); return; }

  for (const p of doomed) {
    const camps = await db.select({ id: s.campaigns.id }).from(s.campaigns).where(eq(s.campaigns.planId, p.id));
    const tac = camps.length
      ? await db.select({ id: s.tactics.id }).from(s.tactics)
          .innerJoin(s.messageLines, eq(s.tactics.messageLineId, s.messageLines.id))
          .where(inArray(s.messageLines.campaignId, camps.map((c) => c.id)))
      : [];
    console.log(`${confirm ? "Mažu" : "Smazal bych"}: ${p.name} (${p.periodStart} – ${p.periodEnd}), ${camps.length} bloků, ${tac.length} taktik`);
  }

  if (!confirm) {
    console.log("\nNic se nesmazalo. Pro skutečné smazání spusťte znovu s --potvrdit.");
    await conn.end();
    return;
  }

  await db.delete(s.plans).where(and(eq(s.plans.clientId, client.id), notInArray(s.plans.name, KEEP)));
  await db.insert(s.changeLog).values({
    userId: null, area: "plan",
    items: [`Úklid: smazány plány ${doomed.map((p) => `„${p.name}"`).join(", ")} (skript smazat-plany)`],
  });
  console.log(`\nHotovo, smazané plány: ${doomed.length}.`);
  await conn.end();
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
