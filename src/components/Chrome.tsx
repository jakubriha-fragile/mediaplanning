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

type Section = "prehled" | "plan" | "mix" | "vysledky" | "kalkulacka" | "sprava" | "nastaveni";

/** Jednoduché ikony kreslené čarou — bez knihovny, barva z textu. */
const ICON: Record<Section, string> = {
  prehled: "M4 19V10M10 19V5M16 19v-7M22 19H2",
  plan: "M3 5h18v14H3zM3 10h18M9 5v14",
  mix: "M12 3a9 9 0 1 0 9 9h-9z M14 2.5A8 8 0 0 1 21.5 10H14z",
  vysledky: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4",
  kalkulacka: "M6 3h12v18H6zM9 7h6M9 12h1M14 12h1M9 16h1M14 16h1",
  sprava: "M16 11a4 4 0 1 0-8 0M4 21a8 8 0 0 1 16 0",
  nastaveni: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2",
};

function Icon({ name }: { name: Section }) {
  return (
    <svg className="sb-ic" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={ICON[name]} />
    </svg>
  );
}

type Item = { key: Section; href: string; label: string };

/**
 * Menu podle toho, kdo se dívá. Agentura plánuje, vyhodnocuje a ladí model;
 * klient vyplňuje svoje položky a čte výsledek. Odborné nástroje (Přehled
 * s modelem zásahu, kalkulačka) by klienta jen mátly.
 */
function groups(role: string): Array<{ title: string | null; items: Item[] }> {
  if (role === "CLIENT") {
    return [{
      title: null,
      items: [
        { key: "vysledky", href: "/vysledky", label: "K vyplnění" },
        { key: "plan", href: "/", label: "Plán" },
        { key: "mix", href: "/mix", label: "Finální mix" },
      ],
    }];
  }
  return [
    {
      title: "Plán",
      items: [
        { key: "prehled", href: "/prehled", label: "Přehled" },
        { key: "plan", href: "/", label: "Plánování" },
        { key: "mix", href: "/mix", label: "Finální mix" },
      ],
    },
    {
      title: "Vyhodnocení",
      items: [
        { key: "vysledky", href: "/vysledky", label: "Výsledky" },
      ],
    },
    {
      title: "Model",
      items: [{ key: "kalkulacka", href: "/kalkulacka", label: "Kalkulačka a předpoklady" }],
    },
  ];
}

const PAGE_TITLE: Record<Section, string> = {
  prehled: "Přehled", plan: "Plánování", mix: "Finální mix", vysledky: "Výsledky", kalkulacka: "Kalkulačka a předpoklady", sprava: "Uživatelé a přístupy",
  nastaveni: "Nastavení",
};

/**
 * Kostra aplikace: menu vlevo, obsah vpravo. Menu nese i kontext — klienta
 * a období otevřeného plánu — takže široké tabulky dostanou celou výšku
 * i šířku okna a hlavička nad nimi je jen jeden tenký řádek.
 */
export function Chrome({
  active,
  user,
  title,
  planId,
  children,
}: {
  active: Section;
  user: { name: string | null; email: string; role: string };
  /** klient a období otevřeného plánu; bez plánu zůstane jen název aplikace */
  title?: { client: string; period: string };
  /** otevřený plán — přenáší se mezi stránkami, aby přepnutí neskočilo na jiný plán */
  planId?: string;
  children: React.ReactNode;
}) {
  const link = (href: string) => (planId && !href.startsWith("/sprava") && !href.startsWith("/nastaveni") ? `${href}?plan=${planId}` : href);
  const pageTitle = user.role === "CLIENT" && active === "plan" ? "Plán"
    : user.role === "CLIENT" && active === "vysledky" ? "K vyplnění"
    : PAGE_TITLE[active];

  return (
    <div className="app">
      <Sticky />
      <aside className="sb">
        <Link href={link("/")} className="sb-brand">
          <Mark size={18} />
          <span><b>Mediaplán</b><small>Fragile</small></span>
        </Link>

        {title && (
          <div className="sb-plan">
            <div className="sb-client">{title.client}</div>
            <div className="sb-period">{title.period}</div>
          </div>
        )}

        <nav className="sb-nav" aria-label="Hlavní menu">
          {groups(user.role).map((g, i) => (
            <div key={i} className="sb-group">
              {g.title && <div className="sb-title">{g.title}</div>}
              {g.items.map((it) => (
                <Link key={it.key} href={link(it.href)} aria-current={active === it.key ? "page" : undefined}>
                  <Icon name={it.key} />{it.label}
                </Link>
              ))}
            </div>
          ))}
          {user.role === "ADMIN" && (
            <div className="sb-group">
              <div className="sb-title">Správa</div>
              <Link href="/sprava" aria-current={active === "sprava" ? "page" : undefined}><Icon name="sprava" />Uživatelé a přístupy</Link>
              <Link href="/nastaveni" aria-current={active === "nastaveni" ? "page" : undefined}><Icon name="nastaveni" />Nastavení</Link>
            </div>
          )}
        </nav>

        <div className="sb-user">
          <div className="sb-who">
            <span className="sb-name">{user.name ?? user.email}</span>
            <span className="role">{ROLE_LABEL[user.role] ?? user.role}</span>
          </div>
          <form action={async () => { "use server"; await signOut({ redirectTo: "/prihlaseni" }); }}>
            <button className="btn sb-out" type="submit">Odhlásit</button>
          </form>
          {/* verze v menu, ne v patičce — ať je vidět bez rolování na konec stránky */}
          <div className="sb-ver" title={`Čas posledního nasazení: ${buildLabel()}`}>
            <span>Mediaplán <b>v{VERSION}</b>{COMMIT && <> · {COMMIT}</>}</span>
            <span>Aktualizováno {buildLabel()}{buildAge() && <> · {buildAge()}</>}</span>
            <span>Fragile · KNOWLIMITS Group</span>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="top">
          <h1>{pageTitle}</h1>
        </header>
        <div className="shell">
          {adminDomainsActive && (
            <div className="banner" style={{ marginTop: 0 }}>
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
      </div>
    </div>
  );
}
