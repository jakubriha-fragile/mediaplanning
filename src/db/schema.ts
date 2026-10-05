/**
 * Datový model podle technického zadání §3 (Drizzle ORM, PostgreSQL).
 *
 * Rozdělení na plán / skutečnost / podklady není kosmetické — je to hranice
 * oprávnění (§5). Kdo smí měnit plán, nemusí smět měnit skutečnost a naopak.
 */
import {
  pgTable, text, integer, doublePrecision, boolean, timestamp,
  primaryKey, uniqueIndex, index, pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createId } from "@/lib/id";

// ---------------------------------------------------------------- číselníky

export const mediaTypeEnum = pgEnum("media_type", ["Paid", "Owned", "Earned"]);

/** Nosič, ne způsob financování. Paid/Owned/Earned je na to kolmé:
 *  TV je skoro vždy Paid, Digital může být Paid i Owned. */
export const channelTypeEnum = pgEnum("channel_type", [
  "TV", "Rádio", "OOH", "Print", "Kino", "Digital", "Vlastní", "PR",
]);

/** Čím je taktika v daném měsíci řízená. Ostatní tři hodnoty se dopočítají —
 *  to je celá pointa: plánovač zadá jedno číslo, ne čtyři, které musí sedět. */
export const planUnitEnum = pgEnum("plan_unit", ["budget", "grp", "impressions"]);

export const planStatusEnum = pgEnum("plan_status", ["draft", "approved", "live", "closed"]);
export const phaseEnum = pgEnum("phase", ["Awareness", "Consideration", "Conversion"]);

/** cumulative = načítá se v čase (rozpočet, reach) → pacing vůči uplynulému času
 *  rate_low   = poměrový, nižší je lepší (CPM, CPA)  → porovnání přímo s plánem
 *  rate_high  = poměrový, vyšší je lepší (CTR, ROAS) → porovnání přímo s plánem */
export const metricKindEnum = pgEnum("metric_kind", ["cumulative", "rate_low", "rate_high"]);
export const roleEnum = pgEnum("role", ["ADMIN", "PLANNER", "ACCOUNT", "CLIENT", "VIEWER"]);
export const areaEnum = pgEnum("area", ["plan", "actuals", "assets"]);
export const levelEnum = pgEnum("level", ["read", "write"]);

export type MediaType = (typeof mediaTypeEnum.enumValues)[number];
export type ChannelType = (typeof channelTypeEnum.enumValues)[number];
export type PlanUnit = (typeof planUnitEnum.enumValues)[number];
export type PlanStatus = (typeof planStatusEnum.enumValues)[number];
export type Role = (typeof roleEnum.enumValues)[number];
export type Area = (typeof areaEnum.enumValues)[number];
export type Level = (typeof levelEnum.enumValues)[number];
export type MetricKind = (typeof metricKindEnum.enumValues)[number];

// ---------------------------------------------------------------- uživatelé

export const users = pgTable("user", {
  id: text("id").primaryKey().$defaultFn(createId),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  image: text("image"),
  role: roleEnum("role").notNull().default("VIEWER"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Auth.js tabulky.
// Aktuálně se nepoužívají — session drží JWT a uživatele zakládá signIn callback.
// Necháváme je ve schématu pro případ přechodu na databázové session.
export const accounts = pgTable(
  "account",
  {
    userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => ({ pk: primaryKey({ columns: [t.provider, t.providerAccountId] }) }),
);

export const sessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.identifier, t.token] }) }),
);

// ---------------------------------------------------------------- klient a plán

