"use client";

import { useRouter, usePathname } from "next/navigation";
import { useState, useTransition } from "react";
import { copyPlanToNextYear } from "@/lib/actions";

export type PlanOption = {
  id: string;
  name: string;
  clientName: string;
  periodStart: string;
  periodEnd: string;
  status: string;
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
 */
export function PlanSwitcher({
  plans, current, canCreate,
}: {
  plans: PlanOption[];
  current: string;
  canCreate: boolean;
}) {
  const router = useRouter();
  const path = usePathname();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const here = plans.find((p) => p.id === current);
  const clients = [...new Set(plans.map((p) => p.clientName))];
  const mine = plans.filter((p) => p.clientName === here?.clientName);

  const go = (planId: string) => router.push(`${path}?plan=${planId}`);

  return (
    <div className="planbar">
      {clients.length > 1 && (
        <select className="txt" value={here?.clientName ?? ""} disabled={pending}
          onChange={(e) => {
            const first = plans.find((p) => p.clientName === e.target.value);
            if (first) go(first.id);
          }}>
          {clients.map((c) => <option key={c}>{c}</option>)}
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

      {canCreate && here && (
        <button className="btn" disabled={pending}
          title="Založí nový plán o rok dál se stejnou strukturou bloků, sdělení a taktik. Čísla zůstanou prázdná."
          onClick={() => {
            if (!confirm(
              `Založit plán o rok dál podle „${here.name}"?\n\n` +
              `Zkopírují se bloky, sdělení a taktiky i s nastavením nosiče — ` +
              `rozpočty, GRP ani metriky se NEkopírují.`)) return;
            startTransition(async () => {
              const res = await copyPlanToNextYear(here.id);
              if (!res.ok) setError(res.error ?? "Založení se nezdařilo.");
              else if (res.planId) go(res.planId);
            });
          }}>
          {pending ? "zakládám…" : "+ Další rok"}
        </button>
      )}

      {error && <span className="share" style={{ color: "var(--bad-pure)" }}>{error}</span>}
    </div>
  );
}
