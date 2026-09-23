"use client";

import { useState } from "react";

/** Textové pole s hodnotou ke zkopírování — ať se URI nikde nerozbije překlepem. */
export function Copyable({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <input
        readOnly
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        style={{
          flex: 1, font: "inherit", fontSize: 12.5, padding: "7px 10px",
          border: "1px solid var(--line-strong)", borderRadius: 4,
          background: "var(--surface-2)", color: "var(--ink)",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        }}
      />
      <button
        className="btn"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "zkopírováno" : "kopírovat"}
      </button>
    </div>
  );
}
