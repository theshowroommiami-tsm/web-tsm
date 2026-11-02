// Segunda ronda, servidor: CB_ENTORNO contra el contexto del despliegue (SRV-02), Turnstile y R2 que fallan sin ser culpa
// de quien envía (SRV-01) y el tiempo del cliente para cb-photos-done (SRV-03).
import { test } from "node:test";
import assert from "node:assert/strict";
import { signPermit } from "../netlify/lib/permit.ts";
import { depsFromEnv, entornoFor } from "../netlify/lib/env.ts";
import { configProblems, handlePhotoUrls, handlePhotosDone, handleRequest, type Deps, type R2Client } from "../netlify/lib/handlers.ts";
import { TURNSTILE_TEST_SECRET, checkTurnstile, verifyTurnstile } from "../netlify/lib/turnstile.ts";
import { R2_TIMEOUT_MS } from "../netlify/lib/r2.ts";
import { CB_TIMEOUTS } from "../src/lib/cbClient.ts";

const KEY = "3b1f5c2e-8d4a-4b7e-9a21-5f6c7d8e9a0b";
const NOW = 1_800_000_000;
const valid = { nombre: "Ana", telefono: "+13055550123", correo: "ana@example.com", marca: "BMW", modelo: "M3", anio: "2020", zona: "33101", servicio: "Full build", descripcion: "Widebody kit" };
const post = (body: unknown) => new Request("https://x/api", { method: "POST", body: JSON.stringify(body) });
const reqBody = { clave: KEY, token: "TOKEN-SECRETO-NO-LOGUEAR", campos: valid, fotos_esperadas: 0 };
const REAL_SECRET = "0x4AAAAAAADRealSecretKeyNoLoguear1234567890";

type Call = { url: string; body?: unknown };
function mkDeps(over: Partial<Deps> & { siteverify?: () => Response | Promise<Response> } = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const { siteverify, ...rest } = over;
  const fetchImpl = (async (url: string, init: { body: string }) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    if (String(url).includes("turnstile")) return siteverify ? siteverify() : new Response(JSON.stringify({ success: true }));
    return new Response(JSON.stringify({ ok: true, lead_id: "L-1", folio: "TEST-1", carpeta: "", duplicado: false, fotos_esperadas: 0 }));
  }) as unknown as typeof fetch;
  const deps: Deps = { entorno: "preview", permitSecret: "ps", receptor: { url: "https://rec", secret: "cd".repeat(32) }, r2: () => ({}) as R2Client, fetchImpl, now: () => NOW, log: (m) => logs.push(m), ...rest };
  return { deps, calls, logs, receptorCalls: () => calls.filter((c) => !c.url.includes("turnstile")).length };
}

// ---- SRV-02 · CB_ENTORNO contra el contexto del despliegue

test("SRV-02: entornoFor contrasta CB_ENTORNO con context.deploy.context de Netlify", () => {
  const casos: [string, string | undefined, string | null, string?][] = [
    // [CB_ENTORNO, contexto, entorno resultante, problema]
    ["production", "production", "production"],
    ["preview", "deploy-preview", "preview"],
    ["preview", "branch-deploy", "preview"],
    ["preview", "dev", "preview"],
    ["preview", "production", null, "CB_ENTORNO(contexto)"],       // Turnstile de prueba en producción: falla abierta
    ["production", "deploy-preview", null, "CB_ENTORNO(contexto)"], // secretos de producción en un preview
    ["production", "branch-deploy", null, "CB_ENTORNO(contexto)"],
    ["production", "dev", null, "CB_ENTORNO(contexto)"],
    ["production", "preview-server", null, "CB_ENTORNO(contexto)"],
    ["production", undefined, "production"],                         // sin contexto no se puede verificar y no se inventa
    ["preview", undefined, "preview"],
    ["production", "staging", "production"],                         // contexto propio (rama): no es uno de los documentados
    ["Production", "production", null, "CB_ENTORNO"],                // la comprobación de siempre sigue: valor exacto
    ["", "production", null, "CB_ENTORNO"],
    ["prod", "deploy-preview", null, "CB_ENTORNO"],
  ];
  for (const [raw, ctx, entorno, problem] of casos) {
    const r = entornoFor(raw, ctx);
    assert.equal(r.entorno, entorno, `${raw} + ${ctx}`);
    assert.equal(r.problem, problem, `${raw} + ${ctx}`);
  }
});

function withNetlifyEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const g = globalThis as { Netlify?: unknown };
  const had = g.Netlify;
  g.Netlify = { env: { get: (k: string) => vars[k] } };
  try { return fn(); } finally { if (had === undefined) delete g.Netlify; else g.Netlify = had; }
}
const FULL = {
  CB_PERMIT_SECRET: "p", RECEPTOR_URL: "https://r", RECEPTOR_SECRET: "s", TURNSTILE_SECRET_KEY: REAL_SECRET,
  R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "x",
};

test("SRV-02: CB_ENTORNO=preview en el contexto production hace que las 3 Functions respondan 500 con CB_ALERT que nombra CB_ENTORNO(contexto)", async () => {
  const deps = withNetlifyEnv({ ...FULL, CB_ENTORNO: "preview", R2_BUCKET: "form-custom-builds-preview" }, () => depsFromEnv("production"));
  assert.equal(deps.entorno, null);
  assert.equal(deps.entornoProblem, "CB_ENTORNO(contexto)");
  const permit = signPermit({ lead_id: "L-1", carpeta: "solicitudes/TEST-0001-aaaaaaaa/", n_max: 2, exp: NOW + 900 }, "p");
  const m = mkDeps({ ...deps, permitSecret: "p", fetchImpl: undefined });
  const logs: string[] = [];
  const d: Deps = { ...deps, now: () => NOW, log: (x) => logs.push(x), fetchImpl: m.deps.fetchImpl };
  assert.equal((await handleRequest(post(reqBody), d)).status, 500);
  assert.equal((await handlePhotoUrls(post({ permiso: permit, fotos: [{ n: 1, size: 10 }] }), d)).status, 500);
  assert.equal((await handlePhotosDone(post({ permiso: permit, fotos: [{ n: 1 }] }), d)).status, 500);
  assert.equal(m.calls.length, 0); // ni Turnstile (de prueba, que pasaría todo) ni receptor
  assert.equal(logs.length, 3);
  for (const l of logs) assert.match(l, /^CB_ALERT config fn=cb-[a-z-]+ missing=.*CB_ENTORNO\(contexto\)/);
});

test("SRV-02: los despliegues correctos siguen funcionando (production en production; preview en deploy-preview)", () => {
  const prod = withNetlifyEnv({ ...FULL, CB_ENTORNO: "production", R2_BUCKET: "form-custom-builds" }, () => depsFromEnv("production"));
  assert.equal(prod.entorno, "production");
  assert.deepEqual(configProblems(prod, true), []);
  const prev = withNetlifyEnv({ ...FULL, CB_ENTORNO: "preview", R2_BUCKET: "form-custom-builds-preview" }, () => depsFromEnv("deploy-preview"));
  assert.equal(prev.entorno, "preview");
  assert.deepEqual(configProblems(prev, true), []);
  // producción cargada en un deploy preview: falla cerrado
  const cruzado = withNetlifyEnv({ ...FULL, CB_ENTORNO: "production", R2_BUCKET: "form-custom-builds" }, () => depsFromEnv("deploy-preview"));
  assert.equal(cruzado.entorno, null);
  assert.deepEqual(configProblems(cruzado), ["CB_ENTORNO(contexto)"]);
});

// El paso del contexto (y del anfitrión) a la configuración de las tres Functions se prueba en tests/cb-ronda3.test.ts
// llamando a las Functions de verdad, no leyendo su código.

// ---- SRV-01 · variables, secret de prueba en producción

