# Mediaplán — Fragile

Webová aplikace pro plánování a průběžné vyhodnocování mediálních kampaní.
Postavená podle technického zadání, se kterým se dodává.

**Stack:** Next.js 15 (App Router) · PostgreSQL · Drizzle ORM · Auth.js (Google SSO) · TypeScript

Umí plánovat **offline i online vedle sebe** (TV, rádio, OOH, print, kino, digital),
počítá **cross-mediální zásah a překryv** a drží **víc plánů nad jedním klientem** —
kvartál i celý rok.

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

Seed založí klienta **BENU** a dva plány: **Q4 2026** s reálnými daty a **Rok 2027**,
kam se struktura z Q4 zkopíruje bez čísel (ceník CPP/CPT se přenese, objemy ne).
V plánu 2027 je navíc blok *UKÁZKA cross-media* — po prohlédnutí ho smažte.

Přihlaste se jako `klient@benu.cz` a zkuste v záložce *Detail & plnění* vyplnit
čerpání u taktiky typu Owned. Pole je zašedlé, a kdyby ho někdo v prohlížeči
odemkl, zápis odmítne server.

---

## Nasazení na Vercel

Repozitář je propojený s Vercel projektem, takže stačí:

**1. Databáze.** Ve Vercelu → *Storage* → *Create Database* → Postgres (Neon),
region **Frankfurt (eu-central-1)** kvůli GDPR. Vercel proměnnou `DATABASE_URL`
doplní do projektu sám.

**2. Framework preset.** Ve Vercelu → *Settings* → *Build & Development Settings*
musí být *Framework Preset* nastavený na **Next.js**. V repozitáři je kvůli tomu
`vercel.json`, ale nastavení v dashboardu má přednost — když je tam `Other`,
build skončí chybou „No Output Directory named public".

**3. Proměnné prostředí.** Ve Vercelu → *Settings* → *Environment Variables*:

| Proměnná | Hodnota |
|---|---|
| `AUTH_SECRET` | výstup `openssl rand -base64 32` |
| `AUTH_GOOGLE_ID` | z Google Cloud Console |
| `AUTH_GOOGLE_SECRET` | z Google Cloud Console |
| `ALLOWED_EMAIL_DOMAINS` | `fragile.cz` (případně i doména klienta) |
| `ADMIN_EMAIL_DOMAINS` | **jen pro testovací fázi** — každý z těchto domén dostane ADMIN. Před puštěním klienta smazat. |
| `ENABLE_DEV_LOGIN` | **nenastavovat**, nebo `false` |

**4. Google OAuth.** Google Cloud Console → *APIs & Services* → *Credentials* →
*Create OAuth client ID* → Web application. Authorized redirect URI:

```
https://<vase-domena>.vercel.app/api/auth/callback/google
```

**5. Tabulky.** Po prvním nasazení jednou lokálně proti produkční databázi
(použijte **nepoolovaný** connection string z Neonu — DDL přes pooler zlobí):

```bash
DATABASE_URL="<produkční connection string>" npm run db:push
DATABASE_URL="<produkční connection string>" npm run db:seed
```

`db:seed` smaže a znovu naplní data — v produkci ho pouštějte jen jednou na začátku.

**6. První administrátor.** Seed založí `admin@fragile.cz`. Změňte e-mail
na svůj v `scripts/seed.ts`, nebo po nasazení v databázi.

---

## Struktura

