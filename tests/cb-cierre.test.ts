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
import { turnstileSizeFor } from "../src/lib/cbSubmit.ts";
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
  assert.match(FORM, /const next = \{ \.\.\.prev, \[k\]: v \};[\s\S]*?saveDraft\(draftOf\(next, sessionRef\.current\)\)/);
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
  // y no queda una región de estado (aria-live o role=status) fuera del formulario, sea cual sea el orden de los atributos;
  // la tarjeta de confirmación (role=status con tabIndex) es la única excepción, porque reemplaza al formulario
  const fuera = (FORM.slice(0, FORM.indexOf("<form ")) + FORM.slice(FORM.indexOf("</form>"))).split("\n")
    .filter((l) => /aria-live|role="status"/.test(l) && !/tabIndex=\{-1\}/.test(l) && !/id="cb-fotos-msg"/.test(l) && !/CB_|preparing/.test(l));
  assert.deepEqual(fuera.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)), []);
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

test("A6: todo aviso de fallo (cupo, error, security check, 403, 400, retry) lleva el teléfono de business.ts como enlace de llamada", () => {
  for (const kind of ["wait", "tserror", "nokey", "quota", "error", "retry", "turnstile", "invalid"] as const) assert.equal(CB_NOTICES[kind].phone, true, kind);
  for (const kind of ["fields", "photos", "photos_lost"] as const) assert.equal(CB_NOTICES[kind].phone, false, kind); // no son un fallo del envío
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
  assert.match(CB_NOTICES.tserror.text, /^The security check couldn't load\. Please reload the page, or call us at$/);
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
  assert.equal(turnstileSizeFor(238), "compact"); // 320 px de pantalla
  assert.equal(turnstileSizeFor(294), "compact"); // 360 px
  assert.equal(turnstileSizeFor(299), "compact");
  assert.equal(turnstileSizeFor(300), "normal");
  assert.equal(turnstileSizeFor(518), "normal");  // escritorio
  assert.equal(turnstileSizeFor(0), "normal");    // sin medir
  assert.match(FORM, /turnstileSizeFor\(tsEl\.current\?\.clientWidth \?\? 0\)/);
  assert.match(FORM, /sitekey: SITE_KEY, action: "cb_request", size,/);
  assert.match(FORM, /new ResizeObserver/);
  assert.match(FORM, /window\.turnstile\.remove\(tsId\.current\)/);
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
    [undefined, null], ["", null], ["Production", null], ["PREVIEW", null], ["prod", null], ["development", null],
    [" production", "production"], ["production\n", "production"], ["\tpreview ", "preview"], // trim(): el valor que se quiso cargar
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
  const conProto = { savedAt: 1000, data: { ...GADS, extra: "x" } };
  const px = mem();
  px.m.set(ATTRIBUTION_KEY, JSON.stringify(conProto).replace('"extra":"x"', '"extra":"x","__proto__":{"polluted":true},"constructor":"c"'));
  assert.ok(Object.prototype.hasOwnProperty.call(JSON.parse(px.m.get(ATTRIBUTION_KEY)!).data, "__proto__")); // la clave existe de verdad
  const cargada = loadAttribution(px.store, 2000);
  assert.deepEqual(cargada, GADS); // se descartan las claves ajenas, __proto__ y constructor incluidos
  assert.equal(Object.prototype.hasOwnProperty.call(cargada!, "__proto__"), false);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  assert.deepEqual(loadAttribution(put({ ...GADS, extra: "x" }), 2000), GADS);
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

// =====================================================================================================================
// Bloque B · robustez de fotos, red y despliegue
// =====================================================================================================================

import { existsSync } from "node:fs";
import { CB_TIMEOUTS, loadDraft, postRequest, uploadPhotos } from "../src/lib/cbClient.ts";
import { decodeImage, type ProcessedPhoto } from "../src/lib/cbPhotos.ts";
import { BODY_MAX } from "../netlify/lib/handlers.ts";
import { callReceptor } from "../netlify/lib/receptor.ts";
import { MAX_THUMB_CHARS, isValidEmail } from "../shared/cb-schema.ts";

// ---- B1 · fotos de iPhone

test("B1: createImageBitmap con from-image y, si el motor lo rechaza, un reintento sin opciones", async () => {
  const g = globalThis as { createImageBitmap?: unknown };
  const had = g.createImageBitmap;
  const calls: unknown[][] = [];
  try {
    g.createImageBitmap = async (...a: unknown[]) => { calls.push(a); if (a[1]) throw new TypeError("from-image no soportado"); return { width: 1, height: 1 }; };
    const file = new Blob(["x"]);
    const bmp = await decodeImage(file);
    assert.deepEqual(bmp, { width: 1, height: 1 });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0][1], { imageOrientation: "from-image" }); // primero respeta la orientación EXIF
    assert.equal(calls[1].length, 1);                                  // y reintenta sin opciones

    calls.length = 0;
    g.createImageBitmap = async (...a: unknown[]) => { calls.push(a); return { width: 2, height: 2 }; };
    await decodeImage(file);
    assert.equal(calls.length, 1); // si la primera funciona, no hay reintento

    g.createImageBitmap = async () => { throw new DOMException("no es una imagen", "InvalidStateError"); };
    await assert.rejects(() => decodeImage(file), /no es una imagen/); // un archivo que no es imagen sigue fallando
  } finally { if (had === undefined) delete g.createImageBitmap; else g.createImageBitmap = had; }
  assert.match(read("src/lib/cbPhotos.ts"), /const bmp = await decodeImage\(file\)/);
});

// ---- B2 · subida de fotos: tiempos y fallos parciales

const BLOB = () => new Blob([new Uint8Array(100)], { type: "image/jpeg" });
const photo = (i: number, thumb = `/9j/T${i}`): ProcessedPhoto => ({ name: `f${i}.jpg`, blob: BLOB(), thumb, previewUrl: `blob:${i}` });
const URLS = { urls: [1, 2, 3].map((n) => ({ n, url: `https://r2.example/foto-${n}.jpg?sig=${n}` })) };
const FAST = { request: 50, photoUrls: 50, put: 50, photosDone: 50 };

type Hit = { url: string; method: string; body?: unknown; aborted: () => boolean };
function stubUpload(opts: { put?: (n: number) => Response | Promise<Response>; urls?: () => Response | Promise<Response>; done?: () => Response | Promise<Response> }) {
  const real = globalThis.fetch;
  const hits: Hit[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    hits.push({ url, method: init.method ?? "GET", body: typeof init.body === "string" ? JSON.parse(init.body) : undefined, aborted: () => !!init.signal?.aborted });
    if (url === "/api/cb-photo-urls") return opts.urls ? opts.urls() : new Response(JSON.stringify(URLS));
    if (url === "/api/cb-photos-done") return opts.done ? opts.done() : new Response(JSON.stringify({ fotos: (hits.find((h) => h.url === "/api/cb-photos-done")!.body as { fotos: unknown[] }).fotos.length }));
    if (init.method === "PUT") return opts.put ? opts.put(Number(/foto-(\d)/.exec(url)![1])) : new Response(null, { status: 200 });
    throw new Error(`fetch inesperado: ${url}`);
  }) as typeof fetch;
  return { hits, restore: () => { globalThis.fetch = real; } };
}
const hangUntilAborted = (init: RequestInit) => new Promise<Response>((_r, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

test("B2: una foto caída no aborta las demás; cb-photos-done recibe solo las que subieron", async () => {
  const s = stubUpload({ put: (n) => { if (n === 2) throw new TypeError("Failed to fetch"); return new Response(null, { status: 200 }); } });
  try {
    const ok = await uploadPhotos("a.b", [photo(1), photo(2), photo(3)], FAST);
    assert.equal(ok, 2);
    assert.equal(s.hits.filter((h) => h.method === "PUT").length, 3); // la 3 se intentó aunque la 2 cayó
    const done = s.hits.find((h) => h.url === "/api/cb-photos-done")!;
    assert.deepEqual(done.body, { permiso: "a.b", fotos: [{ n: 1, miniatura: "/9j/T1" }, { n: 3, miniatura: "/9j/T3" }] });
  } finally { s.restore(); }
});

test("B2: un PUT colgado se aborta a su tiempo y no deja el formulario esperando", async () => {
  const real = globalThis.fetch;
  const s = stubUpload({});
  const inner = globalThis.fetch;
  let putAbort: Hit["aborted"] | undefined;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (init.method === "PUT" && String(url).includes("foto-1")) { putAbort = () => init.signal!.aborted; return hangUntilAborted(init); }
    return inner(url, init);
  }) as typeof fetch;
  try {
    const t0 = Date.now();
    const ok = await uploadPhotos("a.b", [photo(1), photo(2)], FAST);
    assert.equal(ok, 1);
    assert.ok(Date.now() - t0 < 2000, "no espera más que el tiempo del PUT");
    assert.equal(putAbort?.(), true);
    assert.deepEqual((s.hits.find((h) => h.url === "/api/cb-photos-done")!.body as { fotos: { n: number }[] }).fotos.map((f) => f.n), [2]);
  } finally { s.restore(); globalThis.fetch = real; }
});

