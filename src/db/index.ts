import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { conn?: ReturnType<typeof postgres> };

const conn =
  globalForDb.conn ??
  postgres(process.env.DATABASE_URL!, { max: 5, prepare: false });

if (process.env.NODE_ENV !== "production") globalForDb.conn = conn;

export const db = drizzle(conn, { schema });
export { schema };
