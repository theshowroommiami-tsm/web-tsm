import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  bindEstimateCtaTracking, createLeadReporter, ctaLocationOf, LEAD_IDS_KEY, LEAD_IDS_MAX,
} from "../src/lib/cbDataLayer.ts";
import { postRequest } from "../src/lib/cbClient.ts";
import { renderCustomBuildsHtml } from "./helpers/render-form.ts";

const LEAD = "6f1c0a52-9a3e-4d0b-8f7c-2b5d4e1a9c33";
const OTHER = "0d9b7a14-5c2e-4f68-b1a3-7e8f90c2d4a5";

// ---- DOM mínimo para el listener delegado
type El = { getAttribute(n: string): string | null };
const el = (loc: string | null): El => ({ getAttribute: (n) => (n === "data-cta-location" ? loc : null) });
/** Un nodo hijo (ícono, span) cuyo closest resuelve al botón marcado. */
const child = (button: El | null) => ({ closest: (sel: string) => (sel === "[data-cta-location]" ? button : null) });

function fakeDocument() {
  const calls: { type: string; capture: boolean }[] = [];
  let handler: ((e: { target: unknown; preventDefault?: () => void }) => void) | null = null;
  return {
    calls,
    addEventListener(type: "click", fn: typeof handler, capture: boolean) { calls.push({ type, capture }); handler = fn; },
    click(target: unknown) {
      let prevented = false;
      handler?.({ target, preventDefault: () => { prevented = true; } });
      return { prevented };
    },
  };
}

// ---- almacenamiento
function memStore() {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}
const blocked = () => { throw new Error("SecurityError"); };

// ---- estimate_cta_click
test("estimate_cta_click: valores hero, after_projects y after_process; otro valor o ausente = unassigned", () => {
  assert.equal(ctaLocationOf("hero"), "hero");
  assert.equal(ctaLocationOf("after_projects"), "after_projects");
  assert.equal(ctaLocationOf("after_process"), "after_process"); // el tercero lo pidió Hikashi; ANL tiene que registrarlo
  for (const v of [null, undefined, "", "footer", "HERO", "hero ", "after_process "]) assert.equal(ctaLocationOf(v), "unassigned");
});

test("estimate_cta_click: un clic = una entrada exacta, en captura, sin preventDefault", () => {
  const doc = fakeDocument();
  const host: { dataLayer?: Record<string, unknown>[] } = {};
  bindEstimateCtaTracking(doc, host);
  assert.deepEqual(doc.calls, [{ type: "click", capture: true }]);

  const r1 = doc.click(child(el("hero")));
  assert.deepEqual(host.dataLayer, [{ event: "estimate_cta_click", service: "custom_builds", cta_location: "hero" }]);
  doc.click(child(el("after_projects")));
  doc.click(child(el(null)));       // atributo ausente en el elemento resuelto
  doc.click(child(el("nuevo")));    // valor que ANL no definió
  assert.deepEqual(host.dataLayer!.map((e) => e.cta_location), ["hero", "after_projects", "unassigned", "unassigned"]);
  for (const e of host.dataLayer!) assert.deepEqual(Object.keys(e).sort(), ["cta_location", "event", "service"]);
  assert.equal(r1.prevented, false);
});

test("estimate_cta_click: clics fuera de un botón marcado no emiten; conserva la capa existente", () => {
  const doc = fakeDocument();
  const prev = { event: "call_now_click", call_location: "header" };
  const host = { dataLayer: [prev] as Record<string, unknown>[] };
  bindEstimateCtaTracking(doc, host);
  doc.click(child(null));
  doc.click({});          // sin closest (nodo de texto, document)
  doc.click(null);
  assert.deepEqual(host.dataLayer, [prev]);
});

test("estimate_cta_click: idempotente ante remontaje y StrictMode (un solo listener, una sola entrada)", () => {
  const doc = fakeDocument();
  const host: { dataLayer?: Record<string, unknown>[] } = {};
  bindEstimateCtaTracking(doc, host);
  bindEstimateCtaTracking(doc, host);
  bindEstimateCtaTracking(doc, host);
  assert.equal(doc.calls.length, 1);
  doc.click(child(el("hero")));
  assert.equal(host.dataLayer!.length, 1);
});

// ---- generate_lead
const newHost = () => ({ dataLayer: [] as Record<string, unknown>[] });

test("generate_lead: 201 con medir true => una entrada con solo event, service y lead_id", () => {
  const host = newHost(); const store = memStore();
  const push = createLeadReporter(() => host, () => store);
  assert.equal(push(LEAD, true), true);
  assert.deepEqual(host.dataLayer, [{ event: "generate_lead", service: "custom_builds", lead_id: LEAD }]);
  assert.deepEqual(Object.keys(host.dataLayer[0]).sort(), ["event", "lead_id", "service"]);
  assert.deepEqual(JSON.parse(store.m.get(LEAD_IDS_KEY)!), [LEAD]);
});

