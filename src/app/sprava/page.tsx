import { redirect } from "next/navigation";
import { db } from "@/db";
import { users, campaigns, grants, plans, tactics, messageLines } from "@/db/schema";
import { eq, asc } from "drizzle-orm";
import { currentPrincipal } from "@/lib/auth";
import { canManageUsers, channelGroupOf, ACCESS_LEVEL_LABEL } from "@/lib/permissions";
import { monthsBetween, monthLabel } from "@/lib/period";
import { Chrome } from "@/components/Chrome";
import { AccessEditor, type AccessPlan } from "@/components/AccessEditor";
import { addGrant, removeGrant, removeGrantBundle, inviteUser, setUserActive, setUserRole, recentChanges } from "@/lib/actions";
import { getUser } from "@/lib/queries";

export const dynamic = "force-dynamic";

const ROLE_HINT: Record<string, string> = {
  ADMIN: "spravuje uživatele a oprávnění, vidí a mění vše",
  PLANNER: "plán i skutečnost u všech plánů",
  ACCOUNT: "skutečnost a podklady, plán jen ke čtení",
  CLIENT: "jen to, co mu přidělíte níže — bez přístupu nevidí nic",
  VIEWER: "jen čtení všech plánů",
};

const ROLE_NAME: Record<string, string> = {
  ADMIN: "Administrátor", PLANNER: "Plánovač (agentura)", ACCOUNT: "Account (agentura)",
  CLIENT: "Klient", VIEWER: "Jen čtení",
};

/** „položku platí klient sám" — formulace, kterou plány BENU skutečně používají */
const CLIENT_PAYS = /hradí klient|vlastní karty/i;

type GrantView = {
  id: string; userId: string; area: string; level: string; mediaType: string | null; month: string | null;
  note: string | null; campaignName: string | null; planId: string | null; channelGroup: string | null;
  tacticId: string | null; bundle: string | null;
};

/** Svazek grantů → jedna věta: co smí, na čem, kdy. */
function describe(gs: GrantView[], tacticName: Record<string, string>, monthName: Record<string, string>) {
  const areas = new Set(gs.map((g) => `${g.area}:${g.level}`));
  const level =
    areas.has("plan:write") && areas.has("actuals:write") ? ACCESS_LEVEL_LABEL.edit
    : areas.size === 1 && areas.has("actuals:write") ? ACCESS_LEVEL_LABEL.fill
    : areas.size === 1 && areas.has("plan:read") ? ACCESS_LEVEL_LABEL.view
    : [...areas].map((a) => {
        const [ar, lv] = a.split(":");
        return `${ar === "plan" ? "plán" : ar === "actuals" ? "skutečnost" : "podklady"} (${lv === "write" ? "zápis" : "čtení"})`;
      }).join(", ");
  const g0 = gs[0];
  const items = [...new Set(gs.map((g) => g.tacticId).filter(Boolean) as string[])];
  const what = items.length
    ? items.map((t) => tacticName[t] ?? "smazaná položka").join(" · ")
    : [
        g0.channelGroup === "offline" ? "offline" : g0.channelGroup === "online" ? "online" : null,
        g0.mediaType, g0.campaignName ? `blok ${g0.campaignName}` : null,
      ].filter(Boolean).join(", ") || "celý plán";
  const months = [...new Set(gs.map((g) => g.month).filter(Boolean) as string[])].sort();
  const when = months.length ? months.map((m) => monthName[m] ?? m).join(", ") : "všechny měsíce";
  return { level, what, items: items.length, when };
}

