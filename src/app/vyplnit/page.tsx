import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/auth";
import { getUser, getVisiblePlans, pickPlan, getPlan, getFillRows } from "@/lib/queries";
import { planTitle, monthsBetween, monthShort } from "@/lib/period";
import { Chrome } from "@/components/Chrome";
import { PlanSwitcher } from "@/components/PlanSwitcher";
import { FillForm } from "@/components/FillForm";

export const dynamic = "force-dynamic";

/**
 * K vyplnění — jen položky, kam smí uživatel zapisovat. Pro klienta je to
 * hlavní stránka: nemusí se orientovat v celém plánu, vidí jen svoje řádky
 * a u nich jedno pole na měsíc.
 */
export default async function FillPage({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
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
      <Chrome active="vyplnit" user={chrome}>
        <div className="banner info"><span><b>Zatím nemáte přístup k žádnému plánu.</b> Ozvěte se svému accountovi v agentuře.</span></div>
      </Chrome>
    );
  }

  const plan = (await getPlan(planId))!;
  const months = monthsBetween(plan.periodStart, plan.periodEnd);
  const rows = await getFillRows(me, planId);
  const crossYear = plan.periodStart.slice(0, 4) !== plan.periodEnd.slice(0, 4);
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  return (
    <Chrome active="vyplnit" user={chrome} planId={planId} title={{ client: plan.clientName, period: planTitle(plan) }}>
      {allPlans.length > 1 && <PlanSwitcher plans={allPlans} current={planId} canCreate={false} />}
      <FillForm
        key={planId}
        rows={rows}
        months={months}
        monthLabels={Object.fromEntries(months.map((m) => [m, crossYear ? `${monthShort(m)} ${m.slice(2, 4)}` : monthShort(m)]))}
        currentMonth={currentMonth}
        clientView={me.role === "CLIENT"}
      />
    </Chrome>
  );
}
