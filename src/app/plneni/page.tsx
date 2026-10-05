import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/auth";
import { getPerfRows, getUser, getVisiblePlans, pickPlan, getPlan } from "@/lib/queries";
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
  if (!me.active) redirect("/prihlaseni?error=Inactive");
  const user = await getUser(me.id);
  if (!user) redirect("/prihlaseni");

  const sp = await searchParams;
  const allPlans = await getVisiblePlans(me);
  const planId = pickPlan(allPlans, sp.plan);

  if (!planId) {
    return (
      <Chrome active="plneni" user={{ name: user.name, email: user.email, role: user.role }}>
        <div className="banner info"><span><b>Nemáte otevřený žádný plán.</b> Buď zatím žádný neexistuje, nebo vám k němu administrátor ještě nepřidělil přístup.</span></div>
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
