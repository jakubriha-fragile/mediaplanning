import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/auth";
import {
  getPlanRows, getCampaignTree, getUser, getPlans, getPlan,
  defaultPlanId, getReachSummary, getTargetGroups,
} from "@/lib/queries";
import { myUndoStack } from "@/lib/actions";
import { can } from "@/lib/permissions";
import { monthsBetween, monthLabel, quarterGroups, periodLabel, kc, pct } from "@/lib/period";
import { Chrome } from "@/components/Chrome";
import { PlanSwitcher } from "@/components/PlanSwitcher";
import { ReachPanel } from "@/components/ReachPanel";
import { PlanTable, type PlanRow } from "@/components/PlanTable";

export const dynamic = "force-dynamic";

export default async function PlanPage({
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
      <Chrome active="plan" user={{ name: user.name, email: user.email, role: user.role }}>
        <div className="banner info">
          <span><b>Zatím tu není žádný plán.</b> Založte ho v <a href="/nastaveni">Nastavení</a>.</span>
        </div>
      </Chrome>
    );
  }

  const plan = (await getPlan(planId))!;
  const months = monthsBetween(plan.periodStart, plan.periodEnd);
  const quarters = quarterGroups(months);
  const periodName = periodLabel(plan.periodStart, plan.periodEnd);

  const [rows, campaigns, undo, reach, tgs] = await Promise.all([
    getPlanRows(me, planId),
    getCampaignTree(planId),
    myUndoStack(),
    getReachSummary(planId),
    getTargetGroups(),
  ]);

  const canEditPlan = can(me, "write", {
    area: "plan", mediaType: null, planId, campaignId: null, month: null,
  });

  const total = rows.reduce((s, r) => s + months.reduce((a, m) => a + r.budgets[m], 0), 0);
  const byType = (ty: string) =>
    rows.filter((r) => r.mediaType === ty).reduce((s, r) => s + months.reduce((a, m) => a + r.budgets[m], 0), 0);
  const spent = rows.reduce((s, r) => s + months.reduce((a, m) => a + r.actuals[m], 0), 0);

  const readOnlyPlan = !rows.some((r) => months.some((m) => r.editable[m]));
  const tgName = tgs.find((t) => t.id === plan.targetGroupId)?.name ?? "bez cílové skupiny";

  return (
    <Chrome active="plan" user={{ name: user.name, email: user.email, role: user.role }}
      title={{ client: plan.clientName, period: periodLabel(plan.periodStart, plan.periodEnd) }}>
      <PlanSwitcher plans={allPlans} current={planId} canCreate={canEditPlan} />

      <div className="kpis">
        <div className="kpi">
          <div className="k">Plán {periodName}</div>
          <div className="v num">{kc(total)}</div>
          <div className="d">{rows.length} taktik</div>
        </div>
        {(["Paid", "Owned", "Earned"] as const).map((ty) => (
          <div className={`kpi ${ty === "Paid" ? "p" : ty === "Owned" ? "o" : "e"}`} key={ty}>
            <div className="k">{ty}</div>
            <div className="v num">{kc(byType(ty))}</div>
            <div className="d num">{total ? pct(byType(ty) / total) : "—"}</div>
          </div>
        ))}
        <div className="kpi">
          <div className="k">Čerpáno</div>
          <div className="v num">{kc(spent)}</div>
          <div className="d num">{total ? pct(spent / total) : "—"} plánu</div>
        </div>
      </div>

      <ReachPanel
        months={reach.months}
        total={reach.total}
        universe={reach.universe}
        hasUniverse={reach.hasUniverse}
        targetGroupName={tgName}
      />

      {readOnlyPlan && (
        <div className="banner info">
          <span>
            <b>Plán máte jen ke čtení.</b> Rozpočty mění media plánovač. Skutečné čerpání vyplňujete
            v záložce <a href={`/plneni?plan=${planId}`}>Detail &amp; plnění</a>, a to jen tam, kde k tomu máte oprávnění.
          </span>
        </div>
      )}

      <div className="banner">
        <span>
          <b>Pracovní podklad.</b> Rozdělení rozpočtu, mediamix, odhady zásahu i částky vyžadují
          validaci media specialistou před sdílením s klientem. Částky jsou vč. agenturního fee.
        </span>
      </div>

      <PlanTable
        rows={rows as unknown as PlanRow[]}
        campaigns={campaigns}
        planId={planId}
        months={months}
        monthLabels={Object.fromEntries(months.map((m) => [m, monthLabel(m)]))}
        quarters={quarters}
        periodName={periodName}
        canEditPlan={canEditPlan}
        undoLabel={undo[0]?.label ?? null}
      />
    </Chrome>
  );
}
