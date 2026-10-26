/**
 * Test engine oprávnění — běží bez databáze, jen na čisté logice.
 *
 *   npm run test:perms
 *
 * Ověřuje scénář ze zadání §5.2: klient BENU smí vyplňovat skutečné čerpání
 * jen u Paid. U Owned a u plánu musí narazit.
 */
import { can, canSeePlan, canSeeTactic, seesWholePlan, type Principal } from "../src/lib/permissions";

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

console.log("\nČtení — co klient vůbec uvidí");
{
  const paid2027: Principal = {
    id: "u-p27", role: "CLIENT", active: true,
    grants: [{ area: "actuals", level: "write", mediaType: "Paid", planId: PLAN_2027, campaignId: null, month: null }],
  };
  const t = (planId: string, mediaType: "Paid" | "Owned" | "Earned", campaignId = CAMP_BRAND) =>
    ({ planId, mediaType, campaignId, channelType: "Digital" as const, tacticId: "t-x" });
  check("klient vidí plán, na který má grant", canSeePlan(paid2027, PLAN_2027), true);
  check("klient NEVIDÍ plán bez grantu (ani jeho název)", canSeePlan(paid2027, PLAN_2026), false);
  check("klient vidí Paid taktiku", canSeeTactic(paid2027, t(PLAN_2027, "Paid")), true);
  check("klient NEVIDÍ Owned taktiku", canSeeTactic(paid2027, t(PLAN_2027, "Owned")), false);
  check("klient s výsekem NEVIDÍ celý plán (souhrny)", seesWholePlan(paid2027, PLAN_2027), false);
  check("externista vidí jen svou kampaň", canSeeTactic(externista, t(PLAN_2026, "Paid", CAMP_VANOCE)), true);
  check("externista NEVIDÍ jinou kampaň", canSeeTactic(externista, t(PLAN_2026, "Paid", CAMP_BRAND)), false);
  check("klient s plan/read napříč vidí celý plán", seesWholePlan(klient, PLAN_2026), true);
  check("account vidí všechny plány", canSeePlan(account, PLAN_2027), true);
  check("klient bez grantů nevidí nic", canSeePlan({ id: "x", role: "CLIENT", active: true, grants: [] }, PLAN_2026), false);
  check("deaktivovaný nevidí nic", canSeePlan(vypnuty, PLAN_2026), false);
}

console.log("\nSkupina nosičů — klient vyplňuje jen online");
{
  const online: Principal = {
    id: "u-on", role: "CLIENT", active: true,
    grants: [{ area: "actuals", level: "write", mediaType: null, planId: PLAN_2027, campaignId: null, month: null, channelGroup: "online" }],
  };
  const w = (channelType: "TV" | "Digital" | "Vlastní" | "Rádio" | null) =>
    can(online, "write", { area: "actuals", planId: PLAN_2027, mediaType: "Paid", campaignId: CAMP_BRAND, month: "2027-03", channelType, tacticId: "t-1" });
  check("smí čerpání u Digital", w("Digital"), true);
  check("smí čerpání u vlastních kanálů (online)", w("Vlastní"), true);
  check("NESMÍ čerpání u TV", w("TV"), false);
  check("NESMÍ čerpání u rádia", w("Rádio"), false);
  check("NESMÍ operaci napříč nosiči", w(null), false);
  check("NESMÍ měnit plán ani u Digital", can(online, "write", { area: "plan", planId: PLAN_2027, mediaType: "Paid", campaignId: CAMP_BRAND, month: "2027-03", channelType: "Digital", tacticId: "t-1" }), false);
  const tac = (channelType: "TV" | "Digital") => ({ planId: PLAN_2027, mediaType: "Paid" as const, campaignId: CAMP_BRAND, channelType, tacticId: "t-1" });
  check("vidí online taktiku", canSeeTactic(online, tac("Digital")), true);
  check("NEVIDÍ TV taktiku", canSeeTactic(online, tac("TV")), false);
  check("s výsekem online NEVIDÍ souhrny celého plánu", seesWholePlan(online, PLAN_2027), false);
}

console.log("\nJednotlivé položky — klient vyplňuje jen to, co platí sám");
{
  const items: Principal = {
    id: "u-it", role: "CLIENT", active: true,
    grants: [
      { area: "actuals", level: "write", mediaType: null, planId: PLAN_2027, campaignId: null, month: null, tacticId: "t-meta" },
      { area: "plan", level: "write", mediaType: null, planId: PLAN_2027, campaignId: null, month: null, tacticId: "t-meta" },
    ],
  };
  const w = (area: "plan" | "actuals", tacticId: string | null) =>
    can(items, "write", { area, planId: PLAN_2027, mediaType: "Paid", campaignId: CAMP_BRAND, month: "2027-04", channelType: "Digital", tacticId });
  check("smí čerpání u své položky", w("actuals", "t-meta"), true);
  check("smí rozpočet u své položky", w("plan", "t-meta"), true);
  check("NESMÍ čerpání u jiné položky", w("actuals", "t-tv"), false);
  check("NESMÍ založit novou položku (operace bez taktiky)", w("plan", null), false);
  check("NESMÍ měnit blok", can(items, "write", { area: "plan", planId: PLAN_2027, mediaType: null, campaignId: CAMP_BRAND, month: null }), false);
  check("grant na položku NEPŘETEČE do jiného plánu", can(items, "write", { area: "actuals", planId: PLAN_2026, mediaType: "Paid", campaignId: CAMP_BRAND, month: "2026-10", channelType: "Digital", tacticId: "t-meta" }), false);
  const tac = (tacticId: string) => ({ planId: PLAN_2027, mediaType: "Paid" as const, campaignId: CAMP_BRAND, channelType: "Digital" as const, tacticId });
  check("vidí svou položku", canSeeTactic(items, tac("t-meta")), true);
  check("NEVIDÍ cizí položku", canSeeTactic(items, tac("t-tv")), false);
  check("vidí plán (smí ho otevřít)", canSeePlan(items, PLAN_2027), true);
  check("NEVIDÍ souhrny celého plánu", seesWholePlan(items, PLAN_2027), false);
}

console.log(failed ? `\n${failed} testů selhalo\n` : "\nVšechny testy prošly\n");
process.exit(failed ? 1 : 0);
