/**
 * Naplní databázi reálnými daty Q4 2026 (BENU_media_flowchart_Q4_2026_v2_1.xlsx)
 * a založí testovací účty, na kterých jde hned proklikat role a oprávnění.
 *
 *   npm run db:seed
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as s from "../src/db/schema";
import data from "./seed-data.json";

const MONTHS = ["2026-10", "2026-11", "2026-12"] as const;
const QUARTER = "2026-Q4";

type SeedRow = { msgId: string; type: string; channel: string; oct: number; nov: number; dec: number; kpi: string };
type SeedMsg = { id: string; campaign: string; message: string; phase: string; audience: string };

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("Chybí DATABASE_URL. Zkopírujte .env.example do .env a doplňte připojení k databázi.");
    process.exit(1);
  }
  const conn = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(conn, { schema: s });

  console.log("Mažu stará data…");
  // pořadí kvůli cizím klíčům
  await db.delete(s.changeLog);
  await db.delete(s.grants);
  await db.delete(s.assets);
  await db.delete(s.accountNotes);
  await db.delete(s.metricActuals);
  await db.delete(s.metricTargets);
  await db.delete(s.metrics);
  await db.delete(s.actualSpends);
  await db.delete(s.tacticBudgets);
  await db.delete(s.tactics);
  await db.delete(s.messageLines);
  await db.delete(s.campaigns);

  const rows = data.rows as SeedRow[];
  const msgs = data.messages as SeedMsg[];

  // --- kampaně
  const campaignNames = [...new Set(msgs.map((m) => m.campaign))];
  const campaignRows = await db
    .insert(s.campaigns)
    .values(campaignNames.map((name) => ({ name, client: "BENU", quarter: QUARTER })))
    .returning();
  const campaignId = Object.fromEntries(campaignRows.map((c) => [c.name, c.id]));
  console.log(`Kampaně: ${campaignNames.length}`);

  // --- linky sdělení
  const lineRows = await db
    .insert(s.messageLines)
    .values(
      msgs.map((m) => ({
        campaignId: campaignId[m.campaign],
        code: m.id,
        message: m.message,
        phase: m.phase as "Awareness" | "Consideration" | "Conversion",
        audience: m.audience,
      })),
    )
    .returning();
  const lineId = Object.fromEntries(lineRows.map((l) => [l.code, l.id]));
  console.log(`Linky sdělení: ${msgs.length}`);

  // --- taktiky, rozpočty, metriky
  // Sada metrik podle fáze: Awareness → brand, jinak performance (zadání §8)
  const BRAND = [
    { name: "Reach", kind: "cumulative" as const, unit: "" },
    { name: "CPM", kind: "rate_low" as const, unit: "Kč" },
  ];
  const PERF = [
    { name: "Konverze", kind: "cumulative" as const, unit: "" },
    { name: "CPA", kind: "rate_low" as const, unit: "Kč" },
  ];

  let position = 0;
  for (const r of rows) {
    const msg = msgs.find((m) => m.id === r.msgId);
    if (!msg) continue;
    const [t] = await db
      .insert(s.tactics)
      .values({
        messageLineId: lineId[r.msgId],
        channel: r.channel,
        mediaType: r.type as "Paid" | "Owned" | "Earned",
        position: position++,
        note: r.kpi || null,
      })
      .returning();

    const amounts = [r.oct, r.nov, r.dec];
    await db.insert(s.tacticBudgets).values(
      MONTHS.map((month, i) => ({ tacticId: t.id, month, planned: Math.round(amounts[i] || 0) })),
    );

    const set = msg.phase === "Awareness" ? BRAND : PERF;
    await db.insert(s.metrics).values(set.map((m, slot) => ({ tacticId: t.id, ...m, slot })));
  }
  const total = rows.reduce((sum, r) => sum + r.oct + r.nov + r.dec, 0);
  console.log(`Taktiky: ${rows.length}, rozpočet Q4: ${Math.round(total).toLocaleString("cs-CZ")} Kč`);

  // --- testovací účty (viz README → Testovací přihlášení)
  const people = [
    { email: "admin@fragile.cz", name: "Admin Fragile", role: "ADMIN" as const },
    { email: "planner@fragile.cz", name: "Media plánovač", role: "PLANNER" as const },
    { email: "account@fragile.cz", name: "Account", role: "ACCOUNT" as const },
    { email: "klient@benu.cz", name: "Klient BENU", role: "CLIENT" as const },
    { email: "cteni@benu.cz", name: "Čtenář", role: "VIEWER" as const },
  ];
  for (const p of people) {
    await db
      .insert(s.users)
      .values(p)
      .onConflictDoUpdate({ target: s.users.email, set: { role: p.role, active: true } });
  }
  const [client] = await db.select().from(s.users).where(eq(s.users.email, "klient@benu.cz"));

  // Ukázkový grant — přesně scénář ze zadání §5.2:
  // klient BENU vyplňuje skutečné čerpání JEN u Paid, ve všech kampaních a měsících.
  await db.insert(s.grants).values([
    {
      userId: client.id,
      area: "actuals",
      level: "write",
      mediaType: "Paid",
      campaignId: null,
      month: null,
      note: "Klient doplňuje čerpání Paid",
    },
    // a smí číst plán, aby viděl, proti čemu se plní
    { userId: client.id, area: "plan", level: "read", mediaType: null, campaignId: null, month: null },
  ]);

  console.log(`Uživatelé: ${people.length} (klient má grant jen na Paid)`);
  console.log("\nHotovo. Spusťte `npm run dev` a přihlaste se testovacím účtem.");
  await conn.end();
}

import { eq } from "drizzle-orm";

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