test("B2: si ninguna foto sube, devuelve 0 y no llama a cb-photos-done; un PUT con error HTTP tampoco cuenta", async () => {
  let s = stubUpload({ put: () => { throw new TypeError("network"); } });
  try {
    assert.equal(await uploadPhotos("a.b", [photo(1), photo(2)], FAST), 0);
    assert.ok(!s.hits.some((h) => h.url === "/api/cb-photos-done"));
  } finally { s.restore(); }
  s = stubUpload({ put: (n) => new Response(null, { status: n === 1 ? 403 : 200 }) });
  try {
    assert.equal(await uploadPhotos("a.b", [photo(1), photo(2)], FAST), 1);
  } finally { s.restore(); }
});

test("B2: sin miniatura la foto viaja solo con n; los POST con error o sin cuerpo utilizable lanzan", async () => {
  let s = stubUpload({});
  try {
    await uploadPhotos("a.b", [photo(1, "")], FAST);
    assert.deepEqual((s.hits.find((h) => h.url === "/api/cb-photos-done")!.body as { fotos: unknown[] }).fotos, [{ n: 1 }]);
  } finally { s.restore(); }
  s = stubUpload({ urls: () => new Response("{}", { status: 503 }) });
  try { await assert.rejects(() => uploadPhotos("a.b", [photo(1)], FAST), /urls/); } finally { s.restore(); }
  s = stubUpload({ urls: () => new Response("no es json", { status: 200 }) });
  try { await assert.rejects(() => uploadPhotos("a.b", [photo(1)], FAST), /urls/); } finally { s.restore(); }
  s = stubUpload({ done: () => new Response("{}", { status: 400 }) });
  try { await assert.rejects(() => uploadPhotos("a.b", [photo(1)], FAST), /done/); } finally { s.restore(); }
});

