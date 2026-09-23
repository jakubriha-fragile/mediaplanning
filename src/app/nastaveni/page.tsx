import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/auth";
import { canManageUsers } from "@/lib/permissions";
import { getUser } from "@/lib/queries";
import { Chrome } from "@/components/Chrome";
import { Copyable } from "@/components/Copyable";

export const dynamic = "force-dynamic";

/**
 * Kontrola nasazení — ukáže, co je nastavené a co chybí, a hlavně vypíše
 * přesnou redirect URI pro Google Cloud Console. Hodnoty proměnných se
 * nikdy nezobrazují, jen jestli existují.
 */
export default async function SetupPage() {
  const me = await currentPrincipal();
  if (!me) redirect("/prihlaseni");
  if (!canManageUsers(me)) redirect("/");
  const user = await getUser(me.id);
  if (!user) redirect("/prihlaseni");

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${proto}://${host}`;
  const redirectUri = `${origin}/api/auth/callback/google`;

  const isProd = process.env.NODE_ENV === "production";
  const devLoginOn = process.env.ENABLE_DEV_LOGIN === "true" && !isProd;
  const devLoginRequested = process.env.ENABLE_DEV_LOGIN === "true";

  const checks = [
    {
      key: "DATABASE_URL",
      ok: !!process.env.DATABASE_URL,
      hint: "Připojení k databázi. Doplní Neon při propojení s Vercelem.",
    },
    {
      key: "AUTH_SECRET",
      ok: !!process.env.AUTH_SECRET,
      hint: "Podepisuje session. Vygenerujte: openssl rand -base64 32",
    },
    {
      key: "AUTH_GOOGLE_ID",
      ok: !!process.env.AUTH_GOOGLE_ID,
      hint: "Client ID z Google Cloud Console.",
    },
    {
      key: "AUTH_GOOGLE_SECRET",
      ok: !!process.env.AUTH_GOOGLE_SECRET,
      hint: "Client secret ze stejného místa.",
    },
    {
      key: "ALLOWED_EMAIL_DOMAINS",
      ok: !!process.env.ALLOWED_EMAIL_DOMAINS,
      hint: "Domény, ze kterých se smí kdokoli přihlásit, např. fragile.cz. Bez toho se přihlásí jen pozvaní.",
      optional: true,
    },
  ];

  const missing = checks.filter((c) => !c.ok && !c.optional);
  const googleReady = !!process.env.AUTH_GOOGLE_ID && !!process.env.AUTH_GOOGLE_SECRET;

  return (
    <Chrome active="nastaveni" user={{ name: user.name, email: user.email, role: user.role }}>
      {devLoginRequested && isProd && (
        <div className="banner">
          <span>
            <b>Pozor: v produkci je zapnuté ENABLE_DEV_LOGIN.</b> Samo se sice nepoužije, protože
            testovací přihlášení běží jen mimo produkci, ale proměnnou raději odstraňte úplně.
          </span>
        </div>
      )}

      {missing.length > 0 && (
        <div className="banner">
          <span>
            <b>Chybí {missing.length} {missing.length === 1 ? "proměnná" : "proměnné"}:</b>{" "}
            {missing.map((m) => m.key).join(", ")}. Doplňte je ve Vercelu v Settings → Environment
            Variables a spusťte redeploy.
          </span>
        </div>
      )}

      <div className="panel" style={{ borderRadius: 5, marginBottom: 16 }}>
        <div className="toolbar">
          <b>Proměnné prostředí</b>
          <span className="share">Zobrazuje se jen jestli existují, nikdy jejich hodnota</span>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr><th>Proměnná</th><th>Stav</th><th>K čemu je</th></tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.key}>
                  <td><code>{c.key}</code></td>
                  <td>
                    {c.ok ? (
                      <span className="pill s-ok"><b className="g">✓</b>nastaveno</span>
                    ) : c.optional ? (
                      <span className="pill s-idle">nenastaveno</span>
                    ) : (
                      <span className="pill s-bad"><b className="g">▲</b>chybí</span>
                    )}
                  </td>
                  <td className="share">{c.hint}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel" style={{ borderRadius: 5, marginBottom: 16 }}>
        <div className="toolbar">
          <b>Google OAuth</b>
          {googleReady
            ? <span className="pill s-ok"><b className="g">✓</b>nakonfigurováno</span>
            : <span className="pill s-bad"><b className="g">▲</b>zbývá dokončit</span>}
        </div>
        <div style={{ padding: "14px 14px 4px" }}>
          <p style={{ margin: "0 0 10px", fontSize: 12.5 }}>
            V <b>Google Cloud Console → APIs &amp; Services → Credentials → Create OAuth client ID
            → Web application</b> vložte tyhle dvě hodnoty. Musí sedět na znak, jinak Google
            přihlášení odmítne.
          </p>
          <div style={{ marginBottom: 12 }}>
            <div className="share" style={{ marginBottom: 3 }}>Authorized JavaScript origins</div>
            <Copyable value={origin} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <div className="share" style={{ marginBottom: 3 }}>Authorized redirect URI</div>
            <Copyable value={redirectUri} />
          </div>
        </div>
        <div className="note">
          Client ID a secret pak vložte do Vercelu jako <code>AUTH_GOOGLE_ID</code> a{" "}
          <code>AUTH_GOOGLE_SECRET</code> (Production i Preview) a spusťte redeploy.
          Pokud aplikaci pouštíte i lokálně, přidejte do Google ještě origin{" "}
          <code>http://localhost:3000</code> a redirect{" "}
          <code>http://localhost:3000/api/auth/callback/google</code>.
        </div>
      </div>

      <div className="panel" style={{ borderRadius: 5 }}>
        <div className="toolbar"><b>Kdo se sem dostane</b></div>
        <div className="note" style={{ borderTop: "none" }}>
          Přihlásit se může jen ten, kdo je <b>pozvaný v záložce Uživatelé &amp; oprávnění</b>,
          nebo přichází z domény uvedené v <code>ALLOWED_EMAIL_DOMAINS</code>
          {process.env.ALLOWED_EMAIL_DOMAINS ? (
            <> — teď <b>{process.env.ALLOWED_EMAIL_DOMAINS}</b></>
          ) : (
            <> — ta teď není nastavená, takže projdou <b>jen pozvaní</b></>
          )}. Kdo přijde odjinud, neprojde ani s platným Google účtem.
          <br /><br />
          Pro testování s kolegy: buď je pozvěte jmenovitě a rovnou jim nastavte roli, nebo je
          nechte přihlásit z povolené domény — dostanou roli <b>VIEWER</b>, tedy jen čtení,
          a roli jim pak zvednete.
          {devLoginOn && (
            <>
              <br /><br />
              <b>Testovací přihlášení je aktivní</b> (běžíte mimo produkci), takže se na přihlašovací
              stránce dá vybrat účet ze seznamu bez Googlu.
            </>
          )}
        </div>
      </div>
    </Chrome>
  );
}
