# Kontext projektu pro Clauda

Tenhle soubor si Claude Code načítá sám. Je to předávka, ne dokumentace —
uživatelská dokumentace je v `README.md`, technické zadání v `zadani-mediaplan-app.md`.

## Co to je

Nástroj na **plánování mediálních kampaní** pro agenturu Fragile (KNOWLIMITS Group),
klient BENU. Nahrazuje Excel flowchart. Cíl, který zadavatel formuloval doslova:
*„mít nástroj na plánování kampaní, nemuset řešit průběžné propočty, ale soustředit
se na plánování."* Každé rozhodnutí v kódu se tomu podřizuje — plánovač zadá jedno
číslo, zbytek se dopočítá.

**Zadavatel:** Jakub Říha, jakub.riha@fragile.cz
**Produkce:** https://mediaplanning.vercel.app · repo `jakubriha-fragile/mediaplanning`
**Lokálně:** `~/Projekty/mediaplanning`

## Stack

Next.js 15 (App Router, server actions) · React 19 · TypeScript · Drizzle ORM ·
PostgreSQL (Neon, Frankfurt kvůli GDPR) · Auth.js v5 (Google SSO, bez DB adaptéru,
JWT session) · Vercel.

## Jazyk a styl

- **Rozhraní, komentáře i commity česky.** Uživatelé jsou media plánovači, ne vývojáři.
- Komentáře vysvětlují **proč**, ne co. Kde je neintuitivní rozhodnutí, je u něj důvod.
- Vizuální identita Fragile: Poppins (200/300/500), modrá `#382ea8`, oranžová
  `#ff514b` jen jako akcent. Barvy nosičů jsou validovaná kategorická paleta.
- Při generování souborů s češtinou pište UTF-8 přímo, nikdy ne unicode escapy
  v bash heredocu.

## Architektura — kde se co rozhoduje

```
src/lib/permissions.ts   JEDINÉ místo, kde se rozhoduje o oprávněních
src/lib/crossmedia.ts    přepočty jednotek, křivky zásahu, zásah a překryv
src/lib/pacing.ts        výpočty plnění (plán vs. realita v čase)
src/lib/period.ts        měsíce, kvartály a týdny (weeksOfPeriod) odvozené z období plánu
src/lib/weeks.ts         plán po týdnech: přepočet týdny → měsíce, převod měsíce → týdny
src/lib/catalog.ts       číselník Médium → Platforma (výchozí z technické karty, naplní prázdnou tabulku), guessCatalog
src/lib/actions.ts       VŠECHNY zápisy; každý projde assertCan()
src/lib/queries.ts       čtení dat pro stránky
src/lib/undo.ts          zásobník vrácení zpět (10 kroků na uživatele)
src/app/kalkulacka/      Sainsburyho kalkulačka + editace koeficientů duplikace
src/lib/dashboard.ts     data pro Přehled (/prehled): zásah a frekvence v čase, matice oblasti × média,
                         filtry (?oblast, ?medium), modelový scénář „méně TV v přetížení"
src/lib/costKind.ts      média / agenturní práce / smíšené — podle názvu položky
src/lib/estimates.ts     odhad výsledků položky: kliky, konverze, CPA z doručení + CTR/konverze (položka, jinak platforma)
src/lib/mix.ts           data pro Finální mix (/mix): média, měsíce, oblasti, modelový zásah
src/lib/metrics.ts       poměrové ukazatele (CPM, CPC, CPA, CTR, ROAS) se počítají z čerpání a základních čísel
src/lib/displayName.ts   krátký název položky (tactic.label, jinak bez poznámek v závorkách)
src/components/ClientPlan.tsx  Plán pro klienta — jen čtení, offline/online, bez agenturních nástrojů
src/components/Chrome.tsx      kostra: menu vlevo (role → položky), tenká hlavička stránky (.top)
src/app/vysledky/        Výsledky = plnění + vyplňování skutečnosti (Results.tsx); klient ji vidí jako „K vyplnění".
                         /plneni a /vyplnit jen přesměrují (staré odkazy)
src/components/AccessEditor.tsx   přidělení přístupu: plán → co smí → na čem (offline/online/položky)
src/components/ReachCalibration.tsx  zadání naměřených vln (TRP + zásah 1+) → křivka (fitCurve)
scripts/import-strategicky-plan.ts   import týdenního flowchartu BENU z Excelu
```

