import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { currentAttribution, readAttribution } from "../src/lib/cbAttribution.ts";
import { postRequest } from "../src/lib/cbClient.ts";
import { createLeadReporter } from "../src/lib/cbDataLayer.ts";
import { saveAttribution, ATTRIBUTION_KEY } from "../shared/cb-attribution.ts";
import { validateRequest } from "../shared/cb-schema.ts";

const LEAD = "6f1c0a52-9a3e-4d0b-8f7c-2b5d4e1a9c33";
const KEY = "3b1f5c2e-8d4a-4b7e-9a21-5f6c7d8e9a0b";
const valid = { nombre: "Ana", telefono: "+13055550123", marca: "BMW", modelo: "M3", anio: "2020", zona: "33101", servicio: "Full build", descripcion: "Widebody kit" };
const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

/** Lo que hace el navegador con los datos del sitio bloqueados: leer window.localStorage lanza. */
const securityError = () => new DOMException("The operation is insecure.", "SecurityError");
function withBlockedWindow<T>(fn: () => T): T {
  const had = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { get localStorage(): Storage { throw securityError(); } },
  });
  try { return fn(); }
  finally { if (had) Object.defineProperty(globalThis, "window", had); else delete (globalThis as { window?: unknown }).window; }
}

// ---- falla 1: acceso a window.localStorage fuera de try/catch

test("atribución: con localStorage bloqueado, el solo acceso a window.localStorage lanza (la causa de la falla)", () => {
  withBlockedWindow(() => assert.throws(() => (window as Window).localStorage, { name: "SecurityError" }));
});

test("atribución: readAttribution devuelve null si resolver el almacenamiento lanza SecurityError", () => {
  assert.equal(readAttribution(() => { throw securityError(); }), null);
});

test("atribución: currentAttribution devuelve null con window.localStorage que lanza al leerse", () => {
  assert.equal(withBlockedWindow(() => currentAttribution()), null);
});

test("atribución: readAttribution sigue leyendo la atribución guardada cuando el almacenamiento sirve", () => {
  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  assert.equal(readAttribution(() => store), null); // nada guardado
  saveAttribution(store, { origen: "utm", utm_source: "ig" }, Date.now());
  assert.equal(readAttribution(() => store)?.utm_source, "ig");
  // métodos que lanzan (ya estaba cubierto por loadAttribution): sigue null
  const broken = { getItem: () => { throw securityError(); }, setItem: () => {}, removeItem: () => {} };
  assert.equal(readAttribution(() => broken), null);
  assert.ok(m.has(ATTRIBUTION_KEY));
});

test("atribución: sin atribución (almacenamiento bloqueado) la solicitud valida igual, sin origen", () => {
  const a = withBlockedWindow(() => currentAttribution());
  const campos = { ...valid, ...(a ?? {}) };
  const v = validateRequest(campos);
  assert.equal(v.ok, true);
  assert.ok(v.ok && !("origen" in v.data));
});

test("EstimateForm: la atribución se lee con currentAttribution(), sin tocar window.localStorage en onSubmit", () => {
  const src = read("src/components/custom-builds/EstimateForm.tsx");
  assert.doesNotMatch(src, /window\.localStorage/);
  assert.doesNotMatch(src, /loadAttribution\s*\(/);
  const submit = src.slice(src.indexOf("const onSubmit"));
  assert.ok(submit.indexOf("currentAttribution()") > 0);
  assert.ok(submit.indexOf("currentAttribution()") < submit.indexOf("validateRequest("));
});

// ---- falla 2: res.json() sin protección en el 201

type Sent = { clave: string; token: string };
/** fetch simulado: responde 201 con el cuerpo dado (texto crudo) y anota las claves que recibe. */
function stubFetch(bodies: Array<string | (() => Promise<unknown>)>) {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const b = JSON.parse(init!.body!);
    sent.push({ clave: b.clave, token: b.token });
    const body = bodies[Math.min(i++, bodies.length - 1)];
    if (typeof body === "function") {
      // cuerpo cuya lectura falla a mitad (corte de red después del 201)
      return { status: 201, json: body } as unknown as Response;
    }
    return new Response(body, { status: 201 });
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = real; } };
}

test("postRequest: 201 con cuerpo que no es JSON => retry, sin lanzar", async () => {
  for (const body of ["<html>bad gateway</html>", "", "ok", "{\"lead_id\":", "undefined"]) {
    const s = stubFetch([body]);
    try { assert.deepEqual(await postRequest(KEY, "tok", {}, 0), { kind: "retry" }, JSON.stringify(body)); }
    finally { s.restore(); }
  }
});

test("postRequest: 201 cuya lectura del cuerpo falla => retry, sin lanzar", async () => {
  const s = stubFetch([async () => { throw new TypeError("terminated"); }]);
  try { assert.deepEqual(await postRequest(KEY, "tok", {}, 0), { kind: "retry" }); }
  finally { s.restore(); }
});

