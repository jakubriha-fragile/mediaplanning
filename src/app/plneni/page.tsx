import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/auth";
import { getPerfRows, getUser, getPlans, getPlan, defaultPlanId } from "@/lib/queries";
import { myUndoStack } from "@/lib/actions";
import { monthsBetween, monthLabel, quarterGroups, periodLabel } from "@/lib/period";
import { PlanSwitcher } from "@/components/PlanSwitcher";
import { Chrome } from "@/components/Chrome";
import { PerfTable, type PerfRow } from "@/components/PerfTable";

export const dynamic = "force-dynamic";

export default async function PerfPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string }>;
}) {
  const me = await currentPrincipal();
  if (!me) redirect("/prihlaseni");
  const user = await getUser(me.id);
  if (!user) redirect("/prihlaseni");

  const sp = await searchParams;
  const allPlans = await getPlans();
  const planId = (sp.plan && allPlans.some((p) => p.id === sp.plan) ? sp.plan : null) ?? (await defaultPlanId());

  if (!planId) {
    return (
      <Chrome active="plneni" user={{ name: user.name, email: user.email, role: user.role }}>
        <div className="banner info"><span><b>Zatím tu není žádný plán.</b></span></div>
      </Chrome>
    );
  }

  const plan = (await getPlan(planId))!;
  const months = monthsBetween(plan.periodStart, plan.periodEnd);
  const [rows, undo] = await Promise.all([getPerfRows(me, planId), myUndoStack()]);

  const canWriteAnything = rows.some((r) => months.some((m) => r.editable[m]));

  return (
    <Chrome active="plneni" user={{ name: user.name, email: user.email, role: user.role }}
      title={{ client: plan.clientName, period: periodLabel(plan.periodStart, plan.periodEnd) }}>
      <PlanSwitcher plans={allPlans} current={planId} canCreate={false} />
      {!canWriteAnything && (
        <div className="banner info">
          <span>
            <b>Máte jen čtení.</b> Skutečnost vyplňuje ten, komu administrátor přidělil oprávnění
            pro daný typ média, kampaň a měsíc.
          </span>
        </div>
      )}
      <div className="banner">
        <span>
          <b>Pracovní podklad.</b> Vyhodnocení slouží jako interní přehled; před sdílením s klientem
          vyžaduje validaci media specialistou.
        </span>
      </div>
      <PerfTable
        rows={rows}
        months={months}
        monthLabels={Object.fromEntries(months.map((m) => [m, monthLabel(m)]))}
        quarters={quarterGroups(months)}
        periodName={periodLabel(plan.periodStart, plan.periodEnd)}
        undoLabel={undo[0]?.label ?? null} />
    </Chrome>
  );
}
