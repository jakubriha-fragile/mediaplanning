"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  setPlannedBudget, setRowUnit, setTacticMedia, updateTactic, updateMessageLine,
  moveTactic, moveCampaign, createTactic, createMessageLine, createCampaign, deleteTactic, deleteCampaign, undoLast,
  setTacticThemes, setLineThemes, createTheme, renameCampaign, setPlannedBudgets, setPlannedWeeks, setTacticCatalog, autofillCatalog, setRowPricing,
  setFixImpressions, linkLineTargetGroups,
  setTacticEstimate,
  spreadMonthToWeeks,
} from "@/lib/actions";
import type { CatalogMedium } from "@/lib/catalog";
import { estimate, type Estimate } from "@/lib/estimates";
import { costKind } from "@/lib/costKind";
import { ThemeCell, type ThemeOption, type ThemeShare } from "@/components/ThemeCell";
import { Flowchart, type FlowWeek } from "@/components/Flowchart";
import { combineReach, isGrpPriced, priceHint, reachByType, UNIT_LABEL, type Curve } from "@/lib/crossmedia";
import type { ChannelType, PlanUnit } from "@/db/schema";

export type PlanRow = {
  id: string;
  campaign: string;
  campaignId: string;
  messageLineId: string;
  code: string;
  message: string;
  phase: string;
  audience: string;
  channel: string;
  /** vlastní krátký název; null = automaticky */
  label: string | null;
  /** co se ukazuje klientovi a v souhrnech */
  name: string;
  mediaType: "Paid" | "Owned" | "Earned";
  channelType: ChannelType;
  /** cenový model: CPM, CPC, nebo fix (balík s garantovanými impresemi); null = podle nosiče */
  pricing: "cpm" | "cpc" | "fix" | null;
  /** garantované imprese za období u nákupu „fix" */
  fixImpressions: number | null;
  /** cílovka sdělení z číselníku (null = jen text, platí cílovka plánu) */
  lineTargetGroupId: string | null;
  /** kreativa / formáty */
  creative: string | null;
  /** předpoklady odhadu výsledků (src/lib/estimates.ts) */
  est: { measurement: string | null; ctr: number | null; cr: number | null; freq: number | null };
  /** odkud je zásah: zadaná frekvence, nebo křivka modelu */
  reachBy: "freq" | "model" | null;
  /** zásah 1+ položky za období z modelu (podíl 0–1); null = bez GRP nebo agenturní práce */
  reachPct: number | null;
  curve: Curve;
  mediumId: string | null;
  platformId: string | null;
  targetGroupId: string | null;
  /** tematické oblasti a podíly (součet 1); prázdné = nezařazeno */
  themes: ThemeShare[];
  universe: number;
  /** dopočítané jednotky za každý měsíc — rozpočet, GRP, impressions, zásah */
  cells: Record<string, {
    budget: number; grp: number; impressions: number; reach: number;
    frequency: number; driver: PlanUnit; driverValue: number; unitPrice: number; clicks?: number;
    /** doručení odhadnuté z ceníku klienta */
    estimated?: boolean;
  }>;
  budgets: Record<string, number>;
  actuals: Record<string, number>;
  /** které měsíce smí tenhle uživatel u téhle taktiky editovat (rozhodl server) */
  editable: Record<string, boolean>;
  /** plán po týdnech: buňky týdnů (klíč = pondělí); null = plán po měsících */
  weekCells: Record<string, PlanRow["cells"][string]> | null;
  weekEditable: Record<string, boolean> | null;
};

export type PlanWeek = { key: string; label: string; title: string; home: string };

export type CampaignInfo = {
  id: string;
  name: string;
  lines: Array<{ id: string; code: string }>;
};

const kc = (n: number) => Math.round(n).toLocaleString("cs-CZ");
const pct = (n: number) => (n * 100).toFixed(1).replace(".", ",") + " %";
const parse = (s: string) => Number(String(s).replace(/[^\d]/g, "")) || 0;
/** GRP se zadávají i desetinně, proto vlastní parser s čárkou i tečkou. */
const parseNum = (s: string) => Number(String(s).replace(/\s/g, "").replace(",", ".").replace(/[^\d.]/g, "")) || 0;

const CAMP_COLORS = [
  "var(--paid)", "var(--owned)", "var(--earned)", "#c2477e",
  "#5f8b1f", "#8b5fd6", "#b8502a", "#2b7bbf",
];
const PHASES = ["Awareness", "Consideration", "Conversion"] as const;
const CHANNEL_TYPES: ChannelType[] = ["TV", "Rádio", "OOH", "Print", "Kino", "Digital", "Vlastní", "PR"];
/**
 * Zjednodušený režim: plánuje se jen rozpočet v Kč (rozhodnutí zadavatele,
 * listopad 2026 — jednotky, CPM/CPC a přepínač zobrazení byly v týdenním plánu
 * nepřehledné). Výpočty zůstávají: řádek se zadanou cenou (TV s CPP) dál
 * dopočítá GRP i zásah. Přepnutím na false se vrátí Jednotka, Cena a Zobrazit.
 */
const BUDGET_ONLY = true;

type View = "input" | PlanUnit;
const VIEWS: Array<{ key: View; label: string; title: string }> = [
  { key: "input", label: "Zadání", title: "Každý řádek v jednotce, ve které se plánuje — tady se zadává" },
  { key: "budget", label: "Kč", title: "Rozpočet v Kč u všech řádků" },
  { key: "impressions", label: "Imprese", title: "Imprese (z CPM, u TV z GRP a velikosti cílovky)" },
  { key: "clicks", label: "Kliky", title: "Kliky u položek na CPC" },
  { key: "grp", label: "GRP", title: "GRP v cílové skupině (u TV TRP)" },
];

/** Jednotky podle cenového modelu: u CPC rozpočet nebo kliky, jinak rozpočet, GRP, imprese. */
const unitsFor = (ct: ChannelType, pricing: "cpm" | "cpc" | "fix" | null): PlanUnit[] =>
  !isGrpPriced(ct) && pricing === "cpc" ? ["budget", "clicks"] : ["budget", "grp", "impressions"];

/** Sloupec tabulky je buď měsíc, nebo sbalený kvartál. */
type Col =
  | { kind: "m"; key: string; label: string; months: string[] }
  | { kind: "q"; key: string; label: string; months: string[] }
  | { kind: "w"; key: string; label: string; months: string[]; title: string };

// Zadání plánu (návrh se zadavatelem, listopad 2026): sdělení se popíše jednou
// v hlavičce (fáze, cílová skupina, oblast), řádek má jen to, co se u nákupu
// opravdu zadává — kde, typ, nákup, cena a rozpočet. Vpravo šedě, co se dopočítá.
// Dřív měl řádek 12 sloupců a polovinu z nich opakovaně u každé taktiky.
// CTR má vlastní sloupec: u CPC bez něj nejsou imprese ani zásah a v detailu
// řádku ho nikdo nehledal (zadavatel, listopad 2026). Frekvence u digitálu se
// zadává (zásah = imprese ÷ frekvence) — křivka dávala všem řádkům stejných 1,4×.
const LEFT_COLS = 7;   // úchyt, kde, typ, nákup, cena, CTR, frekvence
const RIGHT_COLS = 7;  // celkem, imprese, kliky, zásah, frekvence, stav, smazat

/** Jak se položka nakupuje — u TV a rádia vždy CPP. */
const BUY_LABEL = { cpm: "CPM", cpc: "CPC", fix: "Fix", cpp: "CPP" } as const;
const BUY_UNIT = { cpm: "Kč / 1 000 imp.", cpc: "Kč / klik", fix: "imp. za období", cpp: "Kč / GRP" } as const;

