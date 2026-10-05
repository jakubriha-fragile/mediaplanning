import Link from "next/link";
import { Mark } from "./Mark";
import { Sticky } from "./Sticky";
import { signOut, adminDomains, adminDomainsActive } from "@/lib/auth";
import { VERSION, COMMIT, buildLabel, buildAge } from "@/lib/version";

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "administrátor",
  PLANNER: "plánovač",
  ACCOUNT: "account",
  CLIENT: "klient",
  VIEWER: "čtenář",
};

export function Chrome({
  active,
  user,
  title,
  children,
}: {
  active: "plan" | "plneni" | "kalkulacka" | "sprava" | "nastaveni";
  user: { name: string | null; email: string; role: string };
  /** klient a období otevřeného plánu; bez plánu zůstane jen název aplikace */
  title?: { client: string; period: string };
  children: React.ReactNode;
}) {
  return (
    <>
      <Sticky />
      <div className="top">
        <div className="topin">
          <div className="brandline">
            <Mark />
            <h1>
              {title ? <><em>{title.client}</em> — Mediaplán {title.period}</> : <><em>Mediaplán</em></>}
            </h1>
            <span className="sub">Fragile · plánování a vyhodnocení kampaní</span>
            <div className="right">
              <span>
                {user.name ?? user.email}
                <span className="role">{ROLE_LABEL[user.role] ?? user.role}</span>
              </span>
              <form
                action={async () => {
                  "use server";
                  await signOut({ redirectTo: "/prihlaseni" });
                }}
              >
                <button className="btn" type="submit">Odhlásit</button>
              </form>
            </div>
          </div>
          <nav className="nav">
            <Link href="/" aria-current={active === "plan" ? "page" : undefined}>Plán</Link>
            <Link href="/plneni" aria-current={active === "plneni" ? "page" : undefined}>Detail &amp; plnění</Link>
            {user.role !== "CLIENT" && (
              <Link href="/kalkulacka" aria-current={active === "kalkulacka" ? "page" : undefined}>Kalkulačka zásahu</Link>
            )}
            {user.role === "ADMIN" && (
              <>
                <Link href="/sprava" aria-current={active === "sprava" ? "page" : undefined}>Uživatelé &amp; oprávnění</Link>
                <Link href="/nastaveni" aria-current={active === "nastaveni" ? "page" : undefined}>Nastavení</Link>
              </>
            )}
          </nav>
        </div>
      </div>
      <div className="shell">
        {adminDomainsActive && (
          <div className="banner" style={{ marginTop: 12 }}>
            <span>
              <b>Testovací režim:</b> každý, kdo se přihlásí z domény{" "}
              <b>{adminDomains.join(", ")}</b>, dostane automaticky práva administrátora — tedy může
              měnit rozpočty, spravovat uživatele a přidělovat oprávnění. Než pustíte dovnitř
              klienta, smažte ve Vercelu proměnnou <code>ADMIN_EMAIL_DOMAINS</code> a role lidem
              upravte ve správě uživatelů.
            </span>
          </div>
        )}
        {children}

        <footer className="foot">
          <span>
            Mediaplán <b>v{VERSION}</b>
            {COMMIT && <span className="share"> · {COMMIT}</span>}
          </span>
          <span className="share" title={`Čas posledního nasazení: ${buildLabel()}`}>
            Naposledy aktualizováno {buildLabel()}
            {buildAge() && <> · {buildAge()}</>}
          </span>
          <span className="spacer" />
          <span className="share">Fragile · KNOWLIMITS Group</span>
        </footer>
      </div>
    </>
  );
}
