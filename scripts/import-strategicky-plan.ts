/**
 * Import strategického plánu z Excelu (týdenní flowchart BENU, list „2027plan").
 *
 *   DATABASE_URL=… npx tsx scripts/import-strategicky-plan.ts "<cesta k .xlsx>" [--nahradit]
 *
 * Data klienta se do repozitáře NIKDY neukládají — skript čte soubor z disku
 * a zapisuje rovnou do databáze. Pouštět proti lokální databázi; do produkce
 * až po schválení, protože jde o reálná klientská čísla.
 *
 * Jak se soubor čte:
 *  - Měsíce jsou sloučené buňky v řádku s hlavičkou („Jan", „Feb", … „Dec II",
 *    „Jan 2028"). Hodnota patří měsíci, pod jehož blokem leží — i když je
 *    zapsaná jen do prvního sloupce bloku. „Dec II" se přičítá k prosinci.
 *  - Řádky se hledají podle textu ve sloupci B, ne podle čísel řádků, aby
 *    import přežil další verzi souboru s vloženým řádkem.
 *  - Bere se „Total Client cost including fee" — aplikace všude pracuje
 *    s částkami včetně fee.
 *  - TV se zakládá na TRP (campaign TG), ne na nákupních GRP: zásah se počítá
 *    v cílové skupině kampaně.
 */
import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as XLSX from "xlsx";
import * as s from "../src/db/schema";

type Month = string;
type Series = Record<Month, number>;

const file = process.argv[2];
const replace = process.argv.includes("--nahradit");
if (!file) {
  console.error('Použití: npx tsx scripts/import-strategicky-plan.ts "<soubor.xlsx>" [--nahradit]');
  process.exit(1);
}

const PLAN_NAME = "Strategický plán 2027";
const TG_NAME = "Ženy 25–54"; // PŘEDPOKLAD — Excel cílovou skupinu TRP neuvádí

// ------------------------------------------------------------- čtení listu

const wb = XLSX.readFile(file);
const ws = wb.Sheets[wb.SheetNames[0]];
const merges = ws["!merges"] ?? [];
const MONTHS: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

/** Najde řádek s hlavičkou měsíců a z jeho sloučených buněk sestaví sloupec → měsíc. */
function monthColumns(): Map<number, Month> {
  const map = new Map<number, Month>();
  for (let r = 0; r < 20; r++) {
    const heads = merges.filter((m) => m.s.r === r && m.s.c >= 5);
    const labels = heads.map((m) => String(ws[XLSX.utils.encode_cell(m.s)]?.v ?? "").trim());
    if (!labels.includes("Feb") || !labels.includes("Mar")) continue;
    // rok plánu = rok uvedený u přesahu do dalšího roku mínus jedna, jinak 2027
    const next = labels.find((l) => /^Jan \d{4}$/.test(l));
    const year = next ? Number(next.slice(4)) - 1 : 2027;
    heads.forEach((m, i) => {
      const l = labels[i];
      let y = year, mo: number | undefined;
      if (/^Jan \d{4}$/.test(l)) { y = Number(l.slice(4)); mo = 1; }
      else mo = MONTHS[l.slice(0, 3)]; // „Dec II" → prosinec
      if (!mo) return;
      for (let c = m.s.c; c <= m.e.c; c++) map.set(c, `${y}-${String(mo).padStart(2, "0")}`);
    });
    return map;
  }
  throw new Error("Nenašel jsem řádek s hlavičkou měsíců.");
}

const COLS = monthColumns();
const lastRow = XLSX.utils.decode_range(ws["!ref"]!).e.r;
const label = (r: number) => String(ws[XLSX.utils.encode_cell({ r, c: 1 })]?.v ?? "").trim();

function series(r: number): Series {
  const out: Series = {};
  for (const [c, m] of COLS) {
    const v = ws[XLSX.utils.encode_cell({ r, c })]?.v;
    if (typeof v === "number" && v) out[m] = (out[m] ?? 0) + v;
  }
  return out;
}
const sum = (x: Series) => Object.values(x).reduce((a, b) => a + b, 0);