export function PlanTable({
  rows, campaigns, planId, months, monthLabels, quarters, periodName, canEditPlan, undoLabel, clientView = false,
  themes = [], weeks = null, catalog = [], targetGroups = [], dup, flowWeeks = [],
}: {
  /** týdny období pro Flowchart (u měsíčního plánu se do nich rozloží měsíce) */
  flowWeeks?: FlowWeek[];
  /** koeficienty duplikace pro zásah souhrnných řádků */
  dup?: Record<string, number>;
  /** cílové skupiny klienta s velikostí — výběr u sdělení */
  targetGroups?: Array<{ id: string; name: string; universe: number }>;
  /** číselník médií a platforem */
  catalog?: CatalogMedium[];
  /** plán po týdnech — sloupce jsou týdny, sbalit jde po měsících */
  weeks?: PlanWeek[] | null;
  rows: PlanRow[];
  campaigns: CampaignInfo[];
  planId: string;
  months: string[];
  monthLabels: Record<string, string>;
  quarters: Array<{ key: string; label: string; months: string[] }>;
  periodName: string;
  canEditPlan: boolean;
  undoLabel: string | null;
  /** pohled klienta: bez agenturních sloupců a dopočtů v buňkách */
  clientView?: boolean;
  /** tematické oblasti klienta */
  themes?: ThemeOption[];
}) {
  const leftCols = clientView ? 3 : LEFT_COLS;
  const rightCols = RIGHT_COLS;
  /** rozbalený detail řádku (kreativa, měření, CTR, oblast řádku, co chybí) */
  const [open, setOpen] = useState<string | null>(null);
  /** Tabulka (zadávání) nebo Flowchart (co kdy běží, jen čtení) — pamatuje se v prohlížeči */
  const [mode, setModeState] = useState<"table" | "flow">("table");
  useEffect(() => {
    try { if (localStorage.getItem("plan-mode") === "flow") setModeState("flow"); } catch {}
  }, []);
  const setMode = (m: "table" | "flow") => {
    setModeState(m);
    try { localStorage.setItem("plan-mode", m); } catch {}
  };
  /** z Flowchartu: přepnout na tabulku, otevřít detail řádku a dorolovat k němu */
  const openInTable = (id: string) => {
    setMode("table");
    setOpen(id);
    setTimeout(() => document.getElementById(`row-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 50);
  };
  const [data, setData] = useState(rows);
  const [themeList, setThemeList] = useState<ThemeOption[]>(themes);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragCamp, setDragCamp] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; after: boolean } | null>(null);
  const [dropCamp, setDropCamp] = useState<string | null>(null);

  // server je zdroj pravdy — po každé změně se sem vrátí čerstvá data
  useEffect(() => setData(rows), [rows]);

  /** Sbalený kvartál se ukáže jako jeden součtový sloupec. */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // skupiny, které jde sbalit do jednoho sloupce: kvartály, u týdenního plánu měsíce
  const groupsOfCols = useMemo(() => (weeks
    ? months.map((m) => ({ key: m, label: monthLabels[m] ?? m, months: [m] }))
    : quarters), [weeks, months, monthLabels, quarters]);

  const cols: Col[] = useMemo(() => {
    const out: Col[] = [];
    if (weeks) {
      for (const g of groupsOfCols) {
        if (collapsed.has(g.key)) { out.push({ kind: "q", key: g.key, label: g.label, months: g.months }); continue; }
        weeks.filter((w) => w.home === g.key).forEach((w, i) => {
          out.push({ kind: "w", key: w.key, label: i === 0 ? `${g.label} · ${w.label}` : w.label, months: [g.key], title: w.title });
        });
      }
      return out;
    }
    for (const q of quarters) {
      if (collapsed.has(q.key)) {
        out.push({ kind: "q", key: q.key, label: q.label, months: q.months });
      } else {
        for (const m of q.months) {
          out.push({ kind: "m", key: m, label: monthLabels[m] ?? m, months: [m] });
        }
      }
    }
    return out;
  }, [quarters, collapsed, monthLabels, weeks, groupsOfCols]);

  const [types, setTypes] = useState<Record<string, boolean>>({ Paid: true, Owned: true, Earned: true });
  const [msgSel, setMsgSel] = useState<Set<string>>(new Set());
  const [medSel, setMedSel] = useState<Set<string>>(new Set());
  const [platSel, setPlatSel] = useState<Set<string>>(new Set());
  const mediumOf = (r: PlanRow) => catalog.find((m) => m.id === r.mediumId) ?? null;
  const platformOf = (r: PlanRow) => mediumOf(r)?.platforms.find((p) => p.id === r.platformId) ?? null;
  const NO_MEDIUM = "— bez média —";
  const [audSel, setAudSel] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");

  const campOrder = useMemo(() => [...new Set(rows.map((r) => r.campaign))], [rows]);
  const campColor = (name: string) => CAMP_COLORS[campOrder.indexOf(name) % CAMP_COLORS.length];

  const opts = useMemo(() => ({
    msg: [...new Set(rows.map((r) => r.code))].sort((a, b) => a.localeCompare(b, "cs")),
    med: [...new Set(rows.map((r) => mediumOf(r)?.name ?? NO_MEDIUM))].sort((a, b) => a.localeCompare(b, "cs")),
    plat: [...new Set(rows
      .filter((r) => !medSel.size || medSel.has(mediumOf(r)?.name ?? NO_MEDIUM))
      .map((r) => platformOf(r)?.name).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, "cs")),
    aud: [...new Set(rows.map((r) => r.audience))].sort((a, b) => a.localeCompare(b, "cs")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [rows, catalog, medSel]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.filter((r) => {
      if (!types[r.mediaType]) return false;
      if (msgSel.size && !msgSel.has(r.code)) return false;
      if (medSel.size && !medSel.has(mediumOf(r)?.name ?? NO_MEDIUM)) return false;
      if (platSel.size && !platSel.has(platformOf(r)?.name ?? "")) return false;
      if (audSel.size && !audSel.has(r.audience)) return false;
      if (!needle) return true;
      return [r.channel, r.code, r.message, r.audience, r.campaign, r.phase]
        .join(" ").toLowerCase().includes(needle);
    });
  }, [data, types, msgSel, medSel, platSel, audSel, q, catalog]);

  const anyFilter =
    msgSel.size || medSel.size || platSel.size || audSel.size || q.trim() || !types.Paid || !types.Owned || !types.Earned;

  /**
   * Co tabulka ukazuje: „Zadání" = každý řádek ve své jednotce (jak se plánuje),
   * jinak jedna metrika pro všechny — Kč, imprese, kliky, GRP. Dřív buňka ukazovala
   * všechno naráz (částku, pod ní imprese, pruh) a nedalo se to číst.
   */
  const [viewChoice, setView] = useState<View>("input");
  const view: View = BUDGET_ONLY ? "budget" : viewChoice;
  useEffect(() => {
    try { const v = localStorage.getItem("plan.zobrazeni") as View | null; if (v && VIEWS.some((x) => x.key === v)) setView(v); } catch { /* bez úložiště */ }
  }, []);
  const pickView = (v: View) => { setView(v); try { localStorage.setItem("plan.zobrazeni", v); } catch { /* bez úložiště */ } };
  const viewUnit = (r: PlanRow): PlanUnit => (view === "input" ? rowUnit(r) : view);
  /** hodnota buňky v aktuálním zobrazení */
  const metricOf = (cell: PlanRow["cells"][string] | undefined, budget: number, r: PlanRow): number =>
    view === "input" ? cell?.driverValue ?? 0
    : view === "budget" ? budget ?? 0
    : view === "clicks" ? cell?.clicks ?? 0
    : view === "grp" ? cell?.grp ?? 0
    : view === "impressions" ? cell?.impressions ?? 0
    : (void r, 0);
  // součty: v Zadání a Kč v korunách (jednotky řádků nejde sčítat), jinak v metrice
  const sumKey: PlanUnit = view === "input" ? "budget" : view;
  const cellSum = (cell: PlanRow["cells"][string] | undefined, budget: number) =>
    sumKey === "budget" ? budget ?? 0 : sumKey === "clicks" ? cell?.clicks ?? 0 : sumKey === "grp" ? cell?.grp ?? 0 : cell?.impressions ?? 0;
  const rowTotal = (r: PlanRow) => months.reduce((s, m) => s + cellSum(r.cells[m], r.budgets[m]), 0);
  const colOf = (r: PlanRow, c: Col) => c.kind === "w"
    ? cellSum(r.weekCells?.[c.key], r.weekCells?.[c.key]?.budget ?? 0)
    : c.months.reduce((s, m) => s + cellSum(r.cells[m], r.budgets[m] ?? 0), 0);
  /** rozpočet řádku za období v Kč — z něj se počítá odhad výsledků */
  const budgetOf = (r: PlanRow) => months.reduce((s, m) => s + (r.budgets[m] ?? 0), 0);
  /** kliky a konverze dávají smysl jen u digitálních médií, ne u TV, rádia a agenturní práce */
  const estApplies = (r: PlanRow) => !isGrpPriced(r.channelType) && costKind(r.channel) === "media";
  const estOf = (r: PlanRow): Estimate => {
    const sum = (k: "clicks" | "impressions") => months.reduce((s, m) => s + (r.cells[m]?.[k] ?? 0), 0);
    const plat = platformOf(r);
    if (!estApplies(r)) return estimate({ budget: budgetOf(r) });
    return estimate({
      budget: budgetOf(r),
      ...(r.pricing === "cpc" ? { clicks: sum("clicks") } : { impressions: sum("impressions") }),
      ctr: r.est.ctr ?? plat?.ctr, cr: r.est.cr ?? plat?.cr,
    });
  };
  const buyOf = (r: PlanRow): keyof typeof BUY_LABEL => isGrpPriced(r.channelType) ? "cpp" : r.pricing ?? "cpm";
  /** Co řádek doručí za období — všechno dopočtené, nic se tu nezadává. */
  const calcOf = (r: PlanRow) => {
    const sum = (k: "impressions" | "grp") => months.reduce((s, m) => s + (r.cells[m]?.[k] ?? 0), 0);
    const media = costKind(r.channel) === "media";
    const est = estOf(r);
    const grp = sum("grp");
    const reach = r.reachPct ?? 0;
    return {
      media,
      budget: budgetOf(r),
      impressions: media ? sum("impressions") : 0,
      grp,
      clicks: media ? est.clicks ?? 0 : 0,
      clicksDerived: est.derived.clicks,
      reach,
      /** průměrná frekvence za období: GRP ÷ zásah (u zadané frekvence vyjde ona, pokud nenarazí na strop) */
      freq: reach > 0 ? grp / (reach * 100) : 0,
      est,
    };
  };
  /**
   * Zásah a frekvence řádku nebo skupiny (sdělení, kampaň, plán) za období.
   * Zásah se přes řádky nesčítá (invariant 10) — reachByType (křivka, nebo
   * zadaná frekvence) a combineReach, stejně jako panel zásahu a Finální mix.
   * Efektivní frekvence řádku se odvodí ze zásahu ze serveru, takže se
   * započítá i strop křivky. Frekvence skupiny = všechny GRP ÷ zásah.
   */
  const groupReach = (rs: PlanRow[]) => {
    const items = rs.filter((r) => calcOf(r).media).map((r) => ({
      channelType: r.channelType, grp: calcOf(r).grp, curve: r.curve,
      freq: r.reachBy === "freq" ? calcOf(r).grp / 100 / (r.reachPct || 1) : null,
    }));
    const types = reachByType(items, dup);
    const reach = combineReach(types, dup).net;
    const grp = types.reduce((a, t) => a + t.grp, 0);
    return { reach, freq: reach > 0 ? grp / (reach * 100) : 0 };
  };
  /**
   * Stav řádku: co chybí, aby se počítal. Hlášky jsou návod, co doplnit —
   * dřív se to plánovač dozvěděl jen z pomlčky a tooltipu.
   */
  const statusOf = (r: PlanRow): { level: "ok" | "warn" | "off"; msgs: string[] } => {
    const c = calcOf(r);
    if (!c.media) return { level: "off", msgs: ["Agenturní práce nebo honorář (pozná se podle názvu položky) — do doručení a zásahu se nepočítá."] };
    if (!c.budget) return { level: "off", msgs: ["Bez rozpočtu — zadejte částky do měsíců."] };
    const msgs: string[] = [];
    const buy = buyOf(r);
    if (!r.mediumId) msgs.push("Vyberte, kde se nakupuje (médium › platforma).");
    if (buy === "fix" && !r.fixImpressions) msgs.push("Doplňte garantované imprese za období do sloupce Cena.");
    else if (buy === "cpc" && !c.clicks) msgs.push("Doplňte cenu za klik (CPC) — u řádku, nebo jako výchozí u platformy v Nastavení.");
    else if (buy === "cpc" && !c.impressions) msgs.push("Doplňte CTR ve sloupci CTR (nebo výchozí u platformy v Nastavení) — bez něj se z kliků nedají spočítat imprese, zásah ani frekvence.");
    else if (!c.impressions) msgs.push(`Doplňte cenu (${BUY_LABEL[buy]}) — u řádku, nebo jako výchozí u platformy či v ceníku.`);
    if (!r.lineTargetGroupId) msgs.push("Sdělení nemá cílovou skupinu ze seznamu — zásah a frekvence se počítají s cílovou skupinou plánu.");
    return { level: msgs.length ? "warn" : "ok", msgs };
  };
  /** výchozí cena platformy (šedě v poli Cena), dokud se nezadá vlastní */
  const defaultPriceOf = (r: PlanRow): number | null => {
    const p = platformOf(r);
    return r.pricing === "cpc" ? p?.cpc ?? null : r.pricing === "fix" || isGrpPriced(r.channelType) ? null : p?.cpm ?? null;
  };
  const fmtSum = (v: number) => (sumKey === "budget" ? kc(v) : unitFmt(v, sumKey) || "0");
  const grand = data.reduce((s, r) => s + rowTotal(r), 0);
  const selTotal = visible.reduce((s, r) => s + rowTotal(r), 0);
  const colTotal = (c: Col) => visible.reduce((s, r) => s + colOf(r, c), 0);
  // pruh v buňce měří peníze na společném měřítku — u týdnů týdenní, jinak měsíční
  const axisMax = weeks
    ? Math.max(10000, ...data.flatMap((r) => Object.values(r.weekCells ?? {}).map((c) => c.budget)))
    : Math.max(50000, ...data.flatMap((r) => months.map((m) => r.budgets[m])));

  /** Řídicí jednotka a cena jsou vlastností řádku — bereme je z prvního měsíce. */
  const rowUnit = (r: PlanRow): PlanUnit => r.cells[months[0]]?.driver ?? "budget";
  const rowPrice = (r: PlanRow) =>
    months.map((m) => r.cells[m]?.unitPrice ?? 0).find((v) => v > 0) ?? 0;
  const rowEditable = (r: PlanRow) => months.every((m) => r.editable[m]);

  /** Obálka pro server action: optimistická změna, při odmítnutí návrat zpět. */
  function run(optimistic: () => void, rollback: () => void, action: () => Promise<{ ok: boolean; error?: string }>) {
    optimistic();
    startTransition(async () => {
      const res = await action();
      if (!res.ok) { rollback(); setError(res.error ?? "Uložení se nezdařilo."); }
      else setError(null);
    });
  }

  const patchRow = (id: string, patch: Partial<PlanRow>) =>
    setData((d) => d.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  /** Sdělení, cílovka a fáze patří lince — mění se u všech jejích taktik naráz. */
  const patchLine = (lineId: string, patch: Partial<PlanRow>) =>
    setData((d) => d.map((r) => (r.messageLineId === lineId ? { ...r, ...patch } : r)));

  /**
   * Bloky se skládají ze SEZNAMU KAMPANÍ, ne z řádků. Dřív se braly z taktik,
   * takže nově založený blok bez taktik nebyl vidět a vypadalo to, že se
   * zakládání nepovedlo.
   */
  const groups = useMemo(() => {
    const byId = new Map<string, PlanRow[]>();
    for (const r of visible) {
      if (!byId.has(r.campaignId)) byId.set(r.campaignId, []);
      byId.get(r.campaignId)!.push(r);
    }
    const known = campaigns.map((c) => ({ campaign: c.name, campaignId: c.id, rows: byId.get(c.id) ?? [] }));
    // kdyby se v datech objevila kampaň mimo seznam, ať se neztratí
    for (const r of visible) {
      if (!known.some((g) => g.campaignId === r.campaignId)) {
        known.push({ campaign: r.campaign, campaignId: r.campaignId, rows: byId.get(r.campaignId) ?? [] });
      }
    }
    return anyFilter ? known.filter((g) => g.rows.length) : known;
  }, [visible, campaigns, anyFilter]);

  // ---------------------------------------------- ovládání jako v Excelu
  // Buňky měsíců tvoří mřížku: řádek = pořadí taktiky v tabulce, sloupec = index
  // v `cols`. Šipky, Enter a Tab mezi nimi skáčou, vložený blok z Excelu se
  // rozloží od buňky, kam se vkládá.
  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const rowIdx = useMemo(() => new Map(flat.map((r, i) => [r.id, i])), [flat]);

  const moveFocus = (r: number, c: number, dr: number, dc: number): boolean => {
    let rr = r + dr, cc = c + dc;
    while (rr >= 0 && rr < flat.length && cc >= 0 && cc < cols.length) {
      const el = document.querySelector<HTMLInputElement>(`input[data-grid="${rr}:${cc}"]`);
      if (el && !el.disabled) { el.focus(); return true; }
      rr += dr; cc += dc;
    }
    return false;
  };

  const pasteGrid = (text: string, r0: number, c0: number) => {
    const lines = text.replace(/\r/g, "").split("\n");
    if (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    // hodnoty jdou jen do měsíců — sbalený kvartál se přeskočí
    const editCols = cols.map((c, i) => ({ c, i })).filter((x) => (x.c.kind === "m" || x.c.kind === "w") && x.i >= c0);
    // týdenní plán se sbalenými měsíci: vložení jde po měsících a každý se rozloží do týdnů
    if (weeks && cols[c0]?.kind === "q") {
      const monthCols = cols.slice(c0).filter((c) => c.kind === "q");
      const jobs: Array<{ tacticId: string; month: string; driver: PlanUnit; value: number }> = [];
      lines.forEach((line, i) => {
        const row = flat[r0 + i];
        line.split("\t").forEach((raw, j) => {
          const t = raw.trim();
          if (!t || !row || !monthCols[j]) return;
          jobs.push({ tacticId: row.id, month: monthCols[j].months[0], driver: BUDGET_ONLY ? "budget" : rowUnit(row), value: parseNum(t) });
        });
      });
      run(() => {}, () => {}, async () => {
        for (const jb of jobs) {
          const res = await spreadMonthToWeeks(jb);
          if (!res.ok) return res;
        }
        setInfo(`Vloženo ${jobs.length} měsíčních hodnot, rozloženo do týdnů.`);
        return { ok: true };
      });
      return;
    }
    const items: Array<{ tacticId: string; key: string; driver: PlanUnit; value: number }> = [];
    let skipped = 0;
    lines.forEach((line, i) => {
      const row = flat[r0 + i];
      line.split("\t").forEach((raw, j) => {
        const t = raw.trim();
        if (!t) return; // prázdná buňka v Excelu nic nepřepisuje
        const ec = editCols[j];
        const ok = row && ec && (weeks ? row.weekEditable?.[ec.c.key] : row.editable[ec.c.key]);
        if (!ok) { skipped++; return; }
        items.push({ tacticId: row.id, key: ec.c.key, driver: BUDGET_ONLY ? "budget" : rowUnit(row), value: parseNum(t) });
      });
    });
    if (!items.length) { setInfo(skipped ? "Nic se nevložilo — cílové buňky jsou mimo tabulku nebo k nim nemáte oprávnění." : null); return; }
    run(() => {}, () => {}, async () => {
      const res = weeks
        ? await setPlannedWeeks({ items: items.map(({ key, ...x }) => ({ ...x, week: key })) })
        : await setPlannedBudgets({ items: items.map(({ key, ...x }) => ({ ...x, month: key })) });
      if (res.ok) {
        const n = res.changed ?? 0;
        setInfo(`Vloženo z Excelu: ${n} ${n === 1 ? "hodnota" : n >= 2 && n <= 4 ? "hodnoty" : "hodnot"}` +
          (skipped ? `, ${skipped} mimo tabulku nebo bez oprávnění přeskočeno` : "") + ". Vrátíte jedním kliknutím na Zpět.");
      }
      return res;
    });
  };



  const campaignLines = (campaignId: string) =>
    campaigns.find((c) => c.id === campaignId)?.lines ?? [];
  /** text sdělení podle linky — do nabídky „přesunout pod sdělení" */
  const lineText = useMemo(() => new Map(rows.map((r) => [r.messageLineId, r.message])), [rows]);

  /** nová oblast z editoru — u sdělení i u řádku */
  const createThemeFor = async (name: string) => {
    const res = await createTheme({ planId, name });
    if (!res.ok || !res.themeId) { setError(res.ok ? "Oblast se nepodařilo založit." : res.error); return null; }
    setThemeList((l) => l.some((t) => t.id === res.themeId) ? l : [...l, { id: res.themeId!, name }]);
    return res.themeId;
  };

  return (
    <div className="panel sticky">
      <div className="toolbar noprint">
        <div className="seg" role="radiogroup" aria-label="Pohled na plán">
          <button type="button" role="radio" aria-checked={mode === "table"} className={mode === "table" ? "on" : ""} onClick={() => setMode("table")}
            title="Zadávání plánu">Tabulka</button>
          <button type="button" role="radio" aria-checked={mode === "flow"} className={mode === "flow" ? "on" : ""} onClick={() => setMode("flow")}
            title="Co kdy běží a za kolik — po týdnech, jen čtení">Flowchart</button>
        </div>
        {(["Paid", "Owned", "Earned"] as const).map((ty) => (
          <button key={ty} className="btn" aria-pressed={types[ty]}
            style={types[ty]
              ? { background: `var(--${ty.toLowerCase()}-soft)`, borderColor: `var(--${ty.toLowerCase()})`, borderRadius: 999 }
              : { borderRadius: 999, color: "var(--muted)" }}
            onClick={() => setTypes((t) => ({ ...t, [ty]: !t[ty] }))}>{ty}</button>
        ))}
        {mode === "table" && groupsOfCols.length > 1 && (
          <span style={{ display: "inline-flex", gap: 3, alignItems: "center", flexWrap: "wrap" }}>
            <span className="share" style={{ marginRight: 2 }}>{weeks ? "Měsíce" : "Kvartály"}</span>
            {groupsOfCols.map((q) => (
              <button key={q.key} className="btn" title={collapsed.has(q.key) ? (weeks ? "Rozbalit na týdny" : "Rozbalit na měsíce") : "Sbalit do jednoho sloupce"}
                style={{ borderRadius: 999, fontSize: 11, padding: "2px 9px",
                  color: collapsed.has(q.key) ? "var(--muted)" : "var(--brand-ink)",
                  borderColor: collapsed.has(q.key) ? undefined : "var(--brand)" }}
                onClick={() => setCollapsed((c) => {
                  const n = new Set(c);
                  if (n.has(q.key)) n.delete(q.key); else n.add(q.key);
                  return n;
                })}>
                {collapsed.has(q.key) ? "▸" : "▾"} {q.label.split(" ")[0]}
              </button>
            ))}
            <button className="btn" style={{ borderRadius: 999, fontSize: 11, padding: "2px 9px" }}
              onClick={() => setCollapsed((c) => (c.size === groupsOfCols.length ? new Set() : new Set(groupsOfCols.map((q) => q.key))))}>
              {collapsed.size === groupsOfCols.length ? "Rozbalit vše" : "Sbalit vše"}
            </button>
          </span>
        )}
        <MultiSelect label="Sdělení" options={opts.msg} selected={msgSel} onChange={setMsgSel} />
        <MultiSelect label="Médium" options={opts.med} selected={medSel}
          onChange={(v) => { setMedSel(v); setPlatSel(new Set()); }} />
        {/* platformy jen vybraných médií — jinak by se v nabídce míchaly Search ze Skliku i z Googlu */}
        <MultiSelect label="Platforma" options={opts.plat} selected={platSel} onChange={setPlatSel} />
        <MultiSelect label="Cílová skupina" options={opts.aud} selected={audSel} onChange={setAudSel} />
        <input placeholder="Hledat…" value={q} onChange={(e) => setQ(e.target.value)}
          style={{ font: "inherit", fontSize: 12, padding: "5px 10px", minWidth: 130, maxWidth: 200,
            border: "1px solid var(--line-strong)", borderRadius: 4, background: "var(--surface)", color: "var(--ink)" }} />
        {anyFilter ? (
          <button className="btn danger" onClick={() => {
            setMsgSel(new Set()); setMedSel(new Set()); setPlatSel(new Set()); setAudSel(new Set());
            setQ(""); setTypes({ Paid: true, Owned: true, Earned: true });
          }}>✕ Zrušit filtry</button>
        ) : null}
        <span className="spacer" />
        {!BUDGET_ONLY && <span className="share">Zobrazit</span>}
        {!BUDGET_ONLY && <div className="seg" role="radiogroup" aria-label="Co tabulka ukazuje">
          {VIEWS.filter((v) => v.key !== "clicks" || data.some((r) => r.pricing === "cpc")).map((v) => (
            <button key={v.key} type="button" role="radio" aria-checked={view === v.key} title={v.title}
              className={view === v.key ? "on" : ""} onClick={() => pickView(v.key)}>{v.label}</button>
          ))}
        </div>}
        {mode === "table" && <span className="share legend" title="Bílá pole s rámečkem vyplňujete, šedé sloupce vpravo se dopočítají">
          <span className="lg-in" /> vyplňujete <span className="lg-calc" /> dopočítá se
        </span>}
        {canEditPlan && <UndoButton undoLabel={undoLabel} pending={pending} onUndo={() => run(() => {}, () => {}, undoLast)} />}
        {canEditPlan && <NewCampaignButton onCreate={(name) => run(() => {}, () => {}, () => createCampaign({ planId, name }))} />}
        <span className="share">
          {pending ? (
            <span className="saving"><span className="spinner" />ukládám…</span>
          ) : (
            <>{anyFilter ? `${visible.length} z ${data.length} taktik · ` : `${data.length} taktik · `}{fmtSum(selTotal)} {sumKey === "budget" ? "Kč" : UNIT_LABEL[sumKey].toLowerCase()}</>
          )}
        </span>
      </div>

      {error && (
        <div className="banner" style={{ margin: 0, borderRadius: 0 }}>
          <span><b>Zápis odmítnut.</b> {error}</span>
        </div>
      )}
      {canEditPlan && catalog.length > 0 && data.some((r) => !r.mediumId) && (
        <div className="banner info" style={{ margin: 0, borderRadius: 0 }}>
          <span>
            <b>{data.filter((r) => !r.mediumId).length} položek nemá médium.</b> Médium a platformu vyberete v řádku,
            nebo je nechte doplnit podle názvů (např. „META“ → Meta Ads, „SEA“ → Google Ads · Search). Co se nepozná, zůstane prázdné.
          </span>
          <span className="spacer" />
          <button className="btn" disabled={pending} onClick={() => run(() => {}, () => {}, async () => {
            const res = await autofillCatalog(planId);
            if (res.ok) setInfo(`Doplněno ${res.filled ?? 0} položek, ručně zbývá ${res.left ?? 0}.`);
            return res;
          })}>Doplnit podle názvů</button>
        </div>
      )}
      {canEditPlan && (() => {
        // sdělení s cílovkou jen jako text, ke které existuje stejnojmenná cílová skupina
        const norm = (x: string) => x.trim().toLowerCase().replace(/\s+/g, " ").replace(/[–—]/g, "-");
        const names = new Set(targetGroups.map((t) => norm(t.name)));
        const lines = new Map(data.filter((r) => !r.lineTargetGroupId && r.audience && names.has(norm(r.audience))).map((r) => [r.messageLineId, r]));
        if (!lines.size) return null;
        return (
          <div className="banner info" style={{ margin: 0, borderRadius: 0 }}>
            <span>
              <b>{lines.size} sdělení má cílovou skupinu jen jako text</b> („{[...lines.values()][0].audience}"…), i když stejnojmenná
              cílová skupina existuje. Propojením se začne počítat s její velikostí.
            </span>
            <span className="spacer" />
            <button className="btn" disabled={pending} onClick={() => run(() => {}, () => {}, async () => {
              const res = await linkLineTargetGroups(planId);
              if (res.ok) setInfo(`Propojeno ${res.linked ?? 0} sdělení. Vrátíte jedním Zpět.`);
              return res;
            })}>Propojit podle názvu</button>
          </div>
        );
      })()}
      {info && !error && (
        <div className="banner info" style={{ margin: 0, borderRadius: 0 }}>
          <span>{info}</span>
          <span className="spacer" />
          <button className="linkbtn" onClick={() => setInfo(null)}>zavřít</button>
        </div>
      )}

      {mode === "flow" ? (
        <Flowchart rows={visible} weeks={flowWeeks} monthLabels={monthLabels} weekly={!!weeks} onOpen={openInTable} />
      ) : (<>
      <div className="scroll stick">
        {/* bez práva na úpravu se tabulka kreslí jako text, ne jako zašedlý formulář */}
        <table className={`plan ${canEditPlan ? "" : "ro"}`}>
          <thead>
            <tr>
              <th style={{ width: 28 }} />
              <th title="Kde se nakupuje: médium a platforma z číselníku (Nastavení → Média a platformy). Určí i nosič — TV, rádio, digitál…">Kde · médium › platforma</th>
              <th title="Paid / Owned / Earned">Typ</th>
              {!clientView && <th title="Jak se nakupuje: CPM = za tisíc impresí, CPC = za klik, Fix = balík za pevnou cenu s garantovanými impresemi. TV a rádio vždy CPP (za GRP).">Nákup</th>}
              {!clientView && <th className="r" title="Cena v jednotce podle nákupu. Šedé číslo je výchozí cena platformy nebo ceník — platí, dokud nezadáte vlastní.">Cena</th>}
              {!clientView && <th className="r" title="Míra prokliku v %. U CPC je nutná — imprese = kliky ÷ CTR. U CPM z ní vzniknou kliky. Šedé číslo je výchozí hodnota platformy.">CTR %</th>}
              {!clientView && <th className="r" title="Průměrná frekvence za období řádku, kterou čekáte (frequency cap, zkušenost z platformy). Zásah = imprese ÷ frekvence, v % cílové skupiny. Prázdné = výchozí platformy (šedě), jinak křivka modelu. TV a rádio vždy z křivky.">Frekv.</th>}
              {cols.map((c) => (
                <th className={`r ${c.kind === "q" ? "qcol" : ""}`} key={c.key}
                    title={c.kind === "q" ? `${c.label} — sbaleno, rozbalíte v liště` : c.kind === "w" ? `Týden ${c.title} · rozpočet v Kč` : "Rozpočet v Kč"}>
                  {c.label}
                </th>
              ))}
              <th className="r calc calcfirst" title="Rozpočet za celé období">Celkem Kč</th>
              <th className="r calc" title="Imprese za období: z rozpočtu a CPM, u CPC kliky ÷ CTR, u Fix garantované, u TV z GRP a velikosti cílové skupiny">Imprese</th>
              <th className="r calc" title="Kliky za období: u CPC rozpočet ÷ CPC, jinak imprese × CTR (kurzívou)">Kliky</th>
              <th className="r calc" title="Zásah 1+ řádku za období z modelu (křivka nosiče, cílová skupina sdělení). Modelový odhad, ne měření. U sdělení, kampaně a celku se nesčítá — počítá se modelem znovu z GRP všech jejich řádků (překryv).">Zásah</th>
              <th className="r calc" title="Průměrná frekvence za období: kolikrát reklamu v průměru uvidí zasažený (GRP ÷ zásah). U sdělení, kampaně a celku přes všechny jejich řádky, s odečtením překryvu.">Frekvence</th>
              <th style={{ width: 24 }} title="Stav řádku — kliknutím otevřete detail" />
              <th style={{ width: 30 }} />
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const gt = g.rows.reduce((s, r) => s + rowTotal(r), 0);
              const gc = g.rows.map(calcOf);
              // řádky bloku po sděleních, v pořadí, v jakém v bloku jsou
              const lineGroups: Array<{ id: string; rows: PlanRow[] }> = [];
              for (const r of g.rows) {
                const lg = lineGroups.find((x) => x.id === r.messageLineId);
                if (lg) lg.rows.push(r); else lineGroups.push({ id: r.messageLineId, rows: [r] });
              }
              return (
                <GroupBlock key={g.campaignId}>
                  <tr className={`grp ${dropCamp === g.campaignId ? "dropInto" : ""}`}
                    onDragOver={(e) => {
                      if (!dragId && !dragCamp) return;
                      e.preventDefault();
                      setDropHint(null);
                      setDropCamp(g.campaignId);
                    }}
                    onDragLeave={() => setDropCamp((c) => (c === g.campaignId ? null : c))}
                    onDrop={(e) => {
                      e.preventDefault();
                      const t = dragId, c = dragCamp;
                      setDragId(null); setDragCamp(null); setDropCamp(null);
                      if (c && c !== g.campaignId) {
                        run(() => {}, () => {}, () => moveCampaign({ campaignId: c, targetCampaignId: g.campaignId }));
                      } else if (t) {
                        run(() => {}, () => {}, () => moveTactic({ tacticId: t, targetCampaignId: g.campaignId }));
                      }
                    }}>
                    <td colSpan={leftCols} style={{ boxShadow: `inset 3px 0 0 0 ${campColor(g.campaign)}` }}>
                      {canEditPlan && (
                        <span className="grip" draggable title="Přetažením změníte pořadí kampaní"
                          onDragStart={() => setDragCamp(g.campaignId)}
                          onDragEnd={() => { setDragCamp(null); setDropCamp(null); }}
                          style={{ marginRight: 8 }}>⠿</span>
                      )}
                      <span className="share" style={{ fontWeight: 300, marginRight: 6 }}>Kampaň</span>
                      {canEditPlan ? (
                        <input className="txt blockname" defaultValue={g.campaign} aria-label="Název kampaně"
                          title="Klikněte a přepište název kampaně"
                          size={Math.max(8, g.campaign.length + 1)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            if (e.key === "Escape") { (e.target as HTMLInputElement).value = g.campaign; (e.target as HTMLInputElement).blur(); }
                          }}
                          onBlur={(e) => {
                            const name = e.target.value.trim();
                            if (!name) { e.target.value = g.campaign; return; }
                            if (name === g.campaign) return;
                            run(() => {}, () => { e.target.value = g.campaign; }, () => renameCampaign({ campaignId: g.campaignId, name }));
                          }} />
                      ) : g.campaign}{" "}
                      <span className="share" style={{ fontWeight: 300 }}>{lineGroups.length} sděl. · {g.rows.length} řádků</span>
                      {canEditPlan && (
                        <button className="btn" style={{ marginLeft: 10, fontSize: 11, padding: "2px 8px" }}
                          title="Nové sdělení v této kampani, rovnou s prvním řádkem"
                          onClick={() => run(() => {}, () => {}, () => createMessageLine({ campaignId: g.campaignId }))}>
                          + sdělení
                        </button>
                      )}
                      {canEditPlan && (
                        <button className="btn danger blockact" style={{ marginLeft: 6, fontSize: 11, padding: "2px 8px" }}
                          title="Smazat kampaň"
                          onClick={() => {
                            const n = g.rows.length;
                            if (n > 0 && !confirm(
                              `Kampaň „${g.campaign}" obsahuje ${n} řádků.\n\n` +
                              `Smazáním zmizí i všechny jejich rozpočty, metriky a skutečnost. ` +
                              `Tohle nejde vrátit zpět.\n\nOpravdu smazat celou kampaň včetně obsahu?`)) return;
                            if (n === 0 && !confirm(`Smazat prázdnou kampaň „${g.campaign}"?`)) return;
                            run(() => {}, () => {}, () => deleteCampaign(g.campaignId, n > 0));
                          }}>Smazat kampaň</button>
                      )}
                    </td>
                    {cols.map((c) => {
                      const v = g.rows.reduce((s, r) => s + colOf(r, c), 0);
                      return <td className={`r share num ${c.kind === "q" ? "qcol" : ""}`} key={c.key}>{v ? fmtSum(v) : "–"}</td>;
                    })}
                    <SumCells budget={gt} impressions={gc.reduce((s, x) => s + x.impressions, 0)} clicks={gc.reduce((s, x) => s + x.clicks, 0)} {...groupReach(g.rows)} />
                  </tr>

                  {!g.rows.length && (
                    <tr className="emptygrp">
                      <td />
                      <td colSpan={leftCols - 1 + cols.length + rightCols}>
                        Kampaň zatím nemá žádné sdělení — přidejte ho tlačítkem „+ sdělení" výše.
                      </td>
                    </tr>
                  )}
                  {lineGroups.map((lg) => {
                    const l = lg.rows[0];
                    const lc = lg.rows.map(calcOf);
                    // oblast sdělení = oblast jeho řádků; když se liší, řádky mají výjimky
                    const key = (x: PlanRow) => JSON.stringify([...x.themes].sort((a, b) => a.themeId.localeCompare(b.themeId)).map((t) => [t.themeId, Math.round(t.share * 100)]));
                    const sameThemes = lg.rows.every((x) => key(x) === key(l));
                    const lineEditable = canEditPlan && lg.rows.every(rowEditable);
                    return (
                      <GroupBlock key={lg.id}>
                        <tr className="linehead">
                          <td style={{ boxShadow: `inset 3px 0 0 0 ${campColor(g.campaign)}` }} />
                          <td colSpan={leftCols - 1 + cols.length}>
                            <div className="linehead-box">
                              <span className="linecode" title="Kód sdělení — přiděluje se sám">{l.code}</span>
                              <label className="lf lf-msg">
                                <span>Sdělení</span>
                                <input className="txt" defaultValue={l.message} key={`msg-${lg.id}-${l.message}`} disabled={!canEditPlan}
                                  placeholder="např. Brand – podzim"
                                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                                  onBlur={(e) => {
                                    const v = e.target.value.trim();
                                    if (!v || v === l.message) { e.target.value = l.message; return; }
                                    run(() => patchLine(lg.id, { message: v }), () => patchLine(lg.id, { message: l.message }),
                                        () => updateMessageLine({ messageLineId: lg.id, message: v }));
                                  }} />
                              </label>
                              <label className="lf">
                                <span>Fáze</span>
                                <select className="txt" value={l.phase} disabled={!canEditPlan}
                                  onChange={(e) => {
                                    const v = e.target.value as (typeof PHASES)[number];
                                    run(() => patchLine(lg.id, { phase: v }), () => patchLine(lg.id, { phase: l.phase }),
                                        () => updateMessageLine({ messageLineId: lg.id, phase: v }));
                                  }}>
                                  {PHASES.map((p) => <option key={p}>{p}</option>)}
                                </select>
                              </label>
                              <label className={`lf ${l.lineTargetGroupId ? "" : "lf-warn"}`}
                                title={l.lineTargetGroupId ? "Z velikosti cílové skupiny se počítají GRP, zásah a frekvence všech řádků sdělení"
                                  : "Vyberte cílovou skupinu ze seznamu — dokud ji sdělení nemá, počítá se s cílovou skupinou plánu. Nové skupiny se zakládají v Nastavení."}>
                                <span>Cílová skupina</span>
                                <select className="txt" disabled={!canEditPlan}
                                  value={l.lineTargetGroupId ?? (l.audience && l.audience !== "—" ? "__text" : "")}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    if (v === "__text") return;
                                    const tg = targetGroups.find((t) => t.id === v) ?? null;
                                    const audience = tg ? tg.name : "";
                                    const prev = { audience: l.audience, lineTargetGroupId: l.lineTargetGroupId };
                                    run(() => patchLine(lg.id, { audience, lineTargetGroupId: tg?.id ?? null }), () => patchLine(lg.id, prev),
                                        () => updateMessageLine({ messageLineId: lg.id, audience, targetGroupId: tg?.id ?? null }));
                                  }}>
                                  <option value="">— vyberte —</option>
                                  {!l.lineTargetGroupId && l.audience && l.audience !== "—" && <option value="__text">„{l.audience}" (jen text, nepočítá se)</option>}
                                  {targetGroups.map((t) => <option key={t.id} value={t.id}>{t.name} · {kc(t.universe)} osob</option>)}
                                </select>
                              </label>
                              <label className="lf" title={sameThemes ? "Na kterou oblast sdělení míří — platí pro všechny jeho řádky" : "Řádky sdělení mají různé oblasti. Nastavením tady je sjednotíte; výjimku pro jeden řádek uděláte v jeho detailu."}>
                                <span>Oblast{sameThemes ? "" : " (různé)"}</span>
                                <ThemeCell
                                  value={sameThemes ? l.themes : []}
                                  themes={themeList}
                                  disabled={!lineEditable}
                                  onSave={(shares) => {
                                    const total = shares.reduce((a, x) => a + x.share, 0) || 1;
                                    const norm = shares.map((x) => ({ ...x, share: x.share / total }));
                                    const before = new Map(lg.rows.map((x) => [x.id, x.themes]));
                                    run(() => setData((d) => d.map((x) => (x.messageLineId === lg.id ? { ...x, themes: norm } : x))),
                                        () => setData((d) => d.map((x) => (before.has(x.id) ? { ...x, themes: before.get(x.id)! } : x))),
                                        () => setLineThemes({ messageLineId: lg.id, shares: norm }));
                                  }}
                                  onCreate={createThemeFor} />
                              </label>
                              {canEditPlan && (
                                <button className="btn lineadd" title={`Přidat řádek ke sdělení „${l.message}"`}
                                  onClick={() => run(() => {}, () => {}, () => createTactic({ messageLineId: lg.id }))}>
                                  + řádek
                                </button>
                              )}
                            </div>
                          </td>
                          <SumCells budget={lg.rows.reduce((s, r) => s + rowTotal(r), 0)}
                            impressions={lc.reduce((s, x) => s + x.impressions, 0)} clicks={lc.reduce((s, x) => s + x.clicks, 0)} {...groupReach(lg.rows)} />
                        </tr>

                        {lg.rows.map((r) => {
                          const dh = dropHint?.id === r.id ? dropHint : null;
                          const c = calcOf(r);
                          const st = statusOf(r);
                          const buy = buyOf(r);
                          const plat = platformOf(r);
                          const isOpen = open === r.id;
                          return (
                            <GroupBlock key={r.id}>
                              <tr id={`row-${r.id}`}
                                className={`trow ${isOpen ? "opened" : ""} ${dragId === r.id ? "dragging" : dh ? (dh.after ? "dropAfter" : "dropBefore") : ""}`}
                                onClick={(e) => {
                                  // klik mimo pole otevře detail řádku
                                  if ((e.target as HTMLElement).closest("input, select, button, .grip, .cellbox, .themecell")) return;
                                  setOpen(isOpen ? null : r.id);
                                }}
                                onDragOver={(e) => {
                                  if (dragCamp) return;
                                  if (!dragId || dragId === r.id) return;
                                  e.preventDefault();
                                  const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                  setDropHint({ id: r.id, after: e.clientY > box.top + box.height / 2 });
                                }}
                                onDrop={(e) => {
                                  if (!dragId || dragId === r.id) return;
                                  e.preventDefault();
                                  const id = dragId, after = dropHint?.after ?? false;
                                  setDragId(null); setDropHint(null);
                                  run(() => {}, () => {}, () => moveTactic({ tacticId: id, targetTacticId: r.id, after }));
                                }}>
                                <td style={{ boxShadow: `inset 3px 0 0 0 ${campColor(r.campaign)}`, textAlign: "center" }}>
                                  {canEditPlan && (
                                    <span className="grip" draggable
                                      title="Přetažením změníte pořadí nebo přesunete řádek do jiné kampaně"
                                      onDragStart={() => setDragId(r.id)}
                                      onDragEnd={() => { setDragId(null); setDropHint(null); }}>⠿</span>
                                  )}
                                </td>

                                <td style={{ minWidth: 220, maxWidth: 280 }}>
                                  <select className={`txt ${r.mediumId ? "" : "need"}`} disabled={!canEditPlan}
                                    value={r.platformId ? `p:${r.platformId}` : r.mediumId ? `m:${r.mediumId}` : ""}
                                    title={`${r.channel}${mediumOf(r) ? ` · nosič ${mediumOf(r)!.channelType}` : " — vyberte, kde se nakupuje"}`}
                                    onChange={(e) => {
                                      const [kind, id] = e.target.value.split(":");
                                      const m = kind === "m" ? catalog.find((x) => x.id === id) ?? null
                                        : kind === "p" ? catalog.find((x) => x.platforms.some((p) => p.id === id)) ?? null : null;
                                      const pid = kind === "p" ? id : null;
                                      const p = m?.platforms.find((x) => x.id === pid) ?? null;
                                      // typ média podle nosiče — vlastní kanály jsou Owned, PR Earned; jinak se nemění
                                      const type = m?.channelType === "Vlastní" ? "Owned" : m?.channelType === "PR" ? "Earned" : null;
                                      // platforma, která se kupuje jen za klik, přepne nákup na CPC
                                      const toCpc = !!p && !!p.cpc && !p.cpm && r.pricing !== "cpc" && m?.channelType !== "TV" && m?.channelType !== "Rádio";
                                      const prev = { mediumId: r.mediumId, platformId: r.platformId, channelType: r.channelType, mediaType: r.mediaType, pricing: r.pricing };
                                      run(() => patchRow(r.id, {
                                            mediumId: m?.id ?? null, platformId: pid, ...(m ? { channelType: m.channelType } : {}),
                                            ...(type ? { mediaType: type } : {}), ...(toCpc ? { pricing: "cpc" as const } : {}),
                                          }),
                                          () => patchRow(r.id, prev),
                                          async () => {
                                            const res = await setTacticCatalog({ tacticId: r.id, mediumId: m?.id ?? null, platformId: pid });
                                            if (!res.ok) return res;
                                            if (type && type !== r.mediaType) { const t = await updateTactic({ tacticId: r.id, mediaType: type }); if (!t.ok) return t; }
                                            if (toCpc) return setRowPricing({ tacticId: r.id, pricing: "cpc" });
                                            return res;
                                          });
                                    }}>
                                    <option value="">— vyberte —</option>
                                    {catalog.map((m) => (
                                      <optgroup key={m.id} label={`${m.name} · ${m.channelType}`}>
                                        {m.platforms.map((p) => <option key={p.id} value={`p:${p.id}`}>{m.name} › {p.name}</option>)}
                                        <option value={`m:${m.id}`}>{m.name}{m.platforms.length ? " › bez platformy" : ""}</option>
                                      </optgroup>
                                    ))}
                                  </select>
                                  <div className="rowname" title={r.channel}>{r.channel}</div>
                                </td>

                                <td>
                                  <select className={`txt pill ${r.mediaType}`} value={r.mediaType} disabled={!canEditPlan}
                                    style={{ width: 84 }}
                                    onChange={(e) => {
                                      const v = e.target.value as PlanRow["mediaType"], prev = r.mediaType;
                                      run(() => patchRow(r.id, { mediaType: v }),
                                          () => patchRow(r.id, { mediaType: prev }),
                                          () => updateTactic({ tacticId: r.id, mediaType: v }));
                                    }}>
                                    <option>Paid</option><option>Owned</option><option>Earned</option>
                                  </select>
                                </td>

                                {!clientView && <td>
                                  {isGrpPriced(r.channelType) ? (
                                    <span className="buyfixed" title="TV a rádio se nakupují na GRP — cena za bod (CPP)">CPP</span>
                                  ) : (
                                    <select className="txt" value={r.pricing ?? "cpm"} disabled={!rowEditable(r)} style={{ width: 70 }}
                                      aria-label="Jak se nakupuje" title="CPM = za tisíc impresí, CPC = za klik, Fix = balík za pevnou cenu s garantovanými impresemi"
                                      onChange={(e) => {
                                        const v = e.target.value as "cpm" | "cpc" | "fix";
                                        if (rowPrice(r) > 0 && !confirm(`Přepnout na ${v === "fix" ? "pevnou cenu (Fix)" : v.toUpperCase()}? Zadaná cena se vynuluje (Kč za tisíc impresí není Kč za klik), rozpočty zůstanou.`)) {
                                          e.target.value = r.pricing ?? "cpm";
                                          return;
                                        }
                                        run(() => patchRow(r.id, { pricing: v }), () => patchRow(r.id, { pricing: r.pricing }),
                                            () => setRowPricing({ tacticId: r.id, pricing: v }));
                                      }}>
                                      <option value="cpm">CPM</option>
                                      <option value="cpc">CPC</option>
                                      <option value="fix">Fix</option>
                                    </select>
                                  )}
                                </td>}

                                {!clientView && <td className="r" style={{ whiteSpace: "nowrap" }}>
                                  {buy === "fix" ? (
                                    <PriceCell value={r.fixImpressions ?? 0} unit={BUY_UNIT.fix} hint={priceHint(r.channelType, "fix")}
                                      placeholder="" disabled={!rowEditable(r)}
                                      onCommit={(v) => run(() => patchRow(r.id, { fixImpressions: v || null }), () => patchRow(r.id, { fixImpressions: r.fixImpressions }),
                                        () => setFixImpressions({ tacticId: r.id, value: v || null }))} />
                                  ) : (
                                    <PriceCell value={rowPrice(r)} unit={BUY_UNIT[buy]} hint={priceHint(r.channelType, r.pricing)}
                                      placeholder={defaultPriceOf(r) ? `${kc(defaultPriceOf(r)!)}` : months.some((m) => r.cells[m]?.estimated) ? "ceník" : ""}
                                      disabled={!rowEditable(r)}
                                      onCommit={(v) => run(() => {}, () => {}, () => setRowUnit({ tacticId: r.id, unitPrice: v }))} />
                                  )}
                                </td>}

                                {!clientView && <td className="r ctrcell">
                                  {c.media && !isGrpPriced(r.channelType) ? (
                                    <EstInput kind="pct" label={`CTR ${r.name}`} disabled={!rowEditable(r)}
                                      need={buy === "cpc" && r.est.ctr == null && plat?.ctr == null}
                                      value={r.est.ctr} shown={plat?.ctr ?? undefined}
                                      onCommit={(v) => run(() => patchRow(r.id, { est: { ...r.est, ctr: v as number | null } }), () => patchRow(r.id, { est: r.est }),
                                        () => setTacticEstimate({ tacticId: r.id, field: "ctr", value: v }))} />
                                  ) : <span className="share">—</span>}
                                </td>}

                                {!clientView && <td className="r ctrcell">
                                  {c.media && !isGrpPriced(r.channelType) ? (
                                    <EstInput kind="num" label={`Frekvence ${r.name}`} disabled={!rowEditable(r)}
                                      value={r.est.freq} shown={plat?.freq ?? undefined}
                                      onCommit={(v) => run(() => patchRow(r.id, { est: { ...r.est, freq: v as number | null } }), () => patchRow(r.id, { est: r.est }),
                                        () => setTacticEstimate({ tacticId: r.id, field: "freq", value: v }))} />
                                  ) : <span className="share" title="TV a rádio: frekvence z křivky (GRP ÷ zásah)">—</span>}
                                </td>}

                                {cols.map((col) => {
                                  const unit: PlanUnit = BUDGET_ONLY ? "budget" : rowUnit(r);
                                  // měsíc v kvartálu sbalený u měsíčního plánu: jen součet, needituje se
                                  if (col.kind === "q" && !weeks) {
                                    const sum = col.months.reduce((s, m) => s + metricOf(r.cells[m], r.budgets[m], r), 0);
                                    return (
                                      <td key={col.key} className="budgetcell qcol">
                                        <div className="cellbox locked filled" title="Sbalený kvartál — rozbalte v liště, chcete-li editovat">
                                          <span className="cell num" style={{ display: "block", textAlign: "right", padding: "0 7px" }}>
                                            {sum ? unitFmt(sum, viewUnit(r)) : "–"}
                                          </span>
                                        </div>
                                      </td>
                                    );
                                  }
                                  // co buňka nese: měsíc, sbalený měsíc týdenního plánu, nebo týden
                                  const isWeek = col.kind === "w";
                                  const m = col.kind === "w" ? col.months[0] : col.kind === "q" ? col.months[0] : col.key;
                                  const cell = isWeek ? r.weekCells?.[col.key] : r.cells[m];
                                  const budget = isWeek ? cell?.budget ?? 0 : r.budgets[m];
                                  const editable = isWeek ? !!r.weekEditable?.[col.key]
                                    : col.kind === "q" ? (weeks ?? []).filter((w) => w.home === m).every((w) => !!r.weekEditable?.[w.key])
                                    : r.editable[m];
                                  const inUnit = BUDGET_ONLY || view === "input" || view === unit;
                                  const commit = (v: number) => {
                                    const current = BUDGET_ONLY ? budget ?? 0 : cell?.driverValue ?? 0;
                                    if (Math.abs(current - v) < 1e-9) return;
                                    run(() => {}, () => {}, () =>
                                      isWeek ? setPlannedWeeks({ items: [{ tacticId: r.id, week: col.key, driver: unit, value: v }] })
                                      : col.kind === "q" ? spreadMonthToWeeks({ tacticId: r.id, month: m, driver: unit, value: v })
                                      : setPlannedBudget({ tacticId: r.id, month: m, driver: unit, value: v }));
                                  };
                                  return (
                                    <td key={col.key} className={`budgetcell ${col.kind === "q" ? "qcol" : ""}`}>
                                      <BudgetCell
                                        value={metricOf(cell, budget, r)}
                                        unit={viewUnit(r)}
                                        budget={budget}
                                        grp={cell?.grp ?? 0}
                                        impressions={cell?.impressions ?? 0}
                                        clicks={cell?.clicks ?? 0}
                                        reach={cell?.reach ?? 0}
                                        actual={isWeek ? 0 : r.actuals[m]}
                                        max={col.kind === "q" ? Math.max(axisMax, ...data.map((x) => x.budgets[m] ?? 0)) : axisMax}
                                        type={r.mediaType}
                                        disabled={!editable || !inUnit}
                                        lockedHint={editable && !inUnit ? `Řádek se plánuje v jednotce ${UNIT_LABEL[unit]} — upravíte ho v zobrazení Zadání` : undefined}
                                        showDerived={false}
                                        estimated={!!cell?.estimated}
                                        grpPriced={isGrpPriced(r.channelType)}
                                        grid={`${rowIdx.get(r.id) ?? 0}:${cols.indexOf(col)}`}
                                        onNav={(dr, dc) => moveFocus(rowIdx.get(r.id) ?? 0, cols.indexOf(col), dr, dc)}
                                        onPasteGrid={(text) => pasteGrid(text, rowIdx.get(r.id) ?? 0, cols.indexOf(col))}
                                        onCommit={commit}
                                        onSpread={isWeek && editable && inUnit
                                          ? (v) => run(() => {}, () => {}, () => spreadMonthToWeeks({ tacticId: r.id, month: m, driver: unit, value: v }))
                                          : undefined}
                                        spreadTitle={`Vzít číslo v buňce jako rozpočet celého měsíce (${monthLabels[m] ?? m}) a rozdělit rovnoměrně do jeho týdnů`} />
                                    </td>
                                  );
                                })}

                                <td className="r num calc calcfirst" style={{ fontWeight: 500 }} title={grand ? `${pct(c.budget / grand)} rozpočtu plánu` : undefined}>{kc(c.budget)}</td>
                                <td className="r num calc" title={isGrpPriced(r.channelType) && c.grp ? `${(Math.round(c.grp * 10) / 10).toLocaleString("cs-CZ")} TRP` : undefined}>
                                  {c.impressions ? fmtCount(c.impressions) : "—"}
                                  {isGrpPriced(r.channelType) && c.grp > 0 && <div className="sub">{(Math.round(c.grp)).toLocaleString("cs-CZ")} TRP</div>}
                                </td>
                                <td className={`r num calc ${c.clicksDerived ? "estderived" : ""}`} title={c.clicksDerived ? "Imprese × CTR" : buy === "cpc" ? "Rozpočet ÷ CPC" : undefined}>
                                  {c.clicks ? fmtCount(c.clicks) : "—"}
                                </td>
                                <td className="r num calc">{c.reach ? `${Math.round(c.reach * 100)} %` : "—"}</td>
                                <td className="r num calc" title={r.reachBy === "freq" ? "Zásah = imprese ÷ zadaná frekvence" : r.reachBy === "model" ? "Z křivky modelu — u digitálu raději zadejte frekvenci vlevo" : undefined}>
                                  {fmtFreq(c.freq)}
                                </td>
                                <td style={{ textAlign: "center" }}>
                                  <button className={`stdot ${st.level}`} aria-label="Stav řádku"
                                    title={st.level === "ok" ? "Vše se počítá. Kliknutím otevřete detail." : st.msgs.join("\n")}
                                    onClick={() => setOpen(isOpen ? null : r.id)} />
                                </td>
                                <td className="r">
                                  {canEditPlan && (
                                    <button className="rowdel" title="Smazat řádek"
                                      onClick={() => {
                                        if (!confirm(`Smazat řádek „${r.channel}"? Smažou se i jeho rozpočty a metriky.`)) return;
                                        run(() => setData((d) => d.filter((x) => x.id !== r.id)), () => setData(rows),
                                            () => deleteTactic(r.id));
                                      }}>×</button>
                                  )}
                                </td>
                              </tr>
                              {isOpen && (
                                <tr className="rowdetail">
                                  <td />
                                  <td colSpan={leftCols - 1 + cols.length + rightCols}>
                                    <div className="rowdetail-box">
                                      {st.msgs.length > 0 && (
                                        <div className={`rd-msgs ${st.level}`}>
                                          {st.msgs.map((m) => <div key={m}>{st.level === "warn" ? "⚠ " : ""}{m}</div>)}
                                        </div>
                                      )}
                                      <div className="rd-grid">
                                        <label className="lf">
                                          <span>Název položky</span>
                                          <input className="txt" defaultValue={r.channel} key={`ch-${r.id}-${r.channel}`} disabled={!canEditPlan}
                                            title="Vznikne sám z média a platformy. Přepište, je-li potřeba (např. „ag. práce“ — taková položka se do doručení nepočítá)."
                                            onBlur={(e) => {
                                              const v = e.target.value.trim();
                                              if (!v || v === r.channel) { e.target.value = r.channel; return; }
                                              run(() => patchRow(r.id, { channel: v }), () => patchRow(r.id, { channel: r.channel }),
                                                  () => updateTactic({ tacticId: r.id, channel: v }));
                                            }} />
                                        </label>
                                        <label className="lf">
                                          <span>Kreativa / formáty</span>
                                          <input className="txt" defaultValue={r.creative ?? ""} key={`cr-${r.id}-${r.creative ?? ""}`} disabled={!canEditPlan}
                                            placeholder="6s video + banner"
                                            onBlur={(e) => {
                                              const v = e.target.value.trim(), prev = r.creative ?? "";
                                              if (v === prev) return;
                                              run(() => patchRow(r.id, { creative: v || null }), () => patchRow(r.id, { creative: prev || null }),
                                                  () => setTacticEstimate({ tacticId: r.id, field: "creative", value: v || null }));
                                            }} />
                                        </label>
                                        <label className="lf">
                                          <span>Měření</span>
                                          <EstInput kind="text" label={`Měření ${r.name}`} disabled={!canEditPlan} value={r.est.measurement}
                                            onCommit={(v) => run(() => patchRow(r.id, { est: { ...r.est, measurement: v as string | null } }), () => patchRow(r.id, { est: r.est }),
                                              () => setTacticEstimate({ tacticId: r.id, field: "measurement", value: v }))} />
                                        </label>
                                        {c.media && !isGrpPriced(r.channelType) && (
                                          <label className="lf" title="Konverzní poměr z kliků. Prázdné = výchozí hodnota platformy.">
                                            <span>Konverze %{plat?.cr != null ? " · výchozí platformy šedě" : ""}</span>
                                            <EstInput kind="pct" label={`Konverze ${r.name}`} disabled={!canEditPlan}
                                              value={r.est.cr} shown={plat?.cr ?? undefined}
                                              onCommit={(v) => run(() => patchRow(r.id, { est: { ...r.est, cr: v as number | null } }), () => patchRow(r.id, { est: r.est }),
                                                () => setTacticEstimate({ tacticId: r.id, field: "cr", value: v }))} />
                                          </label>
                                        )}
                                        {c.media && c.est.conversions !== null && (
                                          <div className="lf rd-calc">
                                            <span>Konverze · CPA (dopočteno)</span>
                                            <div>{fmtCount(c.est.conversions)} · {c.est.cpa ? `${kc(c.est.cpa)} Kč` : "—"}</div>
                                          </div>
                                        )}
                                        <label className="lf" title="Výjimka z oblasti sdělení — třeba TV spot pro víc produktů rozdělený procenty">
                                          <span>Oblast řádku</span>
                                          <ThemeCell value={r.themes} themes={themeList} disabled={!canEditPlan}
                                            onSave={(shares) => {
                                              const total = shares.reduce((a, x) => a + x.share, 0) || 1;
                                              const norm = shares.map((x) => ({ ...x, share: x.share / total }));
                                              run(() => patchRow(r.id, { themes: norm }), () => patchRow(r.id, { themes: r.themes }),
                                                  () => setTacticThemes({ tacticId: r.id, shares: norm }));
                                            }}
                                            onCreate={createThemeFor} />
                                        </label>
                                        {canEditPlan && (
                                          <label className="lf">
                                            <span>Přesunout pod sdělení</span>
                                            <select className="txt" value={r.messageLineId}
                                              onChange={(e) => {
                                                const id = e.target.value;
                                                const prev = { messageLineId: r.messageLineId, message: r.message, code: r.code };
                                                const target = campaigns.flatMap((x) => x.lines).find((x) => x.id === id);
                                                run(() => patchRow(r.id, { messageLineId: id, message: lineText.get(id) ?? r.message, code: target?.code ?? r.code }),
                                                    () => patchRow(r.id, prev),
                                                    () => updateTactic({ tacticId: r.id, messageLineId: id }));
                                              }}>
                                              {[...campaigns].sort((a, b) => Number(b.id === r.campaignId) - Number(a.id === r.campaignId)).map((x) => (
                                                <optgroup key={x.id} label={x.id === r.campaignId ? `${x.name} (tato kampaň)` : x.name}>
                                                  {x.lines.map((ln) => (
                                                    <option key={ln.id} value={ln.id}>{ln.code}{lineText.get(ln.id) ? ` · ${lineText.get(ln.id)}` : ""}</option>
                                                  ))}
                                                </optgroup>
                                              ))}
                                            </select>
                                          </label>
                                        )}
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </GroupBlock>
                          );
                        })}
                      </GroupBlock>
                    );
                  })}
                </GroupBlock>
              );
            })}
            {!visible.length && (
              <tr><td colSpan={leftCols + cols.length + rightCols} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>
                {data.length ? "Žádný řádek neodpovídá filtru." : "Plán je prázdný. Začněte tlačítkem „+ Přidat kampaň“ nahoře, pak v kampani „+ sdělení“."}
              </td></tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={leftCols}>CELKEM {anyFilter ? "(výběr)" : periodName} <span className="share" style={{ fontWeight: 300 }}>v Kč</span></td>
              {cols.map((c) => (
                <td className={`r num ${c.kind === "q" ? "qcol" : ""}`} key={c.key}>{fmtSum(colTotal(c))}</td>
              ))}
              {(() => {
                const all = visible.map(calcOf);
                return <SumCells budget={selTotal} impressions={all.reduce((s, x) => s + x.impressions, 0)} clicks={all.reduce((s, x) => s + x.clicks, 0)} {...groupReach(visible)} strong />;
              })()}
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="note">
        <b>Jak zadávat:</b> sdělení popíšete jednou v jeho hlavičce (fáze, cílová skupina, oblast) — platí pro všechny jeho řádky.
        V řádku vyberete, <b>kde</b> se nakupuje, <b>jak</b> (CPM, CPC, Fix; TV a rádio CPP), <b>cenu</b>, u digitálu <b>CTR</b> (u CPC nutné) a <b>frekvenci</b> (zásah = imprese ÷ frekvence) a rozpočet do měsíců.
        Šedé sloupce vpravo se dopočítají. Tečka na konci řádku: zelená = vše se počítá, oranžová = něco chybí
        (kliknutím na řádek otevřete detail s návodem, kreativou, měřením, konverzemi a oblastí řádku), šedá = agenturní práce nebo bez rozpočtu.
        {canEditPlan && <><br /><b>Jako v Excelu:</b> Enter a šipky přeskakují mezi měsíci, Tab doprava.
        Blok zkopírovaný z Excelu vložíte Ctrl+V (⌘V) do první buňky — rozloží se doprava a dolů,
        prázdné buňky nic nepřepíšou a celé vložení vrátíte jedním Zpět.</>}
        {weeks && <><br /><b>Plán po týdnech:</b> zadáváte týdny, měsíce (i sbalené) jsou jejich součet. Týden přes přelom
        se do měsíců dělí podle dnů. Přepnout zpět na měsíce jde v Nastavení plánu.</>}
        <br />Zásah a frekvence jsou modelový odhad, ne měření. Frekvence = průměrný počet kontaktů na zasaženého za období. U digitálu se zadává (vlevo), u TV a rádia vychází z křivky. U sdělení, kampaně a celku se zásah nesčítá — počítá se znovu z GRP všech řádků s odečtením překryvu.
        {canEditPlan && <> Úchyt ⠿ přetáhne řádek (pořadí, jiná kampaň) nebo celou kampaň.</>}
      </div>
      </>)}
    </div>
  );
}