test("B2: los POST de fotos también tienen tiempo máximo", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = ((_u: string, init: RequestInit) => hangUntilAborted(init)) as typeof fetch;
  try { await assert.rejects(() => uploadPhotos("a.b", [photo(1)], FAST)); } finally { globalThis.fetch = real; }
  // los tiempos del navegador caben en las ventanas del PUT prefirmado (300 s) y del permiso (15 min)
  assert.ok(CB_TIMEOUTS.put * 3 < 300_000);
  assert.ok(CB_TIMEOUTS.photoUrls + CB_TIMEOUTS.put * 3 + CB_TIMEOUTS.photosDone < 15 * 60_000);
  assert.ok(CB_TIMEOUTS.request > 16_000, "más que el peor caso de la Function (Turnstile 8 s + receptor 8 s)");
});

// ---- B3 · 502 y 504 son reintentables

test("B3: 502 y 504 se tratan como retry, igual que 503; el tiempo vencido también", async () => {
  const real = globalThis.fetch;
  try {
    for (const status of [502, 503, 504]) {
      globalThis.fetch = (async () => new Response("<html>gateway</html>", { status })) as typeof fetch;
      assert.deepEqual(await postRequest(KEY, "tok", {}, 0), { kind: "retry" }, String(status));
    }
    globalThis.fetch = (async () => new Response("", { status: 500 })) as typeof fetch;
    assert.deepEqual(await postRequest(KEY, "tok", {}, 0), { kind: "error" }); // 500 sigue siendo terminal
    globalThis.fetch = ((_u: string, init: RequestInit) => hangUntilAborted(init)) as typeof fetch;
    assert.deepEqual(await postRequest(KEY, "tok", {}, 0, 30), { kind: "retry" }); // la Function no contestó a tiempo
  } finally { globalThis.fetch = real; }
});

// ---- B5 · tope del cuerpo de cb-photos-done

