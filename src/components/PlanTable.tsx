"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  setPlannedBudget, setRowUnit, setTacticMedia, updateTactic, updateMessageLine,
  moveTactic, moveCampaign, createTactic, createMessageLine, createCampaign, deleteTactic, deleteCampaign, undoLast,
  setTacticThemes, createTheme, renameCampaign, setPlannedBudgets, setPlannedWeeks, setTacticCatalog, autofillCatalog, setRowPricing,
  setTacticEstimate,
  spreadMonthToWeeks,
} from "@/lib/actions";
import type { CatalogMedium } from "@/lib/catalog";
import { estimate, sumEstimates, type Estimate } from "@/lib/estimates";
import { costKind } from "@/lib/costKind";
import { ThemeCell, type ThemeOption, type ThemeShare } from "@/components/ThemeCell";
import { Combo, type ComboOption } from "@/components/Combo";
import { isGrpPriced, priceLabel, priceHint, UNIT_LABEL } from "@/lib/crossmedia";
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
  /** cenový model: CPM, nebo CPC; null = podle nosiče */
  pricing: "cpm" | "cpc" | null;
  /** kreativa / formáty */
  creative: string | null;
  /** předpoklady odhadu výsledků (src/lib/estimates.ts) */
  est: { measurement: string | null; ctr: number | null; cr: number | null };
  /** zásah 1+ položky za období z modelu (podíl 0–1); null = bez GRP nebo agenturní práce */
  reachPct: number | null;
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
const unitsFor = (ct: ChannelType, pricing: "cpm" | "cpc" | null): PlanUnit[] =>
  !isGrpPriced(ct) && pricing === "cpc" ? ["budget", "clicks"] : ["budget", "grp", "impressions"];

/** Sloupec tabulky je buď měsíc, nebo sbalený kvartál. */
type Col =
  | { kind: "m"; key: string; label: string; months: string[] }
  | { kind: "q"; key: string; label: string; months: string[] }
  | { kind: "w"; key: string; label: string; months: string[]; title: string };

// Vždy viditelné: úchyt, sdělení, typ (Paid/Owned/Earned), kanál, oblast, nosič.
// Pod „Podrobnostmi" fáze a cílení, u agentury navíc jednotka a cena — mění se
// zřídka a plánovač je nepotřebuje mít před očima pořád.
const BASE_COLS = 7;
const RIGHT_COLS = 4;  // celkem, podíl, doručení, smazat

/**
 * Odhad výsledků — sloupce vpravo. Cena je ve sloupci Cena, zásah z modelu;
 * zadává se jen CTR a konverzní poměr, a to jen tam, kde se liší od výchozích
 * hodnot platformy. U TV, rádia a agenturní práce se nezadává nic.
 */
type EstKey = "ctr" | "cr" | "result" | "measurement";
const EST_COLS: Array<{ k: EstKey; label: string; title: string; input?: "pct" | "text" }> = [
  { k: "ctr", label: "CTR %", title: "Míra prokliku. Prázdné = výchozí hodnota platformy (šedě), nastavuje se v Nastavení → Média a platformy", input: "pct" },
  { k: "cr", label: "Konv. %", title: "Konverzní poměr z kliků. Prázdné = výchozí hodnota platformy (šedě)", input: "pct" },
  { k: "result", label: "Odhad výsledků", title: "Kliky, konverze a CPA z doručení a předpokladů; zásah 1+ z modelu. Modelový odhad, ne měření." },
  { k: "measurement", label: "Měření", title: "Jak se výsledek měří (brandlift, GA4…)", input: "text" },
];

