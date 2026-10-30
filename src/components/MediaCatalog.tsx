"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveMedium, deleteMedium, savePlatform, deletePlatform, setPlatformEstimate } from "@/lib/actions";
import type { CatalogMedium, CatalogPlatform } from "@/lib/catalog";
import { parseNum } from "@/lib/period";

const CHANNEL_TYPES = ["Digital", "TV", "Rádio", "OOH", "Print", "Kino", "Vlastní", "PR"] as const;

/**
 * Číselník médií a platforem. Médium určuje nosič (a tím výpočet zásahu),
 * platformy jsou typy kampaní v něm. Smazání média položky plánu nesmaže —
 * jen jim médium zmizí a ukážou se mezi „bez média".
 */
export function MediaCatalog({ rows, canEdit }: { rows: CatalogMedium[]; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [newMedium, setNewMedium] = useState({ name: "", channelType: "Digital" as (typeof CHANNEL_TYPES)[number] });
  const [newPlat, setNewPlat] = useState<Record<string, string>>({});

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => start(async () => {
    const res = await fn();
    if (!res.ok) { setError(res.error ?? "Uložení se nezdařilo."); return; }
    setError(null);
    after?.();
    router.refresh();
  });

  return (
    <div className="panel" style={{ borderRadius: "var(--radius)", marginBottom: 16 }} id="media">
      <div className="toolbar">
        <b style={{ fontSize: 13 }}>Média a platformy</b>
        <span className="share">Výběr v Plánování: Médium (určí nosič) → Platforma. Podle technické karty Fragile.</span>
        <span className="spacer" />
        {pending && <span className="saving"><span className="spinner" />ukládám…</span>}
      </div>
      {error && <div className="banner" style={{ margin: 0, borderRadius: 0 }}><span><b>Neuloženo.</b> {error}</span></div>}

      <div className="catalog">
        {CHANNEL_TYPES.filter((ct) => rows.some((m) => m.channelType === ct)).map((ct) => (
          <div key={ct} className="catalog-group">
            <div className="catalog-ct">{ct}</div>
            {rows.filter((m) => m.channelType === ct).map((m) => (
              <div key={m.id} className="catalog-row">
                <div className="catalog-medium">
                  {canEdit ? (
                    <input className="txt" defaultValue={m.name} key={m.name} aria-label="Název média"
                      onBlur={(e) => {
                        const name = e.target.value.trim();
                        if (name && name !== m.name) run(() => saveMedium({ id: m.id, name, channelType: m.channelType }));
                        else e.target.value = m.name;
                      }} />
                  ) : <b>{m.name}</b>}
                  {canEdit && (
                    <select className="txt" value={m.channelType} aria-label="Nosič"
                      onChange={(e) => run(() => saveMedium({ id: m.id, name: m.name, channelType: e.target.value as never }))}>
                      {CHANNEL_TYPES.map((c) => <option key={c}>{c}</option>)}
                    </select>
                  )}
                </div>
                {m.channelType === "Digital" ? (
                  <div>
                    <table className="catalog-defaults">
                      <thead>
                        <tr>
                          <th>Platforma</th>
                          <th className="r" title="Výchozí cena za 1 000 impresí — použije se u položky na CPM bez vlastní ceny (≈)">CPM (Kč)</th>
                          <th className="r" title="Výchozí cena za klik — u položky na CPC bez vlastní ceny (≈)">CPC (Kč)</th>
                          <th className="r" title="Výchozí míra prokliku pro odhad výsledků">CTR %</th>
                          <th className="r" title="Výchozí konverzní poměr z kliků">Konv. %</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {m.platforms.map((p) => (
                          <tr key={p.id}>
                            <td>{p.name}</td>
                            {(["cpm", "cpc", "ctr", "cr"] as const).map((f) => (
                              <td key={f} className="r">
                                <DefaultInput platform={p} field={f} disabled={!canEdit}
                                  onCommit={(v) => run(() => setPlatformEstimate({ platformId: p.id, field: f, value: v }))} />
                              </td>
                            ))}
                            <td>
                              {canEdit && (
                                <button className="res-chip-x" title={`Smazat platformu ${p.name}`}
                                  onClick={() => confirm(`Smazat platformu „${p.name}" u ${m.name}? Položky ji ztratí, čísla zůstanou.`) && run(() => deletePlatform(p.id))}>×</button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {canEdit && (
                      <input className="txt catalog-new" placeholder="+ platforma" value={newPlat[m.id] ?? ""} style={{ marginTop: 4 }}
                        onChange={(e) => setNewPlat((x) => ({ ...x, [m.id]: e.target.value }))}
                        onKeyDown={(e) => {
                          const name = (newPlat[m.id] ?? "").trim();
                          if (e.key === "Enter" && name) run(() => savePlatform({ mediumId: m.id, name }), () => setNewPlat((x) => ({ ...x, [m.id]: "" })));
                        }} />
                    )}
                  </div>
                ) : (
                <div className="catalog-plats">
                    {m.platforms.map((p) => (
                      <span key={p.id} className="chip">
                        {p.name}
                        {canEdit && (
                          <button className="res-chip-x" title={`Smazat platformu ${p.name}`}
                            onClick={() => confirm(`Smazat platformu „${p.name}" u ${m.name}? Položky ji ztratí, čísla zůstanou.`) && run(() => deletePlatform(p.id))}>×</button>
                        )}
                      </span>
                    ))}
                    {canEdit && (
                      <input className="txt catalog-new" placeholder="+ platforma" value={newPlat[m.id] ?? ""}
                        onChange={(e) => setNewPlat((x) => ({ ...x, [m.id]: e.target.value }))}
                        onKeyDown={(e) => {
                          const name = (newPlat[m.id] ?? "").trim();
                          if (e.key === "Enter" && name) run(() => savePlatform({ mediumId: m.id, name }), () => setNewPlat((x) => ({ ...x, [m.id]: "" })));
                        }} />
                    )}
                  </div>
                )}
                {canEdit && (
                  <button className="btn danger" style={{ minHeight: 26 }}
                    onClick={() => confirm(`Smazat médium „${m.name}" i s platformami? Položky plánu zůstanou, jen bez média.`) && run(() => deleteMedium(m.id))}>
                    Smazat
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      {canEdit && (
        <div className="catalog-add">
          <input className="access-select" placeholder="Nové médium, např. Seznam Zprávy" value={newMedium.name}
            onChange={(e) => setNewMedium((x) => ({ ...x, name: e.target.value }))} />
          <select className="access-select" style={{ minWidth: 120 }} value={newMedium.channelType}
            onChange={(e) => setNewMedium((x) => ({ ...x, channelType: e.target.value as never }))}>
            {CHANNEL_TYPES.map((c) => <option key={c}>{c}</option>)}
          </select>
          <button className="btn primary" disabled={!newMedium.name.trim() || pending}
            onClick={() => run(() => saveMedium({ name: newMedium.name.trim(), channelType: newMedium.channelType }),
              () => setNewMedium((x) => ({ ...x, name: "" })))}>Přidat médium</button>
        </div>
      )}
      <div className="note">
        Platformu přidáte napsáním do pole „+ platforma“ a Enterem. Výchozí CPM, CPC, CTR a konverze u digitálních
        platforem platí v plánech všude, kde položka nemá vlastní hodnotu — v plánu jsou označené „≈“ nebo šedě. Změna nosiče u média se projeví u nově vybraných
        položek; u položek, které médium už mají, nosič zůstane, dokud médium v řádku znovu nevyberete.
      </div>
    </div>
  );
}

/** Výchozí předpoklad platformy; procenta se ukládají jako podíl 0–1. Prázdné = nezadáno. */
function DefaultInput({ platform, field, disabled, onCommit }: {
  platform: CatalogPlatform; field: "cpm" | "cpc" | "ctr" | "cr"; disabled: boolean; onCommit: (v: number | null) => void;
}) {
  const pct = field === "ctr" || field === "cr";
  const value = platform[field];
  const text = value === null ? "" : String(Math.round((pct ? value * 100 : value) * 1000) / 1000).replace(".", ",");
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input className="txt defaultinput" inputMode="decimal" disabled={disabled} aria-label={`${field.toUpperCase()} ${platform.name}`}
      value={draft ?? text} placeholder="—"
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === null) return;
        const t = draft.trim();
        setDraft(null);
        if (t === text) return;
        const n = t ? parseNum(t) : null;
        onCommit(n === null || !Number.isFinite(n) || n <= 0 ? null : pct ? n / 100 : n);
      }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setDraft(null); (e.target as HTMLInputElement).blur(); } }} />
  );
}
