import Link from "next/link";
import { Mark } from "./Mark";
import { Sticky } from "./Sticky";
import { signOut, adminDomains, adminDomainsActive } from "@/lib/auth";

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
  children,
}: {
  active: "plan" | "plneni" | "sprava" | "nastaveni";
  user: { name: string | null; email: string; role: string };
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
              <em>BENU</em> — Mediaplán Q4 2026
            </h1>
            <span className="sub">Fragile · Paid / Owned / Earned</span>
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
      </div>
    </>
  );
}