```
src/
  db/schema.ts          datový model (zadání §3)
  lib/permissions.ts    engine oprávnění (§5.2) — jediné místo, kde se rozhoduje
  lib/pacing.ts         výpočty plnění (§6) — převzato z odladěného prototypu
  lib/crossmedia.ts     přepočty jednotek, křivky zásahu, zásah a překryv
  lib/period.ts         měsíce a kvartály odvozené z období plánu
  lib/actions.ts        server actions — každý zápis prochází kontrolou oprávnění
  lib/queries.ts        čtení dat pro stránky
  lib/undo.ts           zásobník pro vrácení zpět (10 kroků na uživatele)
  lib/auth.ts           Google SSO + testovací přihlášení
  middleware.ts         přesměrování nepřihlášených; běží na Edge, proto bez databáze
  app/page.tsx          plán: rozpočty, filtry, souhrny
  app/plneni/page.tsx   detail a plnění: pacing, metriky, poznámky
  app/sprava/page.tsx   uživatelé, oprávnění, historie změn
  app/nastaveni/page.tsx plány, cílové skupiny a universa, kontrola nasazení
scripts/
  seed.ts               klient BENU, plán Q4 2026 a Rok 2027
  test-permissions.ts   test engine oprávnění (běží bez databáze)
  test-crossmedia.ts    test přepočtů a modelu zásahu (běží bez databáze)
```

---

## Cross-mediální plánování

Offline a online se nedají plánovat vedle sebe, dokud se nesejdou v jedné jednotce.
Tou je **cílová skupina a její velikost (universum)**:

```
impressions = GRP × universum / 100
GRP         = zásah % × frekvence
zásah %     = rMax × (1 − e^(−k · GRP/100))      ← křivka zásahu
```

U každé taktiky si vyberete **řídicí jednotku** — rozpočet, GRP, nebo impressions —
a zadáváte jen ji. Zbytek se dopočítá z jednotkové ceny (**CPP** u TV a rádia,
**CPT** jinde). Přepnutí jednotky hodnotu převede, takže z plánu nezmizí peníze.

```bash
npm run test:cross    # 40 testů přepočtů a modelu zásahu
```

### Zásah a překryv

Součet dílčích zásahů není zásah kampaně — část lidí vidí TV i online. Média se
proto skládají od nejsilnějšího a překryv každého dalšího se násobí koeficientem:

```
překryv = min(rᵢ, R, k̄ · rᵢ · R)
R       = R + rᵢ − překryv
```

Model je monotónní (přidané médium zásah nikdy nesníží) a drží se mezi nejsilnějším
jednotlivým médiem a sto procenty.

> **Je to modelový odhad, ne měření.** Přesná deduplikace vyžaduje single-source
> panelová data. Universa, křivky zásahu i duplikační koeficienty jsou zatím
> **výchozí hodnoty odvozené z veřejné demografie** — upravíte je v *Nastavení*
> a před prvním použitím u klienta patří zkalibrovat na panelový zdroj
> (Nielsen Admosphere, SKMO) a nechat validovat media specialistou.

---

## Klienti, plány a období

```
Klient → Mediaplán (období, stav) → Blok → Linka sdělení → Taktika
```

Měsíce se odvozují z období plánu, nikde nejsou zadrátované — kvartál i celý rok
jsou jen jiné hodnoty téhož. V ročním plánu jdou **kvartály sbalit** do jednoho
součtového sloupce.

Plán se drží v adrese (`?plan=…`), takže odkaz na konkrétní plán jde komukoli poslat.
Tlačítko **+ Další rok** založí plán o rok dál se stejnou strukturou — bloky, sdělení,
taktiky i ceník se přenesou, **rozpočty a metriky ne**.

Stavy: `návrh → schváleno → v běhu → uzavřeno`.

---

## Oprávnění

Jádro aplikace. Grant má **pět rozměrů** — kdo × co × kde × kdy:

```
uživatel  ×  plán  ×  typ média  ×  kampaň  ×  měsíc  ×  oblast  ×  úroveň
```

**Rozměr plánu je bezpečnostní pojistka.** Bez něj by grant udělený na letošek
automaticky platil i pro příští rok a pro každý další plán, který vznikne.

Prázdná hodnota = „vše". Výchozí stav je **zákaz**: bez grantu (nebo bez rozsahu
z role) neprojde nic.

```
klient BENU vyplňuje čerpání Paid, ale jen v plánu Q4 2026:
  (klient, Q4 2026, Paid, *, *, actuals, write)

externista jen na Vánoce, jen prosinec:
  (externista, Q4 2026, *, Vánoční katalog, 2026-12, actuals, write)
```

