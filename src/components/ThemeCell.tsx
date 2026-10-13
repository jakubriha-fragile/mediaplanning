"use client";

import { useState } from "react";

export type ThemeOption = { id: string; name: string };
export type ThemeShare = { themeId: string; share: number };

/**
 * Tematická oblast taktiky. Většina taktik míří na jednu oblast; smíšené
 * (TV spot se čtyřmi produkty, online pro brand i produkty) se rozdělí
 * procenty. Editor ukládá celé rozdělení najednou — po částech by součet
 * cestou nebyl sto procent.
 */
export function ThemeCell({
  value, themes, disabled, onSave, onCreate,
}: {
  value: ThemeShare[];
  themes: ThemeOption[];
  disabled: boolean;
  onSave: (shares: ThemeShare[]) => void;
  onCreate: (name: string) => Promise<string | null>;
}) {
  // editor se kreslí s position: fixed — tabulka plánu je v rolovacím
  // kontejneru, který by absolutně umístěný popover uřízl
  const [open, setOpen] = useState<{ top: number; left: number } | null>(null);
  const name = (id: string) => themes.find((t) => t.id === id)?.name ?? "?";
  const sorted = [...value].sort((a, b) => b.share - a.share);
  const title = sorted.map((x) => `${name(x.themeId)} ${Math.round(x.share * 100)} %`).join(" · ");

  const label = !sorted.length
    ? <span className="share">nezařazeno</span>
    : sorted.length === 1
      ? name(sorted[0].themeId)
      : <>{name(sorted[0].themeId)} {Math.round(sorted[0].share * 100)} % <span className="share">+{sorted.length - 1}</span></>;

  return (
    <div style={{ position: "relative" }}>
      <button type="button" className="themecell" disabled={disabled} title={title || "Bez tematické oblasti"}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const h = 120 + 30 * themes.length;
          setOpen({
            top: r.bottom + 4 + h > window.innerHeight ? Math.max(8, r.top - 4 - h) : r.bottom + 4,
            left: Math.min(r.left, window.innerWidth - 300),
          });
        }}>{label}</button>
      {open && (
        <ThemeEditor value={value} themes={themes} pos={open} onClose={() => setOpen(null)}
          onSave={(s) => { setOpen(null); onSave(s); }} onCreate={onCreate} />
      )}
    </div>
  );
}

function ThemeEditor({
  value, themes, pos, onClose, onSave, onCreate,
}: {
  pos: { top: number; left: number };
  value: ThemeShare[];
  themes: ThemeOption[];
  onClose: () => void;
  onSave: (shares: ThemeShare[]) => void;
  onCreate: (name: string) => Promise<string | null>;
}) {
  // procenta jako text — během psaní se nic nepřepočítává pod rukama
  const [pctById, setPct] = useState<Record<string, string>>(
    Object.fromEntries(value.map((x) => [x.themeId, String(Math.round(x.share * 1000) / 10).replace(".", ",")])),
  );
  const [extra, setExtra] = useState<ThemeOption[]>([]);
  const [newName, setNewName] = useState("");
  const all = [...themes, ...extra.filter((e) => !themes.some((t) => t.id === e.id))];
  const num = (s: string | undefined) => Number(String(s ?? "").replace(",", ".")) || 0;
  const sum = all.reduce((a, t) => a + num(pctById[t.id]), 0);
  const picked = all.filter((t) => num(pctById[t.id]) > 0);

  const evenly = () => {
    const ids = picked.length ? picked.map((t) => t.id) : [];
    if (!ids.length) return;
    const each = String(Math.round((100 / ids.length) * 10) / 10).replace(".", ",");
    setPct(Object.fromEntries(ids.map((id) => [id, each])));
  };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 50 }} />
      <div className="themeeditor" role="dialog" aria-label="Tematické oblasti taktiky" style={{ top: pos.top, left: pos.left }}>
        <div className="share" style={{ marginBottom: 6 }}>Podíl taktiky na oblastech (%)</div>
        {all.map((t) => (
          <label key={t.id} className="themerow">
            <span>{t.name}</span>
            <input inputMode="decimal" value={pctById[t.id] ?? ""} placeholder="0"
              onChange={(e) => setPct((p) => ({ ...p, [t.id]: e.target.value }))} />
          </label>
        ))}
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <input className="txt" style={{ border: "1px solid var(--line-strong)" }} placeholder="nová oblast"
            value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button type="button" className="btn" disabled={!newName.trim()}
            onClick={async () => {
              const id = await onCreate(newName.trim());
              if (id) { setExtra((x) => [...x, { id, name: newName.trim() }]); setPct((p) => ({ ...p, [id]: "100" })); setNewName(""); }
            }}>Přidat</button>
        </div>
        <div className="share" style={{ margin: "8px 0", color: Math.abs(sum - 100) > 0.5 && sum > 0 ? "var(--bad)" : undefined }}>
          Součet {String(Math.round(sum * 10) / 10).replace(".", ",")} %{sum > 0 && Math.abs(sum - 100) > 0.5 ? " — při uložení se přepočte na 100 %" : ""}
        </div>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={evenly} disabled={picked.length < 2}
            title="Rozdělí rovným dílem mezi vyplněné oblasti">Rovnoměrně</button>
          <button type="button" className="btn" onClick={onClose}>Zrušit</button>
          <button type="button" className="btn primary"
            onClick={() => onSave(picked.map((t) => ({ themeId: t.id, share: num(pctById[t.id]) / 100 })))}>Uložit</button>
        </div>
      </div>
    </>
  );
}
