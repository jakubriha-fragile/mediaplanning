/**
 * Engine oprávnění — zadání §5.2.
 *
 * Grant má čtyři rozměry: typ média × kampaň × měsíc × oblast, plus úroveň.
 * NULL v rozměru znamená „vše". Operace projde, pokud existuje grant, který
 * pokrývá VŠECHNY rozměry dotčeného záznamu. Chybí-li grant, operace se odmítne —
 * výchozí stav je zákaz.
 *
 * Tohle je jediné místo, kde se o oprávněních rozhoduje. Volá se ze serveru
 * u každého zápisu (src/lib/actions.ts). Front-end si ho pouští jen proto, aby
 * zašedl pole — to je pohodlí, ne ochrana.
 */

import type { Area, Level, MediaType, Role } from "@/db/schema";

export type GrantRow = {
  area: Area;
  level: Level;
  mediaType: MediaType | null;
  campaignId: string | null;
  month: string | null;
};

export type Principal = {
  id: string;
  role: Role;
  active: boolean;
  grants: GrantRow[];
};

/** Co se zrovna mění — souřadnice záznamu ve čtyřech rozměrech. */
export type Target = {
  area: Area;
  mediaType?: MediaType | null;
  campaignId?: string | null;
  month?: string | null;
};

/**
 * Role dávají základní rozsah (zadání §5.1). Grant může přidat, nikdy ubrat.
 * CLIENT záměrně nedostává nic — všechno má z grantů, jinak by „klient smí jen Paid"
 * nešlo vyjádřit.
 */
const ROLE_BASE: Record<Role, Array<{ area: Area; level: Level }>> = {
  ADMIN: [
    { area: "plan", level: "write" },
    { area: "actuals", level: "write" },
    { area: "assets", level: "write" },
  ],
  PLANNER: [
    { area: "plan", level: "write" },
    { area: "actuals", level: "write" },
    { area: "assets", level: "write" },
  ],
  ACCOUNT: [
    { area: "plan", level: "read" },
    { area: "actuals", level: "write" },
    { area: "assets", level: "write" },
  ],
  CLIENT: [],
  VIEWER: [
    { area: "plan", level: "read" },
    { area: "actuals", level: "read" },
    { area: "assets", level: "read" },
  ],
};

const RANK: Record<Level, number> = { read: 0, write: 1 };

/** Sedí rozměr grantu na cíl? NULL v grantu = zástupný znak. */
function dimensionMatches(grantValue: string | null, targetValue: string | null | undefined): boolean {
  if (grantValue === null) return true; // grant platí pro všechny hodnoty
  if (targetValue === null || targetValue === undefined) return false; // cíl je „napříč", grant je úzký
  return grantValue === targetValue;
}

/**
 * Hlavní rozhodovací funkce.
 * `need` je požadovaná úroveň; write implikuje read.
 */
export function can(principal: Principal | null, need: Level, target: Target): boolean {
  if (!principal || !principal.active) return false;
  if (principal.role === "ADMIN") return true; // administrátor obejde granty záměrně

  // 1) základní rozsah z role
  for (const base of ROLE_BASE[principal.role] ?? []) {
    if (base.area === target.area && RANK[base.level] >= RANK[need]) return true;
  }

  // 2) granty — musí sedět všechny čtyři rozměry
  for (const g of principal.grants) {
    if (g.area !== target.area) continue;
    if (RANK[g.level] < RANK[need]) continue;
    if (!dimensionMatches(g.mediaType, target.mediaType ?? null)) continue;
    if (!dimensionMatches(g.campaignId, target.campaignId ?? null)) continue;
    if (!dimensionMatches(g.month, target.month ?? null)) continue;
    return true;
  }
  return false;
}

/** Verze pro server actions: místo false vyhodí chybu, aby zápis spadl. */
export function assertCan(principal: Principal | null, need: Level, target: Target): void {
  if (!can(principal, need, target)) {
    const where = [
      target.area,
      target.mediaType ?? "*",
      target.campaignId ? "kampaň" : "*",
      target.month ?? "*",
    ].join(" / ");
    throw new PermissionError(`Nemáte oprávnění zapisovat: ${where}`);
  }
}

export class PermissionError extends Error {
  readonly code = "FORBIDDEN";
}

/** Smí uživatel spravovat uživatele a oprávnění? */
export function canManageUsers(principal: Principal | null): boolean {
  return !!principal && principal.active && principal.role === "ADMIN";
}

/**
 * Pomůcka pro UI: vrací, které buňky smí uživatel editovat, aby šlo pole zašednout.
 * Nikdy se na to nespoléhá při zápisu.
 */
export function editableMatrix(
  principal: Principal | null,
  campaignId: string,
  months: string[],
  mediaTypes: MediaType[],
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const area of ["plan", "actuals"] as Area[]) {
    for (const mt of mediaTypes) {
      for (const m of months) {
        out[`${area}|${mt}|${m}`] = can(principal, "write", {
          area,
          mediaType: mt,
          campaignId,
          month: m,
        });
      }
    }
  }
  return out;
}
