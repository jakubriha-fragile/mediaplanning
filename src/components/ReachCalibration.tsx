"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addReachMeasurement, deleteReachMeasurement } from "@/lib/actions";
import { reachFromGrp, type Curve } from "@/lib/crossmedia";
import { kc, parseNum } from "@/lib/period";

export type Measurement = {
  id: string; channelType: string; targetGroupId: string; targetGroupName: string;
  grp: number; reach: number; label: string; source: string;
};

export type CurveState = {
  channelType: string;
  targetGroupId: string;
  /** předpoklad z kódu */
  assumed: Curve;
  /** kalibrovaná křivka, pokud jsou měření */
  calibrated: Curve | null;
};

const CHANNELS = ["TV", "Rádio", "Digital", "OOH"] as const;
const CH_LABEL: Record<string, string> = { Digital: "Online" };
const pctTxt = (r: number) => `${Math.round(r * 100)} %`;
const PROBES = [300, 1000, 2000];

/**
 * Kalibrace křivek zásahu z naměřených dat. Až TV nákup dodá vlny
 * (TRP + zásah 1+ z plánovacího systému), zadají se sem a výpočty
 * zásahu v celé aplikaci se jimi začnou řídit. Do té doby platí předpoklad.
 */
export function ReachCalibration({
  rows, curves, targetGroups, defaultTg, canEdit,
}: {
  rows: Measurement[];
  curves: CurveState[];
  targetGroups: Array<{ id: string; name: string }>;
  defaultTg: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<string>("TV");
  const [tg, setTg] = useState(defaultTg ?? targetGroups[0]?.id ?? "");
  const [form, setForm] = useState({ label: "", grp: "", reach: "", source: "" });

  const curve = curves.find((c) => c.channelType === channel && c.targetGroupId === tg);
  const mine = rows.filter((r) => r.channelType === channel && r.targetGroupId === tg);

  const submit = () => {
    const grp = parseNum(form.grp);
    const reach = parseNum(form.reach) / 100;
    if (!grp) { setError("Zadejte TRP vlny."); return; }
    if (!(reach > 0 && reach < 1)) { setError("Zásah 1+ zadejte v procentech, mezi 0 a 100."); return; }
    start(async () => {
      const res = await addReachMeasurement({ channelType: channel as never, targetGroupId: tg, grp, reach, label: form.label, source: form.source });
      if (!res.ok) { setError(res.error); return; }
      setError(null);
      setForm({ label: "", grp: "", reach: "", source: form.source });
      router.refresh();
    });
  };

  return (
    <div className="panel" style={{ borderRadius: "var(--radius)", marginBottom: 16 }} id="kalibrace">
      <div className="toolbar">
        <b style={{ fontSize: 13 }}>Kalibrace zásahu z naměřených dat</b>
        <span className="share">TV nákup dodá ke každé vlně TRP a zásah 1+ — zadejte je sem</span>
        <span className="spacer" />
        {pending && <span className="saving"><span className="spinner" />přepočítávám…</span>}
      </div>

      <div style={{ display: "flex", gap: 16, padding: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="field" style={{ margin: 0 }}>
          <label>Médium</label>
          <div className="seg">
            {CHANNELS.map((c) => (
              <button key={c} type="button" className={channel === c ? "on" : ""} onClick={() => setChannel(c)}>{CH_LABEL[c] ?? c}</button>
            ))}
          </div>
        </div>
        <div className="field" style={{ margin: 0, minWidth: 220 }}>
          <label>Cílová skupina</label>
          <select value={tg} onChange={(e) => setTg(e.target.value)}>
            {targetGroups.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="calib-status">
          {curve?.calibrated
            ? <span className="pill s-ok"><b className="g">✓</b>počítá se z {mine.length} {mine.length === 1 ? "měření" : "měření"}</span>
            : <span className="pill s-idle">zatím předpoklad — žádná měření</span>}
        </div>
      </div>

      {curve && (
        <div className="calib-compare">
          <table>
            <thead>
              <tr>
                <th>Zásah 1+ při</th>
                {PROBES.map((p) => <th key={p} className="r">{kc(p)} TRP</th>)}
                <th className="r">Strop</th>
              </tr>
            </thead>
            <tbody>
              <tr className={curve.calibrated ? "calib-old" : ""}>
                <td>Předpoklad</td>
                {PROBES.map((p) => <td key={p} className="r num">{pctTxt(reachFromGrp(p, curve.assumed))}</td>)}
                <td className="r num">{pctTxt(curve.assumed.rMax)}</td>
              </tr>
              {curve.calibrated && (
                <tr>
                  <td><b style={{ fontWeight: 500 }}>Z naměřených dat</b></td>
                  {PROBES.map((p) => <td key={p} className="r num"><b style={{ fontWeight: 500 }}>{pctTxt(reachFromGrp(p, curve.calibrated!))}</b></td>)}
                  <td className="r num">{pctTxt(curve.calibrated.rMax)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="scroll">
        <table>
          <thead>
            <tr><th>Vlna / období</th><th className="r">TRP</th><th className="r">Zásah 1+</th><th className="r">Model říká</th><th>Zdroj</th><th /></tr>
          </thead>
          <tbody>
            {mine.map((r) => (
              <tr key={r.id}>
                <td>{r.label || <span className="share">bez názvu</span>}</td>
                <td className="r num">{kc(r.grp)}</td>
                <td className="r num">{(r.reach * 100).toLocaleString("cs-CZ", { maximumFractionDigits: 1 })} %</td>
                <td className="r num share">{curve?.calibrated ? pctTxt(reachFromGrp(r.grp, curve.calibrated)) : "—"}</td>
                <td className="share">{r.source}</td>
                <td className="r">
                  {canEdit && (
                    <button className="btn danger" disabled={pending} onClick={() => start(async () => {
                      const res = await deleteReachMeasurement(r.id);
                      if (!res.ok) setError(res.error); else router.refresh();
                    })}>Smazat</button>
                  )}
                </td>
              </tr>
            ))}
            {canEdit && (
              <tr className="calib-new">
                <td><input className="txt" placeholder="např. Vlna 1 (únor)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></td>
                <td className="r"><input className="cell" style={{ width: 90 }} placeholder="TRP" inputMode="decimal" value={form.grp} onChange={(e) => setForm({ ...form, grp: e.target.value })} /></td>
                <td className="r"><input className="cell" style={{ width: 80 }} placeholder="%" inputMode="decimal" value={form.reach} onChange={(e) => setForm({ ...form, reach: e.target.value })} /></td>
                <td />
                <td><input className="txt" placeholder="např. Nielsen Admosphere, TV nákup" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} /></td>
                <td className="r"><button className="btn primary" disabled={pending} onClick={submit}>Přidat</button></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {error && <div className="banner" style={{ margin: 12 }}><span><b>Neuloženo.</b> {error}</span></div>}
      <div className="note">
        <b>Jak to funguje:</b> z jednoho měření se dopočítá rychlost, jakou zásah roste (strop zůstane z předpokladu);
        ze dvou a víc měření se spočítá i strop. Nejlepší jsou vlny s různě vysokými TRP. Jakmile je tu aspoň jedno
        měření, řídí se jím zásah i frekvence v Plánování, Přehledu a Finálním mixu pro danou cílovou skupinu.
        Smazáním všech měření se vrátí předpoklad. TRP musí být ve stejné cílové skupině jako zásah.
      </div>
    </div>
  );
}