function rowOf(text: string, from = 0): number {
  for (let r = from; r <= lastRow; r++) if (label(r).toLowerCase().startsWith(text.toLowerCase())) return r;
  throw new Error(`Řádek „${text}" nenalezen.`);
}
/** První nenulový řádek s daným popiskem pod nadpisem sekce (do 12 řádků). */
function within(section: string, text: string): Series {
  const start = rowOf(section);
  for (let r = start; r <= Math.min(lastRow, start + 12); r++) {
    if (label(r).toLowerCase().startsWith(text.toLowerCase())) {
      const s = series(r);
      if (sum(s)) return s;
    }
  }
  return {};
}

// ------------------------------------------------------------ co importovat

type Tactic = {
  block: string;
  phase: "Awareness" | "Consideration" | "Conversion";
  channel: string;
  channelType: s.ChannelType;
  cost: Series;
  /** doručení: TRP u TV, impressions u online; bez něj se zásah nepočítá */
  delivery?: { unit: "grp" | "impressions"; values: Series };
};

const T: Tactic[] = [];
const add = (t: Tactic) => { if (sum(t.cost) > 0) T.push(t); };

// TV — produkty a brand
for (const [section, block, phase, channel] of [
  ["produktové spoty - 3 produkty", "TV – produkty", "Consideration", 'TV spot 25" – 3 produkty'],
  ["produktové spoty - 4 produkty", "TV – produkty", "Consideration", 'TV spot 30" – 4 produkty'],
  ["ESHOP spoty", "TV – e-shop", "Conversion", 'TV spot 25" – e-shop'],
  ["Brand - hlavní spot", "Brand", "Awareness", "TV – hlavní brandový spot"],
  ['Brand -10" spot', "Brand", "Awareness", 'TV – brandový spot 10"'],
] as const) {
  add({
    block, phase, channel, channelType: "TV",
    cost: within(section, "Total Client cost"),
    delivery: { unit: "grp", values: within(section, "Total TRPs") },
  });
}
add({ block: "Brand", phase: "Awareness", channel: "TV – OMK MC", channelType: "TV", cost: within("Brand OMK MC", "Total Client cost") });
add({ block: "Brand", phase: "Awareness", channel: "TV – sponzoring pořadu o zdraví", channelType: "TV", cost: within("TV pořad sponzoring", "Total Client cost") });

// Rádio — jen náklady, GRP v plánu nejsou
add({ block: "Brand", phase: "Awareness", channel: 'Rádio – Radiohouse 30"', channelType: "Rádio", cost: series(rowOf("Radiohouse Total Client cost")) });
add({ block: "Brand", phase: "Awareness", channel: 'Rádio – ČRo Radiožurnál a Dvojka 20"', channelType: "Rádio", cost: series(rowOf("Čro Total client cost")) });

// Partnerství / event / OOH
add({ block: "Brand", phase: "Awareness", channel: "Partnerství / event / OOH (bude upřesněno)", channelType: "OOH", cost: within("Partnerství/Event/OOH", "Total Client cost") });

// Online — celkové imprese bez rozpadu na platformy a řady
add({
  block: "Online – brand, longevity, produkty", phase: "Awareness", channel: "Online (video, social, display, audio)", channelType: "Digital",
  cost: series(rowOf("Online Total Client cost")),
  delivery: { unit: "impressions", values: series(rowOf("Total Imprese")) },
});

// Podcast Mudrování a SEA
{
  const start = rowOf("Mudrování"); // ve sloupci B je jen „Mudrování", „kreativy" je v C
  let cost: Series = {};
  for (let r = start; r < start + 6; r++) if (label(r).startsWith("Total Client cost")) {
    const s = series(r); if (sum(s)) cost = s;
  }
  add({ block: "Brand", phase: "Awareness", channel: "Podcast Mudrování a články", channelType: "Digital", cost });
}
add({ block: "Prevence & V rovnováze", phase: "Conversion", channel: "SEA – V rovnováze", channelType: "Digital", cost: within("SEA - V ronováze", "Total Client cost") });