**Klientská data se do repozitáře neukládají.** Import čte Excel z disku a píše
rovnou do databáze; do produkce jen se souhlasem zadavatele.

Datový model: `Klient → Plán (období, stav) → Blok → Linka sdělení → Taktika`.
Kolmo na to **tematická oblast** (`theme`, patří klientovi): Brand, Longevity,
Probiotika… Taktika se mezi oblasti dělí podílem (`tactic_theme.share`, součet 1),
smíšené položky typu „TV spot se 4 produkty" rovnoměrně. Částky, kontakty i GRP
oblasti = hodnoty taktiky × podíl; zásah oblasti se počítá z takto dělených GRP.

## Invarianty — tohle nerozbíjet

1. **Oprávnění se kontrolují na serveru u každého zápisu**, v `src/lib/actions.ts`,
   přes `assertCan()`. Zašedlá pole v UI jsou pohodlí, ne ochrana. Grant má rozměry:
   plán × typ média × skupina nosičů (offline/online) × kampaň × položka (taktika)
   × měsíc, plus oblast (plán/skutečnost/podklady). NULL = zástupný znak.
   Výchozí stav je zákaz.
   **Zápis do taktiky skládá souřadnice VŽDY přes `at(c, area, month)`** — jinak
   chybí nosič a položka a grant „jen online" / „jen tahle položka" nejde vynutit.
   **Nová akce bez `assertCan` s `planId` je bezpečnostní chyba.** Kontrola:
   `grep -n 'assertCan(me' src/lib/actions.ts | grep -v 'planId\|at('` musí být
   prázdné (pozor na víceřádkové volání).
   Klientovi se přístup přiděluje přes `grantAccess` (svazek grantů se stejným
   `bundle`); `canSeeTactic` a `seesWholePlan` znají i offline/online a položku.

2. **Rozměr plánu je bezpečnostní pojistka.** Bez něj by grant udělený klientovi
   na Q4 2026 automaticky platil i pro rok 2027 a každý další plán.

3. **Rozpočet v Kč se do `tactic_budget.planned` ukládá vždy**, i když je taktika
   řízená GRP nebo impressions. Na tom stojí všechny součty i porovnání se
   skutečností. Kdo mění driver, musí přepočítat `planned`. Jedna buňka i vložení
   bloku z Excelu (`setPlannedBudgets`, vše-nebo-nic, jeden krok Zpět) jdou přes
   `writeBudget`.

4. **Klíče tabulky duplikací skládá `dupKey()`** (abecedně seřazená dvojice).
   Ručně psaný klíč v jiném pořadí tiše spadne na 1,0 a model přestane počítat
   překryv — přesně tahle chyba už se stala.

5. **Model zásahu musí být monotónní** — přidané médium zásah nikdy nesníží —
   a nezávislý na pořadí vstupu. Hlídají to testy.

6. **Poměrové ukazatele (CPM, CPA, CTR, ROAS) se nikdy neškálují časem.**
   Porovnávají se přímo s plánem. Přes měsíce se váží skutečným čerpáním.
   **A nezadávají se** — počítají se v `resolveMetrics` z čerpání a základních
   čísel; `setMetricActual` zápis do poměrového ukazatele odmítne.
   `setBaseMetricActual` smí založit chybějící základní ukazatel jen tehdy,
   když ho potřebuje poměrový ukazatel téže položky (jinak by přes skutečnost
   šlo zakládat strukturu plánu).

