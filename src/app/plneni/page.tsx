import { redirect } from "next/navigation";

/** Stará adresa — Plnění a K vyplnění jsou teď jedna stránka Výsledky. Odkazy a záložky dál fungují. */
export default async function Moved({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const sp = await searchParams;
  redirect(sp.plan ? `/vysledky?plan=${encodeURIComponent(sp.plan)}` : "/vysledky");
}