test("B5: cb-photos-done acepta 3 miniaturas de 200.000 caracteres (lo que permite el contrato) y rechaza lo que lo excede", async () => {
  assert.equal(MAX_THUMB_CHARS, 200_000);
  assert.equal(BODY_MAX.photosDone, 3 * 200_000 + 4_000);
  assert.equal(BODY_MAX.request, 400_000); // las otras dos no cambian
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0]);
  const dir = "solicitudes/TEST-0001-aaaaaaaa/";
  const files = { [`${dir}foto-1.jpg`]: jpeg, [`${dir}foto-2.jpg`]: jpeg, [`${dir}foto-3.jpg`]: jpeg };
  const thumb = "/9j/" + "A".repeat(MAX_THUMB_CHARS - 4);
  assert.equal(thumb.length, MAX_THUMB_CHARS);
  const p3 = signPermit({ lead_id: "L-1", carpeta: dir, n_max: 3, exp: NOW + 900 }, "ps");
  const d = mkDeps({ r2: () => mkR2({ ...files }) });
  d.fetchImpl = (async (_u: string, init: { body: string }) => { d.calls.push(JSON.parse(JSON.parse(init.body).payload)); return new Response(JSON.stringify({ ok: true, folio: "TEST-0001", fotos: 3 })); }) as unknown as typeof fetch;
  const body = { permiso: p3, fotos: [1, 2, 3].map((n) => ({ n, miniatura: thumb })) };
  assert.ok(JSON.stringify(body).length > 400_000, "antes del cambio esto daba 400");
  const res = await handlePhotosDone(post(body), d);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { fotos: 3, rechazadas: [] });
  assert.equal((d.calls[0].datos.fotos as unknown[]).length, 3);

  const grande = { permiso: p3, fotos: [{ n: 1, miniatura: "/9j/" + "A".repeat(BODY_MAX.photosDone) }] };
  assert.equal((await handlePhotosDone(post(grande), mkDeps({ r2: () => mkR2({ ...files }) }))).status, 400);
});

// ---- B6 · alertas del receptor

function depsWithReceptor(receptor: () => Response | Promise<Response>) {
  const d = mkDeps();
  d.fetchImpl = (async (url: string) => (String(url).includes("turnstile") ? new Response(JSON.stringify({ success: true })) : receptor())) as unknown as typeof fetch;
  return d;
}

test("B6: cada fallo del receptor deja una línea CB_ALERT fija con la causa y sin datos personales", async () => {
  const cases: [string, () => Response | Promise<Response>, number][] = [
    ["timeout", () => { throw new DOMException("The operation timed out.", "TimeoutError"); }, 503],
    ["timeout", () => { throw new DOMException("aborted", "AbortError"); }, 503],
    ["network", () => { throw new TypeError("fetch failed"); }, 503],
    ["http_500", () => new Response("<html>error</html>", { status: 500 }), 503],
    ["http_404", () => new Response("not found", { status: 404 }), 503],
    ["non_json", () => new Response("<html>login</html>", { status: 200 }), 503],
    ["non_json", () => new Response(JSON.stringify({ sin: "ok" }), { status: 200 }), 503],
    ["ocupado", () => new Response(JSON.stringify({ ok: false, error: "ocupado" })), 503],
    ["cupo", () => new Response(JSON.stringify({ ok: false, error: "cupo" })), 429],
    ["firma", () => new Response(JSON.stringify({ ok: false, error: "firma" })), 500],
    ["datos", () => new Response(JSON.stringify({ ok: false, error: "datos" })), 400],
  ];
  for (const [causa, receptor, status] of cases) {
    const d = depsWithReceptor(receptor);
    const res = await handleRequest(post(reqBody), d);
    assert.equal(res.status, status, causa);
    assert.deepEqual(d.logs, [`CB_ALERT receptor accion=crear causa=${causa}`], causa);
    for (const l of d.logs) assert.ok(!/Ana|ana@example|3055550123|M3|Widebody|33101|L-1/.test(l), "sin datos personales");
  }
  // un código raro del receptor no se cuela al log tal cual
  const raro = depsWithReceptor(() => new Response(JSON.stringify({ ok: false, error: "Ana Pérez 305-555-0123" })));
  await handleRequest(post(reqBody), raro);
  assert.deepEqual(raro.logs, ["CB_ALERT receptor accion=crear causa=desconocida"]);
  // y sin fallo no hay línea
  const bien = mkDeps();
  await handleRequest(post(reqBody), bien);
  assert.deepEqual(bien.logs, []);
});