7. **Vrácení zpět ukládá PŮVODNÍ HODNOTU**, ne opačnou operaci. A je to zápis:
   `undoLast` každou operaci znovu ověří přes `assertCanUndo` proti dnešním
   grantům. Snímky pořadí (`snapshotPositions`) jsou vždy jen za jeden plán.

8. **Čtení se kontroluje taky.** Stránky berou plány výhradně z
   `getVisiblePlans(me)` + `pickPlan()`, nikdy z `getPlans()` (ten vrací plány
   všech klientů). Řádky filtruje `canSeeTactic`, souhrn zásahu se počítá jen
   z viditelných taktik. Kdo vidí jen výsek plánu (`seesWholePlan` = false),
   nedostane ani názvy bloků bez viditelné taktiky. Exportovaná funkce v souboru
   `"use server"` je **veřejná akce** — i čtecí funkce tam musí mít kontrolu
   (viz `recentChanges`). Přesuny taktik a bloků mezi plány jsou zakázané.

9. **Klient má vlastní pohled** (navigace: K vyplnění, Plán, Finální mix; po přihlášení
   jde rovnou na K vyplnění). Plán klienta je samostatná komponenta `ClientPlan`,
   ne `PlanTable` s výjimkami; offline/online místo Paid/Owned/Earned (u BENU je vše
   Paid — agentura P/O/E chce vidět dál), zásah jen při `seesWholePlan`.
   Frekvence je všude TÝDNÍ (`weeksIn`/`weeksOf` v period.ts). (`role === "CLIENT"` → `clientView` v `PlanTable`,
   `ReachPanel`, `Results`). Nevidí agenturní sloupce (Jednotka, Cena), dopočty
   GRP v buňkách, odborný panel zásahu ani texty typu „před sdílením s klientem".
   Komentář agentury nesmí měnit ani na serveru (`setAccountNote`). Výhrada
   „modelový odhad, ne měření" u zásahu zůstává i v jeho pohledu.

10. **Zásah se přes měsíce ani bloky nesčítá.** Kumulativní zásah do měsíce m
   i zásah bloku se počítají znovu z nasčítaných GRP (`src/lib/dashboard.ts`).
   Barvy médií v Přehledu (`--m-tv`, `--m-digital`, `--m-radio`, `--m-ooh`) prošly
   validátorem v tomhle pořadí a v obou režimech — staré `TYPE_COLOR` z panelu
   zásahu má TV a Digital k nerozeznání, do nových grafů ho nepoužívat.

11. **Oblast patří klientovi plánu** — `setTacticThemes` to ověřuje na serveru.
   Kopie plánu přenáší i oblasti. Bez řádku v `tactic_theme` je taktika
   „Nezařazeno" a Přehled ji tak i ukazuje.

12. **Agenturní práce není „chybějící data".** `costKind()` ji pozná z názvu
   (ag. práce, fee, natáčení, ambasador…) a Přehled ji z pokrytí modelu vyřazuje.
   Frekvence v Přehledu je **týdenní** (měsíční kontakty ÷ zásah ÷ dny/7 — plán je
   po měsících, takže rovnoměrné rozložení). Hranice přehlcení je týdenní,
   u plánu (`plan.freq_limit`, výchozí 5), ne v prohlížeči — doporučení
   musí vidět všichni stejná. Doporučení „ubrat TV" je spočítané modelem
   (SCENARIO_CUT), ne odhadnuté.

13. **Ceník je jen odhad při čtení.** `rate_card` (klient × nosič, CPP/CPT) se použije
   v `crossContext.priceFor` jen u médií zadaných v Kč bez vlastní ceny — nikdy
   u agenturní práce a smíšených položek, a do `tactic_budget` se nic nezapisuje.
   Plán ho značí „≈", Přehled ukazuje, kolik pokrytí je odhad. Plán, panel
   zásahu i Přehled musí jít přes `priceFor`, jinak se rozejdou.

