import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/auth";
import { getUser, getVisiblePlans, pickPlan, getPlan, getResultRows } from "@/lib/queries";
import { myUndoStack } from "@/lib/actions";
import { planTitle, monthsBetween, monthShort } from "@/lib/period";
import { Chrome } from "@/components/Chrome";
import { PlanSwitcher } from "@/components/PlanSwitcher";
import { Results } from "@/components/Results";

export const dynamic = "force-dynamic";

/**
 * Výsledky — plnění plánu a vyplňování skutečnosti na jednom místě.
 * Dřív dvě stránky (Plnění pro agenturu, K vyplnění pro klienta) se stejnými
 * daty v jiném rozložení; teď jedna, liší se jen tím, co kdo smí měnit.
 */
export default async function ResultsPage({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const me = await currentPrincipal();
  if (!me) redirect("/prihlaseni");
  if (!me.active) redirect("/prihlaseni?error=Inactive");
  const user = await getUser(me.id);
  if (!user) redirect("/prihlaseni");

  const sp = await searchParams;
  const allPlans = await getVisiblePlans(me);
  const planId = pickPlan(allPlans, sp.plan);
  const chrome = { name: user.name, email: user.email, role: user.role };

  if (!planId) {
    return (
      <Chrome active="vysledky" user={chrome}>
        <div className="banner info"><span><b>Zatím nemáte přístup k žádnému plánu.</b> Ozvěte se svému accountovi v agentuře.</span></div>
      </Chrome>
    );
  }

  const plan = (await getPlan(planId))!;
  const months = monthsBetween(plan.periodStart, plan.periodEnd);
  const [rows, undo] = await Promise.all([getResultRows(me, planId), myUndoStack()]);
  const crossYear = plan.periodStart.slice(0, 4) !== plan.periodEnd.slice(0, 4);
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  return (
    <Chrome active="vysledky" user={chrome} planId={planId} title={{ client: plan.clientName, period: planTitle(plan) }}>
      {allPlans.length > 1 && <PlanSwitcher plans={allPlans} current={planId} canCreate={false} />}
      {me.role !== "CLIENT" && (
        <div className="banner">
          <span>
            <b>Pracovní podklad.</b> Vyhodnocení slouží jako interní přehled; před sdílením s klientem
            vyžaduje validaci media specialistou.
          </span>
        </div>
      )}
      <Results
        key={planId}
        rows={rows}
        months={months}
        monthLabels={Object.fromEntries(months.map((m) => [m, crossYear ? `${monthShort(m)} ${m.slice(2, 4)}` : monthShort(m)]))}
        currentMonth={currentMonth}
        clientView={me.role === "CLIENT"}
        undoLabel={undo[0]?.label ?? null}
      />
    </Chrome>
  );
}