/** Fragment s klíčem — skupina je víc řádků, ne jeden element. */
function GroupBlock({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/** Formát hodnoty podle řídicí jednotky. */
function unitFmt(v: number, unit: PlanUnit): string {
  if (!v) return "";
  if (unit === "budget" || unit === "clicks") return kc(v);
  if (unit === "grp") return (Math.round(v * 10) / 10).toLocaleString("cs-CZ");
  return v >= 1_000_000
    ? (v / 1_000_000).toFixed(1).replace(".", ",") + " M"
    : kc(v);
}

function BudgetCell({
  value, unit, budget, grp, impressions, reach, actual, max, type, disabled, showDerived, estimated, onCommit,
  grid, onNav, onPasteGrid, grpPriced = false, clicks = 0, lockedHint, onSpread, spreadTitle,
}: {
  /** proč nejde psát, i když oprávnění je (jiné zobrazení než jednotka řádku) */
  lockedHint?: string;
  /** „÷ měsíc": vezme právě napsané číslo (i neuložené) a rozloží ho do týdnů měsíce */
  onSpread?: (value: number) => void;
  spreadTitle?: string;
  /** kliky u položek na CPC */
  clicks?: number;
  /** nosič se nakupuje na GRP (TV, rádio) — pod číslem ukázat GRP, jinak imprese */
  grpPriced?: boolean;
  /** souřadnice v mřížce „řádek:sloupec" — podle nich se skáče šipkami */
  grid: string;
  /** přesun na sousední buňku; false = dál už nic není */
  onNav: (dr: number, dc: number) => boolean;
  /** vložení víc buněk najednou (blok z Excelu) */
  onPasteGrid: (text: string) => void;
  showDerived: boolean;
  /** dopočet vychází z ceníku, ne z ceny položky — značí se „≈" */
  estimated: boolean;
  value: number; unit: PlanUnit;
  budget: number; grp: number; impressions: number; reach: number;
  actual: number; max: number;
  type: string; disabled: boolean; onCommit: (v: number) => void;
}) {
  /**
   * Během psaní se hodnota NEFORMÁTUJE — jinak by po každém znaku React pole
   * překreslil a kurzor skočil na konec. Mezery mezi tisíci naskočí až po
   * odkliknutí.
   */
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const shown = editing ? draft : unitFmt(value, unit);
  // pruh měří peníze i tam, kde se zadávají GRP — jinak by řádky nešly porovnat
  const w = Math.min(100, (budget / max) * 100);
  const aw = Math.min(100, (actual / max) * 100);

  /** Pod číslem se ukazuje to, co se z něj dopočítalo. U prázdné buňky nic. */
  const approx = estimated ? "≈ " : "";
  const second = !value || !showDerived ? ""
    : unit === "budget"
      // u TV a rádia se mluví v GRP, jinde v impresích (z CPM), u CPC v klicích
      ? clicks > 0 ? `${kc(clicks)} kliků`
        : grpPriced && grp > 0 ? `${approx}${Math.round(grp)} GRP`
        : impressions > 0 ? `${approx}${unitFmt(impressions, "impressions")} imp.`
        : grp > 0 ? `${approx}${Math.round(grp)} GRP` : ""
      : kc(budget) + " Kč";
  const tip = [
    budget ? `${kc(budget)} Kč` : null,
    grp ? `${(Math.round(grp * 10) / 10).toLocaleString("cs-CZ")} GRP` : null,
    impressions ? `${kc(impressions)} impressions` : null,
    clicks ? `${kc(clicks)} kliků` : null,
    reach ? `zásah ${(reach * 100).toFixed(1).replace(".", ",")} %` : null,
    actual ? `čerpáno ${kc(actual)} Kč` : null,
    estimated ? "doručení odhadnuté z ceníku" : null,
  ].filter(Boolean).join(" · ");

  return (
    <>
    {/* tlačítko mimo rámeček buňky — ten ořezává obsah */}
      {onSpread && (value > 0 || (draft ?? "").trim() !== "") && (
        <button type="button" className="spreadbtn" tabIndex={-1} title={spreadTitle}
          // mousedown by pole opustilo a uložilo hodnotu do týdne — tlačítko ji místo toho vezme jako měsíc
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const v = draft !== null ? parseNum(draft) : value;
            setDraft(null);
            if (v > 0) onSpread(v);
          }}>÷ měsíc</button>
      )}
    <div className={`cellbox ${disabled ? "locked" : "editable"} ${value ? "filled" : ""}`} title={[tip, lockedHint].filter(Boolean).join(" · ") || undefined}>

      {budget > 0 && (
        <div className="cellfill" style={{
          width: `${w}%`,
          background: `var(--${type.toLowerCase()}-fill, var(--${type.toLowerCase()}-soft))`,
        }} />
      )}
      {actual > 0 && (
        <div className="cellspent" title={`čerpáno ${kc(actual)} Kč`} style={{ width: `${aw}%` }} />
      )}
      <input
        className="cell"
        inputMode="numeric"
        disabled={disabled}
        title={disabled ? lockedHint ?? "K tomuto rozpočtu nemáte oprávnění" : undefined}
        value={shown}
        onFocus={(e) => { setDraft(value ? String(Math.round(value * 10) / 10) : ""); requestAnimationFrame(() => e.target.select()); }}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d.,]/g, ""))}
        data-grid={grid}
        onBlur={() => { if (draft !== null) { onCommit(parseNum(draft)); setDraft(null); } }}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          // jedna hodnota se vloží normálně, blok (tabulátory, řádky) se rozloží do mřížky
          if (/[\t\n]/.test(text.trim())) {
            e.preventDefault();
            // rozepsaná hodnota by se při opuštění pole zapsala přes vložená čísla
            setDraft(null);
            (e.target as HTMLInputElement).blur();
            onPasteGrid(text);
          }
        }}
        onKeyDown={(e) => {
          const el = e.target as HTMLInputElement;
          const len = el.value.length;
          const whole = el.selectionStart === 0 && el.selectionEnd === len;
          // Excel: Enter dolů, Shift+Enter nahoru; přesun fokusu uloží buňku (blur)
          if (e.key === "Enter") { e.preventDefault(); if (!onNav(e.shiftKey ? -1 : 1, 0)) el.blur(); }
          else if (e.key === "ArrowDown") { e.preventDefault(); onNav(1, 0); }
          else if (e.key === "ArrowUp") { e.preventDefault(); onNav(-1, 0); }
          // do stran jen z kraje textu — uvnitř čísla šipky posouvají kurzor
          else if (e.key === "ArrowLeft" && (whole || (el.selectionStart === 0 && el.selectionEnd === 0))) { e.preventDefault(); onNav(0, -1); }
          else if (e.key === "ArrowRight" && (whole || (el.selectionStart === len && el.selectionEnd === len))) { e.preventDefault(); onNav(0, 1); }
          else if (e.key === "Escape") { setDraft(null); el.blur(); }
        }}
      />
      {!editing && second && <span className="derived">{second}</span>}
    </div>
    </>
  );
}

