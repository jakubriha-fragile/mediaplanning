import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/auth";
import { getPerfRows, getUser } from "@/lib/queries";
import { myUndoStack } from "@/lib/actions";
import { MONTHS, MONTH_LABEL } from "@/lib/months";
import { Chrome } from "@/components/Chrome";
import { PerfTable, type PerfRow } from "@/components/PerfTable";

export const dynamic = "force-dynamic";

export default async function PerfPage() {
  const me = await currentPrincipal();
  if (!me) redirect("/prihlaseni");
  const user = await getUser(me.id);
  if (!user) redirect("/prihlaseni");
  const [rows, undo] = await Promise.all([getPerfRows(me), myUndoStack()]);

  const canWriteAnything = rows.some((r) => MONTHS.some((m) => r.editable[m]));

  return (
    <Chrome active="plneni" user={{ name: user.name, email: user.email, role: user.role }}>
      {!canWriteAnything && (
        <div className="banner info">
          <span>
            <b>Máte jen čtení.</b> Skutečnost vyplňuje ten, komu administrátor přidělil oprávnění
            pro daný typ média, kampaň a měsíc.
          </span>
        </div>
      )}
      <PerfTable rows={rows} months={[...MONTHS]} monthLabels={MONTH_LABEL} undoLabel={undo[0]?.label ?? null} />
      <div className="banner">
        <span>
          <b>Pracovní podklad.</b> Vyhodnocení slouží jako interní přehled; před sdílením s klientem
          vyžaduje validaci media specialistou.
        </span>
      </div>
    </Chrome>
  );
}
