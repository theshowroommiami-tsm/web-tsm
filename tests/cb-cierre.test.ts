// Cierre del código del PR web-tsm#24 (TRD-049): bloque A (lo que exige el requerimiento) y B (robustez).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BRANDS, MAX_LEN, OTHER_BRAND_MAX, brandToSend, normalizeOrigin, otherBrandError, validateRequest,
} from "../shared/cb-schema.ts";
import {
  ATTRIBUTION_KEY, ATTRIBUTION_TTL_MS, captureAttribution, loadAttribution, mergeAttribution, recordAttribution,
  sanitizeAttribution, saveAttribution, type Attribution,
} from "../shared/cb-attribution.ts";
import { CB_CONFIRMATION, CB_INTRO, CB_NOTICES, CB_PRICE_NOTE } from "../src/lib/cbCopy.ts";
import { handlePhotoUrls, handlePhotosDone, handleRequest, type Deps, type R2Client } from "../netlify/lib/handlers.ts";
import { signPermit } from "../netlify/lib/permit.ts";
import { depsFromEnv, R2_BUCKETS } from "../netlify/lib/env.ts";

const KEY = "3b1f5c2e-8d4a-4b7e-9a21-5f6c7d8e9a0b";
const NOW = 1_800_000_000;
const valid = { nombre: "Ana", telefono: "+13055550123", correo: "ana@example.com", marca: "BMW", modelo: "M3", anio: "2020", zona: "33101", servicio: "Full build", descripcion: "Widebody kit" };
const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const FORM = read("src/components/custom-builds/EstimateForm.tsx");

// ---- A1 · marcas

test("A1: BRANDS es exactamente la lista aprobada por Hikashi, con Other al final", () => {
  assert.deepEqual([...BRANDS], [
    "Porsche", "Mercedes-Benz", "BMW", "Land Rover / Range Rover", "Rolls-Royce", "Bentley", "Bugatti",
    "McLaren", "Ferrari", "Lamborghini", "Aston Martin", "Lexus", "Maserati", "Other",
  ]);
  assert.equal(BRANDS.length, 14);
  assert.equal(BRANDS[BRANDS.length - 1], "Other");
  assert.equal(BRANDS.filter((b) => b.startsWith("Land Rover")).length, 1); // una sola opción
  for (const gone of ["Audi", "Chevrolet", "Dodge", "Ford", "Jeep", "Tesla", "Land Rover"]) assert.ok(!BRANDS.includes(gone as never), gone);
});

test("A1: cada marca de la lista cabe en el contrato (MAX_LEN.marca) y valida", () => {
  for (const marca of BRANDS) {
    assert.ok(marca.length <= MAX_LEN.marca, marca);
    assert.equal(validateRequest({ ...valid, marca }).ok, true, marca);
  }
});

// ---- A2 · Other

test("A2: con Other la marca que viaja es 'Other: <texto>' y 'Which make?' es obligatorio (máximo 50)", () => {
  assert.equal(brandToSend("Other", "  Pagani  "), "Other: Pagani");
  assert.equal(brandToSend("Other", "De   Tomaso"), "Other: De Tomaso"); // aplana espacios como el resto de los campos
  assert.equal(brandToSend("Other", ""), "Other");
  assert.equal(brandToSend("BMW", "Pagani"), "BMW"); // sin Other, el texto auxiliar se ignora
  assert.equal(brandToSend("", "Pagani"), "");

  assert.equal(otherBrandError("Other", ""), "Enter the make.");
  assert.equal(otherBrandError("Other", "   "), "Enter the make.");
  assert.equal(otherBrandError("Other", "Pagani"), "");
  assert.equal(otherBrandError("Other", "x".repeat(OTHER_BRAND_MAX)), "");
  assert.equal(otherBrandError("Other", "x".repeat(OTHER_BRAND_MAX + 1)), `Maximum ${OTHER_BRAND_MAX} characters.`);
  assert.equal(otherBrandError("BMW", ""), "");
  assert.equal(OTHER_BRAND_MAX, 50);

  // 7 + 50 caracteres caben en el contrato sin cambiarlo: lo que viaja valida
  const maxima = brandToSend("Other", "x".repeat(OTHER_BRAND_MAX));
  assert.equal(maxima.length, 57);
  assert.ok(maxima.length <= MAX_LEN.marca);
  assert.equal(validateRequest({ ...valid, marca: maxima }).ok, true);
});

