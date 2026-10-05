import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/auth";
import { can, canManageUsers } from "@/lib/permissions";
import { getUser, getPlans, getPlan, getReachSummary, getTargetGroups, getDuplicationRows } from "@/lib/queries";
import { monthsBetween, monthLabel, periodLabel } from "@/lib/period";
import { Chrome } from "@/components/Chrome";
import { ReachCalculator, type CalcSource } from "@/components/ReachCalculator";
import { DuplicationTable } from "@/components/DuplicationTable";

export const dynamic = "force-dynamic";

/**
 * Kalkulačka cross-mediálního zásahu (Sainsbury).
 *
 * Samostatná stránka, ale napojená na mediaplán: zásahy nosičů se dají
 * načíst z libovolného plánu, který uživatel smí číst, a pak upravovat
 * ručně — „co když přidám rádio". Do plánu se nic nezapisuje.
 *
 * Klient ji nevidí: koeficienty jsou know-how agentury a navíc platí
 * napříč všemi klienty.
 */
export default async function CalculatorPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; mesic?: string }>;
}) {
  const me = await currentPrincipal();
  if (!me) redirect("/prihlaseni");
  if (!me.active) redirect("/prihlaseni?error=Inactive");
  if (me.role === "CLIENT") redirect("/");
  const user = await getUser(me.id);
  if (!user) redirect("/prihlaseni");

  const sp = await searchParams;
  const [allPlans, dupRows, tgs] = await Promise.all([getPlans(), getDuplicationRows(), getTargetGroups()]);
  // nabídka jen z plánů, které uživatel smí číst — kalkulačka nesmí být
  // zadní vrátka k číslům cizího plánu
  const readable = allPlans.filter((p) => can(me, "read", { area: "plan", planId: p.id }));

  let source: CalcSource | null = null;
  const planId = sp.plan && readable.some((p) => p.id === sp.plan) ? sp.plan : null;
  if (planId) {
    const plan = (await getPlan(planId))!;
    const months = monthsBetween(plan.periodStart, plan.periodEnd);
    const month = sp.mesic && months.includes(sp.mesic) ? sp.mesic : null;
    const reach = await getReachSummary(me, planId);
    const summary = month ? reach.months.find((m) => m.month === month)! : reach.total;
    source = {
      planId,
      month,
      label: `${plan.clientName} — ${plan.name} · ${month ? `${monthLabel(month)} ${month.slice(0, 4)}` : periodLabel(plan.periodStart, plan.periodEnd)}`,
      months: months.map((m) => ({ value: m, label: `${monthLabel(m)} ${m.slice(0, 4)}` })),
      universe: reach.universe,
      targetGroupName: tgs.find((t) => t.id === plan.targetGroupId)?.name ?? "bez cílové skupiny",
      parts: summary.byType
        .filter((b) => b.reach > 0)
        .map((b) => ({ channelType: b.channelType, reach: b.reach, grp: b.grp })),
    };
  }

  const canCalibrate =
    canManageUsers(me) || can(me, "write", { area: "plan", mediaType: null, planId: null, campaignId: null, month: null });

  return (
    <Chrome active="kalkulacka" user={{ name: user.name, email: user.email, role: user.role }}>
      <ReachCalculator
        key={`${source?.planId ?? ""}|${source?.month ?? ""}`}
        plans={readable.map((p) => ({
          id: p.id,
          label: `${p.clientName} — ${p.name} (${periodLabel(p.periodStart, p.periodEnd)})`,
        }))}
        source={source}
        dup={dupRows.map((r) => ({ typeA: r.typeA, typeB: r.typeB, coef: r.coef }))}
        canCalibrate={canCalibrate}
      />
      <DuplicationTable rows={dupRows} canEdit={canCalibrate} />
    </Chrome>
  );
}
