"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type ComboOption = { value: string; label: string; hint?: string };

/**
 * Pole s našeptávačem: nabízí hodnoty, které už v plánu jsou, ale nebrání
 * napsat novou. Bez tohohle se kanály rozutečou do „META", „Meta" a „meta ".
 */
export function Combo({
  value, options, disabled, placeholder, onCommit, allowFree = true, title,
}: {
  value: string;
  options: ComboOption[];
  disabled?: boolean;
  placeholder?: string;
  allowFree?: boolean;
  title?: string;
  /** vrací vybranou hodnotu; u volného textu je `option` undefined */
  onCommit: (value: string, option?: ComboOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const shown = draft ?? value;

  const matches = useMemo(() => {
    const q = (draft ?? "").trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => (o.label + " " + (o.hint ?? "")).toLowerCase().includes(q));
  }, [draft, options]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) { setOpen(false); setDraft(null); }
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  function choose(o: ComboOption) {
    setOpen(false); setDraft(null);
    if (o.label !== value || o.value !== value) onCommit(o.label, o);
  }

  function commitFree() {
    const v = (draft ?? "").trim();
    setOpen(false); setDraft(null);
    if (!allowFree || !v || v === value) return;
    const exact = options.find((o) => o.label.toLowerCase() === v.toLowerCase());
    onCommit(exact ? exact.label : v, exact);
  }

  return (
    <div className="combo" ref={box}>
      <input
        className="txt"
        disabled={disabled}
        title={title ?? value}
        placeholder={placeholder}
        value={shown}
        onFocus={() => { if (!disabled) { setDraft(value); setOpen(true); setHi(0); } }}
        onChange={(e) => { setDraft(e.target.value); setOpen(true); setHi(0); }}
        onBlur={() => { if (!open) setDraft(null); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, matches.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === "Enter") {
            e.preventDefault();
            if (open && matches[hi]) choose(matches[hi]); else commitFree();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") { setOpen(false); setDraft(null); (e.target as HTMLInputElement).blur(); }
          else if (e.key === "Tab") commitFree();
        }}
      />
      {open && matches.length > 0 && (
        <div className="combolist">
          {matches.slice(0, 40).map((o, i) => (
            <button
              key={o.value}
              type="button"
              className={`comboitem ${i === hi ? "hi" : ""} ${o.label === value ? "cur" : ""}`}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => { e.preventDefault(); choose(o); }}
            >
              <span>{o.label}</span>
              {o.hint && <i>{o.hint}</i>}
            </button>
          ))}
          {allowFree && (draft ?? "").trim() && !matches.some((o) => o.label.toLowerCase() === (draft ?? "").trim().toLowerCase()) && (
            <button type="button" className="comboitem newv"
              onMouseDown={(e) => { e.preventDefault(); commitFree(); }}>
              <span>Použít „{(draft ?? "").trim()}"</span><i>nová hodnota</i>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