test("SRV-01: las variables se leen con trim() (un salto de línea o un espacio no es parte del valor)", () => {
  const d = withNetlifyEnv(
    { ...FULL, CB_ENTORNO: "production\n", TURNSTILE_SECRET_KEY: `${REAL_SECRET}\n`, RECEPTOR_URL: " https://r ", R2_BUCKET: "form-custom-builds ", CB_PERMIT_SECRET: "  " },
    () => depsFromEnv("production"),
  );
  assert.equal(d.entorno, "production");
  assert.equal(d.turnstileSecret, REAL_SECRET);
  assert.equal(d.receptor.url, "https://r");
  assert.deepEqual(d.r2Missing, []);
  assert.deepEqual(configProblems(d), ["CB_PERMIT_SECRET"]); // solo espacios = vacía
});

test("SRV-01: en producción una Secret Key de prueba (la de siempre pasa o cualquiera 1x, 2x, 3x) no vale: TURNSTILE_SECRET_KEY(prueba)", () => {
  const base: Deps = { entorno: "production", permitSecret: "ps", receptor: { url: "u", secret: "s" }, r2: () => ({}) as R2Client };
  for (const secret of [TURNSTILE_TEST_SECRET, "1x0000000000000000000000000000000AA", "2x0000000000000000000000000000000AA", "3x0000000000000000000000000000000FF"]) {
    assert.deepEqual(configProblems({ ...base, turnstileSecret: secret }), ["TURNSTILE_SECRET_KEY(prueba)"], secret);
  }
  assert.deepEqual(configProblems({ ...base, turnstileSecret: REAL_SECRET }), []);
  assert.deepEqual(configProblems({ ...base, turnstileSecret: undefined }), ["TURNSTILE_SECRET_KEY"]);
  // en preview la Secret Key de prueba es la que corresponde (está en el código): no se marca
  assert.deepEqual(configProblems({ ...base, entorno: "preview", turnstileSecret: undefined }), []);
});

test("SRV-01: producción con la Secret Key de prueba responde 500 con alerta, sin llamar a Turnstile ni al receptor", async () => {
  const m = mkDeps({ entorno: "production", turnstileSecret: TURNSTILE_TEST_SECRET });
  const res = await handleRequest(post(reqBody), m.deps);
  assert.equal(res.status, 500);
  assert.deepEqual(m.logs, ["CB_ALERT config fn=cb-request missing=TURNSTILE_SECRET_KEY(prueba)"]);
  assert.equal(m.calls.length, 0);
  assert.ok(!m.logs.join("").includes(TURNSTILE_TEST_SECRET));
});

// ---- SRV-01 · Turnstile: fallo del servicio frente a rechazo del usuario

const ts = (j: unknown, status = 200) => (async () => new Response(typeof j === "string" ? j : JSON.stringify(j), { status })) as unknown as typeof fetch;
const prod = { entorno: "production" as const, secret: REAL_SECRET };
const prodOk = { success: true, hostname: "showroommiami.com", action: "cb_request" };

