import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Připojení se navazuje až při prvním dotazu, ne při načtení modulu.
 *
 * Důvod: Next.js si při buildu tenhle soubor načte kvůli analýze stránek.
 * Kdyby se tu rovnou volalo postgres(DATABASE_URL), build by spadl pokaždé,
 * když proměnná ještě není nastavená — třeba při prvním nasazení, kdy databáze
 * ještě neexistuje. Takhle build projde a chyba se objeví až za běhu,
 * na stránce Nastavení, kde je vidět, co chybí.
 */
type Db = ReturnType<typeof drizzle<typeof schema>>;

// Pool se drží v globalThis VŽDY, i v produkci. Proxy níže volá connect() při
// každém přístupu k db — bez cache by každý dotaz založil nový pool a nové DNS
// dotazy, spojení by zůstávala viset a teplá funkce na Vercelu by po chvíli
// padala na „getaddrinfo EBUSY" (stalo se v listopadu 2026). V dev to navíc
// přežije hot reload.
const globalForDb = globalThis as unknown as {
  db?: Db;
};

function connect(): Db {
  if (globalForDb.db) return globalForDb.db;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL není nastavená. Doplňte ji do proměnných prostředí (ve Vercelu ji přidá Neon při propojení) a spusťte redeploy.",
    );
  }

  // prepare: false je nutné kvůli poolovanému připojení přes pgBouncer.
  // DATABASE_POOL_MAX je jen pro lokální testy proti PGlite, které má jediný
  // backend a souběžná spojení si pletou; v produkci nenastavovat.
  // idle_timeout: nečinná spojení zavřít — zmrazená serverless funkce by je
  // jinak držela, dokud je Neon sám neutne.
  const max = Number(process.env.DATABASE_POOL_MAX) || 5;
  const conn = postgres(url, { max, prepare: false, idle_timeout: 20 });
  globalForDb.db = drizzle(conn, { schema });
  return globalForDb.db;
}

export const db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    const real = connect() as unknown as Record<string | symbol, unknown>;
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export { schema };
