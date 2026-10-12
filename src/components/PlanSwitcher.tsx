"use client";

import { useRouter, usePathname } from "next/navigation";
import { useState, useTransition } from "react";
import {
  copyPlanToNextYear, createPlan, updatePlan, deletePlan, planPeriodImpact, planSummary,
} from "@/lib/actions";
import { periodLabel, monthsBetween, monthLabel, kc } from "@/lib/period";

export type PlanOption = {
  id: string;
  name: string;
  clientId: string;
  clientName: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  targetGroupId: string | null;
};

const STATUS: Record<string, string> = {
  draft: "návrh",
  approved: "schváleno",
  live: "v běhu",
  closed: "uzavřeno",
};

/**
 * Výběr klienta a plánu. Plán se drží v adrese (?plan=…), takže odkaz
 * na konkrétní plán jde komukoli poslat a otevře se mu totéž.
 *
 * Kdo smí plány spravovat, má vedle výběru i „+ Nový plán", nastavení
 * otevřeného plánu a zkratku „+ Další rok".
 */
export function PlanSwitcher({
  plans, current, canCreate, canEdit = false, canDelete = false, targetGroups = [],
}: {
  plans: PlanOption[];
  current: string;
  /** smí zakládat plány (právo měnit plány napříč) */
  canCreate: boolean;
  /** smí měnit otevřený plán */
  canEdit?: boolean;
  /** smí otevřený plán smazat (administrátor, plánovač) */
  canDelete?: boolean;
  targetGroups?: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const path = usePathname();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"new" | "edit" | null>(null);

  const here = plans.find((p) => p.id === current);
  const clients = [...new Map(plans.map((p) => [p.clientId, p.clientName])).entries()];
  const mine = plans.filter((p) => p.clientId === here?.clientId);

  const go = (planId: string) => router.push(`${path}?plan=${planId}`);

  return (
    <div className="planbar">
      {clients.length > 1 && (
        <select className="txt" value={here?.clientId ?? ""} disabled={pending}
          onChange={(e) => {
            const first = plans.find((p) => p.clientId === e.target.value);
            if (first) go(first.id);
          }}>
          {clients.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      )}

      <select className="txt planpick" value={current} disabled={pending}
        onChange={(e) => go(e.target.value)}>
        {mine.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} · {STATUS[p.status] ?? p.status}
          </option>
        ))}
      </select>

      {canEdit && here && (
        <button className="btn" disabled={pending} onClick={() => setDialog("edit")}
          title="Název, období, stav a cílová skupina plánu">⚙ Nastavení plánu</button>
      )}

      {canCreate && (
        <button className="btn" disabled={pending} onClick={() => setDialog("new")}>+ Nový plán</button>
      )}

      {canCreate && here && (
        <button className="btn" disabled={pending}
          title="Rychlá kopie: tentýž plán o rok dál se stejnou strukturou bloků, sdělení a taktik. Čísla zůstanou prázdná."
          onClick={() => {
            if (!confirm(
              `Založit plán o rok dál podle „${here.name}"?\n\n` +
              `Zkopírují se bloky, sdělení a taktiky i s nastavením nosiče a ukazateli — ` +
              `rozpočty, GRP ani cíle se NEkopírují.`)) return;
            startTransition(async () => {
              const res = await copyPlanToNextYear(here.id);
              if (!res.ok) setError(res.error ?? "Založení se nezdařilo.");
              else if (res.planId) { setError(null); go(res.planId); }
            });
          }}>
          {pending ? "zakládám…" : "+ Další rok"}
        </button>
      )}

      {error && <span className="share" style={{ color: "var(--bad)" }}>{error}</span>}

      {dialog === "new" && (
        <NewPlanDialog
          clients={clients}
          plans={plans}
          here={here ?? null}
          targetGroups={targetGroups}
          onClose={() => setDialog(null)}
          onCreated={(id) => { setDialog(null); go(id); }}
        />
      )}
      {dialog === "edit" && here && (
        <EditPlanDialog
          plan={here}
          targetGroups={targetGroups}
          canDelete={canDelete}
          onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); router.refresh(); }}
          onDeleted={() => {
            setDialog(null);
            const next = plans.find((p) => p.id !== here.id);
            router.push(next ? `${path}?plan=${next.id}` : path);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- období

type Preset = "Q1" | "Q2" | "Q3" | "Q4" | "Y" | "custom";
const PRESETS: Array<{ v: Preset; l: string; m: [number, number] | null }> = [
  { v: "Q1", l: "Q1 (leden–březen)", m: [1, 3] },
  { v: "Q2", l: "Q2 (duben–červen)", m: [4, 6] },
  { v: "Q3", l: "Q3 (červenec–září)", m: [7, 9] },
  { v: "Q4", l: "Q4 (říjen–prosinec)", m: [10, 12] },
  { v: "Y", l: "celý rok", m: [1, 12] },
  { v: "custom", l: "vlastní od–do", m: null },
];
const mm = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

function presetOf(start: string, end: string): { preset: Preset; year: number } {
  const y = Number(start.slice(0, 4));
  if (end.slice(0, 4) === start.slice(0, 4)) {
    const a = Number(start.slice(5)), b = Number(end.slice(5));
    const p = PRESETS.find((x) => x.m && x.m[0] === a && x.m[1] === b);
    if (p) return { preset: p.v, year: y };
  }
  return { preset: "custom", year: y };
}

/**
 * Období se nejčastěji plánuje po kvartálech nebo na rok — proto rychlá volba,
 * a „vlastní" jen pro kampaně typu březen–květen nebo přes přelom roku.
 */
function PeriodPicker({
  start, end, onChange,
}: { start: string; end: string; onChange: (start: string, end: string) => void }) {
  const init = presetOf(start, end);
  const [preset, setPreset] = useState<Preset>(init.preset);
  const [year, setYear] = useState(init.year);
  const thisYear = new Date().getFullYear();
  const years = [...new Set([thisYear - 1, thisYear, thisYear + 1, thisYear + 2, thisYear + 3, init.year])].sort();

  const apply = (p: Preset, y: number) => {
    const def = PRESETS.find((x) => x.v === p)?.m;
    if (def) onChange(mm(y, def[0]), mm(y, def[1]));
  };

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
      <div className="field" style={{ margin: 0, minWidth: 190 }}>
        <label>Období</label>
        <select value={preset} onChange={(e) => {
          const p = e.target.value as Preset;
          setPreset(p);
          apply(p, year);
        }}>
          {PRESETS.map((p) => <option key={p.v} value={p.v}>{p.l}</option>)}
        </select>
      </div>
      {preset === "custom" ? (
        <>
          <div className="field" style={{ margin: 0 }}>
            <label>Od</label>
            <input type="month" value={start} onChange={(e) => e.target.value && onChange(e.target.value, end)} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Do</label>
            <input type="month" value={end} onChange={(e) => e.target.value && onChange(start, e.target.value)} />
          </div>
        </>
      ) : (
        <div className="field" style={{ margin: 0, minWidth: 100 }}>
          <label>Rok</label>
          <select value={year} onChange={(e) => { const y = Number(e.target.value); setYear(y); apply(preset, y); }}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}

/** České tvary: 1 rozpočet, 2 rozpočty, 5 rozpočtů. */
const pl = (n: number, one: string, few: string, many: string) =>
  `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;

const periodValid = (start: string, end: string) => start <= end && monthsBetween(start, end).length >= 1;
const monthsText = (start: string, end: string) => {
  return pl(monthsBetween(start, end).length, "měsíc", "měsíce", "měsíců");
};

// ---------------------------------------------------------------- dialogy

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div role="dialog" aria-modal="true" aria-label={title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(20,18,40,.35)",
        display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "8vh 16px", overflow: "auto" }}>
      <div className="panel" style={{ width: "min(560px, 100%)", borderRadius: "var(--radius)",
        boxShadow: "0 18px 50px rgba(0,0,0,.25)" }}>
        <div className="toolbar">
          <b style={{ fontSize: 13 }}>{title}</b>
          <span className="spacer" />
          <button className="btn" onClick={onClose} aria-label="Zavřít" style={{ padding: "2px 9px" }}>✕</button>
        </div>
        <div style={{ padding: "14px 16px" }}>{children}</div>
      </div>
    </div>
  );
}

function TargetGroupSelect({
  value, onChange, options,
}: { value: string | null; onChange: (v: string | null) => void; options: Array<{ id: string; name: string }> }) {
  return (
    <div className="field">
      <label>Výchozí cílová skupina</label>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">— bez cílové skupiny (zásah se nepočítá) —</option>
        {options.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    </div>
  );
}

function NewPlanDialog({
  clients, plans, here, targetGroups, onClose, onCreated,
}: {
  clients: Array<[string, string]>;
  plans: PlanOption[];
  here: PlanOption | null;
  targetGroups: Array<{ id: string; name: string }>;
  onClose: () => void;
  onCreated: (planId: string) => void;
}) {
  const y = new Date().getFullYear() + 1;
  const [clientId, setClientId] = useState(here?.clientId ?? clients[0]?.[0] ?? "");
  const [start, setStart] = useState(mm(y, 1));
  const [end, setEnd] = useState(mm(y, 12));
  // název se doplňuje z období, dokud ho plánovač nepřepíše
  const [name, setName] = useState<string | null>(null);
  const [tg, setTg] = useState<string | null>(here?.targetGroupId ?? null);
  const [copyFrom, setCopyFrom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start_] = useTransition();

  const shownName = name ?? (periodValid(start, end) ? periodLabel(start, end) : "");
  const sources = plans.filter((p) => p.clientId === clientId);

  return (
    <Dialog title="Nový plán" onClose={onClose}>
      {clients.length > 1 && (
        <div className="field">
          <label>Klient</label>
          <select value={clientId} onChange={(e) => { setClientId(e.target.value); setCopyFrom(""); }}>
            {clients.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
          </select>
        </div>
      )}
      <PeriodPicker start={start} end={end} onChange={(a, b) => { setStart(a); setEnd(b); }} />
      <div className="share" style={{ margin: "6px 0 12px" }}>
        {periodValid(start, end) ? `${periodLabel(start, end)} · ${monthsText(start, end)}` : "Konec období je před začátkem."}
      </div>
      <div className="field">
        <label>Název plánu</label>
        <input value={shownName} onChange={(e) => setName(e.target.value)} placeholder="např. Vánoce 2027" />
      </div>
      <TargetGroupSelect value={tg} onChange={setTg} options={targetGroups} />
      <div className="field">
        <label>Převzít strukturu z plánu</label>
        <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
          <option value="">— začít prázdný —</option>
          {sources.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="share" style={{ marginTop: 4 }}>
          Zkopírují se bloky, sdělení a taktiky i s nosičem, ceníkem a ukazateli. Rozpočty, GRP a cíle ne.
        </div>
      </div>

      {error && <div className="banner" style={{ margin: "0 0 10px" }}><span>{error}</span></div>}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>Zrušit</button>
        <button className="btn primary" disabled={pending || !periodValid(start, end) || !shownName.trim() || !clientId}
          onClick={() => start_(async () => {
            const res = await createPlan({
              clientId, name: shownName.trim(), periodStart: start, periodEnd: end,
              targetGroupId: tg, copyFromPlanId: copyFrom || null,
            });
            if (!res.ok) setError(res.error);
            else if (res.planId) onCreated(res.planId);
          })}>
          {pending ? "zakládám…" : "Založit plán"}
        </button>
      </div>
    </Dialog>
  );
}

function EditPlanDialog({
  plan, targetGroups, canDelete, onClose, onSaved, onDeleted,
}: {
  plan: PlanOption;
  targetGroups: Array<{ id: string; name: string }>;
  canDelete: boolean;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(plan.name);
  const [status, setStatus] = useState(plan.status);
  const [start, setStart] = useState(plan.periodStart);
  const [end, setEnd] = useState(plan.periodEnd);
  const [tg, setTg] = useState<string | null>(plan.targetGroupId);
  const [error, setError] = useState<string | null>(null);
  const [pending, run] = useTransition();

  const periodChanged = start !== plan.periodStart || end !== plan.periodEnd;
  const dropped = monthsBetween(plan.periodStart, plan.periodEnd)
    .filter((m) => periodValid(start, end) && !monthsBetween(start, end).includes(m));

  const save = () => run(async () => {
    if (periodChanged && dropped.length) {
      const imp = await planPeriodImpact({ planId: plan.id, periodStart: start, periodEnd: end });
      if (!imp.ok) { setError(imp.error); return; }
      const parts = [
        imp.budgets ? pl(imp.budgets, "rozpočet", "rozpočty", "rozpočtů") : "",
        imp.actuals ? pl(imp.actuals, "údaj o čerpání", "údaje o čerpání", "údajů o čerpání") : "",
        imp.metrics ? pl(imp.metrics, "cíl či výsledek ukazatele", "cíle a výsledky ukazatelů", "cílů a výsledků ukazatelů") : "",
        imp.notes ? pl(imp.notes, "komentář", "komentáře", "komentářů") : "",
      ].filter(Boolean);
      const months = dropped.map((m) => `${monthLabel(m)} ${m.slice(0, 4)}`).join(", ");
      if (!confirm(
        `Z plánu vypadnou měsíce: ${months}.\n\n` +
        (parts.length ? `Smaže se v nich ${parts.join(", ")}. Tohle nejde vrátit zpět.` : "Nejsou v nich žádná čísla.") +
        `\n\nPokračovat?`)) return;
    }
    const res = await updatePlan({
      planId: plan.id,
      name: name.trim(),
      status: status as "draft" | "approved" | "live" | "closed",
      targetGroupId: tg,
      ...(periodChanged ? { periodStart: start, periodEnd: end } : {}),
    });
    if (!res.ok) setError(res.error);
    else onSaved();
  });

  const remove = () => run(async () => {
    const sum = await planSummary(plan.id);
    if (!sum.ok) { setError(sum.error); return; }
    const typed = prompt(
      `Smazat plán „${plan.name}"?\n\n` +
      `Zmizí ${pl(sum.campaigns ?? 0, "blok", "bloky", "bloků")}, ${pl(sum.tactics ?? 0, "taktika", "taktiky", "taktik")}, ` +
      `rozpočty za ${kc(sum.budget ?? 0)} Kč, ` +
      `čerpání ${kc(sum.actual ?? 0)} Kč a oprávnění udělená na tento plán. Tohle nejde vrátit zpět.\n\n` +
      `Pro potvrzení napište přesný název plánu:`);
    if (typed === null) return;
    const res = await deletePlan({ planId: plan.id, confirmName: typed });
    if (!res.ok) setError(res.error);
    else onDeleted();
  });

  return (
    <Dialog title={`Nastavení plánu ${plan.name}`} onClose={onClose}>
      <div className="field">
        <label>Název plánu</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>Stav</label>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {Object.entries(STATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <PeriodPicker start={start} end={end} onChange={(a, b) => { setStart(a); setEnd(b); }} />
      <div className="share" style={{ margin: "6px 0 12px" }}>
        {!periodValid(start, end)
          ? "Konec období je před začátkem."
          : `${periodLabel(start, end)} · ${monthsText(start, end)}` +
            (dropped.length ? ` — vypadne ${pl(dropped.length, "měsíc", "měsíce", "měsíců")} i s čísly` : "")}
      </div>
      <TargetGroupSelect value={tg} onChange={setTg} options={targetGroups} />

      {error && <div className="banner" style={{ margin: "0 0 10px" }}><span>{error}</span></div>}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>Zrušit</button>
        <button className="btn primary" disabled={pending || !periodValid(start, end) || !name.trim()} onClick={save}>
          {pending ? "ukládám…" : "Uložit"}
        </button>
      </div>

      {canDelete && (
        <div style={{ marginTop: 18, paddingTop: 12, borderTop: "1px solid var(--line)",
          display: "flex", alignItems: "center", gap: 10 }}>
          <span className="share" style={{ flex: 1 }}>
            Smazání odstraní celý plán včetně čísel a oprávnění. Nejde vrátit zpět.
          </span>
          <button className="btn danger" disabled={pending} onClick={remove}>Smazat plán</button>
        </div>
      )}
    </Dialog>
  );
}