export function PlanTable({
  rows, campaigns, planId, months, monthLabels, quarters, periodName, canEditPlan, undoLabel, clientView = false,
  themes = [], weeks = null, catalog = [],
}: {
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
  const [details, setDetails] = useState(false);
  const [showEst, setShowEst] = useState(false);
  useEffect(() => {
    try { setShowEst(localStorage.getItem("plan.odhad") === "1"); } catch { /* bez úložiště */ }
  }, []);
  const toggleEst = () => setShowEst((v) => {
    try { localStorage.setItem("plan.odhad", v ? "0" : "1"); } catch { /* bez úložiště */ }
    return !v;
  });
  const rightCols = RIGHT_COLS + (showEst && !clientView ? EST_COLS.length : 0);
  useEffect(() => {
    try { setDetails(localStorage.getItem("plan.podrobnosti") === "1"); } catch { /* bez úložiště */ }
  }, []);
  const toggleDetails = () => {
    setDetails((d) => {
      try { localStorage.setItem("plan.podrobnosti", d ? "0" : "1"); } catch { /* bez úložiště */ }
      return !d;
    });
  };
  // jednotka a cena jsou vidět vždy — zadat CPM a rozpočet a nechat dopočítat
  // imprese je běžná práce plánovače, ne „podrobnost"
  const showUnit = !clientView && !BUDGET_ONLY;
  // cena (CPM/CPC/CPP) je vidět i v režimu jen Kč — z ní se dopočítají prokliky a imprese
  const showPrice = !clientView;
  const leftCols = BASE_COLS + (details ? 3 : 0) + (showUnit ? 1 : 0) + (showPrice ? 1 : 0);
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
  /** Doručení řádku za období — jedna jednotka podle toho, jak se položka nakupuje. */
  const deliveryOf = (r: PlanRow): { text: string; hint: string } => {
    const sum = (k: "clicks" | "impressions" | "grp") => months.reduce((s, m) => s + (r.cells[m]?.[k] ?? 0), 0);
    if (!isGrpPriced(r.channelType) && r.pricing === "cpc") {
      const v = sum("clicks");
      return v ? { text: `${kc(v)} prokliků`, hint: "Z rozpočtu a CPC" } : { text: "—", hint: "Doplňte CPC v ceně" };
    }
    if (isGrpPriced(r.channelType)) {
      const v = sum("grp");
      // u TV a rádia se plánuje v TRP — GRP v cílové skupině kampaně (tak je bere i import z Excelu)
      return v ? { text: `${(Math.round(v * 10) / 10).toLocaleString("cs-CZ")} TRP`, hint: "TRP = GRP v cílové skupině kampaně; z rozpočtu a ceny za bod (CPP)" } : { text: "—", hint: "Doplňte cenu za bod (CPP) v ceně" };
    }
    const v = sum("impressions");
    return v ? { text: `${unitFmt(v, "impressions")} imp.`, hint: "Z rozpočtu a CPM (nebo z ceníku)" } : { text: "—", hint: "Doplňte CPM v ceně nebo v ceníku" };
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


  const lineOptions: ComboOption[] = useMemo(() => {
    const seen = new Map<string, ComboOption>();
    for (const r of rows) {
      if (!seen.has(r.messageLineId)) {
        seen.set(r.messageLineId, { value: r.messageLineId, label: r.message, hint: `${r.code} · ${r.campaign}` });
      }
    }
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label, "cs"));
  }, [rows]);

  const campaignLines = (campaignId: string) =>
    campaigns.find((c) => c.id === campaignId)?.lines ?? [];
  /** text sdělení podle linky — do nabídky „přesunout pod sdělení" */
  const lineText = useMemo(() => new Map(rows.map((r) => [r.messageLineId, r.message])), [rows]);

  return (
    <div className="panel sticky">
      <div className="toolbar">
        {(["Paid", "Owned", "Earned"] as const).map((ty) => (
          <button key={ty} className="btn" aria-pressed={types[ty]}
            style={types[ty]
              ? { background: `var(--${ty.toLowerCase()}-soft)`, borderColor: `var(--${ty.toLowerCase()})`, borderRadius: 999 }
              : { borderRadius: 999, color: "var(--muted)" }}
            onClick={() => setTypes((t) => ({ ...t, [ty]: !t[ty] }))}>{ty}</button>
        ))}
        {groupsOfCols.length > 1 && (
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
        {!clientView && (
          <button className="btn" aria-pressed={showEst} onClick={toggleEst}
            title="Předpoklady (CPM, CPC, CTR, konverzní poměr, frekvence) a dopočtené imprese, kliky, konverze, CPA a zásah">
            {showEst ? "Skrýt odhad výsledků" : "Odhad výsledků"}
          </button>
        )}
        <button className="btn" aria-pressed={details} onClick={toggleDetails}
          title="Fáze, cílení a u agentury jednotka a cena položky">
          {details ? "Skrýt podrobnosti" : "Podrobnosti"}
        </button>
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
      {info && !error && (
        <div className="banner info" style={{ margin: 0, borderRadius: 0 }}>
          <span>{info}</span>
          <span className="spacer" />
          <button className="linkbtn" onClick={() => setInfo(null)}>zavřít</button>
        </div>
      )}

      <div className="scroll stick">
        {/* bez práva na úpravu se tabulka kreslí jako text, ne jako zašedlý formulář */}
        <table className={`plan ${canEditPlan ? "" : "ro"}`}>
          <thead>
            <tr>
              <th style={{ width: 28 }} />
              <th>Sdělení</th>
              {details && <th>Fáze</th>}
              {details && <th>Cílení</th>}
              {details && <th>Kreativa / formáty</th>}
              <th>Typ</th>
              <th title="Kde se nakupuje (Google Ads, Meta Ads, Nova…). Určuje nosič.">Médium</th>
              <th title="Typ kampaně nebo prostor v médiu (Search, Performance Max, YouTube…)">Platforma</th>
              <th title="Na kterou tematickou oblast položka míří — u smíšených podíl v %">Oblast</th>
              <th>Nosič</th>
              {showUnit && <th>Jednotka</th>}
              {showPrice && <th className="r" title="CPP u TV a rádia (Kč za 1 GRP), jinak CPM (Kč za 1 000 impresí). S rozpočtem se z ní dopočítají imprese nebo GRP.">Cena (Kč)</th>}
              {cols.map((c) => (
                <th className={`r ${c.kind === "q" ? "qcol" : ""}`} key={c.key}
                    title={c.kind === "q" ? `${c.label} — sbaleno, rozbalíte v liště` : c.kind === "w" ? `Týden ${c.title}` : undefined}>
                  {c.label}
                </th>
              ))}
              <th className="r">Celkem ({sumKey === "budget" ? "Kč" : UNIT_LABEL[sumKey].toLowerCase()})</th>
              <th className="r">Podíl</th>
              <th className="r" title="Co plán za období doručí: u CPC prokliky, u CPM imprese, u TV a rádia TRP. Počítá se z Kč a ceny.">Doručení</th>
              {showEst && !clientView && EST_COLS.map((e, i) => (
                <th key={e.k} className={`r estcol ${e.input ? "estin" : ""} ${i === 0 ? "estfirst" : ""}`} title={e.title}>{e.label}</th>
              ))}
              <th style={{ width: 30 }} />
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const gt = g.rows.reduce((s, r) => s + rowTotal(r), 0);
              const lines = campaignLines(g.campaignId);
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
                        <span className="grip" draggable title="Přetažením změníte pořadí bloků"
                          onDragStart={() => setDragCamp(g.campaignId)}
                          onDragEnd={() => { setDragCamp(null); setDropCamp(null); }}
                          style={{ marginRight: 8 }}>⠿</span>
                      )}
                      <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2,
                        background: campColor(g.campaign), marginRight: 7 }} />
                      {canEditPlan ? (
                        <input className="txt blockname" defaultValue={g.campaign} aria-label="Název bloku"
                          title="Klikněte a přepište název bloku"
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
                      <span className="share" style={{ fontWeight: 300 }}>{g.rows.length} taktik</span>
                      {canEditPlan && lines[0] && (
                        <button className="btn blockact" style={{ marginLeft: 10, fontSize: 11, padding: "2px 8px" }}
                          title="Přidá řádek k prvnímu sdělení bloku — k jinému sdělení použijte „+ řádek“ u něj"
                          onClick={() => run(() => {}, () => {}, () => createTactic({ messageLineId: lines[0].id }))}>
                          + Taktika
                        </button>
                      )}
                      {canEditPlan && (
                        <button className="btn blockact" style={{ marginLeft: 6, fontSize: 11, padding: "2px 8px" }}
                          title="Nové sdělení v tomto bloku, rovnou s první taktikou"
                          onClick={() => run(() => {}, () => {}, () => createMessageLine({ campaignId: g.campaignId }))}>
                          + Linka sdělení
                        </button>
                      )}
                      {canEditPlan && (
                        <button className="btn danger blockact" style={{ marginLeft: 6, fontSize: 11, padding: "2px 8px" }}
                          title="Smazat blok"
                          onClick={() => {
                            const n = g.rows.length;
                            if (n > 0 && !confirm(
                              `Blok „${g.campaign}" obsahuje ${n} taktik.\n\n` +
                              `Smazáním zmizí i všechny jejich rozpočty, metriky a skutečnost. ` +
                              `Tohle nejde vrátit zpět.\n\nOpravdu smazat celý blok včetně obsahu?`)) return;
                            if (n === 0 && !confirm(`Smazat prázdný blok „${g.campaign}"?`)) return;
                            run(() => {}, () => {}, () => deleteCampaign(g.campaignId, n > 0));
                          }}>Smazat blok</button>
                      )}
                    </td>
                    {cols.map((c) => {
                      const v = g.rows.reduce((s, r) => s + colOf(r, c), 0);
                      return <td className={`r share num ${c.kind === "q" ? "qcol" : ""}`} key={c.key}>{v ? fmtSum(v) : "–"}</td>;
                    })}
                    <td className="r num">{fmtSum(gt)}</td>
                    <td className="r share num">{grand ? pct(gt / grand) : ""}</td>
                    <td />
                    {showEst && !clientView && <EstSumCells sum={sumEstimates(g.rows.map((r) => ({ budget: budgetOf(r), est: estOf(r) })))} />}
                    <td />
                  </tr>

                  {!g.rows.length && (
                    <tr className="emptygrp">
                      <td />
                      <td colSpan={leftCols - 1 + cols.length + rightCols}>
                        Blok zatím nemá žádnou taktiku — přidejte ji tlačítkem „+ Taktika" výše.
                      </td>
                    </tr>
                  )}
                  {g.rows.map((r) => {
                    const dh = dropHint?.id === r.id ? dropHint : null;
                    return (
                      <tr key={r.id}
                        className={dragId === r.id ? "dragging" : dh ? (dh.after ? "dropAfter" : "dropBefore") : ""}
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
                              title="Přetažením změníte pořadí nebo přeřadíte taktiku"
                              onDragStart={() => setDragId(r.id)}
                              onDragEnd={() => { setDragId(null); setDropHint(null); }}>⠿</span>
                          )}
                        </td>

                        <td style={{ maxWidth: 230, minWidth: 190 }}>
                          <Combo
                            value={r.message}
                            options={lineOptions}
                            disabled={!canEditPlan}
                            placeholder="sdělení"
                            onCommit={(text, opt) => {
                              // výběr z nabídky = přeřazení pod existující linku,
                              // vlastní text = přejmenování té současné
                              if (opt && opt.value !== r.messageLineId) {
                                run(() => patchRow(r.id, { messageLineId: opt.value, message: opt.label }),
                                    () => patchRow(r.id, { messageLineId: r.messageLineId, message: r.message }),
                                    () => updateTactic({ tacticId: r.id, messageLineId: opt.value }));
                              } else if (text !== r.message) {
                                run(() => patchLine(r.messageLineId, { message: text }),
                                    () => patchLine(r.messageLineId, { message: r.message }),
                                    () => updateMessageLine({ messageLineId: r.messageLineId, message: text }));
                              }
                            }} />
                          <div className="share" style={{ paddingLeft: 6, display: "flex", gap: 8, alignItems: "center" }}>
                            {canEditPlan ? (
                              /* přeřazení řádku pod jiné sdělení — např. z -2 na -1; nabídka hlavně z vlastního bloku */
                              <select className="linesel" value={r.messageLineId} aria-label="Sdělení řádku"
                                title="Přesunout řádek pod jiné sdělení"
                                onChange={(e) => {
                                  const id = e.target.value;
                                  const prev = { messageLineId: r.messageLineId, message: r.message, code: r.code };
                                  const target = campaigns.flatMap((c) => c.lines).find((l) => l.id === id);
                                  run(() => patchRow(r.id, { messageLineId: id, message: lineText.get(id) ?? r.message, code: target?.code ?? r.code }),
                                      () => patchRow(r.id, prev),
                                      () => updateTactic({ tacticId: r.id, messageLineId: id }));
                                }}>
                                {[...campaigns].sort((a, b) => Number(b.id === r.campaignId) - Number(a.id === r.campaignId)).map((c) => (
                                  <optgroup key={c.id} label={c.id === r.campaignId ? `${c.name} (tento blok)` : c.name}>
                                    {c.lines.map((l) => (
                                      <option key={l.id} value={l.id}>{l.code}{lineText.get(l.id) ? ` · ${lineText.get(l.id)}` : ""}</option>
                                    ))}
                                  </optgroup>
                                ))}
                              </select>
                            ) : r.code}
                            {/* nový řádek patří k TOMUHLE sdělení — tlačítko v bloku přidává k prvnímu */}
                            {canEditPlan && (
                              <button className="linkbtn rowadd" title={`Přidat řádek ke sdělení „${r.message}"`}
                                onClick={() => run(() => {}, () => {}, () => createTactic({ messageLineId: r.messageLineId }))}>
                                + řádek
                              </button>
                            )}
                          </div>
                        </td>

                        {details && <td>
                          <select className="txt" value={r.phase} disabled={!canEditPlan} style={{ minWidth: 118 }}
                            onChange={(e) => {
                              const v = e.target.value as (typeof PHASES)[number], prev = r.phase;
                              run(() => patchLine(r.messageLineId, { phase: v }),
                                  () => patchLine(r.messageLineId, { phase: prev }),
                                  () => updateMessageLine({ messageLineId: r.messageLineId, phase: v }));
                            }}>
                            {PHASES.map((p) => <option key={p}>{p}</option>)}
                          </select>
                        </td>}

                        {details && <td style={{ minWidth: 120, maxWidth: 170 }}>
                          <input className="txt" defaultValue={r.audience} disabled={!canEditPlan} title={r.audience}
                            key={`aud-${r.messageLineId}-${r.audience}`}
                            onBlur={(e) => {
                              const v = e.target.value, prev = r.audience;
                              if (v === prev) return;
                              run(() => patchLine(r.messageLineId, { audience: v }),
                                  () => patchLine(r.messageLineId, { audience: prev }),
                                  () => updateMessageLine({ messageLineId: r.messageLineId, audience: v }));
                            }} />
                        </td>}
                        {details && <td style={{ minWidth: 150, maxWidth: 220 }}>
                          <input className="txt" defaultValue={r.creative ?? ""} disabled={!canEditPlan} title={r.creative ?? ""}
                            key={`cr-${r.id}-${r.creative ?? ""}`} placeholder="např. 6s video + banner"
                            onBlur={(e) => {
                              const v = e.target.value.trim(), prev = r.creative ?? "";
                              if (v === prev) return;
                              run(() => patchRow(r.id, { creative: v || null }), () => patchRow(r.id, { creative: prev || null }),
                                  () => setTacticEstimate({ tacticId: r.id, field: "creative", value: v || null }));
                            }} />
                        </td>}

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

                        <td style={{ minWidth: 150 }}>
                          <select className="txt" value={r.mediumId ?? ""} disabled={!canEditPlan}
                            title={`${r.channel}${mediumOf(r) ? ` · nosič ${mediumOf(r)!.channelType}` : " — vyberte médium, určí i nosič"}`}
                            onChange={(e) => {
                              const m = catalog.find((x) => x.id === e.target.value) ?? null;
                              const prev = { mediumId: r.mediumId, platformId: r.platformId, channelType: r.channelType };
                              run(() => patchRow(r.id, { mediumId: m?.id ?? null, platformId: null, ...(m ? { channelType: m.channelType } : {}) }),
                                  () => patchRow(r.id, prev),
                                  () => setTacticCatalog({ tacticId: r.id, mediumId: m?.id ?? null, platformId: null }));
                            }}>
                            <option value="">— vybrat —</option>
                            {[...new Set(catalog.map((m) => m.channelType))].map((ct) => (
                              <optgroup key={ct} label={ct}>
                                {catalog.filter((m) => m.channelType === ct).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                              </optgroup>
                            ))}
                          </select>
                        </td>
                        <td style={{ minWidth: 140 }}>
                          <select className="txt" value={r.platformId ?? ""} disabled={!canEditPlan || !mediumOf(r)}
                            title={mediumOf(r) ? "Platforma vybraného média" : "Nejdřív vyberte médium"}
                            onChange={(e) => {
                              const pid = e.target.value || null, prev = r.platformId;
                              run(() => patchRow(r.id, { platformId: pid }), () => patchRow(r.id, { platformId: prev }),
                                  () => setTacticCatalog({ tacticId: r.id, mediumId: r.mediumId, platformId: pid }));
                            }}>
                            <option value="">{mediumOf(r) ? "— vybrat —" : "—"}</option>
                            {mediumOf(r)?.platforms.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        </td>
                        <td style={{ minWidth: 130 }}>
                          <ThemeCell
                            value={r.themes}
                            themes={themeList}
                            disabled={!canEditPlan}
                            onSave={(shares) => {
                              const total = shares.reduce((a, x) => a + x.share, 0) || 1;
                              const norm = shares.map((x) => ({ ...x, share: x.share / total }));
                              run(() => patchRow(r.id, { themes: norm }), () => patchRow(r.id, { themes: r.themes }),
                                  () => setTacticThemes({ tacticId: r.id, shares: norm }));
                            }}
                            onCreate={async (name) => {
                              const res = await createTheme({ planId, name });
                              if (!res.ok || !res.themeId) { setError(res.ok ? "Oblast se nepodařilo založit." : res.error); return null; }
                              setThemeList((l) => l.some((t) => t.id === res.themeId) ? l : [...l, { id: res.themeId!, name }]);
                              return res.themeId;
                            }} />
                        </td>

                        <td>
                          <select className="txt pill" value={r.channelType} disabled={!canEditPlan}
                            style={{ width: 86 }}
                            title="Nosič rozhoduje, jestli se nakupuje na GRP nebo na tisíc kontaktů"
                            onChange={(e) => {
                              const v = e.target.value as ChannelType, prev = r.channelType;
                              run(() => patchRow(r.id, { channelType: v }),
                                  () => patchRow(r.id, { channelType: prev }),
                                  () => setTacticMedia({ tacticId: r.id, channelType: v }));
                            }}>
                            {CHANNEL_TYPES.map((t) => <option key={t}>{t}</option>)}
                          </select>
                        </td>

                        {showUnit && <td>
                          <select className="txt" value={rowUnit(r)} disabled={!rowEditable(r)}
                            style={{ width: 104 }}
                            title="Co zadáváte do měsíců. Zbylé jednotky se dopočítají."
                            onChange={(e) => {
                              const v = e.target.value as PlanUnit;
                              run(() => {}, () => {}, () => setRowUnit({ tacticId: r.id, driver: v }));
                            }}>
                            {unitsFor(r.channelType, r.pricing).map((u) => <option key={u} value={u}>{UNIT_LABEL[u]}</option>)}
                          </select>
                        </td>}

                        {showPrice && <td className="r" style={{ whiteSpace: "nowrap" }}>
                          {/* CPM, nebo CPC — u TV a rádia je cena vždy CPP */}
                          {!isGrpPriced(r.channelType) && (
                            <select className="txt pricemodel" value={r.pricing ?? "cpm"} disabled={!rowEditable(r)}
                              aria-label="Cenový model" title="Nakupuje se za tisíc impresí (CPM), nebo za klik (CPC)?"
                              onChange={(e) => {
                                const v = e.target.value as "cpm" | "cpc";
                                if (rowPrice(r) > 0 && !confirm(`Přepnout na ${v.toUpperCase()}? Cena za jednotku se vynuluje (Kč za tisíc impresí není Kč za klik), rozpočty zůstanou.`)) {
                                  e.target.value = r.pricing ?? "cpm";
                                  return;
                                }
                                run(() => patchRow(r.id, { pricing: v }), () => patchRow(r.id, { pricing: r.pricing }),
                                    () => setRowPricing({ tacticId: r.id, pricing: v }));
                              }}>
                              <option value="cpm">CPM</option>
                              <option value="cpc">CPC</option>
                            </select>
                          )}
                          <PriceCell
                            value={rowPrice(r)}
                            label={priceLabel(r.channelType, r.pricing)}
                            hint={priceHint(r.channelType, r.pricing)}
                            disabled={!rowEditable(r)}
                            onCommit={(v) => run(() => {}, () => {}, () => setRowUnit({ tacticId: r.id, unitPrice: v }))} />
                        </td>}

                        {cols.map((c) => {
                          const unit: PlanUnit = BUDGET_ONLY ? "budget" : rowUnit(r);
                          // měsíc v kvartálu sbalený u měsíčního plánu: jen součet, needituje se
                          if (c.kind === "q" && !weeks) {
                            const sum = c.months.reduce((s, m) => s + metricOf(r.cells[m], r.budgets[m], r), 0);
                            return (
                              <td key={c.key} className="budgetcell qcol">
                                <div className="cellbox locked filled" title="Sbalený kvartál — rozbalte v liště, chcete-li editovat">
                                  <span className="cell num" style={{ display: "block", textAlign: "right", padding: "0 7px" }}>
                                    {sum ? unitFmt(sum, viewUnit(r)) : "–"}
                                  </span>
                                </div>
                              </td>
                            );
                          }
                          // co buňka nese: měsíc, sbalený měsíc týdenního plánu, nebo týden
                          const isWeek = c.kind === "w";
                          const m = c.kind === "w" ? c.months[0] : c.kind === "q" ? c.months[0] : c.key;
                          const cell = isWeek ? r.weekCells?.[c.key] : r.cells[m];
                          const budget = isWeek ? cell?.budget ?? 0 : r.budgets[m];
                          const editable = isWeek ? !!r.weekEditable?.[c.key]
                            : c.kind === "q" ? (weeks ?? []).filter((w) => w.home === m).every((w) => !!r.weekEditable?.[w.key])
                            : r.editable[m];
                          // v jiném zobrazení než v jednotce řádku se jen čte — psát Kč do řádku na GRP by změnilo model
                          const inUnit = BUDGET_ONLY || view === "input" || view === unit;
                          const commit = (v: number) => {
                            const current = BUDGET_ONLY ? budget ?? 0 : cell?.driverValue ?? 0;
                            if (Math.abs(current - v) < 1e-9) return;
                            run(() => {}, () => {}, () =>
                              isWeek ? setPlannedWeeks({ items: [{ tacticId: r.id, week: c.key, driver: unit, value: v }] })
                              : c.kind === "q" ? spreadMonthToWeeks({ tacticId: r.id, month: m, driver: unit, value: v })
                              : setPlannedBudget({ tacticId: r.id, month: m, driver: unit, value: v }));
                          };
                          return (
                            <td key={c.key} className={`budgetcell ${c.kind === "q" ? "qcol" : ""}`}>
                              <BudgetCell
                                value={metricOf(cell, budget, r)}
                                unit={viewUnit(r)}
                                budget={budget}
                                grp={cell?.grp ?? 0}
                                impressions={cell?.impressions ?? 0}
                                clicks={cell?.clicks ?? 0}
                                reach={cell?.reach ?? 0}
                                actual={isWeek ? 0 : r.actuals[m]}
                                max={c.kind === "q" ? Math.max(axisMax, ...data.map((x) => x.budgets[m] ?? 0)) : axisMax}
                                type={r.mediaType}
                                disabled={!editable || !inUnit}
                                lockedHint={editable && !inUnit ? `Řádek se plánuje v jednotce ${UNIT_LABEL[unit]} — upravíte ho v zobrazení Zadání` : undefined}
                                showDerived={false}
                                estimated={!!cell?.estimated}
                                grpPriced={isGrpPriced(r.channelType)}
                                grid={`${rowIdx.get(r.id) ?? 0}:${cols.indexOf(c)}`}
                                onNav={(dr, dc) => moveFocus(rowIdx.get(r.id) ?? 0, cols.indexOf(c), dr, dc)}
                                onPasteGrid={(text) => pasteGrid(text, rowIdx.get(r.id) ?? 0, cols.indexOf(c))}
                                onCommit={commit}
                                // týden: zadané číslo jako rozpočet celého měsíce → rovnoměrně do jeho týdnů
                                onSpread={isWeek && editable && inUnit
                                  ? (v) => run(() => {}, () => {}, () => spreadMonthToWeeks({ tacticId: r.id, month: m, driver: unit, value: v }))
                                  : undefined}
                                spreadTitle={`Vzít číslo v buňce jako rozpočet celého měsíce (${monthLabels[m] ?? m}) a rozdělit rovnoměrně do jeho týdnů`} />
                            </td>
                          );
                        })}

                        <td className="r num" style={{ fontWeight: 500 }}>{fmtSum(rowTotal(r))}</td>
                        <td className="r share num">{grand ? pct(rowTotal(r) / grand) : "—"}</td>
                        <td className="r num delivery" title={deliveryOf(r).hint}>{deliveryOf(r).text}</td>
                        {showEst && !clientView && (() => {
                          const est = estOf(r);
                          const plat = platformOf(r);
                          return EST_COLS.map((e, i) => (
                            <td key={e.k} className={`r num estcol ${e.input ? "estin" : ""} ${i === 0 ? "estfirst" : ""}`}>
                              {e.k === "result" ? <EstResult est={est} reachPct={r.reachPct} applies={estApplies(r)} fee={costKind(r.channel) !== "media"} />
                              : (e.k === "ctr" || e.k === "cr") && !estApplies(r) ? null
                              : (
                                <EstInput kind={e.input!} label={`${e.label} ${r.name}`} disabled={!canEditPlan}
                                  value={r.est[e.k]}
                                  shown={e.k === "ctr" ? plat?.ctr ?? undefined : e.k === "cr" ? plat?.cr ?? undefined : undefined}
                                  onCommit={(v) => run(() => patchRow(r.id, { est: { ...r.est, [e.k]: v } }), () => patchRow(r.id, { est: r.est }),
                                    () => setTacticEstimate({ tacticId: r.id, field: e.k as "ctr" | "cr" | "measurement", value: v }))} />
                              )}
                            </td>
                          ));
                        })()}
                        <td className="r">
                          {canEditPlan && (
                            <button className="rowdel" title="Smazat taktiku"
                              onClick={() => {
                                if (!confirm(`Smazat taktiku „${r.channel}"? Smažou se i její rozpočty a metriky.`)) return;
                                run(() => setData((d) => d.filter((x) => x.id !== r.id)), () => setData(rows),
                                    () => deleteTactic(r.id));
                              }}>×</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </GroupBlock>
              );
            })}
            {!visible.length && (
              <tr><td colSpan={leftCols + cols.length + rightCols} style={{ padding: 24, textAlign: "center", color: "var(--muted)" }}>
                Žádná taktika neodpovídá filtru.
              </td></tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={leftCols}>CELKEM {anyFilter ? "(výběr)" : periodName} <span className="share" style={{ fontWeight: 300 }}>{sumKey === "budget" ? "v Kč" : `· ${UNIT_LABEL[sumKey].toLowerCase()}`}</span></td>
              {cols.map((c) => (
                <td className={`r num ${c.kind === "q" ? "qcol" : ""}`} key={c.key}>{fmtSum(colTotal(c))}</td>
              ))}
              <td className="r num">{fmtSum(selTotal)}</td>
              <td className="r num">{grand ? pct(selTotal / grand) : "—"}</td>
              <td />
              {showEst && !clientView && <EstSumCells sum={sumEstimates(visible.map((r) => ({ budget: budgetOf(r), est: estOf(r) })))} />}
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="note">
        {canEditPlan && <><b>Jako v Excelu:</b> Enter a šipky přeskakují mezi měsíci, Tab doprava.
        Blok zkopírovaný z Excelu vložíte Ctrl+V (⌘V) do první buňky — rozloží se doprava a dolů,
        prázdné buňky nic nepřepíšou a celé vložení vrátíte jedním Zpět.<br /></>}
        {weeks && <><b>Plán po týdnech:</b> zadáváte týdny, měsíce (i sbalené) jsou jejich součet. Týden přes přelom
        se do měsíců dělí podle dnů. Přepnout zpět na měsíce jde v Nastavení plánu.<br /></>}
        Délka pruhu = investice v {weeks ? "týdnu" : "měsíci"} na společném měřítku 0–{kc(axisMax)} Kč, oranžový proužek u dna =
        skutečné čerpání. Barevný proužek u levého okraje řádku = kampaň.
        {canEditPlan && <> Úchyt ⠿ u řádku přetáhne taktiku — mezi řádky změní pořadí, na jiný blok ji přesune;
        úchyt u názvu bloku přetahuje celý blok.</>}
        <br />
        <b>Sdělení, fáze a cílová skupina patří lince sdělení</b>, ne jednotlivé taktice — změna se projeví
        u všech taktik téže linky. Kanál a typ média jsou vlastní každé taktice.
        Při přesunu taktiky do jiného bloku si <b>své sdělení, fázi i cílovku nese s sebou</b> — v cílovém bloku
        se použije shodná linka, a když tam žádná není, založí se její kopie.
      </div>
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
  value, label, hint, disabled, onCommit,
}: { value: number; label: string; hint: string; disabled: boolean; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value ? kc(value) : "");
  return (
    <span className="pricecell" title={`${label} — ${hint}`}>
      <input
        className="cell num"
        inputMode="numeric"
        disabled={disabled}
        value={shown}
        placeholder={label}
        onFocus={(e) => { setDraft(value ? String(value) : ""); requestAnimationFrame(() => e.target.select()); }}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d.,]/g, ""))}
        onBlur={() => { if (draft !== null) { onCommit(parseNum(draft)); setDraft(null); } }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") { setDraft(null); (e.target as HTMLInputElement).blur(); }
        }}
      />
      {value > 0 && <i>{label}</i>}
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
  if (!open) return <button className="btn primary" onClick={() => setOpen(true)}>+ Přidat blok</button>;
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
      <input autoFocus placeholder="Název bloku" value={name} onChange={(e) => setName(e.target.value)}
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

/** Výsledek položky jedním řádkem: kliky · konverze · CPA, u TV a rádia zásah 1+. */
function EstResult({ est, reachPct, applies, fee }: { est: Estimate; reachPct: number | null; applies: boolean; fee: boolean }) {
  if (fee) return <span className="share">agenturní práce</span>;
  const parts: React.ReactNode[] = [];
  if (applies && est.clicks !== null) {
    parts.push(<span key="k" className={est.derived.clicks ? "estderived" : undefined}
      title={est.derived.clicks ? "Kliky = imprese × CTR" : "Kliky z rozpočtu a CPC"}>{fmtCount(est.clicks)} kliků</span>);
  }
  if (est.conversions !== null) parts.push(<span key="c">{fmtCount(est.conversions)} konv.</span>);
  if (est.cpa !== null) parts.push(<span key="a">CPA {kc(est.cpa)} Kč</span>);
  if (reachPct !== null) {
    parts.push(<span key="r" title="Zásah 1+ položky za období z modelu (křivka nosiče) — modelový odhad, ne měření">
      zásah 1+ {(reachPct * 100).toLocaleString("cs-CZ", { maximumFractionDigits: 0 })} %</span>);
  }
  if (!parts.length) {
    return <span className="share" title={applies ? "Doplňte cenu (CPM/CPC) a CTR — u položky, nebo jako výchozí u platformy" : undefined}>—</span>;
  }
  return <span className="estresult">{parts.flatMap((p, i) => (i ? [<span key={`s${i}`} className="share"> · </span>, p] : [p]))}</span>;
}

function EstSumCells({ sum }: { sum: ReturnType<typeof sumEstimates> }) {
  const parts = [
    sum.clicks !== null ? `${fmtCount(sum.clicks)} kliků` : null,
    sum.conversions !== null ? `${fmtCount(sum.conversions)} konv.` : null,
    sum.cpa !== null ? `CPA ${kc(sum.cpa)} Kč` : null,
  ].filter(Boolean);
  return (
    <>
      {EST_COLS.map((e, i) => (
        <td key={e.k} className={`r num share estcol ${i === 0 ? "estfirst" : ""}`}
          title={e.k === "result" ? "Součet kliků a konverzí; zásah se přes položky nesčítá — je v Přehledu" : undefined}>
          {e.k === "result" ? parts.join(" · ") : ""}
        </td>
      ))}
    </>
  );
}

/** Pole předpokladu: číslo, procento (ukládá se jako podíl), nebo text. Prázdné = nezadáno. */
function EstInput({ kind, value, shown, label, disabled, onCommit }: {
  kind: "pct" | "text";
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
    : String(Math.round((v as number) * 100 * 1000) / 1000).replace(".", ",");
  return (
    <input className={`cell estinput ${kind === "text" ? "esttext" : ""}`} aria-label={label} disabled={disabled}
      inputMode={kind === "text" ? "text" : "decimal"}
      value={draft ?? toText(value)}
      placeholder={shown !== undefined ? `≈ ${String(Math.round(shown * 100 * 100) / 100).replace(".", ",")}` : ""}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === null) return;
        const t = draft.trim();
        setDraft(null);
        let v: number | string | null;
        if (kind === "text") v = t || null;
        else if (!t) v = null;
        else v = parseNum(t) / 100;
        if (v !== value) onCommit(v);
      }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setDraft(null); (e.target as HTMLInputElement).blur(); } }} />
  );
}
