/**
 * Naplní databázi:
 *   • klient BENU
 *   • cílové skupiny a jejich universa (veřejné odhady — patří opravit)
 *   • křivky zásahu a duplikace mezi nosiči (modelové — patří zkalibrovat)
 *   • plán Q4 2026 z BENU_media_flowchart_Q4_2026_v2_1.xlsx
 *   • plán Rok 2027 — struktura zkopírovaná z Q4 2026, čísla prázdná,
 *     plus ukázkový cross-mediální blok, aby šlo hned vidět, jak počítá
 *   • testovací účty a ukázkový grant
 *
 *   npm run db:seed
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as s from "../src/db/schema";
import data from "./seed-data.json";
import { derive } from "../src/lib/crossmedia";

const MONTHS_2026 = ["2026-10", "2026-11", "2026-12"] as const;
const MONTHS_2027 = Array.from({ length: 12 }, (_, i) => `2027-${String(i + 1).padStart(2, "0")}`);

type SeedRow = { msgId: string; type: string; channel: string; oct: number; nov: number; dec: number; kpi: string };
type SeedMsg = { id: string; campaign: string; message: string; phase: string; audience: string };

/**
 * Nosič se z názvu kanálu nepozná sám — DOOH je OOH, i když se nakupuje
 * programaticky. Mapování je explicitní, ať je vidět, co se čím stalo.
 */
function channelTypeOf(channel: string, mediaType: string): s.ChannelType {
  const c = channel.toLowerCase();
  if (c.includes("dooh") || c.includes("ooh")) return "OOH";
  if (c.includes("tv") && !c.includes("ctv")) return "TV";
  if (c.includes("rádio") || c.includes("radio")) return "Rádio";
  if (c.includes("print") || c.includes("magazín")) return "Print";
  if (c.includes("kino")) return "Kino";
  if (mediaType === "Earned") return "PR";
  if (mediaType === "Owned") return "Vlastní";
  return "Digital";
}