/** Jednotková cena — CPP u TV a rádia, jinak CPM. */
function PriceCell({
  value, unit, hint, placeholder, disabled, onCommit,
}: { value: number; unit: string; hint: string; placeholder: string; disabled: boolean; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value ? kc(value) : "");
  return (
    <span className="pricecell" title={`${unit} — ${hint}${!value && placeholder ? ". Šedě je výchozí hodnota, platí, dokud nezadáte vlastní." : ""}`}>
      <input
        className={`cell num ${!value && !placeholder ? "need" : ""}`}
        inputMode="numeric"
        disabled={disabled}
        value={shown}
        placeholder={placeholder}
        onFocus={(e) => { setDraft(value ? String(value) : ""); requestAnimationFrame(() => e.target.select()); }}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d.,]/g, ""))}
        onBlur={() => { if (draft !== null) { onCommit(parseNum(draft)); setDraft(null); } }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") { setDraft(null); (e.target as HTMLInputElement).blur(); }
        }}
      />
      <i>{unit}</i>
    </span>
  );
}

function UndoButton({
  undoLabel, pending, onUndo,
}: { undoLabel: string | null; pending: boolean; onUndo: () => void }) {
  return (
    <button className="btn" disabled={!undoLabel || pending} onClick={onUndo}
      title={undoLabel ? `Zpět: ${undoLabel}` : "Není co vrátit"}>
      ↶ Zpět
    </button>
  );
}

