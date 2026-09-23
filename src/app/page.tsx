import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/auth";
import { getPlanRows, getCampaignTree, getUser } from "@/lib/queries";
import { can } from "@/lib/permissions";
import { MONTHS, MONTH_LABEL, kc, pct } from "@/lib/months";
import { Chrome } from "@/components/Chrome";
import { PlanTable, type PlanRow } from "@/components/PlanTable";

export const dynamic = "force-dynamic";

export default async function PlanPage() {
  const me = await currentPrincipal();
  if (!me) redirect("/prihlaseni");

  const user = await getUser(me.id);
  if (!user) redirect("/prihlaseni");
  const [rows, campaigns] = await Promise.all([getPlanRows(me), getCampaignTree()]);
  const canEditPlan = can(me, "write", { area: "plan", mediaType: null, campaignId: null, month: null });

  const total = rows.reduce((s, r) => s + MONTHS.reduce((a, m) => a + r.budgets[m], 0), 0);
  const byType = (ty: string) =>
    rows.filter((r) => r.mediaType === ty).reduce((s, r) => s + MONTHS.reduce((a, m) => a + r.budgets[m], 0), 0);
  const spent = rows.reduce((s, r) => s + MONTHS.reduce((a, m) => a + r.actuals[m], 0), 0);

  const readOnlyPlan = !rows.some((r) => MONTHS.some((m) => r.editable[m]));

  return (
    <Chrome active="plan" user={{ name: user.name, email: user.email, role: user.role }}>
      <div className="kpis">
        <div className="kpi">
          <div className="k">Plán Q4</div>
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

      {readOnlyPlan && (
        <div className="banner info">
          <span>
            <b>Plán máte jen ke čtení.</b> Rozpočty mění media plánovač. Skutečné čerpání vyplňujete
            v záložce <a href="/plneni">Detail &amp; plnění</a>, a to jen tam, kde k tomu máte oprávnění.
          </span>
        </div>
      )}

      <PlanTable rows={rows} campaigns={campaigns} months={[...MONTHS]} monthLabels={MONTH_LABEL} canEditPlan={canEditPlan} />

      <div className="banner">
        <span>
          <b>Pracovní podklad.</b> Rozdělení rozpočtu, mediamix i částky vyžadují validaci media
          specialistou před sdílením s klientem. Částky jsou vč. agenturního fee.
        </span>
      </div>
    </Chrome>
  );
}