/** Orientační CPT, aby plán uměl spočítat impressions hned po naplnění. */
const CPT_DEFAULT: Record<s.ChannelType, number> = {
  TV: 0, Rádio: 0, // obchoduje se na CPP, viz níže
  OOH: 95, Print: 180, Kino: 260, Digital: 155, Vlastní: 25, PR: 40,
};
const CPP_DEFAULT: Record<string, number> = { TV: 31_000, Rádio: 4_200 };
const unitPriceOf = (ct: s.ChannelType) => CPP_DEFAULT[ct] ?? CPT_DEFAULT[ct] ?? 0;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("Chybí DATABASE_URL. Zkopírujte .env.example do .env a doplňte připojení k databázi.");
    process.exit(1);
  }
  const conn = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(conn, { schema: s });

  console.log("Mažu stará data…");
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
  await db.delete(s.duplications);
  await db.delete(s.reachCurves);
  await db.delete(s.plans);
  await db.delete(s.targetGroups);
  await db.delete(s.clients);

  // ------------------------------------------------------------------ klient
  const [benu] = await db.insert(s.clients).values({ name: "BENU", slug: "benu" }).returning();

  // ---------------------------------------------------------- cílové skupiny
  // Universa jsou veřejné odhady podle věkové struktury ČR, zaokrouhlené.
  // NEJSOU to panelová data — před prvním reálným plánem je opravte podle
  // zdroje, který používáte (Nielsen Admosphere, SKMO).
  const SRC = "Odhad z veřejné demografie ČSÚ — nahradit panelovým zdrojem";
  const tgRows = await db.insert(s.targetGroups).values([
    { clientId: benu.id, name: "Ženy 25–54", universe: 2_050_000, source: SRC, position: 0,
      note: "Primární skupina lékárenské kategorie" },
    { clientId: benu.id, name: "Ženy 18+", universe: 4_600_000, source: SRC, position: 1 },
    { clientId: benu.id, name: "Dospělí 25–64", universe: 5_900_000, source: SRC, position: 2 },
    { clientId: benu.id, name: "Dospělí 18+", universe: 8_900_000, source: SRC, position: 3 },
    { clientId: benu.id, name: "Rodiče dětí do 12 let", universe: 1_250_000, source: SRC, position: 4 },
    { clientId: benu.id, name: "Senioři 60+", universe: 2_800_000, source: SRC, position: 5 },
  ]).returning();
  const tgPrimary = tgRows[0];

  // ------------------------------------------------- křivky zásahu a duplikace
  const CURVE_SRC = "Modelový odhad — zkalibrovat na panelová data";
  await db.insert(s.reachCurves).values(
    (Object.keys(s.channelTypeEnum.enumValues.reduce((a, k) => ({ ...a, [k]: 1 }), {})) as s.ChannelType[])
      .map((ct) => ({
        channelType: ct,
        targetGroupId: null,
        rMax: DEFAULT_CURVES[ct].rMax,
        k: DEFAULT_CURVES[ct].k,
        source: CURVE_SRC,
      })),
  );
  await db.insert(s.duplications).values(
    Object.entries(DEFAULT_DUPS).map(([key, coef]) => {
      const [typeA, typeB] = key.split("|") as [s.ChannelType, s.ChannelType];
      return { typeA, typeB, coef, source: CURVE_SRC };
    }),
  );
  console.log(`Cílové skupiny: ${tgRows.length}, křivky a duplikace nastaveny`);

  // ------------------------------------------------------------ plán Q4 2026
  const [plan2026] = await db.insert(s.plans).values({
    clientId: benu.id,
    name: "Q4 2026",
    periodStart: "2026-10",
    periodEnd: "2026-12",
    status: "live",
    targetGroupId: tgPrimary.id,
    position: 0,
  }).returning();

  const rows = data.rows as SeedRow[];
  const msgs = data.messages as SeedMsg[];

  const campaignNames = [...new Set(msgs.map((m) => m.campaign))];
  const campaignRows = await db
    .insert(s.campaigns)
    .values(campaignNames.map((name, i) => ({ name, planId: plan2026.id, position: i })))
    .returning();
  const campaignId = Object.fromEntries(campaignRows.map((c) => [c.name, c.id]));

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
    const mediaType = r.type as "Paid" | "Owned" | "Earned";
    const channelType = channelTypeOf(r.channel, mediaType);
    const [t] = await db
      .insert(s.tactics)
      .values({
        messageLineId: lineId[r.msgId],
        channel: r.channel,
        mediaType,
        channelType,
        targetGroupId: null, // = cílová skupina plánu
        position: position++,
        note: r.kpi || null,
      })
      .returning();

    const amounts = [r.oct, r.nov, r.dec];
    const price = unitPriceOf(channelType);
    await db.insert(s.tacticBudgets).values(
      MONTHS_2026.map((month, i) => {
        const planned = Math.round(amounts[i] || 0);
        return { tacticId: t.id, month, planned, driver: "budget" as const, driverValue: planned, unitPrice: price };
      }),
    );

    await db.insert(s.metrics).values(
      (msg.phase === "Awareness" ? BRAND : PERF).map((m, slot) => ({ tacticId: t.id, ...m, slot })),
    );
  }
  const total = rows.reduce((sum, r) => sum + r.oct + r.nov + r.dec, 0);
  console.log(`Plán Q4 2026: ${campaignNames.length} bloků, ${rows.length} taktik, ${Math.round(total).toLocaleString("cs-CZ")} Kč`);

  // ------------------------------------------------------------- plán 2027
  const [plan2027] = await db.insert(s.plans).values({
    clientId: benu.id,
    name: "Rok 2027",
    periodStart: "2027-01",
    periodEnd: "2027-12",
    status: "draft",
    targetGroupId: tgPrimary.id,
    position: 1,
  }).returning();

  // struktura z Q4 2026, čísla prázdná — nový rok nesmí vyjít z loňských částek
  let copied = 0;
  for (const c of campaignRows) {
    const [nc] = await db.insert(s.campaigns)
      .values({ planId: plan2027.id, name: c.name, position: c.position }).returning();
    const srcLines = lineRows.filter((l) => l.campaignId === c.id);
    for (const l of srcLines) {
      const [nl] = await db.insert(s.messageLines).values({
        campaignId: nc.id, code: l.code, message: l.message, phase: l.phase, audience: l.audience,
      }).returning();
      const srcTactics = await db.select().from(s.tactics).where(eq(s.tactics.messageLineId, l.id));
      for (const t of srcTactics) {
        const [nt] = await db.insert(s.tactics).values({
          messageLineId: nl.id, channel: t.channel, mediaType: t.mediaType,
          channelType: t.channelType, targetGroupId: t.targetGroupId,
          position: t.position, note: t.note,
        }).returning();
        // ceník se přenáší, objemy ne
        const price = unitPriceOf(t.channelType);
        await db.insert(s.tacticBudgets).values(
          MONTHS_2027.map((month) => ({
            tacticId: nt.id, month, planned: 0,
            driver: "budget" as const, driverValue: 0, unitPrice: price,
          })),
        );
        copied++;
      }
    }
  }

  // ukázkový cross-mediální blok — ať je hned vidět, jak se offline počítá
  const [ukazka] = await db.insert(s.campaigns)
    .values({ planId: plan2027.id, name: "UKÁZKA cross-media (smazat)", position: 99 }).returning();
  const [ukazkaLine] = await db.insert(s.messageLines).values({
    campaignId: ukazka.id, code: "UKAZKA-1",
    message: "Ukázka přepočtů offline i online — čísla jsou smyšlená",
    phase: "Awareness", audience: "Ženy 25–54",
  }).returning();

  const demo: Array<{ channel: string; ct: s.ChannelType; driver: "grp" | "budget"; q1: number }> = [
    { channel: "TV spot 30\"", ct: "TV", driver: "grp", q1: 180 },
    { channel: "Rádio — celoplošné", ct: "Rádio", driver: "grp", q1: 120 },
    { channel: "OOH — CLV", ct: "OOH", driver: "budget", q1: 1_800_000 },
    { channel: "Online video", ct: "Digital", driver: "budget", q1: 1_200_000 },
  ];
  for (const [i, d] of demo.entries()) {
    const [t] = await db.insert(s.tactics).values({
      messageLineId: ukazkaLine.id, channel: d.channel, mediaType: "Paid",
      channelType: d.ct, position: i,
    }).returning();
    const price = unitPriceOf(d.ct);
    const planned = Math.round(
      derive({
        channelType: d.ct, driver: d.driver, driverValue: d.q1,
        unitPrice: price, universe: tgPrimary.universe,
      }).budget,
    );
    await db.insert(s.tacticBudgets).values(
      ["2027-01", "2027-02", "2027-03"].map((month) => ({
        tacticId: t.id, month, planned, driver: d.driver, driverValue: d.q1, unitPrice: price,
      })),
    );
  }
  console.log(`Plán Rok 2027: zkopírováno ${copied} taktik bez čísel + ukázkový cross-mediální blok`);

  // ------------------------------------------------------------- uživatelé
  const people = [
    { email: "admin@fragile.cz", name: "Admin Fragile", role: "ADMIN" as const },
    { email: "planner@fragile.cz", name: "Media plánovač", role: "PLANNER" as const },
    { email: "account@fragile.cz", name: "Account", role: "ACCOUNT" as const },
    { email: "klient@benu.cz", name: "Klient BENU", role: "CLIENT" as const },
    { email: "cteni@benu.cz", name: "Čtenář", role: "VIEWER" as const },
  ];
  for (const p of people) {
    await db.insert(s.users).values(p)
      .onConflictDoUpdate({ target: s.users.email, set: { role: p.role, active: true } });
  }
  const [client] = await db.select().from(s.users).where(eq(s.users.email, "klient@benu.cz"));

  // Grant je nově vázaný na KONKRÉTNÍ plán — klient nevidí do roku 2027,
  // dokud mu ho někdo vědomě nepustí.
  await db.insert(s.grants).values([
    {
      userId: client.id, area: "actuals", level: "write", mediaType: "Paid",
      planId: plan2026.id, campaignId: null, month: null,
      note: "Klient doplňuje čerpání Paid — jen plán Q4 2026",
    },
    {
      userId: client.id, area: "plan", level: "read", mediaType: null,
      planId: plan2026.id, campaignId: null, month: null,
    },
  ]);

  console.log(`Uživatelé: ${people.length} (klient má grant jen na Paid v Q4 2026)`);
  console.log("\nHotovo. Spusťte `npm run dev` a přihlaste se testovacím účtem.");
  await conn.end();
}