function NewCampaignButton({ onCreate }: { onCreate: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  if (!open) return <button className="btn primary" onClick={() => setOpen(true)}>+ Přidat kampaň</button>;
  return (
    <form
      style={{ display: "flex", gap: 6 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onCreate(name.trim());
        setName(""); setOpen(false);
      }}
    >
      <input autoFocus placeholder="Název kampaně" value={name} onChange={(e) => setName(e.target.value)}
        style={{ font: "inherit", fontSize: 12, padding: "5px 10px", border: "1px solid var(--brand)",
          borderRadius: 4, background: "var(--surface)", color: "var(--ink)", minWidth: 170 }} />
      <button className="btn primary" type="submit">Založit</button>
      <button className="btn" type="button" onClick={() => { setOpen(false); setName(""); }}>Zrušit</button>
    </form>
  );
}

function MultiSelect({
  label, options, selected, onChange,
}: { label: string; options: string[]; selected: Set<string>; onChange: (s: Set<string>) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button className="btn" style={{ borderRadius: 999, borderColor: open ? "var(--brand)" : undefined }}
        onClick={() => setOpen((o) => !o)}>
        {label}{" "}
        {selected.size
          ? <b style={{ background: "var(--brand)", color: "#fff", borderRadius: 999, fontSize: 9.5, padding: "0 5px", marginLeft: 4 }}>{selected.size}</b>
          : <span style={{ color: "var(--muted)", fontSize: 10.5 }}>vše</span>}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 50 }} />
          <div style={{ position: "absolute", zIndex: 60, top: "calc(100% + 4px)", left: 0, minWidth: 240,
            background: "var(--surface)", border: "1px solid var(--line-strong)", borderRadius: 5,
            boxShadow: "0 6px 20px rgba(0,0,0,.14)" }}>
            <div style={{ display: "flex", gap: 10, padding: "7px 10px", borderBottom: "1px solid var(--line)" }}>
              <button className="btn" style={{ border: "none", padding: 0, fontSize: 11, textDecoration: "underline" }}
                onClick={() => onChange(new Set(options))}>Vybrat vše</button>
              <button className="btn" style={{ border: "none", padding: 0, fontSize: 11, textDecoration: "underline" }}
                onClick={() => onChange(new Set())}>Zrušit</button>
            </div>
            <div style={{ maxHeight: 270, overflow: "auto", padding: 4 }}>
              {options.map((o) => (
                <label key={o} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 7px",
                  borderRadius: 3, cursor: "pointer", fontSize: 12 }}>
                  <input type="checkbox" checked={selected.has(o)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(o); else next.delete(o);
                      onChange(next);
                    }} />
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o}</span>
                </label>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Číslo do sloupce odhadu: procenta u CTR a konverzního poměru, jinak číslo; „—" = nejde spočítat. */