test("postRequest: 201 con JSON sin lead_id utilizable => retry", async () => {
  const bodies: unknown[] = [
    {}, [], null, "texto", 7, true,
    { permiso: null, medir: true },
    { lead_id: "", permiso: null, medir: true },
    { lead_id: 42, permiso: null, medir: true },
    { lead_id: null, permiso: null, medir: true },
    { lead_id: ["x"], permiso: null, medir: true },
  ];
  for (const b of bodies) {
    const s = stubFetch([JSON.stringify(b)]);
    try { assert.deepEqual(await postRequest(KEY, "tok", {}, 0), { kind: "retry" }, JSON.stringify(b)); }
    finally { s.restore(); }
  }
});

test("postRequest: 201 con permiso que no es texto ni null => retry", async () => {
  for (const permiso of [42, true, {}, ["a.b"]]) {
    const s = stubFetch([JSON.stringify({ lead_id: LEAD, permiso, medir: true })]);
    try { assert.deepEqual(await postRequest(KEY, "tok", {}, 1), { kind: "retry" }, JSON.stringify(permiso)); }
    finally { s.restore(); }
  }
});

test("postRequest: 201 válido sigue igual (con y sin permiso); medir solo cuenta si es true", async () => {
  const cases: Array<[unknown, { permiso: string | null; medir: boolean }]> = [
    [{ lead_id: LEAD, permiso: "a.b", medir: true }, { permiso: "a.b", medir: true }],
    [{ lead_id: LEAD, permiso: null, medir: true }, { permiso: null, medir: true }],
    [{ lead_id: LEAD, permiso: null, medir: false }, { permiso: null, medir: false }],
    [{ lead_id: LEAD, permiso: null }, { permiso: null, medir: false }],          // sin medir: conservador, no mide
    [{ lead_id: LEAD, medir: "true" }, { permiso: null, medir: false }],           // medir distinto de true estricto
  ];
  for (const [body, want] of cases) {
    const s = stubFetch([JSON.stringify(body)]);
    try { assert.deepEqual(await postRequest(KEY, "tok", {}, 0), { kind: "ok", leadId: LEAD, ...want }, JSON.stringify(body)); }
    finally { s.restore(); }
  }
});

test("postRequest: el resto de la tabla de errores no cambia (400, 403, 429, 503, 500)", async () => {
  const real = globalThis.fetch;
  try {
    const want: Record<number, string> = { 400: "invalid", 403: "turnstile", 429: "quota", 503: "retry", 500: "error" };
    for (const [status, kind] of Object.entries(want)) {
      globalThis.fetch = (async () => new Response("no json", { status: Number(status) })) as typeof fetch;
      assert.deepEqual(await postRequest(KEY, "tok", {}, 0), { kind });
    }
    globalThis.fetch = (async () => { throw new TypeError("network"); }) as typeof fetch;
    assert.deepEqual(await postRequest(KEY, "tok", {}, 0), { kind: "retry" });
  } finally { globalThis.fetch = real; }
});

test("201 malformado: no empuja generate_lead; el reintento con la misma clave sí, una sola vez", async () => {
  const dataLayer: Record<string, unknown>[] = [];
  const memory = new Map<string, string>();
  const store = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v) };
  const push = createLeadReporter(() => ({ dataLayer }), () => store);
  // mismo paso que EstimateForm: solo con "ok"
  const submit = async () => { const o = await postRequest(KEY, "tok", {}, 0); if (o.kind === "ok") push(o.leadId, o.medir); return o.kind; };

  const s = stubFetch(["<html>502</html>", JSON.stringify({ lead_id: LEAD, permiso: null, medir: true }), JSON.stringify({ lead_id: LEAD, permiso: null, medir: true })]);
  try {
    assert.equal(await submit(), "retry");
    assert.equal(dataLayer.length, 0);
    assert.equal(await submit(), "ok");        // replay del mismo lead
    assert.deepEqual(dataLayer, [{ event: "generate_lead", service: "custom_builds", lead_id: LEAD }]);
    assert.equal(await submit(), "ok");        // otro replay: no duplica
    assert.equal(dataLayer.length, 1);
    assert.deepEqual(s.sent.map((x) => x.clave), [KEY, KEY, KEY]); // misma clave de idempotencia en cada intento
  } finally { s.restore(); }
});

test("EstimateForm: con 'retry' sale del estado de envío y conserva la clave de idempotencia", () => {
  const src = read("src/components/custom-builds/EstimateForm.tsx");
  const start = src.indexOf('if (r.kind !== "ok") {');
  const end = src.indexOf("trackGenerateLead(r.leadId, r.medir)");
  assert.ok(start > 0 && end > start);
  const block = src.slice(start, end);
  assert.match(block, /r\.kind === "retry"/);                  // reinicia Turnstile y borra el token consumido
  assert.match(block, /setStatus\("idle"\)/);                  // ya no está enviando
  assert.match(block, /busyRef\.current = false/);             // se puede reenviar
  assert.match(block, /return;/);
  assert.doesNotMatch(block, /claveRef\.current = ""/);        // misma clave: el reintento es un replay
  assert.doesNotMatch(block, /clearDraft\(\)/);                // el borrador (y su clave) sobreviven
  assert.ok(src.indexOf('claveRef.current = ""') > end);       // la clave solo se limpia tras el éxito
});