// hodnoty držíme tady, aby seed nezávisel na importu z app kódu
const DEFAULT_CURVES: Record<s.ChannelType, { rMax: number; k: number }> = {
  TV: { rMax: 0.92, k: 1.05 },
  Rádio: { rMax: 0.68, k: 0.8 },
  OOH: { rMax: 0.85, k: 1.3 },
  Print: { rMax: 0.45, k: 0.7 },
  Kino: { rMax: 0.22, k: 0.55 },
  Digital: { rMax: 0.78, k: 0.95 },
  Vlastní: { rMax: 0.35, k: 0.6 },
  PR: { rMax: 0.3, k: 0.5 },
};

const DEFAULT_DUPS: Record<string, number> = {
  "TV|TV": 1.7, "Digital|Digital": 1.55, "OOH|OOH": 1.5, "Rádio|Rádio": 1.65,
  "Print|Print": 1.4, "Kino|Kino": 1.3, "Vlastní|Vlastní": 1.6, "PR|PR": 1.4,
  "Digital|TV": 1.25, "OOH|TV": 1.15, "Rádio|TV": 1.3, "Print|TV": 1.2, "Kino|TV": 1.05,
  "Digital|OOH": 1.12, "Digital|Rádio": 1.15, "Digital|Print": 1.1, "Digital|Kino": 1.05,
  "OOH|Rádio": 1.18, "OOH|Print": 1.08, "Kino|OOH": 1.05,
  "Print|Rádio": 1.1, "Kino|Rádio": 1.05, "Kino|Print": 1.05,
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
