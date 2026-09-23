import { auth } from "@/lib/auth";

export default auth((req) => {
  const isLogin = req.nextUrl.pathname.startsWith("/prihlaseni");
  if (!req.auth && !isLogin) {
    const url = new URL("/prihlaseni", req.nextUrl.origin);
    return Response.redirect(url);
  }
});

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
