import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/auth";
import { getUser, getVisiblePlans, pickPlan, getPlan, getTargetGroups } from "@/lib/queries";
import { getMix } from "@/lib/mix";
import { planTitle, periodLabel, monthShort } from "@/lib/period";
import { Chrome } from "@/components/Chrome";
import { PlanSwitcher } from "@/components/PlanSwitcher";
import { MixView } from "@/components/MixView";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { draft: "návrh", approved: "schváleno", live: "běží", closed: "uzavřeno" };

/** Finální mix — výsledek plánu na jedné stránce, ke schválení a sdílení. */
export default async function MixPage({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
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
      <Chrome active="mix" user={chrome}>
        <div className="banner info"><span><b>Nemáte otevřený žádný plán.</b></span></div>
      </Chrome>
    );
  }

  const plan = (await getPlan(planId))!;
  const [mix, tgs] = await Promise.all([getMix(me, planId), getTargetGroups()]);
  if (!mix) redirect("/");
  const crossYear = plan.periodStart.slice(0, 4) !== plan.periodEnd.slice(0, 4);

  return (
    <Chrome active="mix" user={chrome} planId={planId} title={{ client: plan.clientName, period: planTitle(plan) }}>
      {allPlans.length > 1 && <PlanSwitcher plans={allPlans} current={planId} canCreate={false} />}
      <MixView
        mix={mix}
        planName={plan.name}
        period={periodLabel(plan.periodStart, plan.periodEnd)}
        tgName={tgs.find((t) => t.id === plan.targetGroupId)?.name ?? "neurčena"}
        status={STATUS[plan.status] ?? plan.status}
        monthLabels={Object.fromEntries(mix.months.map((m) => [m, crossYear ? `${monthShort(m)} ${m.slice(2, 4)}` : monthShort(m)]))}
        clientView={me.role === "CLIENT"}
      />
    </Chrome>
  );
}