13a. **Výchozí CPM/CPC platformy** (`platform.est_cpm/est_cpc`) jsou totéž co ceník,
   jen přesnější: `priceFor` je bere přednostně, při čtení, s „≈". U CPC jsou jediný
   zdroj odhadu ceny. Odhad výsledků nemá vlastní cenu ani frekvenci — bere doručení
   z plánu a zásah z modelu, aby existovalo jen jedno číslo pro totéž.

14. **Koeficienty duplikace se ukládají seřazené** (`sortedPair` = stejné pořadí
   jako `dupKey`). Seed do databáze zapisuje i výchozí hodnoty, proto se
   „vlastní" pozná podle odchylky od výchozí, ne podle existence řádku.

15. **Skutečnost: nula ≠ prázdno.** `setActualSpend` a `setMetricActual` uloží i první
   nulu — „nečerpáno" je odpověď a Výsledky podle existence řádku poznají, co chybí.

16. **Kalibrace zásahu** (`reach_measurement` → `fitCurve` → `reach_curve`) se přepočítá
   při každém přidání/smazání měření; bez měření se řádek křivky smaže a platí
   `DEFAULT_CURVE`. Jedno měření určí jen k (strop z předpokladu), dvě a víc i strop.

17. **Plán po týdnech** (`plan.granularity = "week"`, přepínač v Nastavení plánu — jeden
   pro celý plán, ne po médiích). Týdny žijí v `tactic_budget_week` (klíč = pondělí),
   měsíce v `tactic_budget` se z nich VŽDY sečtou (`syncMonthsFromWeeks`); týden přes
   přelom se dělí podle dnů. Všechno měsíční (součty, Výsledky, zásah, oprávnění)
   tak funguje beze změny. Měsíční zápisy plánu jsou v týdenním plánu zakázané
   (`assertMonthly`). Zápis týdne vyžaduje právo ke VŠEM měsícům, do kterých týden
   zasahuje. Převod měsíce → týdny drží měsíční součty přesně (přelomové týdny se
   ořežou, zbytek dorovnají týdny uvnitř měsíce). Skutečnost zůstává po měsících.

## Ověřování — pouštět před každou dodávkou

```bash
npx tsc --noEmit
npm test                                    # 52 testů oprávnění + 91 cross-média
npx next build
env -u DATABASE_URL -u AUTH_SECRET npx next build   # build nesmí potřebovat proměnné
```

Build nesmí záviset na dostupnosti databáze — proto je připojení v `src/db/index.ts`
líné přes Proxy.

**Na netriviální změnu to nestačí.** Co se dá rozbít jen za běhu (sticky layout,
pozice kurzoru v poli, přepočty po editaci), se ověřuje v prohlížeči proti živé
databázi. Recept na lokální Postgres:

```bash
su postgres -c "/usr/lib/postgresql/16/bin/initdb -D /var/lib/pgtest -A trust -U postgres"
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/pgtest -o '-p 5433 -h 127.0.0.1' start"
psql -h 127.0.0.1 -p 5433 -U postgres -c "create database mediaplan;"
export DATABASE_URL="postgres://postgres@127.0.0.1:5433/mediaplan" ENABLE_DEV_LOGIN=true
npx drizzle-kit push --force && npm run db:seed && npx next dev -p 3100
```

**Na Macu zadavatele** Postgres ani Docker nejsou. Funguje PGlite (Postgres
ve WASM) se síťovým rozhraním — jen musí dostat jediné spojení bez pipeliningu,
jinak hlásí `unnamed prepared statement does not exist`:

```bash
npm i --prefix "$SCRATCH/pg" @electric-sql/pglite @electric-sql/pglite-socket
"$SCRATCH/pg/node_modules/.bin/pglite-server" -d "$SCRATCH/pg/data" -p 5433 -m 1 &
export DATABASE_URL="postgres://postgres@127.0.0.1:5433/postgres?max_pipeline=1" DATABASE_POOL_MAX=1
npx drizzle-kit push --force && npm run db:seed
```

