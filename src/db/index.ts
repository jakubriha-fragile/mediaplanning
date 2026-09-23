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

const globalForDb = globalThis as unknown as {
  conn?: ReturnType<typeof postgres>;
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

  // prepare: false je nutné kvůli poolovanému připojení přes pgBouncer
  const conn = globalForDb.conn ?? postgres(url, { max: 5, prepare: false });
  const db = drizzle(conn, { schema });

  if (process.env.NODE_ENV !== "production") {
    globalForDb.conn = conn;
    globalForDb.db = db;
  }
  return db;
}

export const db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    const real = connect() as unknown as Record<string | symbol, unknown>;
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export { schema };
