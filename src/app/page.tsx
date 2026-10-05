import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/auth";
import {
  getPlanRows, getCampaignTree, getUser, getVisiblePlans, pickPlan, getPlan,
  getReachSummary, getTargetGroups,
} from "@/lib/queries";
import { myUndoStack } from "@/lib/actions";
import { can, seesWholePlan } from "@/lib/permissions";
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
  if (!me.active) redirect("/prihlaseni?error=Inactive");

  const user = await getUser(me.id);
  if (!user) redirect("/prihlaseni");

  const sp = await searchParams;
  const allPlans = await getVisiblePlans(me);
  const planId = pickPlan(allPlans, sp.plan);

  if (!planId) {
    return (
      <Chrome active="plan" user={{ name: user.name, email: user.email, role: user.role }}>
        <div className="banner info">
          <span><b>Nemáte otevřený žádný plán.</b> Buď zatím žádný neexistuje, nebo vám k němu administrátor ještě nepřidělil přístup.</span>
        </div>
      </Chrome>
    );
  }

  const plan = (await getPlan(planId))!;
  const months = monthsBetween(plan.periodStart, plan.periodEnd);
  const quarters = quarterGroups(months);
  const periodName = periodLabel(plan.periodStart, plan.periodEnd);

  const [rows, allCampaigns, undo, reach, tgs] = await Promise.all([
    getPlanRows(me, planId),
    getCampaignTree(planId),
    myUndoStack(),
    getReachSummary(me, planId),
    getTargetGroups(),
  ]);

  // kdo vidí jen výsek plánu, nesmí ani přes prázdné bloky poznat, co dalšího
  // v plánu je — bloky bez jediné viditelné taktiky se mu nepošlou
  const campaigns = seesWholePlan(me, planId)
    ? allCampaigns
    : allCampaigns.filter((c) => rows.some((r) => r.campaignId === c.id));

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
          <div className="v num">{kc(total)}<span className="cur">Kč</span></div>
          <div className="d">{rows.length} taktik</div>
        </div>
        {(["Paid", "Owned", "Earned"] as const).map((ty) => (
          <div className={`kpi ${ty === "Paid" ? "p" : ty === "Owned" ? "o" : "e"}`} key={ty}>
            <div className="k">{ty}</div>
            <div className="v num">{kc(byType(ty))}<span className="cur">Kč</span></div>
            <div className="d num">{total ? pct(byType(ty) / total) : "—"}</div>
          </div>
        ))}
        <div className="kpi">
          <div className="k">Čerpáno</div>
          <div className="v num">{kc(spent)}<span className="cur">Kč</span></div>
          <div className="d num">{total ? pct(spent / total) : "—"} plánu</div>
        </div>
      </div>

      <ReachPanel
        planId={planId}
        showCalculator={me.role !== "CLIENT"}
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
