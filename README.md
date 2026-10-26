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

Klient bez přidělených přístupů nevidí nic. Jako administrátor mu v *Uživatelé & přístupy*
přidělte třeba „vyplňuje skutečnost — vybrané položky — Vybrat, co platí klient sám",
pak se přihlaste jako `klient@benu.cz`: otevře se mu rovnou *K vyplnění* jen s jeho
položkami. Cizí položky nevidí, a kdyby někdo zápis zkusil obejít, odmítne ho server.

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

`db:seed` smaže a znovu naplní data — **v produkci ho už nepouštějte**, smazal by i importovaný
strategický plán. Ukázkové plány ze seedu jdou z produkce uklidit skriptem
`scripts/smazat-plany.ts` (bez `--potvrdit` jen vypíše, co by smazal).

**Zkratky pro produkci.** Connection string produkční databáze (nepoolovaný, z Neonu)
se jednou uloží do Klíčenky macOS a dál se nevkládá:

```bash
npm run prod:ulozit                     # jednou: vloží se string, uloží se šifrovaně
npm run nasadit                         # schéma do produkce + git push
npm run prod:import -- "plán.xlsx" --doplnit   # doplní chybějící položky z Excelu
npm run prod:uklid                      # úklid plánů (bez --potvrdit jen vypíše)
```

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
> **výchozí hodnoty odvozené z veřejné demografie** — koeficienty duplikace upravíte v *Kalkulačce zásahu*, universa v *Nastavení*,
> a před prvním použitím u klienta patří zkalibrovat na panelový zdroj
> (Nielsen Admosphere, SKMO) a nechat validovat media specialistou.

### Přehled

První záložka pro agenturu (klient ji nevidí). Úvodní obrazovka odpoví bez rolování:
jedna věta se zásahem a frekvencí, rozpočet, náklad na zasaženou osobu a počet přetížených
měsíců; pod tím zásah a frekvence v jednom grafu se společnou osou měsíců a vpravo
**Co s tím** — doporučení spočítaná modelem (např. kolik uvolní −30 % TRP v přetížených
měsících). Níž matice **oblasti × média** (klik na oblast filtruje celý přehled) a sbalený
panel s metodikou, předpoklady a slovníčkem. Pojmy jsou vysvětlené za otazníkem.
Hranici přehlcení nastavuje plánovač u plánu.

### Ceník pro odhad doručení

