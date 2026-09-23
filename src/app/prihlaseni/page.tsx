import { redirect } from "next/navigation";
import { auth, signIn } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq, asc } from "drizzle-orm";
import { Mark } from "@/components/Mark";

export const dynamic = "force-dynamic";

const devLogin = process.env.ENABLE_DEV_LOGIN === "true" && process.env.NODE_ENV !== "production";
const googleReady = !!process.env.AUTH_GOOGLE_ID && !!process.env.AUTH_GOOGLE_SECRET;

/** Chyby z Auth.js přeložené do češtiny — generické hlášky nikomu nepomůžou. */
const ERRORS: Record<string, { title: string; detail: string }> = {
  Configuration: {
    title: "Přihlášení není správně nastavené",
    detail:
      "Auth.js nemůže dokončit konfiguraci. Nejčastěji chybí proměnná AUTH_SECRET, " +
      "nebo je uložená jen pro Preview a ne pro Production.",
  },
  AccessDenied: {
    title: "Účet nemá přístup",
    detail:
      "Přihlásit se může jen ten, kdo je pozvaný, nebo přichází z povolené domény. " +
      "Požádejte administrátora o pozvánku.",
  },
  Verification: { title: "Odkaz vypršel", detail: "Zkuste se přihlásit znovu." },
  Default: { title: "Přihlášení se nezdařilo", detail: "Zkuste to prosím znovu." },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (session?.user) redirect("/");

  const { error } = await searchParams;
  const err = error ? (ERRORS[error] ?? ERRORS.Default) : null;

  // Bootstrap pomůcka: dokud se nedá přihlásit, ukážeme NÁZVY chybějících
  // proměnných (nikdy hodnoty). Jinak by se administrátor nedostal ani
  // na stránku Nastavení, kde je diagnostika schovaná.
  const missing = [
    { key: "AUTH_SECRET", ok: !!process.env.AUTH_SECRET },
    { key: "AUTH_GOOGLE_ID", ok: !!process.env.AUTH_GOOGLE_ID },
    { key: "AUTH_GOOGLE_SECRET", ok: !!process.env.AUTH_GOOGLE_SECRET },
    { key: "DATABASE_URL", ok: !!process.env.DATABASE_URL },
  ].filter((c) => !c.ok);

  let testUsers: Array<{ id: string; email: string; name: string | null; role: string }> = [];
  if (devLogin) {
    try {
      testUsers = await db.select().from(users).where(eq(users.active, true)).orderBy(asc(users.role)).limit(20);
    } catch {
      testUsers = [];
    }
  }

  return (
    <div className="login">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
        <Mark size={20} />
        <span className="sub">Fragile · KNOWLIMITS Group</span>
      </div>

      <div className="card">
        <h2>Mediaplán</h2>
        <p>Plánování a vyhodnocování kampaní BENU. Přístup jen pro pozvané účty.</p>

        {err && (
          <div className="banner" style={{ marginTop: 0 }}>
            <span><b>{err.title}.</b> {err.detail}</span>
          </div>
        )}

        {missing.length > 0 && (
          <div className="banner" style={{ marginTop: 0 }}>
            <span>
              <b>Chybí nastavení:</b>{" "}
              {missing.map((m) => m.key).join(", ")}. Doplňte je ve Vercelu
              v Settings → Environment Variables pro prostředí <b>Production</b> a spusťte redeploy.
            </span>
          </div>
        )}

        {googleReady && (
          <form action={async () => { "use server"; await signIn("google", { redirectTo: "/" }); }}>
            <button className="btn primary" type="submit" style={{ width: "100%", padding: 10 }}>
              Přihlásit se přes Google
            </button>
          </form>
        )}

        {devLogin && testUsers.length > 0 && (
          <>
            {googleReady && <div className="sep">nebo testovací účet</div>}
            <form action={async (fd: FormData) => {
              "use server";
              await signIn("dev", { email: String(fd.get("email")), redirectTo: "/" });
            }}>
              <div className="field">
                <label htmlFor="email">Testovací účet</label>
                <select id="email" name="email" defaultValue={testUsers[0]?.email}>
                  {testUsers.map((u) => (
                    <option key={u.id} value={u.email}>{u.name ?? u.email} — {u.role}</option>
                  ))}
                </select>
              </div>
              <button className="btn" type="submit" style={{ width: "100%", padding: 9 }}>
                Přihlásit se
              </button>
            </form>
            <p style={{ marginTop: 16, marginBottom: 0, fontSize: 11.5 }}>
              Testovací přihlášení je jen pro lokální vývoj. V produkci se samo vypne.
            </p>
          </>
        )}

        {!googleReady && !devLogin && (
          <div className="banner" style={{ marginBottom: 0 }}>
            <span><b>Google SSO zatím není nakonfigurované.</b> Doplňte klíče podle hlášky výše.</span>
          </div>
        )}
      </div>
    </div>
  );
}