Dev server pak přes `.claude/launch.json` (konfigurace `mediaplan-local`, port
3100, testovací přihlášení zapnuté). Při `next build` dev server zastavit —
oba píšou do `.next`.

Pak Playwright (`/opt/pw-browsers/chromium`, spouštět s `--no-proxy-server`),
přihlásit se přes `select#email` jako `admin@fragile.cz`. **Tři reálné chyby
vylezly až takhle** — nesetříděné klíče duplikací, zaseknutý model zásahu
a nepřepočítané rozpočty po změně nosiče. Žádnou z nich by typecheck nechytil.

## Nasazení

**Pozor, už se to stalo:** commit se změnou schématu se pushnul bez `db:push`
a produkce padala na `column "plan_id" does not exist`. Když přibude povinný
sloupec bez výchozí hodnoty do neprázdné tabulky, `drizzle-kit push` nabídne
tabulku vyprázdnit — buď to vědomě přijmout a pustit seed, nebo napsat
migraci, která sloupec nejdřív naplní. Na otázku „created or renamed" volit
`+ create`, pokud nejde opravdu o přejmenování. `db:push` i seed pouštět
v interaktivním terminálu, ne přes `!` v Claude Code (nemá stdin).

**Zkratky pro produkci (říjen 2026):** nepoolovaný connection string je u zadavatele
v Klíčence macOS (`npm run prod:ulozit`, jednou). Pak `npm run nasadit` = schéma
do produkce + `git push`; `npm run prod:import -- "<xlsx>" --doplnit`,
`npm run prod:uklid`. Vše přes `scripts/prod.sh`. Claude Klíčenku nečte a proti
produkci nic nespouští — příkazy jen připraví, pouští je zadavatel.

1. `npm run db:push` proti **produkční** databázi, pokud se měnilo schéma.
   **Nepoolovaný** connection string z Neonu — přes pooler DDL zlobí a zasekne se.
   Během běhu `drizzle-kit` nic nevkládat do terminálu, čte ze stdin a paste ho shodí.
2. Teprve pak `git push` na `main`. Vercel staví sám přes webhook.
3. Nové sloupce staré verzi nevadí, obráceně ano — proto tohle pořadí.

**Seed (`npm run db:seed`) na produkci už NEPOUŠTĚT.** Maže všechna plánovací data
klienta včetně importovaného Strategického plánu 2027 a zakládá ukázkové plány
Q4 2026 a Rok 2027, které zadavatel nechal smazat (říjen 2026, `scripts/smazat-plany.ts`).
Seed je jen pro lokální testy.

Co se automaticky **nestane**: migrace, seed, a propsání změněných proměnných
prostředí (ty se projeví až po redeploy).

Ve Vercelu musí být *Framework Preset* = **Next.js**, jinak build spadne na
„No Output Directory named public". Nastavení v dashboardu přebíjí `vercel.json`.

Verze a čas nasazení jsou v menu pod Odhlásit — zapéká je `next.config.mjs` při buildu.
Verzi zvyšovat ručně: `npm version patch --no-git-tag-version`.

## Práce s terminálem u zadavatele

Příkazy mu posílat **jako jeden celek spojený přes `&&`**, nikdy jako volné řádky
pod sebou. Vkládá je najednou a při selhání `cd` se zbytek spustí ve špatné složce —
dvakrát se tím rozbalil projekt do domovské složky. Ověření cesty (`pwd`) musí být
součástí téhož řetězce, ne samostatný krok.

## Dluh a co dál

Zadavatel si vyžádal tento směr (zbývá z původního seznamu):

- **Benchmarking** — neukládá se historie uzavřených plánů ani externí zdroj.
  Otevřené otázky: licence na data (Nielsen Admosphere, SKMO, ATmedia), a hlavně
  **souhlas se agregací napříč klienty** — benchmark přes víc klientů je agregace
  klientských dat a chce to ověřit ve smlouvách.

Technický dluh:

