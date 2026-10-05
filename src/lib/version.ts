/**
 * Verze aplikace a čas posledního nasazení.
 *
 * Hodnoty zapéká `next.config.mjs` při buildu. Díky tomu v patičce svítí čas,
 * kdy se nasazovalo — ne čas, kdy se stránka zrovna otevřela.
 */

export const VERSION = process.env.APP_VERSION ?? "—";
export const COMMIT = (process.env.COMMIT_SHA ?? "").slice(0, 7);
export const BUILD_TIME = process.env.BUILD_TIME ?? "";

/** „5. října 2026, 13:04" — celé datum pro titulek v patičce. */
export function buildLabel(): string {
  if (!BUILD_TIME) return "neznámo kdy";
  const d = new Date(BUILD_TIME);
  if (Number.isNaN(d.getTime())) return "neznámo kdy";
  return new Intl.DateTimeFormat("cs-CZ", {
    day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit",
    timeZone: "Europe/Prague",
  }).format(d);
}

/** „dnes", „včera", „před 3 dny" — aby šlo poznat stáří bez počítání. */
export function buildAge(now = new Date()): string {
  if (!BUILD_TIME) return "";
  const d = new Date(BUILD_TIME);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days < 0) return "";
  if (days === 0) return "dnes";
  if (days === 1) return "včera";
  if (days < 5) return `před ${days} dny`;
  if (days < 32) return `před ${days} dny`;
  const months = Math.floor(days / 30);
  return months === 1 ? "před měsícem" : `před ${months} měsíci`;
}