V Kalkulačce zásahu (po výběru plánu), odkaz vede i z Přehledu („Doplnit ceník").
Cena za kontakt podle média — CPP u TV a rádia, CPT u ostatních — platí pro všechny
plány klienta. U každého média je vidět, kolik Kč čeká na cenu, a **návrh z plánu**
(průměr z položek, které cenu mají) s tlačítkem *Použít*. Položky zadané jen v Kč
pak dostanou odhad doručení, v Plánu označený „≈". Agenturní práce odhad nedostane.

### Plán

Výchozí pohled ukazuje jen to podstatné: sdělení, Paid/Owned/Earned, kanál, oblast,
nosič a měsíce. **Podrobnosti** přidají fázi, cílení, jednotku a cenu (pamatuje si
prohlížeč). Sdělení zůstává při vodorovném rolování vidět.

### Tematické oblasti

Na co komunikace míří — Brand, Longevity, Probiotika, Dermo, Prevence & V rovnováze,
Katalogy a akce, Privátní značky. V Plánu je sloupec **Oblast**: klik otevře rozdělení
v procentech (součet se při uložení přepočte na 100 %, tlačítko *Rovnoměrně*, nová
oblast se dá založit rovnou tam). Přehled ukazuje každou oblast jako malý graf
investic se stejnou osou, se zásahem, frekvencí a kontakty.

### Import strategického plánu z Excelu

```bash
DATABASE_URL="…" npx tsx scripts/import-strategicky-plan.ts "BENU Strategic Plan 2027.xlsx" --nahradit
```

Čte týdenní flowchart (měsíce jsou sloučené buňky v hlavičce, „Dec II" patří k prosinci),
bere *Total Client cost including fee*, u TV TRP a u online imprese. Na konci porovná
importovaný součet se součtem v Excelu. Data klienta zůstávají mimo repozitář.

### Sekce aplikace

| Záložka | Pro koho | Co tam je |
|---|---|---|
| **Přehled** | agentura | zásah a frekvence v čase, oblasti × média, doporučení |
| **Plánování** | agentura | tabulka plánu — rozpočty, GRP, imprese, bloky, oblasti |
| **Finální mix** | všichni | výsledek plánu na jedné stránce: rozdělení rozpočtu, mediamix po měsících, oblasti; tisk do PDF |
| **Plnění** | agentura | plán vs. skutečnost, cíle a výsledky ukazatelů (KPI), komentáře |
| **K vyplnění** | klient i agentura | jen položky, kam smí uživatel zapisovat, po měsících — jedno pole na měsíc |
| **Kalkulačka** | agentura | Sainsbury, ceník, kalibrace zásahu, koeficienty duplikace |

Klient vidí jen *K vyplnění*, *Plán* (čtení) a *Finální mix*; po přihlášení se mu otevře
*K vyplnění*. Otevřený plán se mezi záložkami přenáší.

**Plán pro klienta** je samostatný jednoduchý pohled: součet, offline/online (ne Paid/Owned/Earned),
čerpáno a tabulka položek po měsících s odstínem podle výše částky — bez filtrů, kódů sdělení
a polí. Odhad zásahu vidí jen klient s přístupem k celému plánu (u výseku by „0 %" mátlo).

**Krátké názvy.** Položky se klientovi a v souhrnech ukazují bez poznámek pro agenturu
(„(hradí klient z vlastní karty)", „(navýšení…)", „(odhad)"). Vlastní krátký název jde zadat
v Plánování → Podrobnosti → *Krátký název*; plný název zůstává v nápovědě.

**Frekvence je všude týdně** — kolikrát týdně reklamu průměrně uvidí zasažený (v Plánování za
období i po měsících, v Přehledu po měsících).

### Finální mix

Souhrn ke schválení a sdílení — nic se tu nezadává. Rozpočet celkem, podíl offline/online,
modelový zásah 1+ za období, pruh rozdělení rozpočtu, tabulka médií (doručení v TRP nebo
impresích, cena za jednotku jen pro agenturu, zásah) s **flowchartem po měsících** a rozpadem
na položky, a rozdělení podle tematických oblastí. Tlačítko *Tisk / PDF* schová navigaci.

### K vyplnění

Měsíce jako záložky s červeným počtem chybějících údajů, pod tím jen položky uživatele:
plán, pole *Skutečnost* (ukládá se samo po opuštění pole) a stav — vyplněno / chybí /
zatím neprobíhá. „Nečerpáno" zapíše nulu: **nula je odpověď**, prázdné pole ne. Má-li
položka ukazatele (konverze, CPA…), vyplňují se pod ní. Rozpočet tu jde měnit jen u položek
řízených v Kč — u GRP/impresí by přepis změnil model, ty se mění v Plánování.

### Ukazatele (KPI)

V *Plnění* jde u každé položky **přidat ukazatel** (název, jednotka, typ: načítá se /
nižší = lépe / vyšší = lépe), zadat jeho **cíl** po měsících (sloupec Plán / cíl, v režimu
jednoho měsíce) a smazat ho. Skutečnost ukazatelů vyplňuje ten, kdo má zápis do skutečnosti.

**Poměrové ukazatele se nezadávají, počítají se** (`src/lib/metrics.ts`): CPM = čerpání ÷ imprese
× 1 000, CPC = čerpání ÷ kliky, CPA = čerpání ÷ konverze, CTR = kliky ÷ imprese × 100,
ROAS = tržby ÷ čerpání — za každý měsíc. Zadává se jen čerpání a základní čísla. Chybí-li u položky
základní ukazatel, který poměr potřebuje (CPM bez impresí), nabídne se k vyplnění a založí se
prvním zápisem. Ukazatel se pozná podle názvu.

### Kalkulačka zásahu

Samostatná položka menu (klient ji nevidí). Zásahy nosičů se dají **načíst
z libovolného plánu** a období (celé, nebo jeden měsíc) a pak upravovat ručně
— „co když přidám rádio". Do plánu se nic nezapisuje. Ukazuje kombinaci krok
za krokem, srovnání s nezávislostí (k = 1) a s naivním součtem.

Níž je **dopočet koeficientu z naměřených dat**: k = (R_A + R_B − R_A+B) / (R_A × R_B),
který jde uložit k dané dvojici nosičů, a **tabulka všech koeficientů** — upravit
je smí administrátor a plánovač, změna platí pro všechny plány a zapíše se do
historie i se zdrojem. Na rozdíl od kalkulačky v Excelu nezáleží na pořadí médií.

**Kalibrace zásahu z naměřených dat.** Až TV nákup dodá k vlnám TRP a zásah 1+
(plánovací systém nad Nielsen Admosphere), zadají se sem po médiích a cílových skupinách.
Z jednoho měření se dopočítá rychlost růstu zásahu (strop zůstane z předpokladu), ze dvou
a víc i strop. Křivka se hned použije v Plánování, Přehledu i Finálním mixu; srovnání
„předpoklad vs. naměřená data" je vidět při 300 / 1 000 / 2 000 TRP. Smazáním všech
měření se vrátí předpoklad. TRP i zásah musí být ve stejné cílové skupině.

---

## Klienti, plány a období

```
Klient → Mediaplán (období, stav) → Blok → Linka sdělení → Taktika
```

Měsíce se odvozují z období plánu, nikde nejsou zadrátované — kvartál i celý rok
jsou jen jiné hodnoty téhož. V ročním plánu jdou **kvartály sbalit** do jednoho
součtového sloupce.

Plán se drží v adrese (`?plan=…`), takže odkaz na konkrétní plán jde komukoli poslat.

Vedle výběru plánu (administrátor a plánovač):

- **+ Nový plán** — název, období (Q1–Q4, celý rok, nebo vlastní od–do i přes přelom
  roku), výchozí cílová skupina a volitelně *převzít strukturu* z jiného plánu téhož
  klienta. Název se doplní z období, dokud ho nepřepíšete.
- **⚙ Nastavení plánu** — přejmenovat, změnit stav, cílovou skupinu i období. Když
  období zkrátíte, aplikace předem řekne, kolik vyplněných čísel v měsících, které
  vypadnou, se smaže. Tamtéž **Smazat plán** — s potvrzením přesným názvem, nejde vrátit.
- **+ Další rok** — rychlá kopie téhož plánu o rok dál.

Kopie přenáší bloky, sdělení, taktiky, ceník i ukazatele (Reach/CPM, Konverze/CPA),
**rozpočty, GRP a cíle ne**. Názvy plánů musí být u klienta jedinečné.

Stavy: `návrh → schváleno → v běhu → uzavřeno`.

---

## Oprávnění

Jádro aplikace. Agentura (administrátor, plánovač) má přístup z role. **Klient nevidí nic,
dokud mu ho administrátor nepřidělí** — v *Uživatelé & přístupy* ve třech krocích:

1. **Plán** — vždy konkrétní.
2. **Co smí** — *jen vidí* / *vyplňuje skutečnost* / *upravuje plán i skutečnost*.
3. **Na čem** — celý plán / **offline** (TV, rádio, OOH, tisk, kino, PR) / **online**
   (digital, vlastní kanály) / **vybrané položky** (s tlačítkem „Vybrat, co platí klient sám").
4. Volitelně jen některé měsíce.

Z výběru vznikne svazek grantů, který se v přehledu ukáže jako jedna věta a odebere naráz.
Pod tím zůstává engine s granty po rozměrech:

```
uživatel  ×  plán  ×  typ média  ×  offline/online  ×  kampaň  ×  položka  ×  měsíc  ×  oblast  ×  úroveň
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

Kontrola běží **na serveru u každého zápisu** (`src/lib/actions.ts`) **i čtení**.
Zašedlá pole v rozhraní jsou pohodlí, ne ochrana. Klient vidí jen plány, na které
má grant — ostatní plány ani jejich názvy se mu nepošlou, ani na přímý odkaz.
V plánu vidí jen taktiky, na které má grant (typ média, offline/online, kampaň,
položka; rozměr měsíce řádky neskrývá), a souhrny se počítají jen z nich. Grant
na jednu položku nedovolí založit novou taktiku ani měnit blok.

```bash
npm run test:perms    # 52 testů včetně scénářů ze zadání, izolace plánů, offline/online a položek
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
- **Kalibrace křivek zásahu** — rozhraní je hotové (Kalkulačka), chybí data od TV nákupu.
- **Tematické oblasti** — zakládat jdou, přejmenovat a mazat zatím ne.
- **Export do XLSX** — zadání §9.
- **Podklady a poznámky** — tabulky v databázi jsou, rozhraní chybí.
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