export const clients = pgTable("client", {
  id: text("id").primaryKey().$defaultFn(createId),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * Mediaplán je období nad klientem — kvartál, rok, kampaňové okno.
 * Měsíce se z období odvozují, nikde nejsou zadrátované.
 */
export const plans = pgTable(
  "plan",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    clientId: text("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    periodStart: text("period_start").notNull(), // "2027-01"
    periodEnd: text("period_end").notNull(),     // "2027-12"
    status: planStatusEnum("status").notNull().default("draft"),
    currency: text("currency").notNull().default("CZK"),
    /** Výchozí cílová skupina plánu — taktika ji může přebít vlastní. */
    targetGroupId: text("target_group_id"),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({ uq: uniqueIndex("plan_uq").on(t.clientId, t.name) }),
);

/**
 * Cílová skupina a její velikost. Universum je ta hodnota, která drží celé
 * cross-mediální plánování: bez něj nejde GRP převést na impressions ani zpět,
 * a zásah se nedá spočítat vůbec.
 */
export const targetGroups = pgTable(
  "target_group",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    clientId: text("client_id").references(() => clients.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    universe: integer("universe").notNull().default(0), // počet osob
    source: text("source").notNull().default(""),
    note: text("note").notNull().default(""),
    position: integer("position").notNull().default(0),
  },
  (t) => ({ uq: uniqueIndex("target_group_uq").on(t.name, t.clientId) }),
);

/**
 * Křivka zásahu média: kolik čistého zásahu přinese daný objem GRP.
 *     zásah % = rMax × (1 − e^(−k · GRP/100))
 * rMax je strop daného média na dané cílové skupině, k rychlost nasycení.
 * Hodnoty jsou modelové — patří zkalibrovat na panelová data.
 */
export const reachCurves = pgTable(
  "reach_curve",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    channelType: channelTypeEnum("channel_type").notNull(),
    targetGroupId: text("target_group_id").references(() => targetGroups.id, { onDelete: "cascade" }),
    rMax: doublePrecision("r_max").notNull().default(0.8),
    k: doublePrecision("k").notNull().default(0.9),
    source: text("source").notNull().default(""),
  },
  (t) => ({ uq: uniqueIndex("reach_curve_uq").on(t.channelType, t.targetGroupId) }),
);

/**
 * Duplikace nad rámec nezávislosti pro dvojici médií. 1,0 = publika se
 * překrývají přesně tak, jak by odpovídalo náhodě (Sainsbury). Vyšší hodnota
 * znamená větší reálný překryv, a tedy nižší čistý zásah.
 */
export const duplications = pgTable(
  "duplication",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    typeA: channelTypeEnum("type_a").notNull(),
    typeB: channelTypeEnum("type_b").notNull(),
    coef: doublePrecision("coef").notNull().default(1),
    source: text("source").notNull().default(""),
  },
  (t) => ({ uq: uniqueIndex("duplication_uq").on(t.typeA, t.typeB) }),
);

export const campaigns = pgTable(
  "campaign",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    planId: text("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    archived: boolean("archived").notNull().default(false),
  },
  (t) => ({ uq: uniqueIndex("campaign_uq").on(t.name, t.planId) }),
);

export const messageLines = pgTable(
  "message_line",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    message: text("message").notNull(),
    phase: phaseEnum("phase").notNull(),
    audience: text("audience").notNull(),
  },
  (t) => ({ uq: uniqueIndex("message_line_uq").on(t.code, t.campaignId) }),
);

export const tactics = pgTable(
  "tactic",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    messageLineId: text("message_line_id").notNull().references(() => messageLines.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    mediaType: mediaTypeEnum("media_type").notNull(),
    channelType: channelTypeEnum("channel_type").notNull().default("Digital"),
    /** NULL = použije se cílová skupina plánu. */
    targetGroupId: text("target_group_id").references(() => targetGroups.id, { onDelete: "set null" }),
    position: integer("position").notNull().default(0),
    note: text("note"),
  },
  (t) => ({ idx: index("tactic_line_idx").on(t.messageLineId) }),
);

export const tacticBudgets = pgTable(
  "tactic_budget",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tacticId: text("tactic_id").notNull().references(() => tactics.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    /** Rozpočet v Kč. U GRP i impressions driveru se dopočítá při zápisu,
     *  aby všechny součty a porovnání se skutečností zůstaly na jednom poli. */
    planned: integer("planned").notNull().default(0),
    driver: planUnitEnum("driver").notNull().default("budget"),
    /** Hodnota v jednotce driveru — Kč, GRP, nebo impressions. */
    driverValue: doublePrecision("driver_value").notNull().default(0),
    /** CPP (Kč/GRP) u TV a rádia, jinak CPT (Kč/1000 impressions). */
    unitPrice: doublePrecision("unit_price").notNull().default(0),
  },
  (t) => ({ uq: uniqueIndex("tactic_budget_uq").on(t.tacticId, t.month) }),
);

export const metrics = pgTable(
  "metric",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tacticId: text("tactic_id").notNull().references(() => tactics.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: metricKindEnum("kind").notNull().default("cumulative"),
    unit: text("unit").notNull().default(""),
    slot: integer("slot").notNull().default(0),
  },
  (t) => ({ uq: uniqueIndex("metric_uq").on(t.tacticId, t.slot) }),
);

export const metricTargets = pgTable(
  "metric_target",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    metricId: text("metric_id").notNull().references(() => metrics.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    target: doublePrecision("target").notNull().default(0),
  },
  (t) => ({ uq: uniqueIndex("metric_target_uq").on(t.metricId, t.month) }),
);

// ---------------------------------------------------------------- skutečnost

export const actualSpends = pgTable(
  "actual_spend",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tacticId: text("tactic_id").notNull().references(() => tactics.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    amount: integer("amount").notNull().default(0),
  },
  (t) => ({ uq: uniqueIndex("actual_spend_uq").on(t.tacticId, t.month) }),
);

export const metricActuals = pgTable(
  "metric_actual",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    metricId: text("metric_id").notNull().references(() => metrics.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    value: doublePrecision("value").notNull().default(0),
  },
  (t) => ({ uq: uniqueIndex("metric_actual_uq").on(t.metricId, t.month) }),
);

/** Vysvětlení odchylky. Stav ZŮSTÁVÁ červený — poznámka dokládá, že o odchylce
 *  víte, neschvaluje ji (zadání §6.3). */
