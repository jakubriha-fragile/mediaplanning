import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/auth";
import { getUser, getVisiblePlans, pickPlan, getPlan, getTargetGroups } from "@/lib/queries";
import { getDashboard } from "@/lib/dashboard";
import { planTitle, monthShort, periodLabel } from "@/lib/period";
import { Chrome } from "@/components/Chrome";
import { PlanSwitcher } from "@/components/PlanSwitcher";
import { Overview } from "@/components/dashboard/Overview";

export const dynamic = "force-dynamic";

/**
 * Přehled plánu — první pohled pro agenturu: zásah v čase, investice,
 * frekvence a bloky. Klient ho zatím nevidí; má vlastní zjednodušený
 * pohled v Plánu, a odborné metriky (frekvence, přírůstky) by bez výkladu mátly.
 */
export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string }>;
}) {
  const me = await currentPrincipal();
  if (!me) redirect("/prihlaseni");
  if (!me.active) redirect("/prihlaseni?error=Inactive");
  if (me.role === "CLIENT") redirect("/");
  const user = await getUser(me.id);
  if (!user) redirect("/prihlaseni");

  const sp = await searchParams;
  const allPlans = await getVisiblePlans(me);
  const planId = pickPlan(allPlans, sp.plan);
  const chrome = { name: user.name, email: user.email, role: user.role };

  if (!planId) {
    return (
      <Chrome active="prehled" user={chrome}>
        <div className="banner info"><span><b>Nemáte otevřený žádný plán.</b></span></div>
      </Chrome>
    );
  }

  const [plan, data, tgs] = await Promise.all([getPlan(planId), getDashboard(me, planId), getTargetGroups()]);
  if (!plan || !data) redirect("/");

  // u ročního plánu přes přelom roku je potřeba vidět rok, jinak stačí měsíc
  const crossYear = plan.periodStart.slice(0, 4) !== plan.periodEnd.slice(0, 4);
  const monthLabels = Object.fromEntries(data.months.map((m) => [
    m, crossYear ? `${monthShort(m)} ${m.slice(2, 4)}` : monthShort(m),
  ]));

  return (
    <Chrome active="prehled" user={chrome} title={{ client: plan.clientName, period: planTitle(plan) }}>
      <PlanSwitcher plans={allPlans} current={planId} canCreate={false} />
      <Overview
        data={data}
        monthLabels={monthLabels}
        planId={planId}
        tgName={tgs.find((t) => t.id === plan.targetGroupId)?.name ?? "bez cílové skupiny"}
        periodName={periodLabel(plan.periodStart, plan.periodEnd)}
        showCalculator
      />
    </Chrome>
  );
}