const fmtCount = (v: number) => v >= 1_000_000
  ? (v / 1_000_000).toLocaleString("cs-CZ", { maximumFractionDigits: 2 }) + " mil."
  : kc(v);

const fmtFreq = (f: number) => (f ? `${f.toLocaleString("cs-CZ", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}×` : "—");

/**
 * Součty dopočtených sloupců za kampaň, sdělení nebo plán. Zásah a frekvence
 * se nesčítají — přicházejí z groupReach (model přes GRP všech řádků skupiny).
 */
function SumCells({ budget, impressions, clicks, reach, freq, strong = false }: {
  budget: number; impressions: number; clicks: number; reach: number; freq: number; strong?: boolean;
}) {
  return (
    <>
      <td className="r num calc calcfirst" style={strong ? { fontWeight: 500 } : undefined}>{kc(budget)}</td>
      <td className="r num calc">{impressions ? fmtCount(impressions) : "–"}</td>
      <td className="r num calc">{clicks ? fmtCount(clicks) : "–"}</td>
      <td className="r num calc" title="Modelový odhad přes všechny řádky skupiny — překryv médií odečtený, nesčítá se">{reach ? `${Math.round(reach * 100)} %` : "–"}</td>
      <td className="r num calc">{fmtFreq(freq)}</td>
      <td />
      <td />
    </>
  );
}

