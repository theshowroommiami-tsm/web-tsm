// Renderiza componentes de Custom Builds en el servidor (renderToString) como lo hace el prerender, para probar el HTML que
// recibe el navegador antes de hidratar. Node no ejecuta .tsx ni el alias "@/": se empaqueta en memoria con esbuild
// (dependencia de vite, ya instalada; no agrega nada a package.json) y se importa el resultado.
import { build } from "esbuild";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

/**
 * Sustituto de react/jsx-runtime que anota las props de cada ancla hacia #estimate que se crea al renderizar (el HTML no
 * muestra los manejadores de eventos). Delega todo lo demás en el runtime real.
 */
const JSX_SPY = (root: string) => `
import * as real from ${JSON.stringify(`${root}/node_modules/react/jsx-runtime.js`)};
export const estimateAnchors = [];
const spy = (make) => (type, props, key) => {
  if (type === "a" && props && props.href === "#estimate") estimateAnchors.push(props);
  return make(type, props, key);
};
export const Fragment = real.Fragment;
export const jsx = spy(real.jsx);
export const jsxs = spy(real.jsxs);
`;

/** Empaqueta `body` (código TypeScript que exporta lo que la prueba lee) con los alias del proyecto y devuelve el módulo. */
async function bundleModule(body: string, siteKey: string, spyJsx = false): Promise<Record<string, unknown>> {
  const out = await build({
    stdin: { contents: body, resolveDir: ROOT, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "node", jsx: "automatic", logLevel: "silent",
    alias: { "@": `${ROOT}/src` },
    plugins: spyJsx ? [{
      name: "jsx-spy",
      setup(b) {
        b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: "jsx-spy", namespace: "jsx-spy" }));
        b.onLoad({ filter: /.*/, namespace: "jsx-spy" }, () => ({ contents: JSX_SPY(ROOT), loader: "js", resolveDir: ROOT }));
      },
    }] : [],
    loader: { ".png": "dataurl", ".jpg": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".css": "empty" },
    define: { "import.meta.env.VITE_TURNSTILE_SITE_KEY": JSON.stringify(siteKey) },
    banner: { js: `import { createRequire as __cr } from "node:module"; const require = __cr(${JSON.stringify(pathToFileURL(`${ROOT}/x.js`).href)});` },
  });
  const code = out.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

/** Empaqueta `body` (código TypeScript que exporta `html`) con los alias del proyecto y devuelve ese `html`. */
async function bundleHtml(body: string, siteKey: string): Promise<string> {
  return (await bundleModule(body, siteKey)).html as string;
}

export async function renderEstimateFormHtml(siteKey = "1x00000000000000000000AA"): Promise<string> {
  return bundleHtml(`import React from "react";
import { renderToString } from "react-dom/server";
import EstimateForm from "@/components/custom-builds/EstimateForm";
export const html = renderToString(React.createElement(EstimateForm));`, siteKey);
}

/** El aviso previo a la hidratación, en el estado dado (ready = false es el HTML del servidor; true, la página ya hidratada). */
export async function renderLoadingNoticeHtml(ready: boolean, siteKey = "1x00000000000000000000AA"): Promise<string> {
  return bundleHtml(`import React from "react";
import { renderToString } from "react-dom/server";
import { LoadingNotice } from "@/components/custom-builds/EstimateForm";
export const html = renderToString(React.createElement(LoadingNotice, { ready: ${ready} }));`, siteKey);
}

/** La página /custom-builds completa, como la prerenderiza el build. */
export async function renderCustomBuildsHtml(siteKey = "1x00000000000000000000AA"): Promise<string> {
  return bundleHtml(`import React from "react";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import CustomBuilds from "@/pages/CustomBuilds";
export const html = renderToString(React.createElement(StaticRouter, { location: "/custom-builds" }, React.createElement(CustomBuilds)));`, siteKey);
}

/**
 * Los anclajes hacia #estimate de la página /custom-builds tal como React los crea al renderizar: su data-cta-location y su
 * manejador onClick, junto con el goToEstimate del propio EstimateForm (para comparar por identidad).
 */
export async function renderCustomBuildsAnchors(siteKey = "1x00000000000000000000AA"): Promise<{
  anchors: { cta: unknown; onClick: unknown }[]; goToEstimate: unknown;
}> {
  const mod = await bundleModule(`import React from "react";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import CustomBuilds from "@/pages/CustomBuilds";
import { goToEstimate } from "@/components/custom-builds/EstimateForm";
import { estimateAnchors } from "react/jsx-runtime";
renderToString(React.createElement(StaticRouter, { location: "/custom-builds" }, React.createElement(CustomBuilds)));
export const anchors = estimateAnchors.map((p) => ({ cta: p["data-cta-location"], onClick: p.onClick }));
export { goToEstimate };`, siteKey, true);
  return { anchors: mod.anchors as { cta: unknown; onClick: unknown }[], goToEstimate: mod.goToEstimate };
}