export default async function AdminPage() {
  const me = await currentPrincipal();
  if (!me) redirect("/prihlaseni");
  if (!canManageUsers(me)) redirect("/");

  const user = await getUser(me.id);
  if (!user) redirect("/prihlaseni");

  const [people, planRows, grantRows, log] = await Promise.all([
    db.select().from(users).orderBy(asc(users.role), asc(users.email)),
    db.select().from(plans).orderBy(asc(plans.position), asc(plans.periodStart)),
    db
      .select({
        id: grants.id, userId: grants.userId, area: grants.area, level: grants.level,
        mediaType: grants.mediaType, month: grants.month, note: grants.note,
        campaignName: campaigns.name, planId: grants.planId,
        channelGroup: grants.channelGroup, tacticId: grants.tacticId, bundle: grants.bundle,
      })
      .from(grants)
      .leftJoin(campaigns, eq(grants.campaignId, campaigns.id)),
    recentChanges(40),
  ]);

  // granty se udělují na konkrétní plán, takže kampaně nabízíme jen z nich
  const camps = await db.select().from(campaigns).orderBy(asc(campaigns.name));
  const tacticRows = await db
    .select({
      id: tactics.id, channel: tactics.channel, channelType: tactics.channelType,
      block: campaigns.name, planId: campaigns.planId,
    })
    .from(tactics)
    .innerJoin(messageLines, eq(tactics.messageLineId, messageLines.id))
    .innerJoin(campaigns, eq(messageLines.campaignId, campaigns.id))
    .orderBy(asc(campaigns.position), asc(campaigns.name), asc(tactics.position));
  const tacticName = Object.fromEntries(tacticRows.map((t) => [t.id, t.channel]));
  const MONTHS = [...new Set(planRows.flatMap((p) => monthsBetween(p.periodStart, p.periodEnd)))].sort();
  const MONTH_LABEL = Object.fromEntries(MONTHS.map((m) => [m, `${monthLabel(m)} ${m.slice(0, 4)}`]));
  const planName = Object.fromEntries(planRows.map((p) => [p.id, p.name]));
  const accessPlans: AccessPlan[] = planRows.map((p) => ({
    id: p.id,
    name: p.name,
    months: monthsBetween(p.periodStart, p.periodEnd).map((m) => ({ value: m, label: MONTH_LABEL[m] })),
    tactics: tacticRows.filter((t) => t.planId === p.id).map((t) => ({
      id: t.id, channel: t.channel, channelType: t.channelType, block: t.block,
      group: channelGroupOf(t.channelType), clientPays: CLIENT_PAYS.test(t.channel),
    })),
  }));

  return (
    <Chrome active="sprava" user={{ name: user.name, email: user.email, role: user.role }}>
      <div className="banner info">
        <span>
          <b>Jak přístupy fungují:</b> agentura (administrátor, plánovač) vidí všechno podle role.
          Klient nevidí nic, dokud mu tady nepřidělíte přístup — vždy ke konkrétnímu plánu, a buď
          k celému, nebo jen k offline, online či vybraným položkám. Uvidí pak jen to, k čemu přístup
          má, a v záložce <b>K vyplnění</b> najde přesně svoje položky. Kontroluje se to na serveru
          u každého zápisu i čtení.
        </span>
      </div>

      <div className="panel" style={{ borderRadius: 5, marginBottom: 16 }}>
        <div className="toolbar"><b>Pozvat uživatele</b>
          <span className="share">Účet vznikne až prvním přihlášením přes Google</span>
        </div>
        <form
          action={async (fd: FormData) => {
            "use server";
            await inviteUser({
              email: String(fd.get("email")),
              name: String(fd.get("name") || ""),
              role: fd.get("role") as never,
            });
          }}
          style={{ display: "flex", gap: 10, padding: 12, flexWrap: "wrap", alignItems: "flex-end" }}
        >
          <div className="field" style={{ margin: 0, minWidth: 220 }}>
            <label htmlFor="email">E-mail</label>
            <input id="email" name="email" type="email" required placeholder="jmeno@benu.cz" />
          </div>
          <div className="field" style={{ margin: 0, minWidth: 160 }}>
            <label htmlFor="name">Jméno</label>
            <input id="name" name="name" placeholder="nepovinné" />
          </div>
          <div className="field" style={{ margin: 0, minWidth: 150 }}>
            <label htmlFor="role">Role</label>
            <select id="role" name="role" defaultValue="CLIENT">
              {Object.keys(ROLE_HINT).map((r) => <option key={r} value={r}>{ROLE_NAME[r]}</option>)}
            </select>
          </div>
          <button className="btn primary" type="submit">Pozvat</button>
        </form>
        <div className="note">
          {Object.entries(ROLE_HINT).map(([r, h]) => <div key={r}><b>{ROLE_NAME[r]}</b> — {h}</div>)}
        </div>
      </div>

      {people.map((u) => {
        const myGrants = grantRows.filter((g) => g.userId === u.id);
        return (
        <div className="panel" key={u.id} style={{ borderRadius: 5, marginBottom: 12 }}>
          <div className="toolbar">
            <b>{u.name ?? u.email}</b>
            <span className="pill ph">{ROLE_NAME[u.role] ?? u.role}</span>
            <span className="share">{u.email}</span>
            {!u.active && <span className="pill s-bad">deaktivován</span>}
            <span className="spacer" />
            {u.id !== me.id && (
              <form action={async (fd: FormData) => { "use server"; await setUserRole({ userId: u.id, role: fd.get("role") as never }); }}
                style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <select name="role" defaultValue={u.role} aria-label="Role" className="txt"
                  style={{ width: "auto", border: "1px solid var(--line-strong)" }}>
                  {Object.keys(ROLE_HINT).map((r) => <option key={r} value={r}>{ROLE_NAME[r]}</option>)}
                </select>
                <button className="btn" type="submit">Změnit roli</button>
              </form>
            )}
            <form action={async () => { "use server"; await setUserActive(u.id, !u.active); }}>
              <button className={`btn ${u.active ? "danger" : ""}`} type="submit" disabled={u.id === me.id}>
                {u.active ? "Deaktivovat" : "Aktivovat"}
              </button>
            </form>
          </div>

          {myGrants.length > 0 && (() => {
            // svazek = jedno přidělení; staré granty bez svazku jsou každý zvlášť
            const groups = new Map<string, GrantView[]>();
            for (const g of myGrants) {
              const key = g.bundle ? `b:${g.bundle}` : `g:${g.id}`;
              groups.set(key, [...(groups.get(key) ?? []), g]);
            }
            return (
              <div className="scroll">
                <table className="accesslist">
                  <thead><tr><th>Plán</th><th>Co smí</th><th>Na čem</th><th>Kdy</th><th /></tr></thead>
                  <tbody>
                    {[...groups.entries()].map(([key, gs]) => {
                      const d = describe(gs, tacticName, MONTH_LABEL);
                      const g0 = gs[0];
                      return (
                        <tr key={key}>
                          <td>{g0.planId ? planName[g0.planId] ?? "—" : <span className="share">všechny plány</span>}</td>
                          <td><span className={`pill ${gs.some((g) => g.level === "write") ? "s-ok" : "ph"}`}>{d.level}</span></td>
                          <td style={{ maxWidth: 520 }}>
                            {d.items ? <><b>{d.items} {d.items === 1 ? "položka" : d.items < 5 ? "položky" : "položek"}:</b> <span className="share">{d.what}</span></> : d.what}
                          </td>
                          <td className="share">{d.when}</td>
                          <td className="r">
                            <form action={async () => {
                              "use server";
                              if (g0.bundle) await removeGrantBundle({ userId: u.id, bundle: g0.bundle });
                              else await removeGrant(g0.id);
                            }}>
                              <button className="btn danger" type="submit">Odebrat</button>
                            </form>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })()}

          {u.role === "CLIENT" && !myGrants.length && (
            <div className="banner info" style={{ margin: 12 }}>
              <span><b>Zatím nic nevidí.</b> Přidejte mu přístup k plánu — třeba „vyplňuje skutečnost" u položek, které platí sám.</span>
            </div>
          )}

          {/* administrátor a plánovač mají z role plný přístup — grant by nic nepřidal
              a předvyplněný formulář jen sváděl k omylu */}
          {u.role === "ADMIN" || u.role === "PLANNER" ? (
            <div className="note" style={{ borderTop: "1px solid var(--line)" }}>
              {ROLE_NAME[u.role]} má přístup ke všem plánům z role — další oprávnění nepotřebuje.
            </div>
          ) : (
          <>
          <AccessEditor userId={u.id} userLabel={u.name ?? u.email} plans={accessPlans} />
          <details className="adv">
          <summary>Pokročilé: oprávnění po jednotlivých rozměrech</summary>
          <form
            action={async (fd: FormData) => {
              "use server";
              const plan = String(fd.get("planId") || "");
              await addGrant({
                userId: u.id,
                area: fd.get("area") as never,
                level: fd.get("level") as never,
                mediaType: (fd.get("mediaType") || null) as never,
                // „*" je vědomá volba všech plánů; prázdná hodnota formulář neodešle
                planId: (plan === "*" ? null : plan) as never,
                campaignId: (fd.get("campaignId") || null) as never,
                month: (fd.get("month") || null) as never,
                channelGroup: (fd.get("channelGroup") || null) as never,
                note: String(fd.get("note") || ""),
              });
            }}
            style={{ display: "flex", gap: 8, padding: 12, flexWrap: "wrap", alignItems: "flex-end", borderTop: "1px solid var(--line)" }}
          >
            <div className="field" style={{ margin: 0, minWidth: 120 }}>
              <label>Oblast</label>
              <select name="area" defaultValue="" required>
                <option value="" disabled>vyberte…</option>
                <option value="plan">plán</option>
                <option value="actuals">skutečnost</option>
                <option value="assets">podklady</option>
              </select>
            </div>
            <div className="field" style={{ margin: 0, minWidth: 100 }}>
              <label>Úroveň</label>
              <select name="level" defaultValue="" required>
                <option value="" disabled>vyberte…</option>
                <option value="read">čtení</option><option value="write">zápis</option>
              </select>
            </div>
            <div className="field" style={{ margin: 0, minWidth: 150 }}>
              <label>Plán</label>
              <select name="planId" defaultValue="" required>
                <option value="" disabled>vyberte plán…</option>
                {planRows.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                <option value="*">všechny plány (i budoucí)</option>
              </select>
            </div>
            <div className="field" style={{ margin: 0, minWidth: 120 }}>
              <label>Typ média</label>
              <select name="mediaType" defaultValue=""><option value="">všechny</option>
                <option>Paid</option><option>Owned</option><option>Earned</option></select>
            </div>
            <div className="field" style={{ margin: 0, minWidth: 120 }}>
              <label>Nosiče</label>
              <select name="channelGroup" defaultValue=""><option value="">offline i online</option>
                <option value="offline">offline</option><option value="online">online</option></select>
            </div>
            <div className="field" style={{ margin: 0, minWidth: 150 }}>
              <label>Kampaň</label>
              {/* kampaně se jmenují v každém plánu stejně — bez seskupení se snadno
                  vybrala kampaň z jiného plánu a grant pak nikdy nezabral */}
              <select name="campaignId" defaultValue=""><option value="">všechny</option>
                {planRows.map((p) => (
                  <optgroup key={p.id} label={p.name}>
                    {camps.filter((c) => c.planId === p.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </optgroup>
                ))}</select>
            </div>
            <div className="field" style={{ margin: 0, minWidth: 120 }}>
              <label>Měsíc</label>
              <select name="month" defaultValue=""><option value="">všechny</option>
                {planRows.map((p) => (
                  <optgroup key={p.id} label={p.name}>
                    {monthsBetween(p.periodStart, p.periodEnd).map((m) => <option key={`${p.id}-${m}`} value={m}>{MONTH_LABEL[m]}</option>)}
                  </optgroup>
                ))}</select>
            </div>
            <div className="field" style={{ margin: 0, minWidth: 140 }}>
              <label>Poznámka</label>
              <input name="note" placeholder="proč je grant udělen" />
            </div>
            <button className="btn" type="submit">Přidat oprávnění</button>
          </form>
          </details>
          </>
          )}
        </div>
        );
      })}

      <div className="panel" style={{ borderRadius: 5 }}>
        <div className="toolbar"><b>Historie změn</b><span className="share">posledních 40 záznamů</span></div>
        <div className="scroll">
          <table>
            <thead><tr><th>Kdy</th><th>Kdo</th><th>Oblast</th><th>Změna</th></tr></thead>
            <tbody>
              {log.map((e) => (
                <tr key={e.id}>
                  <td className="share" style={{ whiteSpace: "nowrap" }}>
                    {e.ts.toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric" })}{" "}
                    {e.ts.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>{e.userName ?? e.userEmail ?? "—"}</td>
                  <td><span className="pill ph">{e.area === "plan" ? "plán" : e.area === "actuals" ? "skutečnost" : "podklady"}</span></td>
                  <td>{e.items.map((i, k) => <div key={k}>{i}</div>)}</td>
                </tr>
              ))}
              {!log.length && <tr><td colSpan={4} style={{ padding: 20, textAlign: "center", color: "var(--muted)" }}>Zatím žádné změny.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="note">Záznamy vznikají automaticky při zápisu a nelze je editovat ani mazat.</div>
      </div>
    </Chrome>
  );
}
