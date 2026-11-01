// Renderiza EstimateForm en el servidor (renderToString) como lo hace el prerender, para probar el HTML que recibe el
// navegador antes de hidratar. Node no ejecuta .tsx ni el alias "@/": se empaqueta en memoria con esbuild (dependencia
// de vite, ya instalada; no agrega nada a package.json) y se importa el resultado.
import { build } from "esbuild";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

export async function renderEstimateFormHtml(siteKey = "1x00000000000000000000AA"): Promise<string> {
  const out = await build({
    stdin: {
      contents: `import React from "react";
import { renderToString } from "react-dom/server";
import EstimateForm from "@/components/custom-builds/EstimateForm";
export const html = renderToString(React.createElement(EstimateForm));`,
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true, write: false, format: "esm", platform: "node", jsx: "automatic", logLevel: "silent",
    alias: { "@": `${ROOT}/src` },
    define: { "import.meta.env.VITE_TURNSTILE_SITE_KEY": JSON.stringify(siteKey) },
    banner: { js: `import { createRequire as __cr } from "node:module"; const require = __cr(${JSON.stringify(pathToFileURL(`${ROOT}/x.js`).href)});` },
  });
  const code = out.outputFiles[0].text;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return mod.html as string;
}