/** Pole předpokladu: číslo, procento (ukládá se jako podíl), nebo text. Prázdné = nezadáno. */
function EstInput({ kind, value, shown, label, disabled, need = false, onCommit }: {
  kind: "pct" | "num" | "text";
  /** chybí a řádek bez něj nepočítá — zvýraznit */
  need?: boolean;
  value: number | string | null;
  /** výchozí hodnota platformy, když není zadaná (šedá nápověda v poli) */
  shown?: number;
  label: string;
  disabled: boolean;
  onCommit: (v: number | string | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const toText = (v: number | string | null) =>
    v === null || v === "" ? "" : kind === "text" ? String(v)
    : String(Math.round((v as number) * (kind === "pct" ? 100 : 1) * 1000) / 1000).replace(".", ",");
  return (
    <input className={`cell estinput ${kind === "text" ? "esttext" : ""} ${need ? "need" : ""}`} aria-label={label} disabled={disabled}
      inputMode={kind === "text" ? "text" : "decimal"}
      value={draft ?? toText(value)}
      placeholder={shown !== undefined ? `≈ ${String(Math.round(shown * (kind === "pct" ? 100 : 1) * 100) / 100).replace(".", ",")}` : ""}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === null) return;
        const t = draft.trim();
        setDraft(null);
        let v: number | string | null;
        if (kind === "text") v = t || null;
        else if (!t) v = null;
        else v = kind === "pct" ? parseNum(t) / 100 : parseNum(t);
        if (v !== value) onCommit(v);
      }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setDraft(null); (e.target as HTMLInputElement).blur(); } }} />
  );
}