Kontrola běží **na serveru u každého zápisu** (`src/lib/actions.ts`).
Zašedlá pole v rozhraní jsou pohodlí, ne ochrana.

```bash
npm run test:perms    # 22 testů včetně scénářů ze zadání a izolace plánů
npm test              # oprávnění i cross-mediální přepočty
```

---

## Vrácení zpět

Před každou změnou se uloží **původní hodnota**, ne opačná operace. Vrácení
pak stav prostě přepíše zpět, takže nezáleží na tom, co mezitím udělal někdo
jiný. Drží se 10 posledních kroků na uživatele.

Přesun taktiky, bloku i založení bloku vrátit lze. Smazání taktiky ani bloku ne — kaskádou padnou i rozpočty a metriky. Proto
se u něj potvrzuje a v logu je to označené.

---

## Co ještě není hotové

Poctivý seznam, aby nepřekvapil:

- **Benchmarky** — zatím se neukládá historie uzavřených plánů ani externí zdroj.
- **Import z XLSX** — data se zatím nahrávají seedem, ne přes rozhraní.
- **Kalibrace modelu zásahu** — křivky a duplikace jdou upravit v databázi,
  rozhraní pro ně zatím chybí (cílové skupiny a universa editovatelné jsou).
- **Efektivní zásah (3+ kontakty)** — spočítaný v `crossmedia.ts`, v rozhraní není.
- **Export do XLSX** — zadání §9.
- **Podklady a poznámky** — tabulky v databázi jsou, rozhraní chybí.
- **Přidávání linek sdělení** — akce `createMessageLine` existuje, tlačítko v UI ne.
- **Migrace** — projekt používá `db:push`. Před produkčním provozem přejděte
  na `drizzle-kit generate` a verzované migrace.

---

## Verze a čas nasazení

V patičce každé stránky je verze aplikace a čas posledního nasazení — podle něj
poznáte, jestli na Vercelu běží to, co jste právě pushli. Na Vercelu se vedle
verze ukáže i zkrácený hash commitu.

Obojí zapéká `next.config.mjs` **při buildu**. Kdyby se čas bral až za běhu,
ukazoval by „teď" a nic by neprozradil.

Verzi zvyšujete ručně v `package.json`:

```bash
npm version patch --no-git-tag-version   # 0.12.0 → 0.12.1
npm version minor --no-git-tag-version   # 0.12.0 → 0.13.0
```

---

## Poznámky k bezpečnosti

- **Žádná vlastní hesla.** Jen Google SSO. Důvody v zadání §4.
- **Bez databázového adaptéru.** Session drží JWT, uživatele zakládá `signIn`
  callback — díky tomu se řídí role i přístup na jednom místě a build nezávisí
  na dostupnosti databáze.
- `ENABLE_DEV_LOGIN` se v produkci sám vypne (`NODE_ENV === "production"`),
  ale nenastavujte ho na `true` ani tak.
- Přihlásit se může jen ten, kdo už je pozvaný v databázi, nebo přichází
  z domény v `ALLOWED_EMAIL_DOMAINS`. Ostatní neprojdou ani s platným
  Google účtem.
- Historie změn se needituje ani nemaže.
- `ADMIN_EMAIL_DOMAINS` je dočasná testovací pomůcka: povyšuje kohokoli z dané
  domény na administrátora. Dokud je nastavená, svítí v aplikaci na každé stránce
  upozornění. **Před puštěním klienta ji smažte** a role lidem upravte ve správě
  uživatelů — snížení role se automaticky neděje, aby se neztratila ručně
  udělená práva.

---

> **Pracovní podklad.** Rozpočty, mediamix i částky v seedu pocházejí
> z pracovní verze mediaplánu a před sdílením s klientem vyžadují validaci
> media specialistou. Před produkčním nasazením s reálnými daty klienta
> doporučujeme právní review zpracování osobních údajů.