test("A2: EstimateForm pide la marca con Other, la deja en el borrador y en el orden de foco de errores", () => {
  assert.match(FORM, /fields\.marca === OTHER_BRAND/);
  assert.match(FORM, /k="marca_otra" label="Which make\?" required/);
  assert.match(FORM, /FIELD_ORDER = \["nombre", "telefono", "correo", "marca", "marca_otra", "modelo"/);
  assert.match(FORM, /brandToSend\(fields\.marca/);
  assert.match(FORM, /delete raw\.marca_otra/); // el campo auxiliar no viaja: el contrato no cambia
  assert.match(FORM, /maxLength: k === "marca_otra" \? OTHER_BRAND_MAX/);
  // el borrador (set -> saveDraft) guarda todos los campos de `fields`, marca_otra incluido
  assert.match(FORM, /const next = \{ \.\.\.prev, \[k\]: v \};[\s\S]*?saveDraft\(\{ fields: next/);
});

// ---- A3 · textos

test("A3: los textos exactos del requerimiento", () => {
  assert.equal(CB_INTRO, "Tell us about your vehicle and the custom work you have in mind. Our team will review your request and contact you to discuss your project.");
  assert.equal(CB_CONFIRMATION, "Your request has been received. Our team will contact you to discuss your project.");
  assert.equal(CB_PRICE_NOTE, "Final pricing depends on the scope of work, the materials selected and an evaluation of your vehicle. Submitting this form sends a request; it is not a final quote or a confirmed appointment.");
});

test("A3: EstimateForm muestra esos textos y no promete 'one business day'", () => {
  assert.match(FORM, /\{CB_INTRO\}/);
  assert.match(FORM, /\{CB_PRICE_NOTE\}/);
  assert.match(FORM, /<p className="text-gray-300">\{CB_CONFIRMATION\}<\/p>/);
  for (const f of ["src/components/custom-builds/EstimateForm.tsx", "src/pages/CustomBuilds.tsx", "src/lib/cbCopy.ts"]) {
    assert.doesNotMatch(read(f), /business day/i, f);
    assert.doesNotMatch(read(f), /within one/i, f);
  }
  for (const text of [CB_INTRO, CB_PRICE_NOTE, CB_CONFIRMATION, ...Object.values(CB_NOTICES).map((n) => n.text)]) {
    assert.doesNotMatch(text, /business day|24 hours|same day|within \d/i, text);
  }
});

// ---- A4 · origen desconocido

test("A4: sin atribución el origen es 'unknown'; el navegador no lo decide", () => {
  const sin = validateRequest(valid);
  assert.ok(sin.ok && sin.data.origen === "unknown");

  // dice google_ads pero no hay click_id: nada se atribuye a Google Ads
  const falso = validateRequest({ ...valid, origen: "google_ads" });
  assert.ok(falso.ok && falso.data.origen === "unknown");
  // dice google_ads con evidencia de UTM: es utm
  const utm = validateRequest({ ...valid, origen: "google_ads", utm_source: "ig" });
  assert.ok(utm.ok && utm.data.origen === "utm");
  // dice utm sin UTM pero con referrer: es referral
  const ref = validateRequest({ ...valid, origen: "utm", referrer: "www.google.com" });
  assert.ok(ref.ok && ref.data.origen === "referral");
  // dice unknown pero trae un click_id completo: es google_ads
  const real = validateRequest({ ...valid, origen: "unknown", click_id_tipo: "gclid", click_id: "abc123" });
  assert.ok(real.ok && real.data.origen === "google_ads");
  // la precedencia es google_ads > utm > referral
  const todo = validateRequest({ ...valid, click_id_tipo: "wbraid", click_id: "w1", utm_campaign: "c", referrer: "x.com" });
  assert.ok(todo.ok && todo.data.origen === "google_ads");
  // un valor fuera de la lista sigue siendo error
  assert.equal(validateRequest({ ...valid, origen: "otro" }).ok, false);
});

test("A4: un click_id sin click_id_tipo (o al revés) se descarta", () => {
  const solo = validateRequest({ ...valid, click_id: "abc123", utm_source: "ig" });
  assert.ok(solo.ok);
  assert.ok(!("click_id" in solo.data) && !("click_id_tipo" in solo.data));
  assert.equal(solo.data.origen, "utm"); // sin click_id completo no es google_ads

  const soloTipo = validateRequest({ ...valid, click_id_tipo: "gclid" });
  assert.ok(soloTipo.ok);
  assert.ok(!("click_id_tipo" in soloTipo.data));
  assert.equal(soloTipo.data.origen, "unknown");

  const d: Record<string, string> = { click_id: "x", origen: "google_ads" };
  normalizeOrigin(d);
  assert.deepEqual(d, { origen: "unknown" });
});

function mkR2(files: Record<string, Uint8Array> = {}): R2Client & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    presignPut: async (k, s) => `https://r2.example/${k}?size=${s}`,
    head: async (k) => (files[k] ? { size: files[k].length } : null),
    firstBytes: async (k) => files[k]?.slice(0, 3) ?? null,
    remove: async (k) => { removed.push(k); delete files[k]; },
  };
}
const REPLY = { ok: true, replay: false, lead_id: "L-1", folio: "TEST-0001", carpeta: "solicitudes/TEST-0001-aaaaaaaa/", duplicado: false, fotos_esperadas: 2 };
type ReceptorCall = { accion: string; entorno: string; datos: Record<string, unknown> };
function mkDeps(over: Partial<Deps> = {}): Deps & { calls: ReceptorCall[]; logs: string[] } {
  const calls: ReceptorCall[] = [];
  const logs: string[] = [];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    if (String(url).includes("turnstile")) return new Response(JSON.stringify({ success: true }));
    calls.push(JSON.parse(JSON.parse(init.body).payload));
    return new Response(JSON.stringify(REPLY));
  }) as unknown as typeof fetch;
  return { entorno: "preview", permitSecret: "ps", receptor: { url: "https://rec", secret: "cd".repeat(32) }, r2: () => mkR2(), fetchImpl, now: () => NOW, log: (m) => logs.push(m), calls, logs, ...over };
}
const post = (body: unknown) => new Request("https://x/api", { method: "POST", body: JSON.stringify(body) });
const reqBody = { clave: KEY, token: "tok", campos: valid, fotos_esperadas: 2 };

