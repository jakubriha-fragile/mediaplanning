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
src/lib/period.ts        měsíce a kvartály odvozené z období plánu
src/lib/actions.ts       VŠECHNY zápisy; každý projde assertCan()
src/lib/queries.ts       čtení dat pro stránky
src/lib/undo.ts          zásobník vrácení zpět (10 kroků na uživatele)
```

Datový model: `Klient → Plán (období, stav) → Blok → Linka sdělení → Taktika`.

## Invarianty — tohle nerozbíjet

1. **Oprávnění se kontrolují na serveru u každého zápisu**, v `src/lib/actions.ts`,
   přes `assertCan()`. Zašedlá pole v UI jsou pohodlí, ne ochrana. Grant má **pět
   rozměrů**: plán × typ média × kampaň × měsíc × oblast. NULL = zástupný znak.
   Výchozí stav je zákaz.
   **Nová akce bez `assertCan` s `planId` je bezpečnostní chyba.** Kontrola:
   `grep -n 'assertCan(me' src/lib/actions.ts | grep -v planId` musí být prázdné
   (pozor na víceřádkové volání).

2. **Rozměr plánu je bezpečnostní pojistka.** Bez něj by grant udělený klientovi
   na Q4 2026 automaticky platil i pro rok 2027 a každý další plán.

3. **Rozpočet v Kč se do `tactic_budget.planned` ukládá vždy**, i když je taktika
   řízená GRP nebo impressions. Na tom stojí všechny součty i porovnání se
   skutečností. Kdo mění driver, musí přepočítat `planned`.

4. **Klíče tabulky duplikací skládá `dupKey()`** (abecedně seřazená dvojice).
   Ručně psaný klíč v jiném pořadí tiše spadne na 1,0 a model přestane počítat
   překryv — přesně tahle chyba už se stala.

5. **Model zásahu musí být monotónní** — přidané médium zásah nikdy nesníží —
   a nezávislý na pořadí vstupu. Hlídají to testy.

6. **Poměrové ukazatele (CPM, CPA, CTR, ROAS) se nikdy neškálují časem.**
   Porovnávají se přímo s plánem. Přes měsíce se váží skutečným čerpáním.

7. **Vrácení zpět ukládá PŮVODNÍ HODNOTU**, ne opačnou operaci.

## Ověřování — pouštět před každou dodávkou

```bash
npx tsc --noEmit
npm test                                    # 22 testů oprávnění + 40 cross-média
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

Pak Playwright (`/opt/pw-browsers/chromium`, spouštět s `--no-proxy-server`),
přihlásit se přes `select#email` jako `admin@fragile.cz`. **Tři reálné chyby
vylezly až takhle** — nesetříděné klíče duplikací, zaseknutý model zásahu
a nepřepočítané rozpočty po změně nosiče. Žádnou z nich by typecheck nechytil.

## Nasazení

1. `npm run db:push` proti **produkční** databázi, pokud se měnilo schéma.
   **Nepoolovaný** connection string z Neonu — přes pooler DDL zlobí a zasekne se.
   Během běhu `drizzle-kit` nic nevkládat do terminálu, čte ze stdin a paste ho shodí.
2. Teprve pak `git push` na `main`. Vercel staví sám přes webhook.
3. Nové sloupce staré verzi nevadí, obráceně ano — proto tohle pořadí.

Co se automaticky **nestane**: migrace, seed, a propsání změněných proměnných
prostředí (ty se projeví až po redeploy).

Ve Vercelu musí být *Framework Preset* = **Next.js**, jinak build spadne na
„No Output Directory named public". Nastavení v dashboardu přebíjí `vercel.json`.

Verze a čas nasazení jsou v patičce — zapéká je `next.config.mjs` při buildu.
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

- Import a export XLSX (zadání §9) — data se zatím nahrávají seedem.
- Rozhraní pro kalibraci křivek zásahu a duplikací (cílové skupiny editovatelné jsou).
- Efektivní zásah (3+ kontakty) — spočítaný v `crossmedia.ts`, v UI není.
- Podklady a poznámky — tabulky jsou, rozhraní chybí.
- Tlačítko „+ linka sdělení" — akce `createMessageLine` existuje, tlačítko ne.
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