test("B6: callReceptor devuelve la causa de transporte y cb-photos-done también alerta con accion=fotos", async () => {
  const env = { url: "https://rec", secret: "cd".repeat(32), entorno: "preview" as const };
  const mk = (f: () => Response | Promise<Response>) => (async () => f()) as unknown as typeof fetch;
  assert.deepEqual(await callReceptor(env, "ping", {}, mk(() => new Response("x", { status: 502 }))), { ok: false, error: "interno", cause: "http_502" });
  assert.deepEqual(await callReceptor(env, "ping", {}, mk(() => new Response("{"))), { ok: false, error: "interno", cause: "non_json" });
  assert.deepEqual(await callReceptor(env, "ping", {}, mk(() => new Response(JSON.stringify({ ok: false, error: "cupo" })))), { ok: false, error: "cupo" });
  assert.equal((await callReceptor(env, "ping", {}, mk(() => new Response(JSON.stringify({ ok: true, version: "1.1.2" }))))).ok, true);

  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0]);
  const d = mkDeps({ r2: () => mkR2({ "solicitudes/TEST-0001-aaaaaaaa/foto-1.jpg": jpeg }) });
  d.fetchImpl = (async () => { throw new DOMException("timed out", "TimeoutError"); }) as unknown as typeof fetch;
  const res = await handlePhotosDone(post({ permiso: permit, fotos: [{ n: 1 }] }), d);
  assert.equal(res.status, 503);
  assert.deepEqual(d.logs, ["CB_ALERT receptor accion=fotos causa=timeout"]);
});

// ---- B7 · lead_id vacío y fotos sin permiso

test("B7: un lead_id vacío del receptor es 503 reintentable, no un 201", async () => {
  for (const reply of [{ ok: true }, { ok: true, lead_id: "", carpeta: "solicitudes/T-1-aaaaaaaa/" }, { ok: true, lead_id: null }]) {
    const d = depsWithReceptor(() => new Response(JSON.stringify(reply)));
    const res = await handleRequest(post(reqBody), d);
    assert.equal(res.status, 503, JSON.stringify(reply));
    assert.deepEqual(await res.json(), { error: "unavailable" });
    assert.deepEqual(d.logs, ["CB_ALERT receptor accion=crear causa=sin_lead_id"]);
  }
  assert.equal((await handleRequest(post(reqBody), mkDeps())).status, 201); // con lead_id sigue igual
});

// ---- B9 · .lovable/plan.md

test("B9: .lovable/plan.md ya no existe (describía un segundo contenedor GTM que no está aplicado)", () => {
  assert.equal(existsSync(new URL("../.lovable/plan.md", import.meta.url)), false);
  assert.doesNotMatch(read("index.html"), /GTM-P77D69RV/);
  assert.match(read("index.html"), /GTM-W2VG66T5/);
});

// ---- B10 · correo

test("B10: el correo rechaza lo que se puede leer como otra cosa o que el receptor rompería", () => {
  const rechazados: [string, string][] = [
    ["a@b..co", "dos puntos seguidos"], ["a..b@example.com", "dos puntos seguidos en el usuario"],
    ["a@-.co", "etiqueta que empieza con -"], ["a@b-.co", "etiqueta que termina con -"], ["a@x.-b.co", "etiqueta que empieza con -"],
    ["a@x.b-.co", "etiqueta que termina con -"], ["a@.example.com", "dominio que empieza con punto"],
    ["a@example.com.", "dominio que termina con punto"],
    ["<ana@example.com>", "ángulos"], ["ana<@example.com", "<"], ["ana@example.com>", ">"], ['"ana"@example.com', "comillas"],
    ["ana,bob@example.com", "coma"], ["ana@example.com;bob@example.com", "punto y coma"],
    ["ana\u0085@example.com", "U+0085"], ["ana\u200b@example.com", "U+200B"], ["ana@exa\u202emple.com", "U+202E"],
    ["ana\u0000@example.com", "nulo"], ["ana\u0007@example.com", "control"], ["ana\u007f@example.com", "DEL"],
    ["ana\ufeff@example.com", "BOM"], ["ana@example\u00ad.com", "guion suave"], ["ana\u2028@example.com", "separador de línea"],
    ["=1+1@a.co", "fórmula ="], ["+ana@example.com", "empieza con +"], ["-ana@example.com", "empieza con -"],
    ["=cmd|' /C calc'!A0@a.co", "fórmula con tubería"],
    ["ana@example", "sin punto en el dominio"], ["ana@", "sin dominio"], ["@example.com", "sin usuario"], ["ana example@x.co", "espacio"],
    ["ana@@example.com", "dos @"], ["ana@example.c", "TLD de una letra"],
  ];
  for (const [correo, por] of rechazados) {
    assert.equal(isValidEmail(correo), false, `${por}: ${JSON.stringify(correo)}`);
    const r = validateRequest({ ...valid, correo });
    assert.equal(r.ok, false, `${por}: ${JSON.stringify(correo)}`);
    assert.deepEqual(r.errors, { correo: "Enter a valid email address." }, por);
  }
});

