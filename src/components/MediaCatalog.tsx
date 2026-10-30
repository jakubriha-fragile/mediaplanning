"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveMedium, deleteMedium, savePlatform, deletePlatform } from "@/lib/actions";
import type { CatalogMedium } from "@/lib/catalog";

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
        Platformu přidáte napsáním do pole „+ platforma“ a Enterem. Změna nosiče u média se projeví u nově vybraných
        položek; u položek, které médium už mají, nosič zůstane, dokud médium v řádku znovu nevyberete.
      </div>
    </div>
  );
}