test("SRV-01: checkTurnstile distingue ok, rechazo del usuario y fallo del servicio, con una causa fija", async () => {
  assert.deepEqual(await checkTurnstile(prod, "t", KEY, ts(prodOk)), { outcome: "ok" });
  // del usuario (o de un bot): 403
  for (const j of [{ success: false, "error-codes": ["invalid-input-response"] }, { success: false, "error-codes": ["timeout-or-duplicate"] }, { success: false }, { success: false, "error-codes": [] }, { success: false, "error-codes": ["algo-nuevo"] }]) {
    assert.deepEqual(await checkTurnstile(prod, "t", KEY, ts(j)), { outcome: "rejected" }, JSON.stringify(j));
  }
  assert.deepEqual(await checkTurnstile(prod, "t", KEY, ts({ ...prodOk, hostname: "evil.com" })), { outcome: "rejected" });
  assert.deepEqual(await checkTurnstile(prod, "t", KEY, ts({ ...prodOk, action: "otra" })), { outcome: "rejected" });
  assert.deepEqual(await checkTurnstile(prod, "", KEY, ts(prodOk)), { outcome: "rejected" }); // sin token
  // del servicio o de la configuración: 503
  const servicio: [string, typeof fetch][] = [
    ["invalid_secret", ts({ success: false, "error-codes": ["invalid-input-secret"] })],
    ["missing_secret", ts({ success: false, "error-codes": ["missing-input-secret"] })],
    ["bad_request", ts({ success: false, "error-codes": ["bad-request"] })],
    ["internal_error", ts({ success: false, "error-codes": ["internal-error"] })],
    ["invalid_secret", ts({ success: false, "error-codes": ["invalid-input-response", "invalid-input-secret"] })],
    ["http_500", ts("oops", 500)],
    ["http_429", ts({ success: false }, 429)],
    ["non_json", ts("<html>gateway</html>")],
    ["non_json", ts("null")],
    ["timeout", (async () => { throw new DOMException("The operation timed out.", "TimeoutError"); }) as unknown as typeof fetch],
    ["timeout", (async () => { throw new DOMException("aborted", "AbortError"); }) as unknown as typeof fetch],
    ["network", (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch],
  ];
  for (const [cause, f] of servicio) assert.deepEqual(await checkTurnstile(prod, "t", KEY, f), { outcome: "unavailable", cause }, cause);
  // verifyTurnstile sigue devolviendo true solo con un token válido
  assert.equal(await verifyTurnstile(prod, "t", KEY, ts(prodOk)), true);
  assert.equal(await verifyTurnstile(prod, "t", KEY, ts("oops", 500)), false);
});

test("SRV-01: un fallo del servicio de Turnstile es 503 reintentable con CB_ALERT turnstile, no un 403 'verify you're human'", async () => {
  const casos: [string, () => Response | Promise<Response>][] = [
    ["invalid_secret", () => new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-secret"] }))],
    ["http_503", () => new Response("down", { status: 503 })],
    ["non_json", () => new Response("<html>")],
    ["timeout", () => { throw new DOMException("timed out", "TimeoutError"); }],
    ["network", () => { throw new TypeError("fetch failed"); }],
  ];
  for (const [causa, siteverify] of casos) {
    const m = mkDeps({ siteverify });
    const res = await handleRequest(post(reqBody), m.deps);
    assert.equal(res.status, 503, causa);
    assert.deepEqual(await res.json(), { error: "unavailable" });
    assert.deepEqual(m.logs, [`CB_ALERT turnstile causa=${causa}`], causa);
    assert.equal(m.receptorCalls(), 0, "sin Turnstile no se llama al receptor");
    assert.ok(!m.logs.join("").includes("TOKEN-SECRETO") && !m.logs.join("").includes("Ana"));
  }
  // el rechazo del usuario sigue siendo 403 y no deja línea de alerta
  const m = mkDeps({ siteverify: () => new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] })) });
  const res = await handleRequest(post(reqBody), m.deps);
  assert.equal(res.status, 403);
  assert.deepEqual(m.logs, []);
  assert.equal(m.receptorCalls(), 0);
  // y con Turnstile bien, el flujo sigue hasta el 201
  assert.equal((await handleRequest(post(reqBody), mkDeps().deps)).status, 201);
});

// ---- SRV-01 · R2: CB_ALERT r2

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0]);
const permit = signPermit({ lead_id: "L-1", carpeta: "solicitudes/TEST-0001-aaaaaaaa/", n_max: 2, exp: NOW + 900 }, "ps");
const r2With = (over: Partial<R2Client>): R2Client => ({
  presignPut: async () => "https://r2.example/x", head: async () => ({ size: 4 }), firstBytes: async () => JPEG.slice(0, 3), remove: async () => {}, ...over,
});