test("generate_lead: inicializa window.dataLayer si no existe", () => {
  const host: { dataLayer?: Record<string, unknown>[] } = {};
  createLeadReporter(() => host, () => memStore())(LEAD, true);
  assert.equal(host.dataLayer!.length, 1);
});

test("generate_lead: mismo lead_id (replay con la misma clave) no vuelve a salir", () => {
  const host = newHost(); const push = createLeadReporter(() => host, () => memStore());
  assert.equal(push(LEAD, true), true);
  assert.equal(push(LEAD, true), false);
  assert.equal(host.dataLayer.length, 1);
  assert.equal(push(OTHER, true), true);
  assert.equal(host.dataLayer.length, 2);
});

test("generate_lead: medir distinto de true (posible duplicado) no emite ni registra el lead_id", () => {
  const host = newHost(); const store = memStore();
  const push = createLeadReporter(() => host, () => store);
  for (const medir of [false, undefined, null, "true", 1]) assert.equal(push(LEAD, medir), false);
  assert.equal(host.dataLayer.length, 0);
  assert.equal(store.m.size, 0);
});

test("generate_lead: lead_id ausente o que no es texto no emite", () => {
  const host = newHost(); const push = createLeadReporter(() => host, () => memStore());
  for (const id of [undefined, null, "", 0, 42, {}, [LEAD]]) assert.equal(push(id, true), false);
  assert.equal(host.dataLayer.length, 0);
});

test("generate_lead: 400, 403, 429, 500 y 503 del servidor no emiten; el 201 sí, y solo con medir true", async () => {
  const realFetch = globalThis.fetch;
  try {
    const host = newHost(); const push = createLeadReporter(() => host, () => memStore());
    const send = async (status: number, body: unknown) => {
      globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
      const o = await postRequest(LEAD, "tok", {}, 0);
      if (o.kind === "ok") push(o.leadId, o.medir); // mismo paso que EstimateForm
      return o.kind;
    };
    for (const s of [400, 403, 429, 500, 503]) assert.notEqual(await send(s, { lead_id: LEAD, medir: true }), "ok");
    assert.equal(host.dataLayer.length, 0);

    assert.equal(await send(201, { lead_id: OTHER, permiso: null, medir: false }), "ok");
    assert.equal(host.dataLayer.length, 0);
    assert.equal(await send(201, { lead_id: LEAD, permiso: null }), "ok"); // sin medir
    assert.equal(host.dataLayer.length, 0);

    assert.equal(await send(201, { lead_id: LEAD, permiso: "p.q", medir: true }), "ok");
    assert.deepEqual(host.dataLayer, [{ event: "generate_lead", service: "custom_builds", lead_id: LEAD }]);
    await send(201, { lead_id: LEAD, permiso: "p.q", medir: true }); // replay
    assert.equal(host.dataLayer.length, 1);
  } finally { globalThis.fetch = realFetch; }
});

test("generate_lead: recarga tras el envío no repite (localStorage); con localStorage bloqueado, una por carga", () => {
  const store = memStore(); const host = newHost();
  createLeadReporter(() => host, () => store)(LEAD, true);
  assert.equal(host.dataLayer.length, 1);
  // Recarga: Set nuevo, mismo localStorage.
  const reloaded = newHost();
  assert.equal(createLeadReporter(() => reloaded, () => store)(LEAD, true), false);
  assert.equal(reloaded.dataLayer.length, 0);

  // Bloqueado: rige el Set de la carga.
  const h1 = newHost(); const p1 = createLeadReporter(() => h1, blocked);
  assert.equal(p1(LEAD, true), true);
  assert.equal(p1(LEAD, true), false);
  assert.equal(h1.dataLayer.length, 1);
  const h2 = newHost(); // otra carga: puede duplicar [ER]; Ads deduplica con transaction_id
  assert.equal(createLeadReporter(() => h2, blocked)(LEAD, true), true);
});

test("generate_lead: setItem falla pero getItem sirve => rige el Set", () => {
  const host = newHost();
  const store = { getItem: () => null, setItem: blocked };
  const push = createLeadReporter(() => host, () => store);
  assert.equal(push(LEAD, true), true);
  assert.equal(push(LEAD, true), false);
});

test("generate_lead: lista de hasta 20, se descarta el más viejo; valor corrupto se trata como vacío", () => {
  const store = memStore(); const host = newHost();
  const push = createLeadReporter(() => host, () => store);
  const ids = Array.from({ length: LEAD_IDS_MAX + 1 }, (_, i) => `id-${i}`);
  ids.forEach((id) => push(id, true));
  const saved = JSON.parse(store.m.get(LEAD_IDS_KEY)!);
  assert.equal(saved.length, LEAD_IDS_MAX);
  assert.equal(saved[0], "id-1");
  assert.equal(saved.at(-1), `id-${LEAD_IDS_MAX}`);

  for (const bad of ["not json", "{\"a\":1}", "\"x\"", "[1,2,null]"]) {
    const s = memStore(); s.m.set(LEAD_IDS_KEY, bad);
    const h = newHost();
    assert.equal(createLeadReporter(() => h, () => s)(LEAD, true), true);
    assert.deepEqual(JSON.parse(s.m.get(LEAD_IDS_KEY)!), [LEAD]);
  }
});

