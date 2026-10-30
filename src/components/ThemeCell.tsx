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

/**
 * Výběr oblastí zaškrtnutím: jedna oblast = 100 %, víc oblastí = rovným dílem.
 * Procenta se objeví až u dvou a víc oblastí a jdou upravit (TV spot, kde jeden
 * produkt má víc času). Dřív se všechno zadávalo procenty — i obyčejných 100.
 */
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
  const fmt = (n: number) => String(Math.round(n * 10) / 10).replace(".", ",");
  // procenta jako text — během psaní se nic nepřepočítává pod rukama
  const [pctById, setPct] = useState<Record<string, string>>(
    Object.fromEntries(value.map((x) => [x.themeId, fmt(x.share * 100)])),
  );
  const [extra, setExtra] = useState<ThemeOption[]>([]);
  const [newName, setNewName] = useState("");
  const all = [...themes, ...extra.filter((e) => !themes.some((t) => t.id === e.id))];
  const num = (s: string | undefined) => Number(String(s ?? "").replace(",", ".")) || 0;
  const picked = all.filter((t) => pctById[t.id] !== undefined);
  const sum = picked.reduce((a, t) => a + num(pctById[t.id]), 0);

  /** zaškrtnutí přepočte rovným dílem — ruční procenta se dělají až potom */
  const toggle = (id: string) => {
    const ids = pctById[id] !== undefined ? picked.map((t) => t.id).filter((x) => x !== id) : [...picked.map((t) => t.id), id];
    setPct(Object.fromEntries(ids.map((x) => [x, fmt(100 / ids.length)])));
  };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 50 }} />
      <div className="themeeditor" role="dialog" aria-label="Tematické oblasti taktiky" style={{ top: pos.top, left: pos.left }}>
        <div className="share" style={{ marginBottom: 6 }}>Na co položka míří — zaškrtněte jednu nebo víc oblastí</div>
        {all.map((t) => {
          const on = pctById[t.id] !== undefined;
          return (
            <div key={t.id} className={`themerow ${on ? "on" : ""}`}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, cursor: "pointer" }}>
                <input type="checkbox" checked={on} onChange={() => toggle(t.id)} style={{ accentColor: "var(--brand)" }} />
                <span>{t.name}</span>
              </label>
              {on && picked.length > 1 && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                  <input inputMode="decimal" aria-label={`Podíl ${t.name} v %`} value={pctById[t.id]}
                    onChange={(e) => setPct((p) => ({ ...p, [t.id]: e.target.value }))} />
                  <span className="share">%</span>
                </span>
              )}
            </div>
          );
        })}
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <input className="txt" style={{ border: "1px solid var(--line-strong)" }} placeholder="nová oblast"
            value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button type="button" className="btn" disabled={!newName.trim()}
            onClick={async () => {
              const id = await onCreate(newName.trim());
              if (id) {
                setExtra((x) => [...x, { id, name: newName.trim() }]);
                const ids = [...picked.map((t) => t.id), id];
                setPct(Object.fromEntries(ids.map((x) => [x, fmt(100 / ids.length)])));
                setNewName("");
              }
            }}>Přidat</button>
        </div>
        {picked.length > 1 && (
          <div className="share" style={{ margin: "8px 0 0", color: Math.abs(sum - 100) > 0.5 ? "var(--bad)" : undefined }}>
            Součet {fmt(sum)} %{Math.abs(sum - 100) > 0.5 ? " — při uložení se přepočte na 100 %" : ""}
          </div>
        )}
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 10 }}>
          {picked.length > 0 && (
            <button type="button" className="btn" onClick={() => setPct({})} title="Položka nebude patřit žádné oblasti">Nezařazeno</button>
          )}
          <button type="button" className="btn" onClick={onClose}>Zrušit</button>
          <button type="button" className="btn primary"
            onClick={() => onSave(picked.map((t) => ({ themeId: t.id, share: (num(pctById[t.id]) || 100 / picked.length) / 100 })))}>Uložit</button>
        </div>
      </div>
    </>
  );
}
