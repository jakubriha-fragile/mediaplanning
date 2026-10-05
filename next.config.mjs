import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

/**
 * Verze a čas sestavení se zapékají při buildu — tenhle soubor se vyhodnotí
 * jednou, při něm. Kdyby se čas bral až za běhu, ukazoval by „teď" a nikdo by
 * nepoznal, jestli na Vercelu běží poslední nasazení, nebo tři dny staré.
 */
const nextConfig = {
  experimental: { serverActions: { bodySizeLimit: "4mb" } },
  env: {
    APP_VERSION: pkg.version,
    BUILD_TIME: new Date().toISOString(),
    // Vercel doplní samo; lokálně prostě nebude
    COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA ?? "",
  },
};

export default nextConfig;
