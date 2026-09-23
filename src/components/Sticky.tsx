"use client";

import { useEffect } from "react";

/**
 * Ukotvení bez magických čísel.
 *
 * Tabulka má vlastní scrollovací rám (`.scroll.stick`) a v něm ukotvené
 * záhlaví. Aby rám při rolování stránky nepodjel hlavičku, nesmí stránka
 * mít co rolovat navíc — výška rámu se proto dopočítá tak, aby se celý
 * panel vešel přesně pod ukotvenou hlavičku:
 *
 *     výška rámu = okno − hlavička − lišta − co je pod tabulkou
 *
 * Poslední člen se měří, protože pod tabulkou bývá různě vysoký odskok.
 * Výsledek nezávisí na výšce rámu, takže měření nekmitá.
 */
export function Sticky() {
  useEffect(() => {
    const root = document.documentElement;
    const h = (el: Element | null) => (el ? el.getBoundingClientRect().height : 0);

    const measure = () => {
      const topH = Math.round(h(document.querySelector(".top")));
      const barH = Math.round(h(document.querySelector(".panel.sticky > .toolbar")));
      root.style.setProperty("--top-h", `${topH}px`);
      root.style.setProperty("--bar-h", `${barH}px`);
      root.style.setProperty("--head-h", `${Math.round(h(document.querySelector(".scroll.stick thead tr")))}px`);

      const box = document.querySelector<HTMLElement>(".scroll.stick");
      if (!box) return;
      const below = Math.max(
        0,
        Math.round(root.scrollHeight - (box.getBoundingClientRect().bottom + window.scrollY)),
      );
      const max = Math.max(240, window.innerHeight - topH - barH - below);
      root.style.setProperty("--scroll-max", `${max}px`);
    };

    measure();
    // druhé měření po dosazení výšky — písma a zalomení lišty se ustálí až teď
    const raf = requestAnimationFrame(measure);

    const ro = new ResizeObserver(measure);
    for (const sel of [".top", ".panel.sticky > .toolbar", ".scroll.stick thead tr"]) {
      const el = document.querySelector(sel);
      if (el) ro.observe(el);
    }
    window.addEventListener("resize", measure);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  });

  return null;
}