test("B10: el correo acepta direcciones normales (a@b.co, mayúsculas, +tag, subdominios, apóstrofo)", () => {
  for (const correo of ["a@b.co", "ANA@Example.COM", "ana.o+tag@sub.example.co.uk", "o'brien@example.com", "ana_1@ex-ample.com", "a@b-c.co", "ana@xn--caf-dma.com", "jose.perez@mail.example.org"]) {
    assert.equal(isValidEmail(correo), true, correo);
    const r = validateRequest({ ...valid, correo });
    assert.ok(r.ok, correo);
    assert.equal(r.data.correo, correo); // se conserva tal cual, sin pasar a minúsculas
  }
  // los blancos de los extremos (y un BOM al inicio, que trim() también quita) se recortan antes de validar
  assert.ok(validateRequest({ ...valid, correo: "  ana@example.com \t" }).ok);
  const bom = validateRequest({ ...valid, correo: "\ufeffana@example.com" });
  assert.ok(bom.ok && bom.data.correo === "ana@example.com");
  assert.equal(isValidEmail("\ufeffana@example.com"), false); // pero la función sola no lo acepta
  // un correo vacío o ausente sigue siendo "obligatorio", no "inválido"
  assert.deepEqual(validateRequest({ ...valid, correo: "" }).errors, { correo: "Enter your email address." });
  assert.equal(validateRequest({ ...valid, correo: "x".repeat(161) + "@a.co" }).ok, false);
});

// ---- B11 · borrador

function withSession<T>(raw: string | null, fn: () => T): T {
  const g = globalThis as { sessionStorage?: unknown };
  const had = g.sessionStorage;
  g.sessionStorage = { getItem: () => raw, setItem() {}, removeItem() {} };
  try { return fn(); } finally { if (had === undefined) delete g.sessionStorage; else g.sessionStorage = had; }
}

test("B11: loadDraft se queda solo con valores de texto, así normalizePhone y validateRequest no reciben otra cosa", () => {
  const draft = (fields: unknown, clave: unknown = KEY) => JSON.stringify({ fields, clave });
  assert.deepEqual(withSession(draft({ nombre: "Ana", telefono: 3055550123, correo: { x: 1 }, marca: null, modelo: ["M3"], anio: true, zona: "33101" }), loadDraft),
    { fields: { nombre: "Ana", zona: "33101" }, clave: KEY });
  assert.deepEqual(withSession(draft({ nombre: "Ana" }), loadDraft), { fields: { nombre: "Ana" }, clave: KEY });
  // una clave que no es UUID v4 se descarta (el servidor la rechazaría con 400 y el usuario quedaría atascado)
  assert.equal(withSession(draft({ nombre: "Ana" }, "no-es-uuid"), loadDraft)?.clave, "");
  assert.equal(withSession(draft({ nombre: "Ana" }, 42), loadDraft)?.clave, "");
  // formas inválidas
  for (const raw of [null, "", "{no json", "null", "42", '"texto"', "[]", JSON.stringify({ clave: KEY }), JSON.stringify({ fields: "x", clave: KEY }), JSON.stringify({ fields: [1], clave: KEY })]) {
    assert.equal(withSession(raw, loadDraft), null, String(raw));
  }
  // y lo que devuelve ya no rompe el envío: todo valor es texto
  const d = withSession(draft({ telefono: 3055550123, nombre: "Ana" }), loadDraft)!;
  assert.ok(Object.values(d.fields).every((v) => typeof v === "string"));
  // sin almacenamiento (bloqueado) no lanza
  const g = globalThis as { sessionStorage?: unknown };
  const had = g.sessionStorage;
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { throw new DOMException("insecure", "SecurityError"); } });
  try { assert.equal(loadDraft(), null); } finally { delete (globalThis as { sessionStorage?: unknown }).sessionStorage; if (had !== undefined) g.sessionStorage = had; }
});
