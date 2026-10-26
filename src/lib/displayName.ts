/**
 * Krátký název položky. Názvy z Excelu nesou poznámky pro agenturu —
 * „(hradí klient z vlastní karty)", „(navýšení o 15 000 Kč)", „(odhad)" —
 * které klienta v seznamu jen zahlcují. Vlastní krátký název (tactic.label)
 * má přednost; jinak se tyhle poznámky odstřihnou. Plný název zůstává
 * v nápovědě a podle něj se dál pozná agenturní práce (costKind).
 */
const NOISE = /hradí klient|vlastní karty|navýšení|odhad|bude upřesněno|přefakturace/i;

export function shortName(channel: string): string {
  let s = channel
    // „(…poznámka…)" kdekoli v názvu
    .replace(/\s*\(([^()]*)\)/g, (all, inner: string) => (NOISE.test(inner) ? "" : all))
    // „ - hradí klient z vlastní karty" na konci
    .replace(/\s+[-–]\s+[^-–]*$/u, (tail) => (NOISE.test(tail) ? "" : tail))
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!s) s = channel.trim();
  return s;
}

export function displayName(t: { channel: string; label?: string | null }): string {
  return t.label?.trim() || shortName(t.channel);
}
