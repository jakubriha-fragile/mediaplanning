"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { grantAccess } from "@/lib/actions";
import { ACCESS_LEVEL_LABEL, type AccessLevel } from "@/lib/permissions";

export type AccessPlan = {
  id: string;
  name: string;
  months: Array<{ value: string; label: string }>;
  tactics: Array<{
    id: string;
    channel: string;
    channelType: string;
    group: "offline" | "online";
    block: string;
    /** položku platí klient sám (z názvu „hradí klient z vlastní karty") */
    clientPays: boolean;
  }>;
};

type Scope = "all" | "offline" | "online" | "items";

const LEVEL_HINT: Record<AccessLevel, string> = {
  view: "Uvidí čísla, nic nezmění.",
  fill: "Zapisuje skutečné čerpání a výsledky. Plán jen vidí.",
  edit: "Mění rozpočty i skutečnost. Strukturu plánu (bloky, nové položky) dál spravuje agentura.",
};

/**
 * Přidělení přístupu ve třech krocích: plán → co smí → na čem.
 * Z výběru vznikne svazek grantů na serveru (grantAccess); engine oprávnění
 * se nemění, tohle je jen srozumitelnější vstup.
 */
export function AccessEditor({ userId, userLabel, plans }: { userId: string; userLabel: string; plans: AccessPlan[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [planId, setPlanId] = useState(plans[0]?.id ?? "");
  const [level, setLevel] = useState<AccessLevel>("fill");
  const [scope, setScope] = useState<Scope>("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [allMonths, setAllMonths] = useState(true);
  const [months, setMonths] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const plan = plans.find((p) => p.id === planId);
  const counts = useMemo(() => ({
    offline: plan?.tactics.filter((t) => t.group === "offline").length ?? 0,
    online: plan?.tactics.filter((t) => t.group === "online").length ?? 0,
    all: plan?.tactics.length ?? 0,
  }), [plan]);

  if (!plans.length) return <div className="note">Zatím neexistuje žádný plán, ke kterému by šlo přidělit přístup.</div>;

  if (!open) {
    return (
      <div style={{ padding: "10px 12px", borderTop: "1px solid var(--line)" }}>
        <button className="btn primary" onClick={() => setOpen(true)}>+ Přidat přístup</button>
      </div>
    );
  }

  const shown = (plan?.tactics ?? []).filter((t) => !q || `${t.channel} ${t.block}`.toLowerCase().includes(q.toLowerCase()));
  const blocks = [...new Set(shown.map((t) => t.block))];
  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  };

  const target =
    scope === "all" ? "celý plán"
    : scope === "offline" ? `offline položky (${counts.offline})`
    : scope === "online" ? `online položky (${counts.online})`
    : picked.size ? `${picked.size} ${picked.size === 1 ? "vybranou položku" : picked.size < 5 ? "vybrané položky" : "vybraných položek"}` : "— vyberte položky —";
  const when = allMonths ? "všechny měsíce" : months.size ? `${months.size} ${months.size === 1 ? "měsíc" : months.size < 5 ? "měsíce" : "měsíců"}` : "— vyberte měsíce —";
  const ready = !!planId && (scope !== "items" || picked.size > 0) && (allMonths || months.size > 0);

  const submit = () => start(async () => {
    const res = await grantAccess({
      userId, planId, level, scope,
      tacticIds: scope === "items" ? [...picked] : [],
      months: allMonths ? [] : [...months],
    });
    if (!res.ok) { setError(res.error); return; }
    setError(null);
    setOpen(false);
    setPicked(new Set());
    router.refresh();
  });

  return (
    <div className="access" style={{ borderTop: "1px solid var(--line)" }}>
      <div className="access-step">
        <div className="access-n">1</div>
        <div style={{ flex: 1 }}>
          <div className="access-h">Plán</div>
          <select className="access-select" value={planId} onChange={(e) => { setPlanId(e.target.value); setPicked(new Set()); setMonths(new Set()); }}>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>

      <div className="access-step">
        <div className="access-n">2</div>
        <div style={{ flex: 1 }}>
          <div className="access-h">Co smí</div>
          <div className="choice">
            {(Object.keys(ACCESS_LEVEL_LABEL) as AccessLevel[]).map((l) => (
              <label key={l} className={level === l ? "on" : ""}>
                <input type="radio" name={`lvl-${userId}`} checked={level === l} onChange={() => setLevel(l)} />
                <b>{ACCESS_LEVEL_LABEL[l][0].toUpperCase() + ACCESS_LEVEL_LABEL[l].slice(1)}</b>
                <span>{LEVEL_HINT[l]}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="access-step">
        <div className="access-n">3</div>
        <div style={{ flex: 1 }}>
          <div className="access-h">Na čem</div>
          <div className="choice">
            {([
              ["all", "Celý plán", `všech ${counts.all} položek`],
              ["offline", "Offline", `TV, rádio, OOH, tisk… · ${counts.offline} položek`],
              ["online", "Online", `digital, sociální sítě… · ${counts.online} položek`],
              ["items", "Vybrané položky", "jen řádky, které označíte"],
            ] as Array<[Scope, string, string]>).map(([v, l, h]) => (
              <label key={v} className={scope === v ? "on" : ""}>
                <input type="radio" name={`scope-${userId}`} checked={scope === v} onChange={() => setScope(v)} />
                <b>{l}</b><span>{h}</span>
              </label>
            ))}
          </div>

          {scope === "items" && plan && (
            <div className="picker">
              <div className="picker-bar">
                <input className="access-select" style={{ maxWidth: 260 }} placeholder="Hledat položku…" value={q} onChange={(e) => setQ(e.target.value)} />
                {plan.tactics.some((t) => t.clientPays) && (
                  <button className="btn" type="button"
                    onClick={() => setPicked(new Set([...picked, ...plan.tactics.filter((t) => t.clientPays).map((t) => t.id)]))}>
                    Vybrat, co platí klient sám
                  </button>
                )}
                {picked.size > 0 && <button className="btn" type="button" onClick={() => setPicked(new Set())}>Zrušit výběr</button>}
                <span className="share">vybráno {picked.size}</span>
              </div>
              <div className="picker-list">
                {blocks.map((b) => (
                  <div key={b}>
                    <div className="picker-block">{b}</div>
                    {shown.filter((t) => t.block === b).map((t) => (
                      <label key={t.id} className="picker-item">
                        <input type="checkbox" checked={picked.has(t.id)} onChange={() => setPicked(toggle(picked, t.id))} />
                        <span>{t.channel}</span>
                        <span className={`pill ${t.group === "online" ? "s-ok" : "ph"}`}>{t.channelType}</span>
                        {t.clientPays && <span className="pill ph">platí klient</span>}
                      </label>
                    ))}
                  </div>
                ))}
                {!shown.length && <div className="share" style={{ padding: 10 }}>Nic nenalezeno.</div>}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="access-step">
        <div className="access-n">4</div>
        <div style={{ flex: 1 }}>
          <div className="access-h">Kdy <span className="share">— nepovinné</span></div>
          <label className="picker-item" style={{ padding: 0 }}>
            <input type="checkbox" checked={allMonths} onChange={(e) => setAllMonths(e.target.checked)} />
            <span>Všechny měsíce plánu</span>
          </label>
          {!allMonths && plan && (
            <div className="chips">
              {plan.months.map((m) => (
                <button key={m.value} type="button" className={`chip ${months.has(m.value) ? "on" : ""}`}
                  onClick={() => setMonths(toggle(months, m.value))}>{m.label}</button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="access-sum">
        <span>
          <b>{userLabel}</b> {ACCESS_LEVEL_LABEL[level]} — {target}, {when}
          {plan ? <> · <b>{plan.name}</b></> : null}
        </span>
        <span className="spacer" />
        {error && <span style={{ color: "var(--bad)" }}>{error}</span>}
        <button className="btn" type="button" onClick={() => setOpen(false)}>Zrušit</button>
        <button className="btn primary" type="button" disabled={!ready || pending} onClick={submit}>
          {pending ? "Ukládám…" : "Přidat přístup"}
        </button>
      </div>
    </div>
  );
}
