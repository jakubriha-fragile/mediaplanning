import { asc } from "drizzle-orm";
import { db } from "@/db";
import { media, platforms, type ChannelType } from "@/db/schema";

/**
 * Výchozí číselník médií a platforem. Digitál podle technické karty Fragile
 * (listy Google Ads, Sklik, Microsoft Ads, Social Ads, ChatGPT, RTB), offline
 * podle toho, jak se v agentuře nakupuje. Upravuje se v Nastavení — tohle je
 * jen počáteční naplnění prázdné tabulky.
 */
export const DEFAULT_CATALOG: Array<{ name: string; channelType: ChannelType; platforms: string[] }> = [
  { name: "Google Ads", channelType: "Digital", platforms: ["Search", "Performance Max", "Demand Gen", "Display", "Remarketing", "YouTube", "App"] },
  { name: "Sklik", channelType: "Digital", platforms: ["Search", "Display", "Nativní / kombinovaná reklama", "Chytrá kampaň", "Video", "Branding"] },
  { name: "Microsoft Ads", channelType: "Digital", platforms: ["Search", "Performance Max"] },
  { name: "Meta Ads", channelType: "Digital", platforms: ["Facebook + Instagram", "Facebook", "Instagram", "Lead Ads", "Advantage+"] },
  { name: "TikTok Ads", channelType: "Digital", platforms: ["In-feed video", "Spark Ads", "TopView"] },
  { name: "LinkedIn Ads", channelType: "Digital", platforms: ["Sponsored content", "Video", "Lead Gen"] },
  { name: "Pinterest Ads", channelType: "Digital", platforms: ["Image", "Video"] },
  { name: "X (Twitter)", channelType: "Digital", platforms: ["Promoted post", "Video"] },
  { name: "ChatGPT Ads", channelType: "Digital", platforms: ["Native Conversational Ad"] },
  { name: "Seznam (přímý nákup)", channelType: "Digital", platforms: ["Display", "Video", "Nativní", "Články / PR", "Podcast / audio"] },
  { name: "AdForm", channelType: "Digital", platforms: ["Display", "Video", "Branding", "Native", "Audio", "CTV", "DOOH"] },
  { name: "DV360", channelType: "Digital", platforms: ["Display", "YouTube", "Audio", "Native", "Demand Gen"] },
  { name: "Teads", channelType: "Digital", platforms: ["Display", "Video", "CTV"] },
  { name: "Spotify", channelType: "Digital", platforms: ["Audio", "Video"] },
  { name: "eTarget", channelType: "Digital", platforms: ["Banner"] },
  { name: "Nova Group", channelType: "TV", platforms: ["Spoty", "Sponzoring", "Product placement", "Speciální formáty"] },
  { name: "Prima", channelType: "TV", platforms: ["Spoty", "Sponzoring", "Product placement", "Speciální formáty"] },
  { name: "Česká televize", channelType: "TV", platforms: ["Spoty", "Sponzoring"] },
  { name: "Atmedia (tematické stanice)", channelType: "TV", platforms: ["Spoty", "Sponzoring"] },
  { name: "TV — mix stanic", channelType: "TV", platforms: ["Spoty", "Sponzoring", "Product placement"] },
  { name: "Radiohouse", channelType: "Rádio", platforms: ["Spoty", "Sponzoring", "Speciální formáty"] },
  { name: "Český rozhlas", channelType: "Rádio", platforms: ["Spoty", "Sponzoring"] },
  { name: "Media Club", channelType: "Rádio", platforms: ["Spoty", "Sponzoring"] },
  { name: "Outdoor", channelType: "OOH", platforms: ["Billboard", "City light", "DOOH", "Doprava", "Eventy a partnerství"] },
  { name: "Tisk", channelType: "Print", platforms: ["Deníky", "Magazíny", "Inzerce / advertorial"] },
  { name: "Kino", channelType: "Kino", platforms: ["Reklamní blok"] },
  { name: "Vlastní kanály", channelType: "Vlastní", platforms: ["Social media (organic)", "Web", "E-mailing", "Influenceři / content"] },
  { name: "PR", channelType: "PR", platforms: ["Tiskové zprávy", "Eventy"] },
];

/** Výchozí předpoklady platformy; CTR a konverze jako podíl 0–1, null = nezadáno. */
export type PlatformDefaults = { cpm: number | null; cpc: number | null; ctr: number | null; cr: number | null };
export type CatalogPlatform = { id: string; name: string } & PlatformDefaults;
export type CatalogMedium = { id: string; name: string; channelType: ChannelType; platforms: CatalogPlatform[] };

/** Číselník pro výběry. Prázdnou tabulku (nová databáze) naplní výchozími hodnotami. */
export async function getCatalog(): Promise<CatalogMedium[]> {
  let ms = await db.select().from(media).orderBy(asc(media.position), asc(media.name));
  if (!ms.length) {
    for (const [i, m] of DEFAULT_CATALOG.entries()) {
      const [row] = await db.insert(media).values({ name: m.name, channelType: m.channelType, position: i })
        .onConflictDoNothing().returning();
      if (row) {
        await db.insert(platforms).values(m.platforms.map((name, j) => ({ mediumId: row.id, name, position: j })))
          .onConflictDoNothing();
      }
    }
    ms = await db.select().from(media).orderBy(asc(media.position), asc(media.name));
  }
  const ps = await db.select().from(platforms).orderBy(asc(platforms.position), asc(platforms.name));
  return ms.map((m) => ({
    id: m.id, name: m.name, channelType: m.channelType,
    platforms: ps.filter((p) => p.mediumId === m.id).map((p) => ({
      id: p.id, name: p.name, cpm: p.estCpm, cpc: p.estCpc, ctr: p.estCtr, cr: p.estCr,
    })),
  }));
}

/**
 * Odhad média a platformy z názvu položky — pro převod existujících plánů.
 * Jen jisté shody; co se nepozná, zůstane prázdné a doplní se ručně.
 */
export function guessCatalog(channel: string, channelType: ChannelType): { medium: string; platform: string | null } | null {
  const n = channel.toLowerCase();
  if (/\bsea\b|search/.test(n)) return { medium: "Google Ads", platform: "Search" };
  if (/youtube/.test(n)) return { medium: "Google Ads", platform: "YouTube" };
  if (/tiktok/.test(n)) return { medium: "TikTok Ads", platform: "In-feed video" };
  if (/\bmeta\b|facebook|instagram/.test(n)) return { medium: "Meta Ads", platform: "Facebook + Instagram" };
  if (/seznam|mudrování|podcast/.test(n)) return { medium: "Seznam (přímý nákup)", platform: /podcast/.test(n) ? "Podcast / audio" : null };
  if (/radiohouse/.test(n)) return { medium: "Radiohouse", platform: "Spoty" };
  if (/čro|rozhlas|radiožurnál|dvojka/.test(n)) return { medium: "Český rozhlas", platform: "Spoty" };
  if (channelType === "TV") {
    if (/sponzor/.test(n)) return { medium: "TV — mix stanic", platform: "Sponzoring" };
    return { medium: "TV — mix stanic", platform: "Spoty" };
  }
  if (channelType === "OOH") return { medium: "Outdoor", platform: /event|partnerstv/.test(n) ? "Eventy a partnerství" : null };
  return null;
}
