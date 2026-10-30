import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/auth";
import {
  getPlanRows, getCampaignTree, getUser, getVisiblePlans, pickPlan, getPlan,
  getReachSummary, getTargetGroups, getThemes, getFillRows,
} from "@/lib/queries";
import { myUndoStack } from "@/lib/actions";
import { can, seesWholePlan } from "@/lib/permissions";
import { planTitle, monthsBetween, monthLabel, monthShort, quarterGroups, periodLabel, kc, pct, weeksOfPeriod, weekRange, weekHome } from "@/lib/period";
import { Chrome } from "@/components/Chrome";
import { PlanSwitcher } from "@/components/PlanSwitcher";
import { ReachPanel } from "@/components/ReachPanel";
import { PlanTable, type PlanRow } from "@/components/PlanTable";
import { ClientPlan } from "@/components/ClientPlan";
import { getCatalog } from "@/lib/catalog";
import { channelGroupOf } from "@/lib/permissions";

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

  // klient přichází hlavně vyplňovat — bez výslovně vybraného plánu ho pošleme na jeho položky
  if (me.role === "CLIENT" && !sp.plan && planId && (await getFillRows(me, planId)).length) {
    redirect(`/vysledky?plan=${planId}`);
  }

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

  const [rows, allCampaigns, undo, reach, tgs, themeList] = await Promise.all([
    getPlanRows(me, planId),
    getCampaignTree(planId),
    myUndoStack(),
    getReachSummary(me, planId),
    getTargetGroups(),
    getThemes(plan.clientId),
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

  // klient: čitelný přehled bez agenturních nástrojů — offline/online místo
  // Paid/Owned/Earned, zásah jen když vidí celý plán (jinak by „0 %" mátlo)
  if (me.role === "CLIENT") {
    const whole = seesWholePlan(me, planId);
    const sumOf = (online: boolean) => rows.filter((r) => (channelGroupOf(r.channelType) === "online") === online)
      .reduce((s, r) => s + months.reduce((a, m) => a + r.budgets[m], 0), 0);
    const fillable = (await getFillRows(me, planId)).length > 0;
    const crossYear = plan.periodStart.slice(0, 4) !== plan.periodEnd.slice(0, 4);
    return (
      <Chrome active="plan" user={{ name: user.name, email: user.email, role: user.role }}
        planId={planId} title={{ client: plan.clientName, period: planTitle(plan) }}>
        {allPlans.length > 1 && <PlanSwitcher plans={allPlans} current={planId} canCreate={false} />}
        <div className="kpis" style={{ marginTop: 12 }}>
          <div className="kpi">
            <div className="k">{whole ? `Plán ${periodName}` : "Vaše položky"}</div>
            <div className="v num">{kc(total)}<span className="cur">Kč</span></div>
            <div className="d">{rows.length} {rows.length === 1 ? "položka" : rows.length < 5 ? "položky" : "položek"}</div>
          </div>
          {[false, true].map((online) => {
            const v = sumOf(online);
            if (!v && !whole) return null;
            return (
              <div className="kpi" key={String(online)}>
                <div className="k">{online ? "Online" : "Offline"}</div>
                <div className="v num">{kc(v)}<span className="cur">Kč</span></div>
                <div className="d num">{total ? pct(v / total) : "—"}</div>
              </div>
            );
          })}
          <div className="kpi">
            <div className="k">Čerpáno</div>
            <div className="v num">{kc(spent)}<span className="cur">Kč</span></div>
            <div className="d num">{total ? pct(spent / total) : "—"} plánu</div>
          </div>
        </div>
        {whole && (
          <ReachPanel planId={planId} showCalculator={false} clientView months={reach.months} total={reach.total}
            universe={reach.universe} hasUniverse={reach.hasUniverse} targetGroupName={tgName} />
        )}
        <div className="banner info">
          <span>
            Mediaplán připravila agentura Fragile. <b>Částky jsou včetně agenturního fee.</b>{" "}
            {fillable ? <>Svoje položky vyplňujete v záložce <a href={`/vysledky?plan=${planId}`}>K vyplnění</a>. </> : null}
            Souhrn najdete ve <a href={`/mix?plan=${planId}`}>Finálním mixu</a>; s dotazy se obraťte na svého accounta.
          </span>
        </div>
        <ClientPlan
          rows={rows.map((r) => ({
            id: r.id, name: r.name, full: r.channel, block: r.campaign, channelType: r.channelType,
            online: channelGroupOf(r.channelType) === "online", budgets: r.budgets,
          }))}
          months={months}
          monthLabels={Object.fromEntries(months.map((m) => [m, crossYear ? `${monthShort(m)} ${m.slice(2, 4)}` : monthShort(m)]))}
        />
      </Chrome>
    );
  }

  return (
    <Chrome active="plan" user={{ name: user.name, email: user.email, role: user.role }}
      planId={planId} title={{ client: plan.clientName, period: planTitle(plan) }}>
      <PlanSwitcher
        plans={allPlans}
        current={planId}
        // zakládat plány smí jen kdo smí měnit plány napříč — stejně jako createPlan na serveru
        canCreate={can(me, "write", { area: "plan", mediaType: null, planId: null, campaignId: null, month: null })}
        canEdit={canEditPlan}
        canDelete={canEditPlan && (me.role === "ADMIN" || me.role === "PLANNER")}
        targetGroups={tgs.map((t) => ({ id: t.id, name: t.name }))}
      />

      <div className="kpis">
        <div className="kpi">
          <div className="k">Plán {periodName}</div>
          <div className="v num">{kc(total)}<span className="cur">Kč</span></div>
          <div className="d">{rows.length} taktik</div>
        </div>
        {/* kdo vidí jen výsek plánu, by u typů mimo svůj grant viděl „0 Kč",
            jako by v plánu nebyly — takové dlaždice vynecháme */}
        {(["Paid", "Owned", "Earned"] as const)
          .filter((ty) => seesWholePlan(me, planId) || rows.some((r) => r.mediaType === ty))
          .map((ty) => (
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
        showCalculator
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
            v záložce <a href={`/vysledky?plan=${planId}`}>Výsledky</a>, a to jen tam, kde k tomu máte oprávnění.
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
        themes={themeList.map((t) => ({ id: t.id, name: t.name }))}
        catalog={await getCatalog()}
        weeks={plan.granularity === "week"
          ? weeksOfPeriod(plan.periodStart, plan.periodEnd).map((w) => ({ key: w.key, label: w.label, title: weekRange(w.key), home: weekHome(w) }))
          : null}
      />
    </Chrome>
  );
}
