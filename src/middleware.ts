import { NextResponse, type NextRequest } from "next/server";

/**
 * Middleware běží v Edge Runtime, kde nejsou k dispozici Node.js moduly —
 * a tím pádem ani ovladač databáze. Proto tu záměrně NEimportujeme `auth`
 * z lib/auth: stáhlo by to do edge bundlu celý `postgres` (viz varování
 * "A Node.js module is loaded ('net')" v logu buildu).
 *
 * Tohle je jen přesměrování nepřihlášených, tedy pohodlí, ne bezpečnostní
 * hranice. Skutečná kontrola běží na každé stránce (currentPrincipal)
 * a u každého zápisu (assertCan v lib/actions).
 */
const SESSION_COOKIE = /^(__Secure-)?authjs\.session-token/;

export function middleware(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith("/prihlaseni")) return NextResponse.next();

  const signedIn = req.cookies.getAll().some((c) => SESSION_COOKIE.test(c.name));
  if (!signedIn) {
    return NextResponse.redirect(new URL("/prihlaseni", req.nextUrl.origin));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
