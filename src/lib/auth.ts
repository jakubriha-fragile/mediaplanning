/**
 * Přihlášení — zadání §4.
 *
 * Google SSO je jediná produkční cesta. Vlastní hesla se záměrně nestaví
 * (odůvodnění v zadání §4).
 *
 * Testovací přihlášení (ENABLE_DEV_LOGIN) existuje jen proto, aby šlo projekt
 * rozjet a proklikat role bez zakládání OAuth klienta. V produkci se samo
 * vypne, když NODE_ENV === "production" a proměnná není výslovně zapnutá.
 */
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, grants } from "@/db/schema";
import type { Principal } from "@/lib/permissions";

const devLoginEnabled =
  process.env.ENABLE_DEV_LOGIN === "true" && process.env.NODE_ENV !== "production";

const allowedDomains = (process.env.ALLOWED_EMAIL_DOMAINS ?? "")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Bez databázového adaptéru záměrně: session drží JWT a uživatele si zakládáme
  // sami v signIn callbacku. Díky tomu si řídíme roli i to, kdo vůbec smí dovnitř,
  // a build nezávisí na dostupnosti databáze.
  session: { strategy: "jwt" },
  trustHost: true,
  pages: { signIn: "/prihlaseni" },
  providers: [
    ...(process.env.AUTH_GOOGLE_ID
      ? [
          Google({
            clientId: process.env.AUTH_GOOGLE_ID,
            clientSecret: process.env.AUTH_GOOGLE_SECRET,
            allowDangerousEmailAccountLinking: true,
          }),
        ]
      : []),
    ...(devLoginEnabled
      ? [
          Credentials({
            id: "dev",
            name: "Testovací účet",
            credentials: { email: { label: "E-mail", type: "text" } },
            async authorize(creds) {
              const email = String(creds?.email ?? "").toLowerCase();
              if (!email) return null;
              const [user] = await db.select().from(users).where(eq(users.email, email));
              if (!user || !user.active) return null;
              return { id: user.id, email: user.email, name: user.name ?? undefined };
            },
          }),
        ]
      : []),
  ],
  callbacks: {
    /**
     * Kdo se smí vůbec přihlásit: buď je už pozvaný v databázi, nebo přichází
     * z povolené domény. Nikdo jiný dovnitř, ani s platným Google účtem.
     */
    async signIn({ user }) {
      const email = user.email?.toLowerCase();
      if (!email) return false;

      const [existing] = await db.select().from(users).where(eq(users.email, email));
      if (existing) {
        if (!existing.active) return false;
        // doplníme jméno a avatar, když je účet vytvořený pozvánkou
        if ((!existing.name && user.name) || (!existing.image && user.image)) {
          await db
            .update(users)
            .set({ name: existing.name ?? user.name ?? null, image: existing.image ?? user.image ?? null })
            .where(eq(users.id, existing.id));
        }
        return true;
      }

      // nepozvaný účet projde jen z povolené domény, a to s rolí VIEWER
      const domain = email.split("@")[1] ?? "";
      if (!allowedDomains.includes(domain)) return false;
      await db.insert(users).values({
        email,
        name: user.name ?? null,
        image: user.image ?? null,
        role: "VIEWER",
      });
      return true;
    },
    async jwt({ token, user }) {
      if (user?.email) token.email = user.email;
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.email) session.user.email = token.email as string;
      return session;
    },
  },
});

/** Přihlášený uživatel i s granty — vstup do engine oprávnění. */
export async function currentPrincipal(): Promise<Principal | null> {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (!email) return null;
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) return null;
  const rows = await db.select().from(grants).where(eq(grants.userId, user.id));
  return {
    id: user.id,
    role: user.role,
    active: user.active,
    grants: rows.map((g) => ({
      area: g.area,
      level: g.level,
      mediaType: g.mediaType,
      campaignId: g.campaignId,
      month: g.month,
    })),
  };
}