export const accountNotes = pgTable(
  "account_note",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tacticId: text("tactic_id").notNull().references(() => tactics.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    text: text("text").notNull(),
  },
  (t) => ({ uq: uniqueIndex("account_note_uq").on(t.tacticId, t.month) }),
);

// ---------------------------------------------------------------- oprávnění

/** Grant se čtyřmi rozměry (zadání §5.2). NULL = zástupný znak „vše".
 *  Výchozí stav je zákaz — bez grantu (nebo bez rozsahu z role) se nezapíše nic. */
export const grants = pgTable(
  "grant",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    area: areaEnum("area").notNull(),
    level: levelEnum("level").notNull(),
    mediaType: mediaTypeEnum("media_type"),
    /** Pátý rozměr. Bez něj by grant mohl přetéct do plánu jiného klienta. */
    planId: text("plan_id").references(() => plans.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
    month: text("month"),
    note: text("note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({ idx: index("grant_user_idx").on(t.userId) }),
);

// ---------------------------------------------------------------- podklady a historie

export const assets = pgTable("asset", {
  id: text("id").primaryKey().$defaultFn(createId),
  title: text("title").notNull(),
  url: text("url").notNull(),
  note: text("note").notNull().default(""),
  tacticId: text("tactic_id").references(() => tactics.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** Vzniká automaticky porovnáním hodnoty před a po zápisu. Needituje se ani nemaže. */
export const changeLog = pgTable(
  "change_log",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    ts: timestamp("ts").notNull().defaultNow(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    area: areaEnum("area").notNull(),
    items: text("items").array().notNull(),
  },
  (t) => ({ idx: index("change_log_ts_idx").on(t.ts) }),
);

// ---------------------------------------------------------------- relace

export const clientRelations = relations(clients, ({ many }) => ({ plans: many(plans) }));
export const planRelations = relations(plans, ({ one, many }) => ({
  client: one(clients, { fields: [plans.clientId], references: [clients.id] }),
  campaigns: many(campaigns),
}));
export const campaignRelations = relations(campaigns, ({ one, many }) => ({
  plan: one(plans, { fields: [campaigns.planId], references: [plans.id] }),
  messageLines: many(messageLines),
}));
export const messageLineRelations = relations(messageLines, ({ one, many }) => ({
  campaign: one(campaigns, { fields: [messageLines.campaignId], references: [campaigns.id] }),
  tactics: many(tactics),
}));
export const tacticRelations = relations(tactics, ({ one, many }) => ({
  messageLine: one(messageLines, { fields: [tactics.messageLineId], references: [messageLines.id] }),
  budgets: many(tacticBudgets),
  actuals: many(actualSpends),
  notes: many(accountNotes),
  metrics: many(metrics),
}));
export const metricRelations = relations(metrics, ({ one, many }) => ({
  tactic: one(tactics, { fields: [metrics.tacticId], references: [tactics.id] }),
  targets: many(metricTargets),
  actuals: many(metricActuals),
}));
export const tacticBudgetRelations = relations(tacticBudgets, ({ one }) => ({
  tactic: one(tactics, { fields: [tacticBudgets.tacticId], references: [tactics.id] }),
}));
export const actualSpendRelations = relations(actualSpends, ({ one }) => ({
  tactic: one(tactics, { fields: [actualSpends.tacticId], references: [tactics.id] }),
}));
export const accountNoteRelations = relations(accountNotes, ({ one }) => ({
  tactic: one(tactics, { fields: [accountNotes.tacticId], references: [tactics.id] }),
}));
export const metricTargetRelations = relations(metricTargets, ({ one }) => ({
  metric: one(metrics, { fields: [metricTargets.metricId], references: [metrics.id] }),
}));
export const metricActualRelations = relations(metricActuals, ({ one }) => ({
  metric: one(metrics, { fields: [metricActuals.metricId], references: [metrics.id] }),
}));
export const userRelations = relations(users, ({ many }) => ({ grants: many(grants) }));
export const grantRelations = relations(grants, ({ one }) => ({
  user: one(users, { fields: [grants.userId], references: [users.id] }),
  campaign: one(campaigns, { fields: [grants.campaignId], references: [campaigns.id] }),
  plan: one(plans, { fields: [grants.planId], references: [plans.id] }),
}));
export const changeLogRelations = relations(changeLog, ({ one }) => ({
  user: one(users, { fields: [changeLog.userId], references: [users.id] }),
}));

/**
 * Zásobník pro vrácení zpět. Před každou změnou se sem uloží, co by ji vrátilo.
 * Držíme posledních 10 kroků na uživatele — víc by svádělo k „rozbalování"
 * cizích změn, které mezitím proběhly.
 */
export const undoEntries = pgTable(
  "undo_entry",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    ts: timestamp("ts").notNull().defaultNow(),
    label: text("label").notNull(),
    ops: text("ops").notNull(), // JSON: seznam operací, které stav vrátí
  },
  (t) => ({ idx: index("undo_user_idx").on(t.userId, t.ts) }),
);
