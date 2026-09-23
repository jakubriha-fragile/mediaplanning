import { redirect } from "next/navigation";
import { db } from "@/db";
import { users, campaigns, grants } from "@/db/schema";
import { eq, asc } from "drizzle-orm";
import { currentPrincipal } from "@/lib/auth";
import { canManageUsers } from "@/lib/permissions";
import { MONTHS, MONTH_LABEL, QUARTER } from "@/lib/months";
import { Chrome } from "@/components/Chrome";
import { addGrant, removeGrant, inviteUser, setUserActive, recentChanges } from "@/lib/actions";
import { getUser } from "@/lib/queries";

export const dynamic = "force-dynamic";

const ROLE_HINT: Record<string, string> = {
  ADMIN: "spravuje uživatele a oprávnění, vidí a mění vše",
  PLANNER: "plán i skutečnost",
  ACCOUNT: "skutečnost a podklady, plán jen ke čtení",
  CLIENT: "jen to, co mu přidělíte grantem",
  VIEWER: "jen čtení",
};

export default async function AdminPage() {
  const me = await currentPrincipal();
  if (!me) redirect("/prihlaseni");
  if (!canManageUsers(me)) redirect("/");

  const user = await getUser(me.id);
  if (!user) redirect("/prihlaseni");

  const [people, camps, grantRows, log] = await Promise.all([
    db.select().from(users).orderBy(asc(users.role), asc(users.email)),
    db.select().from(campaigns).where(eq(campaigns.quarter, QUARTER)).orderBy(asc(campaigns.name)),
    db
      .select({
        id: grants.id, userId: grants.userId, area: grants.area, level: grants.level,
        mediaType: grants.mediaType, month: grants.month, note: grants.note,
        campaignName: campaigns.name,
      })
      .from(grants)
      .leftJoin(campaigns, eq(grants.campaignId, campaigns.id)),
    recentChanges(40),
  ]);

  return (
    <Chrome active="sprava" user={{ name: user.name, email: user.email, role: user.role }}>
      <div className="banner info">
        <span>
          <b>Oprávnění se vynucuje na serveru.</b> Zašedlá pole v rozhraní jsou pohodlí, ne ochrana —
          o tom, co projde, rozhoduje engine u každého zápisu. Grant má čtyři rozměry: typ média,
          kampaň, měsíc a oblast. Prázdná hodnota znamená „vše". Kdo nemá grant, nemá přístup.
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
              {Object.keys(ROLE_HINT).map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <button className="btn primary" type="submit">Pozvat</button>
        </form>
        <div className="note">
          {Object.entries(ROLE_HINT).map(([r, h]) => <div key={r}><b>{r}</b> — {h}</div>)}
        </div>
      </div>

      {people.map((u) => {
        const myGrants = grantRows.filter((g) => g.userId === u.id);
        return (
        <div className="panel" key={u.id} style={{ borderRadius: 5, marginBottom: 12 }}>
          <div className="toolbar">
            <b>{u.name ?? u.email}</b>
            <span className="pill ph">{u.role}</span>
            <span className="share">{u.email}</span>
            {!u.active && <span className="pill s-bad">deaktivován</span>}
            <span className="spacer" />
            <form action={async () => { "use server"; await setUserActive(u.id, !u.active); }}>
              <button className={`btn ${u.active ? "danger" : ""}`} type="submit" disabled={u.id === me.id}>
                {u.active ? "Deaktivovat" : "Aktivovat"}
              </button>
            </form>
          </div>

          {myGrants.length > 0 && (
            <div className="scroll">
              <table>
                <thead>
                  <tr><th>Oblast</th><th>Úroveň</th><th>Typ média</th><th>Kampaň</th><th>Měsíc</th><th>Poznámka</th><th /></tr>
                </thead>
                <tbody>
                  {myGrants.map((g) => (
                    <tr key={g.id}>
                      <td>{g.area === "plan" ? "plán" : g.area === "actuals" ? "skutečnost" : "podklady"}</td>
                      <td><span className={`pill ${g.level === "write" ? "s-ok" : "ph"}`}>{g.level === "write" ? "zápis" : "čtení"}</span></td>
                      <td>{g.mediaType ? <span className={`pill ${g.mediaType}`}>{g.mediaType}</span> : <span className="share">všechny</span>}</td>
                      <td>{g.campaignName ?? <span className="share">všechny</span>}</td>
                      <td>{g.month ? MONTH_LABEL[g.month] ?? g.month : <span className="share">všechny</span>}</td>
                      <td className="share">{g.note ?? ""}</td>
                      <td className="r">
                        <form action={async () => { "use server"; await removeGrant(g.id); }}>
                          <button className="btn danger" type="submit">Odebrat</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <form
            action={async (fd: FormData) => {
              "use server";
              await addGrant({
                userId: u.id,
                area: fd.get("area") as never,
                level: fd.get("level") as never,
                mediaType: (fd.get("mediaType") || null) as never,
                campaignId: (fd.get("campaignId") || null) as never,
                month: (fd.get("month") || null) as never,
                note: String(fd.get("note") || ""),
              });
            }}
            style={{ display: "flex", gap: 8, padding: 12, flexWrap: "wrap", alignItems: "flex-end", borderTop: "1px solid var(--line)" }}
          >
            <div className="field" style={{ margin: 0, minWidth: 120 }}>
              <label>Oblast</label>
              <select name="area" defaultValue="actuals">
                <option value="plan">plán</option>
                <option value="actuals">skutečnost</option>
                <option value="assets">podklady</option>
              </select>
            </div>
            <div className="field" style={{ margin: 0, minWidth: 100 }}>
              <label>Úroveň</label>
              <select name="level" defaultValue="write"><option value="read">čtení</option><option value="write">zápis</option></select>
            </div>
            <div className="field" style={{ margin: 0, minWidth: 120 }}>
              <label>Typ média</label>
              <select name="mediaType" defaultValue=""><option value="">všechny</option>
                <option>Paid</option><option>Owned</option><option>Earned</option></select>
            </div>
            <div className="field" style={{ margin: 0, minWidth: 150 }}>
              <label>Kampaň</label>
              <select name="campaignId" defaultValue=""><option value="">všechny</option>
                {camps.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            </div>
            <div className="field" style={{ margin: 0, minWidth: 120 }}>
              <label>Měsíc</label>
              <select name="month" defaultValue=""><option value="">všechny</option>
                {MONTHS.map((m) => <option key={m} value={m}>{MONTH_LABEL[m]}</option>)}</select>
            </div>
            <div className="field" style={{ margin: 0, minWidth: 140 }}>
              <label>Poznámka</label>
              <input name="note" placeholder="proč je grant udělen" />
            </div>
            <button className="btn" type="submit">Přidat oprávnění</button>
          </form>
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