// Social media — každý řádek je taktika; blok podle produktové řady v názvu
const SOME_BLOCK: Array<[RegExp, string, Tactic["phase"]]> = [
  [/dermokatalog|vánoční/i, "Dermokatalog & Vánoční katalog", "Consideration"],
  [/solero/i, "Solero", "Consideration"],
  [/skineffect/i, "Skineffect", "Consideration"],
  [/probio/i, "Probio", "Consideration"],
  [/prevence & v rovnováze/i, "Prevence & V rovnováze", "Consideration"],
  [/melanom/i, "Prevence & V rovnováze", "Consideration"],
  [/longevity/i, "Longevity", "Awareness"],
  [/authea/i, "Authea", "Consideration"],
  [/optamins/i, "Optamins", "Consideration"],
];
{
  const start = rowOf("Social Media - Fragile");
  const end = rowOf("Total SOME", start);
  for (let r = start + 1; r < end; r++) {
    const name = label(r);
    const cost = series(r);
    if (!name || !sum(cost)) continue;
    const hit = SOME_BLOCK.find(([re]) => re.test(name));
    add({
      block: hit?.[1] ?? "Social media – always-on",
      phase: hit?.[2] ?? "Awareness",
      channel: name.replace(/\s+/g, " ").slice(0, 110),
      channelType: "Digital",
      cost,
    });
  }
}

// ------------------------------------------------------ tematické oblasti
//
// Rozřazení schválil zadavatel (říjen 2026). Smíšené položky se zatím dělí
// rovnoměrně — poměry se pak doladí v aplikaci, sloupec Oblast.

const THEMES = ["Brand", "Longevity", "Probiotika", "Dermo", "Prevence & V rovnováze", "Katalogy a akce", "Privátní značky"];
const PRODUCTS = ["Longevity", "Probiotika", "Dermo", "Prevence & V rovnováze"];
const evenly = (names: string[]) => Object.fromEntries(names.map((n) => [n, 1 / names.length]));

function themesOf(t: Tactic): Record<string, number> {
  if (t.block === "TV – produkty") return evenly(PRODUCTS);             // spot se 4 produkty
  if (t.block.startsWith("Online")) return evenly(["Brand", ...PRODUCTS]); // brand / longevity / produkty
  const byBlock: Record<string, string> = {
    "Brand": "Brand",
    "TV – e-shop": "Brand",
    "Social media – always-on": "Brand",
    "Longevity": "Longevity",
    "Probio": "Probiotika",
    "Skineffect": "Dermo",
    "Authea": "Dermo",
    "Prevence & V rovnováze": "Prevence & V rovnováze",
    "Dermokatalog & Vánoční katalog": "Katalogy a akce",
    "Solero": "Privátní značky",
    "Optamins": "Privátní značky",
  };
  const name = byBlock[t.block];
  if (!name) throw new Error(`Blok „${t.block}" nemá přiřazenou oblast — doplňte ho do themesOf().`);
  return { [name]: 1 };
}

// ------------------------------------------------------------ kontrola součtů

const months = [...new Set(COLS.values())].sort();
const periodMonths = months.filter((m) => T.some((t) => t.cost[m]));
const periodStart = periodMonths[0];
const periodEnd = periodMonths[periodMonths.length - 1];
const imported = T.reduce((a, t) => a + sum(t.cost), 0);
const grand = sum(series(rowOf("Total Client cost", rowOf("TV + radio + online + Stezka + Mudrování+SoMe"))));

T.forEach(themesOf); // neznámý blok shodí import dřív, než se cokoli zapíše
console.log(`Období v datech: ${periodStart} – ${periodEnd} (${periodMonths.length} měsíců)`);
const empty = months.filter((m) => !periodMonths.includes(m));
if (empty.length) console.log(`Měsíce bez jediné hodnoty: ${empty.join(", ")}`);
console.log(`Taktik: ${T.length}, náklady celkem ${Math.round(imported).toLocaleString("cs-CZ")} Kč`);
console.log(`Součet v Excelu („Total total"): ${Math.round(grand).toLocaleString("cs-CZ")} Kč, rozdíl ${Math.round(imported - grand).toLocaleString("cs-CZ")} Kč`);

