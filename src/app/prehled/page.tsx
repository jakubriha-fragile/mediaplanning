import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/auth";
import { getUser, getVisiblePlans, pickPlan, getPlan, getTargetGroups, getThemes } from "@/lib/queries";
import { channelTypeEnum, type ChannelType } from "@/db/schema";
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
  searchParams: Promise<{ plan?: string; oblast?: string; medium?: string; propozice?: string; sdeleni?: string }>;
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

  const plan = await getPlan(planId);
  if (!plan) redirect("/");
  const themes = await getThemes(plan.clientId);
  // filtry z adresy — jen hodnoty, které k plánu opravdu patří
  const themeId = themes.some((t) => t.id === sp.oblast) ? sp.oblast! : null;
  const channelType = (channelTypeEnum.enumValues as readonly string[]).includes(sp.medium ?? "")
    ? (sp.medium as ChannelType) : null;
  // propozice a sdělení z adresy — getDashboard filtruje jen viditelné řádky, cizí id nic nenajde
  const campaignId = sp.propozice ?? null;
  const lineId = sp.sdeleni ?? null;
  const [data, tgs] = await Promise.all([getDashboard(me, planId, { themeId, channelType, campaignId, lineId }), getTargetGroups()]);
  if (!data) redirect("/");

  // u ročního plánu přes přelom roku je potřeba vidět rok, jinak stačí měsíc
  const crossYear = plan.periodStart.slice(0, 4) !== plan.periodEnd.slice(0, 4);
  const monthLabels: Record<string, string> = Object.fromEntries(data.months.map((m) => [
    m, crossYear ? `${monthShort(m)} ${m.slice(2, 4)}` : monthShort(m),
  ]));

  return (
    <Chrome active="prehled" user={chrome} planId={planId} title={{ client: plan.clientName, period: planTitle(plan) }}>
      {allPlans.length > 1 && <PlanSwitcher plans={allPlans} current={planId} canCreate={false} />}
      <Overview
        data={data}
        monthLabels={monthLabels}
        planId={planId}
        tgName={tgs.find((t) => t.id === plan.targetGroupId)?.name ?? "bez cílové skupiny"}
        periodName={periodLabel(plan.periodStart, plan.periodEnd)}
        themes={themes.map((t) => ({ id: t.id, name: t.name }))}
        filter={{ themeId, channelType, campaignId: data.campaigns.some((c) => c.id === campaignId) ? campaignId : null, lineId: data.lines.some((l) => l.id === lineId) ? lineId : null }}
      />
    </Chrome>
  );
}
