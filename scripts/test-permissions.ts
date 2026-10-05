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

const PLAN_2026 = "plan-q4-2026";
const PLAN_2027 = "plan-rok-2027";
const CAMP_BRAND = "camp-brand";
const CAMP_VANOCE = "camp-vanoce";

const klient: Principal = {
  id: "u-klient",
  role: "CLIENT",
  active: true,
  grants: [
    { area: "actuals", level: "write", mediaType: "Paid", planId: null, campaignId: null, month: null },
    { area: "plan", level: "read", mediaType: null, planId: null, campaignId: null, month: null },
  ],
};

const externista: Principal = {
  id: "u-ext",
  role: "CLIENT",
  active: true,
  grants: [
    { area: "actuals", level: "write", mediaType: null, planId: null, campaignId: CAMP_VANOCE, month: "2026-12" },
  ],
};

const account: Principal = { id: "u-acc", role: "ACCOUNT", active: true, grants: [] };
const planner: Principal = { id: "u-pl", role: "PLANNER", active: true, grants: [] };
const admin: Principal = { id: "u-ad", role: "ADMIN", active: true, grants: [] };
const vypnuty: Principal = { ...klient, id: "u-off", active: false };

console.log("\nKlient BENU — grant jen na Paid / skutečnost");
check("smí zapsat čerpání u Paid", can(klient, "write", { area: "actuals", planId: PLAN_2026, mediaType: "Paid", campaignId: CAMP_BRAND, month: "2026-10" }), true);
check("NESMÍ zapsat čerpání u Owned", can(klient, "write", { area: "actuals", planId: PLAN_2026, mediaType: "Owned", campaignId: CAMP_BRAND, month: "2026-10" }), false);
check("NESMÍ zapsat čerpání u Earned", can(klient, "write", { area: "actuals", planId: PLAN_2026, mediaType: "Earned", campaignId: CAMP_BRAND, month: "2026-11" }), false);
check("smí číst plán", can(klient, "read", { area: "plan", planId: PLAN_2026, mediaType: "Paid", campaignId: CAMP_BRAND, month: "2026-10" }), true);
check("NESMÍ měnit plán ani u Paid", can(klient, "write", { area: "plan", planId: PLAN_2026, mediaType: "Paid", campaignId: CAMP_BRAND, month: "2026-10" }), false);
check("NESMÍ zapisovat podklady", can(klient, "write", { area: "assets", planId: PLAN_2026, mediaType: "Paid", campaignId: CAMP_BRAND, month: "2026-10" }), false);

console.log("\nExternista — jen Vánoční kampaň, jen prosinec");
check("smí prosinec ve Vánoční kampani", can(externista, "write", { area: "actuals", planId: PLAN_2026, mediaType: "Paid", campaignId: CAMP_VANOCE, month: "2026-12" }), true);
check("NESMÍ listopad ve stejné kampani", can(externista, "write", { area: "actuals", planId: PLAN_2026, mediaType: "Paid", campaignId: CAMP_VANOCE, month: "2026-11" }), false);
check("NESMÍ prosinec v jiné kampani", can(externista, "write", { area: "actuals", planId: PLAN_2026, mediaType: "Paid", campaignId: CAMP_BRAND, month: "2026-12" }), false);

console.log("\nRole bez grantů");
check("account zapisuje skutečnost", can(account, "write", { area: "actuals", planId: PLAN_2026, mediaType: "Owned", campaignId: CAMP_BRAND, month: "2026-10" }), true);
check("account NEMĚNÍ plán", can(account, "write", { area: "plan", planId: PLAN_2026, mediaType: "Owned", campaignId: CAMP_BRAND, month: "2026-10" }), false);
check("account plán čte", can(account, "read", { area: "plan", planId: PLAN_2026, mediaType: "Owned", campaignId: CAMP_BRAND, month: "2026-10" }), true);
check("plánovač mění plán", can(planner, "write", { area: "plan", planId: PLAN_2026, mediaType: "Earned", campaignId: CAMP_BRAND, month: "2026-12" }), true);
check("administrátor smí vše", can(admin, "write", { area: "plan", planId: PLAN_2026, mediaType: "Earned", campaignId: CAMP_VANOCE, month: "2026-12" }), true);

console.log("\nHraniční případy");
check("deaktivovaný uživatel nesmí nic", can(vypnuty, "write", { area: "actuals", planId: PLAN_2026, mediaType: "Paid", campaignId: CAMP_BRAND, month: "2026-10" }), false);
check("nepřihlášený nesmí nic", can(null, "read", { area: "plan", planId: PLAN_2026, mediaType: "Paid", campaignId: CAMP_BRAND, month: "2026-10" }), false);
check(
  "úzký grant neprojde na operaci 'napříč měsíci'",
  can(externista, "write", { area: "actuals", planId: PLAN_2026, mediaType: "Paid", campaignId: CAMP_VANOCE, month: null }),
  false,
);

console.log("\nRozměr plánu — grant nesmí přetéct do jiného plánu");
const naRok2027: Principal = {
  id: "u-2027",
  role: "CLIENT",
  active: true,
  grants: [
    { area: "actuals", level: "write", mediaType: "Paid", planId: PLAN_2027, campaignId: null, month: null },
  ],
};
check("smí čerpání v plánu 2027", can(naRok2027, "write", { area: "actuals", planId: PLAN_2027, mediaType: "Paid", campaignId: CAMP_BRAND, month: "2027-03" }), true);
check("NESMÍ čerpání v plánu Q4 2026", can(naRok2027, "write", { area: "actuals", planId: PLAN_2026, mediaType: "Paid", campaignId: CAMP_BRAND, month: "2026-10" }), false);
check("NESMÍ operaci napříč plány", can(naRok2027, "write", { area: "actuals", planId: null, mediaType: "Paid", campaignId: CAMP_BRAND, month: "2027-03" }), false);
check("klient s grantem bez plánu smí v obou plánech", can(klient, "write", { area: "actuals", planId: PLAN_2027, mediaType: "Paid", campaignId: CAMP_BRAND, month: "2027-05" }), true);
check("administrátor projde i přes rozměr plánu", can(admin, "write", { area: "plan", planId: PLAN_2027, mediaType: "Paid", campaignId: CAMP_BRAND, month: "2027-07" }), true);

console.log(failed ? `\n${failed} testů selhalo\n` : "\nVšechny testy prošly\n");
process.exit(failed ? 1 : 0);