// ------------------------------------------------------------------- zápis

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Chybí DATABASE_URL.");
  const conn = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(conn, { schema: s });

  let [client] = await db.select().from(s.clients).where(eq(s.clients.slug, "benu"));
  if (!client) [client] = await db.insert(s.clients).values({ name: "BENU", slug: "benu" }).returning();

  let [tg] = await db.select().from(s.targetGroups).where(eq(s.targetGroups.name, TG_NAME));
  if (!tg) {
    [tg] = await db.insert(s.targetGroups).values({
      clientId: client.id, name: TG_NAME, universe: 2_050_000,
      source: "Předpoklad — ověřit proti cílové skupině TRP z nákupu TV",
    }).returning();
  }

  // oblasti klienta — existující se nepřepisují, chybějící se doplní.
  // Dřív než se smaže starý plán: když tohle selže, plán zůstane, jak byl.
  const themeIds: Record<string, string> = {};
  for (const [i, name] of THEMES.entries()) {
    let [th] = await db.select().from(s.themes).where(and(eq(s.themes.clientId, client.id), eq(s.themes.name, name)));
    if (!th) [th] = await db.insert(s.themes).values({ clientId: client.id, name, position: i }).returning();
    themeIds[name] = th.id;
  }

  const [existing] = await db.select().from(s.plans)
    .where(and(eq(s.plans.clientId, client.id), eq(s.plans.name, PLAN_NAME)));
  if (existing && !replace) throw new Error(`Plán „${PLAN_NAME}" už existuje — pusťte s --nahradit.`);
  if (existing) await db.delete(s.plans).where(eq(s.plans.id, existing.id));

  const [plan] = await db.insert(s.plans).values({
    clientId: client.id, name: PLAN_NAME, periodStart, periodEnd,
    status: "draft", targetGroupId: tg.id, position: 10,
  }).returning();

  const blocks = [...new Set(T.map((t) => t.block))];
  let pos = 0;
  for (const [bi, block] of blocks.entries()) {
    const [camp] = await db.insert(s.campaigns).values({ planId: plan.id, name: block, position: bi }).returning();
    const mine = T.filter((t) => t.block === block);
    const code = block.toUpperCase().normalize("NFD").replace(/[^A-Z0-9]+/g, "").slice(0, 10) || "BLOK";
    const [line] = await db.insert(s.messageLines).values({
      campaignId: camp.id, code: `${code}-1`, message: block, phase: mine[0].phase, audience: TG_NAME,
    }).returning();

    for (const t of mine) {
      const [tac] = await db.insert(s.tactics).values({
        messageLineId: line.id, channel: t.channel, mediaType: "Paid", channelType: t.channelType, position: pos++,
      }).returning();

      await db.insert(s.tacticBudgets).values(periodMonths.map((m) => {
        const cost = t.cost[m] ?? 0;
        const del = t.delivery?.values[m] ?? 0;
        if (t.delivery && del > 0) {
          // Kč se ukládá vždy (invariant 3); jednotková cena se dopočte z nákladu a doručení
          const unitPrice = t.delivery.unit === "grp" ? cost / del : (cost / del) * 1000;
          return { tacticId: tac.id, month: m, planned: Math.round(cost), driver: t.delivery.unit, driverValue: del, unitPrice };
        }
        return { tacticId: tac.id, month: m, planned: Math.round(cost), driver: "budget" as const, driverValue: cost, unitPrice: 0 };
      }));

      await db.insert(s.tacticThemes).values(
        Object.entries(themesOf(t)).map(([name, share]) => ({ tacticId: tac.id, themeId: themeIds[name], share })),
      );

      const brand = t.phase === "Awareness";
      await db.insert(s.metrics).values([
        { tacticId: tac.id, name: brand ? "Reach" : "Konverze", kind: "cumulative" as const, unit: "", slot: 0 },
        { tacticId: tac.id, name: brand ? "CPM" : "CPA", kind: "rate_low" as const, unit: "Kč", slot: 1 },
      ]);
    }
  }
  console.log(`Založen plán „${PLAN_NAME}" (${blocks.length} bloků).`);
  await conn.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