// ---- código del flujo (anl-06 §3.5 g y h)
const flowFiles = ["src/lib/cbDataLayer.ts", "src/lib/cbClient.ts", "src/lib/cbSubmit.ts", "src/lib/cbFloatingCall.ts", "src/components/custom-builds/EstimateForm.tsx", "src/pages/CustomBuilds.tsx"];
const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

test("código del flujo: sin gtag(, gtag/js ni googleadservices; lead_id y folio no van a la URL", () => {
  for (const f of flowFiles) {
    const src = read(f);
    assert.doesNotMatch(src, /gtag\s*\(|gtag\/js|googleadservices/i, f);
    assert.doesNotMatch(src, /pushState|replaceState|location\.(href|hash|search)\s*=|location\.(assign|replace)\s*\(/, f);
  }
});

test("EstimateForm: generate_lead sale solo desde runSubmit (que lo prueba con dobles), nunca desde el componente", () => {
  const src = read("src/components/custom-builds/EstimateForm.tsx");
  assert.equal((src.match(/trackGenerateLead/g) ?? []).length, 2); // el import y la dependencia que se le pasa a runSubmit
  assert.match(src, /runSubmit\(/);
  assert.doesNotMatch(src, /trackGenerateLead\(/);
});

// Los botones se leen del HTML que renderiza la página de verdad (renderToString), no de su código fuente.
const ESTIMATE_BUTTON = "Request a Custom Build Estimate";

test("CustomBuilds: exactamente tres botones hacia #estimate, con hero, after_projects y after_process, en ese orden de la página", async () => {
  const html = await renderCustomBuildsHtml();
  const anchors = [...html.matchAll(/<a href="#estimate"([^>]*)>([\s\S]*?)<\/a>/g)];
  assert.equal(anchors.length, 3);
  assert.deepEqual(anchors.map((m) => /data-cta-location="([^"]*)"/.exec(m[1])?.[1]), ["hero", "after_projects", "after_process"]);
  for (const m of anchors) assert.ok(m[2].includes(ESTIMATE_BUTTON), "mismo texto en los tres");
  // y ninguna otra ancla de la página lleva data-cta-location (cada una emitiría un estimate_cta_click)
  assert.equal((html.match(/data-cta-location=/g) ?? []).length, 3);
});

test("CustomBuilds: el botón de Our Process va después de los cuatro pasos, dentro de la misma sección, centrado y con margen", async () => {
  const html = await renderCustomBuildsHtml();
  const from = html.indexOf("Our Process");
  assert.ok(from > 0);
  const section = html.slice(from, html.indexOf("</section>", from));
  const steps = ["Consultation", "Design", "Build", "Reveal"].map((t) => section.indexOf(`>${t}</h3>`));
  assert.ok(steps.every((i) => i > 0) && steps.every((i, n) => n === 0 || i > steps[n - 1]), "los cuatro pasos, en orden");
  const cta = section.indexOf('data-cta-location="after_process"');
  assert.ok(cta > steps[3], "el botón queda después del cuarto paso");
  assert.equal((section.match(/data-cta-location=/g) ?? []).length, 1); // y es el único de la sección
  const wrapper = /<div class="([^"]*)"><a href="#estimate"[^>]*data-cta-location="after_process"/.exec(section)?.[1].split(/\s+/) ?? [];
  assert.ok(wrapper.includes("text-center") && wrapper.includes("mt-12"), `contenedor: ${wrapper.join(" ")}`);
  const button = /data-cta-location="after_process"[^>]*><button class="([^"]*)"/.exec(section)?.[1] ?? "";
  for (const c of ["border-neon-cyan", "text-neon-cyan", "font-bold", "px-8", "py-4", "rounded-lg"]) assert.ok(button.split(/\s+/).includes(c), c);
  assert.doesNotMatch(button, /bg-gradient/); // outline, igual que el de después de los proyectos
});

test("CustomBuilds: cada uno de los tres clics empuja UN estimate_cta_click con su cta_location y solo service y cta_location", async () => {
  const html = await renderCustomBuildsHtml();
  const locs = [...html.matchAll(/<a href="#estimate"[^>]*data-cta-location="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(locs, ["hero", "after_projects", "after_process"]);
  const doc = fakeDocument();
  const host: { dataLayer?: Record<string, unknown>[] } = {};
  bindEstimateCtaTracking(doc, host);
  for (const [n, loc] of locs.entries()) {
    const r = doc.click(child(el(loc))); // el clic cae en el botón o en su texto: closest() resuelve al ancla marcada
    assert.equal(host.dataLayer!.length, n + 1, `un clic = una entrada (${loc})`);
    assert.deepEqual(host.dataLayer![n], { event: "estimate_cta_click", service: "custom_builds", cta_location: loc });
    assert.deepEqual(Object.keys(host.dataLayer![n]).sort(), ["cta_location", "event", "service"]);
    assert.equal(r.prevented, false);
  }
});