test("A4: cb-request manda 'unknown' al receptor cuando falta el origen, y recalcula el que declara el navegador", async () => {
  const d = mkDeps();
  assert.equal((await handleRequest(post(reqBody), d)).status, 201);
  assert.equal(d.calls[0].datos.origen, "unknown");

  const falso = mkDeps();
  await handleRequest(post({ ...reqBody, campos: { ...valid, origen: "google_ads", click_id: "sin-tipo" } }), falso);
  assert.equal(falso.calls[0].datos.origen, "unknown");
  assert.ok(!("click_id" in falso.calls[0].datos));

  const real = mkDeps();
  await handleRequest(post({ ...reqBody, campos: { ...valid, click_id_tipo: "gclid", click_id: "Cj0KCQ-abc" } }), real);
  assert.equal(real.calls[0].datos.origen, "google_ads");
  assert.equal(real.calls[0].datos.click_id, "Cj0KCQ-abc");
});

// ---- A5 · estado, errores y accesibilidad

test("A5: el estado y los errores van dentro del formulario, junto al botón, con role='alert'", () => {
  const form = FORM.slice(FORM.indexOf("<form "), FORM.indexOf("</form>"));
  assert.match(form, /role="alert"/);
  assert.match(form, /role="status" aria-live="polite"/);
  assert.match(form, /CB_SENDING/);
  assert.match(form, /CB_UPLOADING/);
  const iAlert = form.indexOf('role="alert"');
  const iButton = form.indexOf("<Button ");
  assert.ok(iAlert > 0 && iAlert < iButton, "el aviso queda justo antes del botón de enviar");
  assert.ok(form.indexOf("<div ref={tsEl} />") < iAlert, "y después del widget de seguridad");
  // y no queda una región de estado fuera del formulario, arriba
  assert.ok(!FORM.slice(0, FORM.indexOf("<form ")).includes("aria-live=\"polite\" role=\"status\""));
  // un fallo lleva el aviso a la vista
  assert.match(FORM, /noticeRef\.current\?\.scrollIntoView\(\{ block: "center"/);
});

test("A5: al terminar con éxito el foco va a la confirmación (role='status'), no al encabezado", () => {
  assert.match(FORM, /ref=\{doneRef\} tabIndex=\{-1\} role="status"/);
  assert.match(FORM, /if \(status === "done"\) doneRef\.current\?\.focus\(\)/);
  const submit = FORM.slice(FORM.indexOf("const onSubmit"), FORM.indexOf("const busy ="));
  assert.doesNotMatch(submit, /ESTIMATE_HEADING_ID/); // ya no enfoca el h2 antes de que exista la tarjeta
});

test("A5: los obligatorios se exponen a tecnologías de apoyo y teléfono y correo no dicen '(optional)'", () => {
  for (const k of ["nombre", "telefono", "correo", "modelo", "anio", "zona", "descripcion"]) {
    assert.match(FORM, new RegExp(`common\\("${k}", true\\)`), k);
  }
  assert.match(FORM, /select\("marca", BRANDS, true\)/);
  assert.match(FORM, /select\("servicio", SERVICES, true\)/);
  assert.match(FORM, /common\("marca_otra", true\)/);
  assert.match(FORM, /"aria-required": required \? true : undefined/);
  assert.match(FORM, /k="telefono" label="Phone" required>/);
  assert.match(FORM, /k="correo" label="Email" required>/);
  // lo opcional sigue sin aria-required
  assert.match(FORM, /select\("presupuesto", BUDGETS\)/);
  assert.match(FORM, /select\("plazo", TIMELINES\)/);
});

// ---- A6 · salida clara con el teléfono

test("A6: cupo, error y 'security check' llevan el teléfono de business.ts como enlace de llamada", () => {
  for (const kind of ["wait", "tserror", "nokey", "quota", "error"] as const) assert.equal(CB_NOTICES[kind].phone, true, kind);
  for (const kind of ["turnstile", "invalid", "retry", "fields", "photos", "photos_lost"] as const) assert.equal(CB_NOTICES[kind].phone, false, kind);
  assert.match(FORM, /import \{ BUSINESS_PHONE_DISPLAY, BUSINESS_PHONE_HREF \} from "@\/config\/business"/);
  assert.match(FORM, /<a href=\{BUSINESS_PHONE_HREF\} data-call-location="page_body"/);
  assert.match(FORM, />\s*\{BUSINESS_PHONE_DISPLAY\}\s*<\/a>/);
  // el número solo sale de @/config/business: ni el formulario ni los textos lo escriben a mano
  for (const f of ["src/components/custom-builds/EstimateForm.tsx", "src/lib/cbCopy.ts"]) {
    assert.doesNotMatch(read(f), /305[-. )]*419[-. ]*8379|3054198379/, f);
  }
  assert.match(read("src/config/business.ts"), /BUSINESS_PHONE_DISPLAY = "305-419-8379"/);
});

test("A6: el error-callback de Turnstile y la falta de la Site Key muestran un aviso explícito", () => {
  assert.match(FORM, /"error-callback": \(\) => \{ setToken\(""\); showNotice\("tserror", false\); \}/);
  assert.match(FORM, /s\.addEventListener\("error", onLoadError\)/); // el script bloqueado también avisa
  assert.match(FORM, /if \(!SITE_KEY\) \{\s*console\.error\("VITE_TURNSTILE_SITE_KEY is missing/);
  assert.match(FORM, /showNotice\("nokey", false\)/);
  assert.match(FORM, /showNotice\(SITE_KEY \? "wait" : "nokey"\)/); // sin Site Key: aviso propio, no el genérico
  assert.match(CB_NOTICES.tserror.text, /^The security check couldn't load\. Please reload the page or call us at$/);
});

// ---- A7 · móvil

test("A7: campos de 44 px, 16 px de letra y márgenes de desplazamiento; el botón de quitar foto es de 32 px dentro de la miniatura", () => {
  const cls = FORM.match(/const inputCls =\s*"([^"]+)"/)?.[1] ?? "";
  for (const c of ["min-h-11", "text-base", "scroll-mt-32", "scroll-mb-28"]) assert.ok(cls.split(" ").includes(c), c);
  assert.match(FORM, /absolute top-1 right-1 h-8 w-8 rounded-full/);
  assert.doesNotMatch(FORM, /-top-2 -right-2/);
  assert.doesNotMatch(FORM, /h-6 w-6/);
  // el aviso de estado también deja margen bajo la barra fija y sobre CALL NOW
  assert.match(FORM, /ref=\{noticeRef\} className="scroll-mt-32 scroll-mb-28/);
});

test("A7: Turnstile elige el widget compacto cuando el espacio es menor a 300 px y se redibuja al girar", () => {
  assert.match(FORM, /TURNSTILE_NORMAL_WIDTH = 300/);
  assert.match(FORM, /return w > 0 && w < TURNSTILE_NORMAL_WIDTH \? "compact" : "normal"/);
  assert.match(FORM, /sitekey: SITE_KEY, action: "cb_request", size,/);
  assert.match(FORM, /new ResizeObserver/);
  assert.match(FORM, /window\.turnstile\.remove\(tsId\.current\)/);
});

test("A7: FloatingCallButton no se toca", () => {
  assert.match(read("src/components/FloatingCallButton.tsx"), /fixed bottom-6 right-6 z-50/);
});

// ---- A8 · configuración que falla cerrado

const permit = signPermit({ lead_id: "L-1", carpeta: "solicitudes/TEST-0001-aaaaaaaa/", n_max: 2, exp: NOW + 900 }, "ps");

test("A8: sin CB_ENTORNO válido las tres Functions responden 500 con alerta que nombra la variable", async () => {
  for (const entorno of [null, "" as never, "Production" as never, "prod" as never]) {
    const d = mkDeps({ entorno });
    assert.equal((await handleRequest(post(reqBody), d)).status, 500, String(entorno));
    assert.equal((await handlePhotoUrls(post({ permiso: permit, fotos: [{ n: 1, size: 10 }] }), d)).status, 500);
    assert.equal((await handlePhotosDone(post({ permiso: permit, fotos: [{ n: 1 }] }), d)).status, 500);
    assert.equal(d.calls.length, 0); // ni Turnstile de prueba ni receptor
    assert.equal(d.logs.length, 3);
    for (const l of d.logs) assert.match(l, /^CB_ALERT config fn=cb-[a-z-]+ missing=.*CB_ENTORNO/);
  }
});

test("A8: producción exige TURNSTILE_SECRET_KEY, y el aviso lista nombres, nunca valores", async () => {
  const d = mkDeps({ entorno: "production", permitSecret: "SECRETO-NO-LOGUEAR", receptor: { url: "", secret: "OTRO-SECRETO" } });
  const res = await handleRequest(post(reqBody), d);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "config" });
  assert.equal(d.logs.length, 1);
  assert.equal(d.logs[0], "CB_ALERT config fn=cb-request missing=RECEPTOR_URL,TURNSTILE_SECRET_KEY");
  assert.ok(!d.logs[0].includes("SECRETO") && !d.logs[0].includes("OTRO"));
});

test("A8: las R2_* entran en la comprobación de las Functions de fotos, no en la de cb-request", async () => {
  const r2Missing = ["R2_ACCESS_KEY_ID", "R2_BUCKET(entorno)"];
  const d = mkDeps({ r2Missing });
  const urls = await handlePhotoUrls(post({ permiso: permit, fotos: [{ n: 1, size: 10 }] }), d);
  assert.equal(urls.status, 500);
  assert.deepEqual(await urls.json(), { error: "config" });
  assert.equal((await handlePhotosDone(post({ permiso: permit, fotos: [{ n: 1 }] }), d)).status, 500);
  assert.deepEqual(d.logs, [
    "CB_ALERT config fn=cb-photo-urls missing=R2_ACCESS_KEY_ID,R2_BUCKET(entorno)",
    "CB_ALERT config fn=cb-photos-done missing=R2_ACCESS_KEY_ID,R2_BUCKET(entorno)",
  ]);
  // la solicitud (y su lead) no se pierde por un R2 mal configurado: las fotos son opcionales
  assert.equal((await handleRequest(post(reqBody), d)).status, 201);
});

test("A8: d.r2() corre dentro del try: si lanza, 503 reintentable y no una excepción sin cuerpo", async () => {
  const boom = mkDeps({ r2: () => { throw new TypeError("accessKeyId is a required option"); } });
  const urls = await handlePhotoUrls(post({ permiso: permit, fotos: [{ n: 1, size: 10 }] }), boom);
  assert.equal(urls.status, 503);
  assert.deepEqual(await urls.json(), { error: "unavailable" });
  const done = await handlePhotosDone(post({ permiso: permit, fotos: [{ n: 1 }] }), boom);
  assert.equal(done.status, 503);
});

function withNetlifyEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const g = globalThis as { Netlify?: unknown };
  const had = g.Netlify;
  g.Netlify = { env: { get: (k: string) => vars[k] } };
  try { return fn(); } finally { if (had === undefined) delete g.Netlify; else g.Netlify = had; }
}
const FULL = {
  CB_PERMIT_SECRET: "p", RECEPTOR_URL: "https://r", RECEPTOR_SECRET: "s", TURNSTILE_SECRET_KEY: "t",
  R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "x",
};

test("A8: depsFromEnv acepta solo 'production' o 'preview' exactos y deja el entorno en null con cualquier otro valor", () => {
  const cases: [string | undefined, string | null][] = [
    ["production", "production"], ["preview", "preview"],
    [undefined, null], ["", null], ["Production", null], ["PREVIEW", null], ["prod", null], [" production", null], ["development", null],
  ];
  for (const [value, want] of cases) {
    const d = withNetlifyEnv({ ...FULL, ...(value === undefined ? {} : { CB_ENTORNO: value }), R2_BUCKET: R2_BUCKETS.preview }, depsFromEnv);
    assert.equal(d.entorno, want, String(value));
  }
});

test("A8: el bucket tiene que corresponder al entorno (production con form-custom-builds, preview con form-custom-builds-preview)", () => {
  assert.deepEqual(R2_BUCKETS, { production: "form-custom-builds", preview: "form-custom-builds-preview" });
  const missing = (CB_ENTORNO: string, R2_BUCKET: string | undefined) =>
    withNetlifyEnv({ ...FULL, CB_ENTORNO, ...(R2_BUCKET === undefined ? {} : { R2_BUCKET }) }, depsFromEnv).r2Missing;
  assert.deepEqual(missing("production", "form-custom-builds"), []);
  assert.deepEqual(missing("preview", "form-custom-builds-preview"), []);
  assert.deepEqual(missing("production", "form-custom-builds-preview"), ["R2_BUCKET(entorno)"]); // cruce de contextos
  assert.deepEqual(missing("preview", "form-custom-builds"), ["R2_BUCKET(entorno)"]);
  assert.deepEqual(missing("production", "otro-bucket"), ["R2_BUCKET(entorno)"]);
  assert.deepEqual(missing("production", undefined), ["R2_BUCKET"]);
  const sinR2 = withNetlifyEnv({ CB_ENTORNO: "preview" }, depsFromEnv).r2Missing;
  assert.deepEqual(sinR2, ["R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]);
});

// ---- A9 · atribución

const mem = () => {
  const m = new Map<string, string>();
  return { m, store: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } };
};
const GADS: Attribution = { origen: "google_ads", click_id_tipo: "gclid", click_id: "Cj0KCQ-lunes", utm_source: "google", aterrizaje: "/custom-builds" };
const UTM: Attribution = { origen: "utm", utm_source: "ig", utm_campaign: "spring", aterrizaje: "/custom-builds" };
const REF: Attribution = { origen: "referral", referrer: "www.google.com", aterrizaje: "/custom-builds" };
const stored = (m: Map<string, string>) => JSON.parse(m.get(ATTRIBUTION_KEY)!) as { savedAt: number; data: Attribution };

test("A9: loadAttribution reconstruye el objeto o devuelve null; una atribución guardada no invalida el envío", () => {
  const put = (data: unknown, savedAt = 1000) => { const x = mem(); x.m.set(ATTRIBUTION_KEY, JSON.stringify({ savedAt, data })); return x.store; };
  // válida: solo claves conocidas (las extras se descartan)
  assert.deepEqual(loadAttribution(put({ ...GADS, extra: "x", __proto__: { a: 1 } }), 2000), GADS);
  // un utm_term largo (lo que hoy bloquea al usuario) -> null, y la solicitud valida igual
  const largo = put({ ...UTM, utm_term: "x".repeat(MAX_LEN.utm_term + 1) });
  assert.equal(loadAttribution(largo, 2000), null);
  const a = loadAttribution(largo, 2000);
  assert.equal(validateRequest({ ...valid, ...(a ?? {}) }).ok, true);
  // cada forma inválida
  const malas: unknown[] = [
    null, "texto", 42, [], {}, { origen: "otro", utm_source: "x" }, { origen: "unknown", referrer: "x.com" },
    { ...UTM, utm_source: 5 }, { ...UTM, utm_medium: ["a"] }, { ...UTM, utm_campaign: "c".repeat(MAX_LEN.utm_campaign + 1) },
    { ...REF, referrer: "r".repeat(MAX_LEN.referrer + 1) }, { ...REF, aterrizaje: "a".repeat(MAX_LEN.aterrizaje + 1) },
    { ...GADS, click_id_tipo: "fbclid" }, { ...GADS, click_id: "i".repeat(MAX_LEN.click_id + 1) },
    { ...GADS, click_id: undefined }, { origen: "google_ads", click_id: "solo-id" },
    { origen: "google_ads", utm_source: "x" }, { origen: "utm" }, { origen: "referral" },
  ];
  for (const bad of malas) {
    const store = put(bad);
    assert.equal(loadAttribution(store, 2000), null, JSON.stringify(bad));
    const campos = { ...valid, ...(loadAttribution(store, 2000) ?? {}) };
    assert.equal(validateRequest(campos).ok, true, `no debe invalidar el envío: ${JSON.stringify(bad)}`);
  }
  // JSON roto y fecha inválida
  const x = mem(); x.m.set(ATTRIBUTION_KEY, "{no es json");
  assert.equal(loadAttribution(x.store, 2000), null);
  assert.equal(loadAttribution(put(GADS, "ayer" as never), 2000), null);
  // un valor válido en el borde del largo se conserva
  const borde = { ...UTM, utm_term: "t".repeat(MAX_LEN.utm_term) };
  assert.equal(loadAttribution(put(borde), 2000)?.utm_term?.length, MAX_LEN.utm_term);
  assert.equal(sanitizeAttribution(REF)?.referrer, "www.google.com");
});

test("A9: una señal más débil no pisa una más fuerte vigente (google_ads 3, utm 2, referral 1)", () => {
  assert.equal(mergeAttribution(GADS, REF), GADS);
  assert.equal(mergeAttribution(GADS, UTM), GADS);
  assert.equal(mergeAttribution(UTM, REF), UTM);
  assert.equal(mergeAttribution(null, REF), REF);
  // igual o mayor rango: la nueva
  const otroGclid = { ...GADS, click_id: "Cj0KCQ-miercoles" };
  assert.equal(mergeAttribution(GADS, otroGclid), otroGclid);
  assert.equal(mergeAttribution(UTM, { ...UTM, utm_source: "tt" }).utm_source, "tt");
  assert.equal(mergeAttribution(REF, UTM), UTM);
  assert.equal(mergeAttribution(UTM, GADS), GADS);
  assert.equal(mergeAttribution(REF, { ...REF, referrer: "bing.com" }).referrer, "bing.com");
});

test("A9: recordAttribution guarda sin pisar lo más fuerte y renueva savedAt solo cuando reemplaza", () => {
  const t0 = 1_000_000;

  // gclid el lunes y referral de Google el miércoles: conserva el gclid y NO renueva savedAt
  let s = mem();
  assert.deepEqual(recordAttribution(s.store, GADS, t0), GADS);
  assert.deepEqual(recordAttribution(s.store, REF, t0 + 2 * 86_400_000), GADS); // devuelve lo guardado, reconstruido
  assert.deepEqual(stored(s.m), { savedAt: t0, data: GADS });

  // gclid y luego utm: conserva el gclid
  s = mem(); recordAttribution(s.store, GADS, t0);
  assert.deepEqual(recordAttribution(s.store, UTM, t0 + 1000), GADS);
  assert.equal(stored(s.m).data.click_id, "Cj0KCQ-lunes");

  // gclid y luego otro gclid: el nuevo, con savedAt renovado
  s = mem(); recordAttribution(s.store, GADS, t0);
  const otro = { ...GADS, click_id: "Cj0KCQ-miercoles" };
  assert.equal(recordAttribution(s.store, otro, t0 + 5000), otro);
  assert.deepEqual(stored(s.m), { savedAt: t0 + 5000, data: otro });

  // utm y luego referral: conserva utm
  s = mem(); recordAttribution(s.store, UTM, t0);
  assert.deepEqual(recordAttribution(s.store, REF, t0 + 1000), UTM);
  assert.equal(stored(s.m).savedAt, t0);

  // utm y luego otro utm: reemplaza y renueva
  s = mem(); recordAttribution(s.store, UTM, t0);
  const utm2 = { ...UTM, utm_source: "tt" };
  recordAttribution(s.store, utm2, t0 + 1000);
  assert.deepEqual(stored(s.m), { savedAt: t0 + 1000, data: utm2 });

  // referral y luego utm, y utm y luego gclid: sube
  s = mem(); recordAttribution(s.store, REF, t0);
  recordAttribution(s.store, UTM, t0 + 1);
  assert.equal(stored(s.m).data.origen, "utm");
  recordAttribution(s.store, GADS, t0 + 2);
  assert.equal(stored(s.m).data.origen, "google_ads");

  // referral y luego otro referral: reemplaza
  s = mem(); recordAttribution(s.store, REF, t0);
  recordAttribution(s.store, { ...REF, referrer: "bing.com" }, t0 + 1);
  assert.equal(stored(s.m).data.referrer, "bing.com");

  // el gclid vencido (más de 90 días) ya no protege: el referral nuevo lo reemplaza
  s = mem(); recordAttribution(s.store, GADS, t0);
  assert.equal(recordAttribution(s.store, REF, t0 + ATTRIBUTION_TTL_MS + 1), REF);
  assert.equal(stored(s.m).data.origen, "referral");

  // lo guardado era basura: no estorba, se reemplaza
  s = mem(); s.m.set(ATTRIBUTION_KEY, JSON.stringify({ savedAt: t0, data: { origen: "utm", utm_term: "x".repeat(500) } }));
  assert.equal(recordAttribution(s.store, REF, t0 + 1), REF);

  // almacenamiento que lanza: no revienta
  const roto = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
  assert.doesNotThrow(() => recordAttribution(roto, REF, t0));
});

test("A9: la recarga completa con referrer externo en la misma sesión no pisa el gclid", () => {
  const s = mem();
  const t0 = 5_000_000;
  // aterrizaje desde el anuncio
  const landing = captureAttribution("?gclid=Cj0KCQ-abc&utm_source=google&utm_medium=cpc", "/custom-builds", "https://www.google.com/", "showroommiami.com")!;
  assert.equal(landing.origen, "google_ads");
  recordAttribution(s.store, landing, t0);
  // navegación interna (Link) borra la query; luego una recarga completa conserva el referrer de Google
  const reload = captureAttribution("", "/custom-builds", "https://www.google.com/", "showroommiami.com")!;
  assert.equal(reload.origen, "referral");
  assert.equal(recordAttribution(s.store, reload, t0 + 600_000).origen, "google_ads");
  assert.equal(loadAttribution(s.store, t0 + 600_001)?.click_id, "Cj0KCQ-abc");
  assert.equal(stored(s.m).savedAt, t0);
  // una visita sin ninguna señal sigue sin guardar nada
  assert.equal(captureAttribution("", "/", "", "showroommiami.com"), null);
});

test("A9: la atribución guardada se aplica con recordAttribution al aterrizar, no con saveAttribution directo", () => {
  const src = read("src/lib/cbAttribution.ts");
  assert.match(src, /recordAttribution\(window\.localStorage, a\)/);
  assert.doesNotMatch(src, /\bsaveAttribution\(/);
  // y saveAttribution sigue disponible para el almacenamiento puro
  const s = mem(); saveAttribution(s.store, UTM, 7);
  assert.equal(stored(s.m).savedAt, 7);
});