- Tematické oblasti nejde přejmenovat ani smazat (jen založit).
- Výsledky: „chybí" = měsíc ≤ dnešní a plán > 0 bez zapsané skutečnosti. Čerpání se
  ale vykazuje se zpožděním — možná posunout o měsíc, až se ozve klient.

- Import a export XLSX (zadání §9) — data se zatím nahrávají seedem.
- Kalibrace křivek: rozhraní je (Kalkulačka → Kalibrace zásahu), čeká se na vlny od TV nákupu.
- Plán: řádek bloku se při vodorovném rolování neukotvuje (název bloku odjede);
  ukotvené jsou jen úchyt a sdělení.
  **TV křivka = předpoklad zadavatele** (říjen 2026): TV zasáhne téměř celou cílovku
  (rMax 0,98, k 1,5 → 300 TRP ≈ 97 %). Řádky křivek, které do DB zapsal seed se
  zdrojem `UNCALIBRATED_SOURCE`, se ignorují — přednost má kód; skutečná kalibrace
  (jiný zdroj) má přednost před kódem. Až přijde TV report, nahradit.
- **Zásah = 1+.** Zadavatel pracuje jen se zásahem 1+ a frekvencí; efektivní zásah 3+
  je v panelu zásahu schovaný (`SHOW_EFFECTIVE` v `ReachPanel.tsx`), výpočet a testy zůstaly.
  GRP/TRP v plánu BENU jsou podklad pro zásah 1+ (potvrzeno, říjen 2026).
- Strategický plán BENU 2027: cílová skupina Ženy 25–54 (potvrzeno), leden 2027
  zatím prázdný (rozhodnutí zadavatele, říjen 2026). Chybí GRP rádia, doručení u OMK MC,
  sponzoringu, partnerství a podcastu, rozpad online po platformách a u social
  oddělení fee od médií.
- **Výchozí koeficienty duplikace** jsou 1,05–1,70 (publika se překrývají), kalkulačka
  zadavatele počítá s ≤ 1. Při vysokých zásazích k > 1 narazí na strop překryvu
  a další média nepřidají nic. Rozhodnout s media specialistou, ideálně z dat.
- Z revize (říjen 2026), zatím neřešené: ukotvené levé sloupce v ročním plánu;
  měsíc zápisu se neověřuje proti
  období plánu; žádné transakce u vícekrokových zápisů; `loadPlan` stahuje celé
  tabulky všech plánů; křivky, duplikace a cílové skupiny nejsou oddělené po
  klientech; ROLE_BASE dává PLANNER/ACCOUNT/VIEWER čtení všech klientů;
  `actions.ts` (1400 řádků) a `PlanTable.tsx` rozdělit.
- Podklady a poznámky — tabulky jsou, rozhraní chybí.
- Přechod z `db:push` na verzované migrace (`drizzle-kit generate`).

## Nevyřízené bezpečnostní úkoly

- **Rotovat `AUTH_SECRET`.** Zadavatel ho jednou poslal do chatu. Dokud se
  nevymění, platí za kompromitovaný.
- **Smazat `ADMIN_EMAIL_DOMAINS`** ve Vercelu, než se pustí dovnitř klient.
  Dokud je nastavená, každý z dané domény dostane administrátora a v aplikaci
  o tom svítí upozornění. Snížení role se automaticky neděje.

## Co říkat o výstupech

Mediaplány, rozpočty, mediamix a odhady zásahu jsou **pracovní podklad** —
před sdílením s klientem vyžadují validaci media specialistou. U cross-mediálního
zásahu to platí dvojnásob: **je to modelový odhad, ne měření.** Přesná deduplikace
vyžaduje single-source panelová data. Universa, křivky i duplikační koeficienty
jsou zatím odvozené z veřejné demografie a patří zkalibrovat. Tahle výhrada je
i v aplikaci u panelu zásahu — neodstraňovat ji, dokud se model nezkalibruje.

Pro reálná klientská data doporučit právní review zpracování osobních údajů.
