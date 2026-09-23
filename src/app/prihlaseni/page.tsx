import { redirect } from "next/navigation";
import { auth, signIn } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq, asc } from "drizzle-orm";
import { Mark } from "@/components/Mark";

export const dynamic = "force-dynamic";

const devLogin = process.env.ENABLE_DEV_LOGIN === "true" && process.env.NODE_ENV !== "production";
const googleReady = !!process.env.AUTH_GOOGLE_ID;

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) redirect("/");

  const testUsers = devLogin
    ? await db.select().from(users).where(eq(users.active, true)).orderBy(asc(users.role)).limit(20)
    : [];

  return (
    <div className="login">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
        <Mark size={20} />
        <span className="sub">Fragile · KNOWLIMITS Group</span>
      </div>
      <div className="card">
        <h2>Mediaplán</h2>
        <p>Plánování a vyhodnocování kampaní BENU. Přístup jen pro pozvané účty.</p>

        {googleReady && (
          <form action={async () => { "use server"; await signIn("google", { redirectTo: "/" }); }}>
            <button className="btn primary" type="submit" style={{ width: "100%", padding: "10px" }}>
              Přihlásit se přes Google
            </button>
          </form>
        )}

        {devLogin && (
          <>
            {googleReady && <div className="sep">nebo testovací účet</div>}
            {!googleReady && (
              <div className="banner" style={{ marginTop: 0 }}>
                <span>
                  <b>Google SSO zatím není nastavené.</b> Doplňte AUTH_GOOGLE_ID a AUTH_GOOGLE_SECRET
                  do proměnných prostředí. Zatím se přihlaste testovacím účtem.
                </span>
              </div>
            )}
            <form action={async (fd: FormData) => {
              "use server";
              await signIn("dev", { email: String(fd.get("email")), redirectTo: "/" });
            }}>
              <div className="field">
                <label htmlFor="email">Testovací účet</label>
                <select id="email" name="email" defaultValue={testUsers[0]?.email}>
                  {testUsers.map((u) => (
                    <option key={u.id} value={u.email}>
                      {u.name ?? u.email} — {u.role}
                    </option>
                  ))}
                </select>
              </div>
              <button className="btn" type="submit" style={{ width: "100%", padding: "9px" }}>
                Přihlásit se
              </button>
            </form>
            <p style={{ marginTop: 16, marginBottom: 0, fontSize: 11.5 }}>
              Testovací přihlášení je určené jen pro lokální vývoj. V produkci ho vypněte
              nastavením <code>ENABLE_DEV_LOGIN=false</code>.
            </p>
          </>
        )}

        {!googleReady && !devLogin && (
          <div className="banner"><span><b>Přihlášení není nakonfigurováno.</b> Doplňte Google OAuth klíče.</span></div>
        )}
      </div>
    </div>
  );
}