test("SRV-01: los dos catch de R2 dejan 'CB_ALERT r2 fn=<función> causa=<palabra fija>' sin mensajes ni claves", async () => {
  const casos: [string, Partial<R2Client>][] = [
    ["head_403", { head: async () => { throw new Error("r2 head 403"); } }],
    ["head_503", { head: async () => { throw new Error("r2 head 503"); } }],
    ["get_500", { firstBytes: async () => { throw new Error("r2 get 500"); } }],
    ["timeout", { head: async () => { throw new DOMException("The operation timed out.", "TimeoutError"); } }],
    ["timeout", { firstBytes: async () => { throw new DOMException("aborted", "AbortError"); } }],
    ["error", { head: async () => { throw new TypeError("accessKeyId SECRETA-NO-LOGUEAR is invalid"); } }],
    ["error", { head: async () => { throw new Error("r2 head 403 con texto de más SECRETA"); } }],
  ];
  for (const [causa, over] of casos) {
    const m = mkDeps({ r2: () => r2With(over) });
    const res = await handlePhotosDone(post({ permiso: permit, fotos: [{ n: 1 }] }), m.deps);
    assert.equal(res.status, 503, causa);
    assert.deepEqual(m.logs, [`CB_ALERT r2 fn=cb-photos-done causa=${causa}`], causa);
    assert.ok(!m.logs.join("").includes("SECRETA"));
  }
  // cb-photo-urls
  const firma = mkDeps({ r2: () => r2With({ presignPut: async () => { throw new TypeError("boom SECRETA"); } }) });
  const res = await handlePhotoUrls(post({ permiso: permit, fotos: [{ n: 1, size: 10 }] }), firma.deps);
  assert.equal(res.status, 503);
  assert.deepEqual(firma.logs, ["CB_ALERT r2 fn=cb-photo-urls causa=error"]);
  const build = mkDeps({ r2: () => { throw new TypeError("accessKeyId is a required option"); } });
  assert.equal((await handlePhotoUrls(post({ permiso: permit, fotos: [{ n: 1, size: 10 }] }), build.deps)).status, 503);
  assert.deepEqual(build.logs, ["CB_ALERT r2 fn=cb-photo-urls causa=error"]);
  // sin fallo de R2 no hay línea
  const bien = mkDeps({ r2: () => r2With({}) });
  assert.equal((await handlePhotoUrls(post({ permiso: permit, fotos: [{ n: 1, size: 10 }] }), bien.deps)).status, 200);
  assert.deepEqual(bien.logs, []);
});

// ---- SRV-03 · tiempo del cliente para cb-photos-done

test("SRV-03: el tiempo del cliente para cb-photos-done es mayor que el peor caso del servidor y menor que el corte de la Function", () => {
  const FUNCTION_LIMIT_MS = 60_000; // Function síncrona de Netlify (cifra de la auditoría; la cuenta no se puede ver desde el código)
  const RECEPTOR_MS = 8_000;        // netlify/lib/receptor.ts
  const peorServidor = 3 * 3 * R2_TIMEOUT_MS + RECEPTOR_MS; // 3 fotos x (HEAD + GET + DELETE) x 4 s + receptor
  assert.equal(peorServidor, 44_000);
  assert.ok(CB_TIMEOUTS.photosDone > peorServidor, "el cliente no se rinde mientras el servidor aún registra las fotos");
  assert.ok(CB_TIMEOUTS.photosDone < FUNCTION_LIMIT_MS, "y espera menos que el corte de la Function");
  assert.equal(CB_TIMEOUTS.photosDone, 50_000);
  // y el total de la subida cabe en el PUT prefirmado (300 s) y en el permiso (15 min)
  assert.ok(CB_TIMEOUTS.put * 3 < 300_000);
  assert.ok(CB_TIMEOUTS.photoUrls + CB_TIMEOUTS.put * 3 + CB_TIMEOUTS.photosDone < 15 * 60_000);
});
