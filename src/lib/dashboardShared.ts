/**
 * Konstanty Přehledu sdílené serverem i prohlížečem. Samostatně proto, že
 * dashboard.ts tahá databázi — kdyby je klientská komponenta importovala
 * odtamtud, dostala by do balíčku i ovladač Postgresu a build spadne.
 */
export const UNASSIGNED = "__nezarazeno";
/** O kolik se v doporučení ubere TV tlak v přetížených měsících. */
export const SCENARIO_CUT = 0.3;
