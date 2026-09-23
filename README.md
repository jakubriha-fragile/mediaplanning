# Mediaplán — Fragile

Webová aplikace pro plánování a průběžné vyhodnocování mediálních kampaní.
Postavená podle technického zadání, se kterým se dodává.

**Stack:** Next.js 15 (App Router) · PostgreSQL · Drizzle ORM · Auth.js (Google SSO) · TypeScript

---

## Rychlý start

```bash
npm install
cp .env.example .env        # doplňte DATABASE_URL a AUTH_SECRET
npm run db:push             # vytvoří tabulky
npm run db:seed             # naplní reálnými daty Q4 2026 + testovací účty
npm run dev                 # http://localhost:3000
```

Bez Google OAuth klíčů se přihlásíte **testovacím účtem** — na přihlašovací
stránce vyberete ze seznamu. Rovnou si tak proklikáte role.

| Účet | Role | Co smí |
|---|---|---|
| `admin@fragile.cz` | ADMIN | vše, včetně správy uživatelů a oprávnění |
| `planner@fragile.cz` | PLANNER | plán i skutečnost |
| `account@fragile.cz` | ACCOUNT | skutečnost a podklady, plán jen čte |
| `klient@benu.cz` | CLIENT | **jen čerpání u Paid** — ukázka granulárního oprávnění |
| `cteni@benu.cz` | VIEWER | jen čtení |

Přihlaste se jako `klient@benu.cz` a zkuste v záložce *Detail & plnění* vyplnit
čerpání u taktiky typu Owned. Pole je zašedlé, a kdyby ho někdo v prohlížeči
odemkl, zápis odmítne server.

---

## Nasazení na Vercel

Repozitář je propojený s Vercel projektem, takže stačí:

**1. Databáze.** Ve Vercelu → *Storage* → *Create Database* → Postgres (Neon),
region **Frankfurt (eu-central-1)** kvůli GDPR. Vercel proměnnou `DATABASE_URL`
doplní do projektu sám.

**2. Proměnné prostředí.** Ve Vercelu → *Settings* → *Environment Variables*:

| Proměnná | Hodnota |
|---|---|
| `AUTH_SECRET` | výstup `openssl rand -base64 32` |
| `AUTH_GOOGLE_ID` | z Google Cloud Console |
| `AUTH_GOOGLE_SECRET` | z Google Cloud Console |
| `ALLOWED_EMAIL_DOMAINS` | `fragile.cz` (případně i doména klienta) |
| `ENABLE_DEV_LOGIN` | **nenastavovat**, nebo `false` |

**3. Google OAuth.** Google Cloud Console → *APIs & Services* → *Credentials* →
*Create OAuth client ID* → Web application. Authorized redirect URI:

```
https://<vase-domena>.vercel.app/api/auth/callback/google
```

**4. Tabulky.** Po prvním nasazení jednou lokálně proti produkční databázi:

```bash
DATABASE_URL="<produkční connection string>" npm run db:push
DATABASE_URL="<produkční connection string>" npm run db:seed
```

`db:seed` smaže a znovu naplní data — v produkci ho pouštějte jen jednou na začátku.

**5. První administrátor.** Seed založí `admin@fragile.cz`. Změňte e-mail
na svůj v `scripts/seed.ts`, nebo po nasazení v databázi.

---

## Struktura

```
src/
  db/schema.ts          datový model (zadání §3)
  lib/permissions.ts    engine oprávnění (§5.2) — jediné místo, kde se rozhoduje
  lib/pacing.ts         výpočty plnění (§6) — převzato z odladěného prototypu
  lib/actions.ts        server actions — každý zápis prochází kontrolou oprávnění
  lib/queries.ts        čtení dat pro stránky
  lib/auth.ts           Google SSO + testovací přihlášení
  app/page.tsx          plán: rozpočty, filtry, souhrny
  app/plneni/page.tsx   detail a plnění: pacing, metriky, poznámky
  app/sprava/page.tsx   uživatelé, oprávnění, historie změn
scripts/
  seed.ts               naplnění daty Q4 2026
  test-permissions.ts   test engine oprávnění (běží bez databáze)
```

---

## Oprávnění

Jádro aplikace. Grant má **čtyři rozměry** — kdo × co × kde × kdy:

```
uživatel  ×  typ média  ×  kampaň  ×  měsíc  ×  oblast  ×  úroveň
```

Prázdná hodnota = „vše". Výchozí stav je **zákaz**: bez grantu (nebo bez rozsahu
z role) neprojde nic.

```
klient BENU vyplňuje čerpání Paid ve všech kampaních:
  (klient, Paid, *, *, actuals, write)

externista jen na Vánoce, jen prosinec:
  (externista, *, Vánoční katalog, 2026-12, actuals, write)
```

Kontrola běží **na serveru u každého zápisu** (`src/lib/actions.ts`).
Zašedlá pole v rozhraní jsou pohodlí, ne ochrana.

```bash
npm run test:perms    # 17 testů včetně scénářů ze zadání
```

---

## Co ještě není hotové

Poctivý seznam, aby nepřekvapil:

- **Import z XLSX** — data se zatím nahrávají seedem, ne přes rozhraní.
- **Export do XLSX** — zadání §9.
- **Podklady a poznámky** — tabulky v databázi jsou, rozhraní chybí.
- **Vrácení zpět** — historie se zapisuje, undo tlačítko zatím ne.
- **Drag & drop řazení taktik** — sloupec `position` je připravený.
- **Přidávání a mazání taktik a linek** — zatím jen editace existujících.
- **Migrace** — projekt používá `db:push`. Před produkčním provozem přejděte
  na `drizzle-kit generate` a verzované migrace.

---

## Poznámky k bezpečnosti

- **Žádná vlastní hesla.** Jen Google SSO. Důvody v zadání §4.
- `ENABLE_DEV_LOGIN` se v produkci sám vypne (`NODE_ENV === "production"`),
  ale nenastavujte ho na `true` ani tak.
- Přihlásit se může jen ten, kdo už je pozvaný v databázi, nebo přichází
  z domény v `ALLOWED_EMAIL_DOMAINS`. Ostatní neprojdou ani s platným
  Google účtem.
- Historie změn se needituje ani nemaže.

---

> **Pracovní podklad.** Rozpočty, mediamix i částky v seedu pocházejí
> z pracovní verze mediaplánu a před sdílením s klientem vyžadují validaci
> media specialistou. Před produkčním nasazením s reálnými daty klienta
> doporučujeme právní review zpracování osobních údajů.
