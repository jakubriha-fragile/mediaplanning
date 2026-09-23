/**
 * Test engine oprávnění — běží bez databáze, jen na čisté logice.
 *
 *   npm run test:perms
 *
 * Ověřuje scénář ze zadání §5.2: klient BENU smí vyplňovat skutečné čerpání
 * jen u Paid. U Owned a u plánu musí narazit.
 */
import { can, type Principal } from "../src/lib/permissions";

let failed = 0;
function check(label: string, actual: boolean, expected: boolean) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${ok ? "" : `  (čekáno ${expected}, vráceno ${actual})`}`);
}

const CAMP_BRAND = "camp-brand";
const CAMP_VANOCE = "camp-vanoce";

const klient: Principal = {
  id: "u-klient",
  role: "CLIENT",
  active: true,
  grants: [
    { area: "actuals", level: "write", mediaType: "Paid", campaignId: null, month: null },
    { area: "plan", level: "read", mediaType: null, campaignId: null, month: null },
  ],
};

const externista: Principal = {
  id: "u-ext",
  role: "CLIENT",
  active: true,
  grants: [
    { area: "actuals", level: "write", mediaType: null, campaignId: CAMP_VANOCE, month: "2026-12" },
  ],
};

const account: Principal = { id: "u-acc", role: "ACCOUNT", active: true, grants: [] };
const planner: Principal = { id: "u-pl", role: "PLANNER", active: true, grants: [] };
const admin: Principal = { id: "u-ad", role: "ADMIN", active: true, grants: [] };
const vypnuty: Principal = { ...klient, id: "u-off", active: false };

console.log("\nKlient BENU — grant jen na Paid / skutečnost");
check("smí zapsat čerpání u Paid", can(klient, "write", { area: "actuals", mediaType: "Paid", campaignId: CAMP_BRAND, month: "2026-10" }), true);
check("NESMÍ zapsat čerpání u Owned", can(klient, "write", { area: "actuals", mediaType: "Owned", campaignId: CAMP_BRAND, month: "2026-10" }), false);
check("NESMÍ zapsat čerpání u Earned", can(klient, "write", { area: "actuals", mediaType: "Earned", campaignId: CAMP_BRAND, month: "2026-11" }), false);
check("smí číst plán", can(klient, "read", { area: "plan", mediaType: "Paid", campaignId: CAMP_BRAND, month: "2026-10" }), true);
check("NESMÍ měnit plán ani u Paid", can(klient, "write", { area: "plan", mediaType: "Paid", campaignId: CAMP_BRAND, month: "2026-10" }), false);
check("NESMÍ zapisovat podklady", can(klient, "write", { area: "assets", mediaType: "Paid", campaignId: CAMP_BRAND, month: "2026-10" }), false);

console.log("\nExternista — jen Vánoční kampaň, jen prosinec");
check("smí prosinec ve Vánoční kampani", can(externista, "write", { area: "actuals", mediaType: "Paid", campaignId: CAMP_VANOCE, month: "2026-12" }), true);
check("NESMÍ listopad ve stejné kampani", can(externista, "write", { area: "actuals", mediaType: "Paid", campaignId: CAMP_VANOCE, month: "2026-11" }), false);
check("NESMÍ prosinec v jiné kampani", can(externista, "write", { area: "actuals", mediaType: "Paid", campaignId: CAMP_BRAND, month: "2026-12" }), false);

console.log("\nRole bez grantů");
check("account zapisuje skutečnost", can(account, "write", { area: "actuals", mediaType: "Owned", campaignId: CAMP_BRAND, month: "2026-10" }), true);
check("account NEMĚNÍ plán", can(account, "write", { area: "plan", mediaType: "Owned", campaignId: CAMP_BRAND, month: "2026-10" }), false);
check("account plán čte", can(account, "read", { area: "plan", mediaType: "Owned", campaignId: CAMP_BRAND, month: "2026-10" }), true);
check("plánovač mění plán", can(planner, "write", { area: "plan", mediaType: "Earned", campaignId: CAMP_BRAND, month: "2026-12" }), true);
check("administrátor smí vše", can(admin, "write", { area: "plan", mediaType: "Earned", campaignId: CAMP_VANOCE, month: "2026-12" }), true);

console.log("\nHraniční případy");
check("deaktivovaný uživatel nesmí nic", can(vypnuty, "write", { area: "actuals", mediaType: "Paid", campaignId: CAMP_BRAND, month: "2026-10" }), false);
check("nepřihlášený nesmí nic", can(null, "read", { area: "plan", mediaType: "Paid", campaignId: CAMP_BRAND, month: "2026-10" }), false);
check(
  "úzký grant neprojde na operaci 'napříč měsíci'",
  can(externista, "write", { area: "actuals", mediaType: "Paid", campaignId: CAMP_VANOCE, month: null }),
  false,
);

console.log(failed ? `\n${failed} testů selhalo\n` : "\nVšechny testy prošly\n");
process.exit(failed ? 1 : 0);
