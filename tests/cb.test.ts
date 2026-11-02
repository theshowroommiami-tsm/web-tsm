import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { validateRequest, normalizePhone, isUuidV4 } from "../shared/cb-schema.ts";
import { captureAttribution, loadAttribution, saveAttribution, ATTRIBUTION_TTL_MS } from "../shared/cb-attribution.ts";
import { signPermit, verifyPermit } from "../netlify/lib/permit.ts";
import { signPayload, receptorErrorStatus } from "../netlify/lib/receptor.ts";
import { verifyTurnstile, TURNSTILE_TEST_SECRET } from "../netlify/lib/turnstile.ts";
import { handleRequest, handlePhotoUrls, handlePhotosDone, type Deps, type R2Client } from "../netlify/lib/handlers.ts";

const KEY = "3b1f5c2e-8d4a-4b7e-9a21-5f6c7d8e9a0b";
const valid = { nombre: "Ana", telefono: "+13055550123", correo: "ana@example.com", marca: "BMW", modelo: "M3", anio: "2020", zona: "33101", servicio: "Full build", descripcion: "Widebody kit\nand paint" };
const NOW = 1_800_000_000;

// ---- esquema
test("schema: teléfono y correo obligatorios", () => {
  assert.equal(validateRequest(valid).ok, true); // ambos válidos
  const { telefono, correo, ...base } = valid;
  const sinTel = validateRequest({ ...base, correo });
  assert.equal(sinTel.ok, false);
  assert.deepEqual(sinTel.errors, { telefono: "Enter your phone number." });
  const sinCorreo = validateRequest({ ...base, telefono });
  assert.equal(sinCorreo.ok, false);
  assert.deepEqual(sinCorreo.errors, { correo: "Enter your email address." });
  const ninguno = validateRequest(base);
  assert.equal(ninguno.ok, false);
  assert.deepEqual(ninguno.errors, { telefono: "Enter your phone number.", correo: "Enter your email address." });
  const blancos = validateRequest({ ...base, telefono: "   ", correo: " \t " });
  assert.equal(blancos.ok, false);
  assert.deepEqual(blancos.errors, { telefono: "Enter your phone number.", correo: "Enter your email address." });
  const correoMalo = validateRequest({ ...valid, correo: "ana@" });
  assert.equal(correoMalo.ok, false);
  assert.deepEqual(correoMalo.errors, { correo: "Enter a valid email address." });
  const telMalo = validateRequest({ ...valid, telefono: "3055550123" });
  assert.equal(telMalo.ok, false);
  assert.deepEqual(telMalo.errors, { telefono: "Enter a valid phone number." });
  // Teléfonos inventados: pasar el E.164 no basta (si no, dos falsos iguales marcarían un duplicado y apagarían la medición)
  for (const falso of ["0000000000", "1111111111", "5555555555", "1234567890", "+10000000000", "+15555555555", "+17777777777", "+4444444444"]) {
    const r = validateRequest({ ...valid, telefono: normalizePhone(falso) || falso });
    assert.equal(r.ok, false, falso);
    assert.deepEqual(r.errors, { telefono: "Enter a valid phone number." }, falso);
  }
  // Los reales siguen pasando: US en cualquier formato, y números de otro país con "+"
  for (const real of ["(305) 555-0123", "1 786 555 0199", "+13055550123", "+442079460958", "+521551234567"]) {
    assert.equal(validateRequest({ ...valid, telefono: normalizePhone(real) }).ok, true, real);
  }
});
test("schema: largos, año, E.164, enums y tipos", () => {
  assert.equal(validateRequest({ ...valid, nombre: "x".repeat(121) }).ok, false);
  assert.equal(validateRequest({ ...valid, anio: "20x0" }).ok, false);
  assert.equal(validateRequest({ ...valid, telefono: "3055550123" }).ok, false);
  assert.equal(validateRequest({ ...valid, origen: "otro" }).ok, false);
  assert.equal(validateRequest({ ...valid, nombre: 5 }).ok, false);
  assert.equal(validateRequest(null).ok, false);
});
test("schema: descripción conserva saltos de línea, el resto se aplana", () => {
  const r = validateRequest({ ...valid, nombre: "Ana\n  M" });
  assert.ok(r.ok && r.data.nombre === "Ana M" && r.data.descripcion.includes("\n"));
});
test("normalizePhone y UUID v4", () => {
  assert.equal(normalizePhone("(305) 555-0123"), "+13055550123");
  assert.equal(normalizePhone("1 305 555 0123"), "+13055550123");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("123"), "");
  assert.ok(isUuidV4(KEY)); assert.ok(!isUuidV4("nope"));
});

// ---- atribución
test("atribución: clasificación y precedencia", () => {
  const a = captureAttribution("?gclid=abc&utm_source=google&utm_medium=cpc", "/custom-builds", "https://www.google.com/", "showroommiami.com");
  assert.equal(a?.origen, "google_ads"); assert.equal(a?.click_id_tipo, "gclid"); assert.equal(a?.referrer, "www.google.com");
  assert.equal(captureAttribution("?utm_source=ig", "/", "", "showroommiami.com")?.origen, "utm");
  assert.equal(captureAttribution("?wbraid=w1", "/", "", "x.com")?.click_id_tipo, "wbraid");
  const ref = captureAttribution("", "/sales", "https://example.org/page?x=1", "showroommiami.com");
  assert.equal(ref?.origen, "referral"); assert.equal(ref?.referrer, "example.org"); assert.equal(ref?.aterrizaje, "/sales");
  assert.equal(captureAttribution("", "/", "", "showroommiami.com"), null);
  assert.equal(captureAttribution("", "/", "https://www.showroommiami.com/x", "showroommiami.com"), null);
});
test("atribución: 90 días", () => {
  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  saveAttribution(store, { origen: "utm", utm_source: "ig" }, 1000);
  assert.equal(loadAttribution(store, 1000 + ATTRIBUTION_TTL_MS - 1)?.utm_source, "ig");
  assert.equal(loadAttribution(store, 1000 + ATTRIBUTION_TTL_MS + 1), null);
  assert.equal(m.size, 0);
});

// ---- permiso
test("permiso: firma, expiración y manipulación", () => {
  const p = { lead_id: "L1", carpeta: "solicitudes/CB-0001-1a2b3c4d/", n_max: 2, exp: NOW + 900 };
  const t = signPermit(p, "s3cret");
  assert.deepEqual(verifyPermit(t, "s3cret", NOW), p);
  assert.equal(verifyPermit(t, "otro", NOW), null);
  assert.equal(verifyPermit(t, "s3cret", NOW + 900), null); // now >= exp
  assert.equal(verifyPermit(t, "s3cret", NOW + 899)?.n_max, 2);
  const [seg, sig] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ ...p, n_max: 3 })).toString("base64url");
  assert.equal(verifyPermit(`${forged}.${sig}`, "s3cret", NOW), null);
  assert.equal(verifyPermit(seg, "s3cret", NOW), null);
  assert.equal(verifyPermit(undefined, "s3cret", NOW), null);
  const evil = signPermit({ ...p, carpeta: "../x/" }, "s3cret");
  assert.equal(verifyPermit(evil, "s3cret", NOW), null);
});

// ---- receptor
test("receptor: HMAC usa el texto hex como clave", () => {
  const hex = "ab".repeat(32);
  assert.equal(signPayload("{}", hex), createHmac("sha256", Buffer.from(hex, "utf8")).update("{}").digest("hex"));
  assert.notEqual(signPayload("{}", hex), createHmac("sha256", Buffer.from(hex, "hex")).update("{}").digest("hex"));
});
test("receptor: tabla de errores", () => {
  assert.equal(receptorErrorStatus("cupo").status, 429);
  assert.equal(receptorErrorStatus("datos").status, 400);
  assert.equal(receptorErrorStatus("clave").status, 400);
  assert.equal(receptorErrorStatus("ocupado").status, 503);
  assert.equal(receptorErrorStatus("interno").status, 503);
  assert.equal(receptorErrorStatus("lead").status, 409);
  for (const e of ["firma", "vencido", "entorno", "formato", "accion", "metodo", "config"]) {
    assert.deepEqual(receptorErrorStatus(e), { status: 500, alert: true });
  }
});

// ---- turnstile
const ts = (j: object) => (async () => new Response(JSON.stringify(j))) as unknown as typeof fetch;
test("turnstile: producción exige hostname y acción; preview usa la clave de prueba sin hostname", async () => {
  const prod = { entorno: "production" as const, secret: "S" };
  assert.equal(await verifyTurnstile(prod, "t", KEY, ts({ success: true, hostname: "showroommiami.com", action: "cb_request" })), true);
  assert.equal(await verifyTurnstile(prod, "t", KEY, ts({ success: true, hostname: "evil.com", action: "cb_request" })), false);
  assert.equal(await verifyTurnstile(prod, "t", KEY, ts({ success: true, hostname: "www.showroommiami.com", action: "otra" })), false);
  assert.equal(await verifyTurnstile({ entorno: "production" }, "t", KEY, ts({ success: true })), false);
  let sent: any;
  const spy = (async (_u: string, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ success: true, hostname: "deploy-preview-1--web-tsm.netlify.app" })); }) as unknown as typeof fetch;
  assert.equal(await verifyTurnstile({ entorno: "preview", secret: "IGNORED" }, "t", KEY, spy), true);
  assert.equal(sent.secret, TURNSTILE_TEST_SECRET); assert.equal(sent.idempotency_key, KEY);
  assert.equal(await verifyTurnstile({ entorno: "preview" }, "", KEY, spy), false);
});

// ---- handlers
function mkR2(files: Record<string, Uint8Array>): R2Client & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    presignPut: async (k, s) => `https://r2.example/${k}?size=${s}`,
    head: async (k) => (files[k] ? { size: files[k].length } : null),
    firstBytes: async (k) => files[k]?.slice(0, 3) ?? null,
    remove: async (k) => { removed.push(k); delete files[k]; },
  };
}
function mkDeps(over: Partial<Deps> & { receptorReply?: object } = {}): Deps & { calls: any[] } {
  const calls: any[] = [];
  const reply = over.receptorReply ?? { ok: true, replay: false, lead_id: "L-1", folio: "TEST-0001", carpeta: "solicitudes/TEST-0001-aaaaaaaa/", duplicado: false, fotos_esperadas: 2 };
  const fetchImpl = (async (url: string, init: any) => {
    if (String(url).includes("turnstile")) return new Response(JSON.stringify({ success: true }));
    calls.push(JSON.parse(JSON.parse(init.body).payload));
    return new Response(JSON.stringify(reply));
  }) as unknown as typeof fetch;
  return { entorno: "preview", permitSecret: "ps", receptor: { url: "https://rec", secret: "cd".repeat(32) }, r2: () => mkR2({}), fetchImpl, now: () => NOW, calls, ...over };
}
const post = (body: unknown) => new Request("https://x/api", { method: "POST", body: JSON.stringify(body) });
const reqBody = { clave: KEY, token: "tok", campos: valid, fotos_esperadas: 2 };

test("cb-request: 201 con lead_id, permiso y medir; sin datos personales", async () => {
  const d = mkDeps();
  const res = await handleRequest(post(reqBody), d);
  assert.equal(res.status, 201);
  const j = await res.json();
  assert.deepEqual(Object.keys(j).sort(), ["lead_id", "medir", "permiso"]);
  assert.equal(j.medir, true);
  const p = verifyPermit(j.permiso, "ps", NOW)!;
  assert.deepEqual([p.lead_id, p.n_max, p.exp], ["L-1", 2, NOW + 900]);
  assert.equal(d.calls[0].accion, "crear"); assert.equal(d.calls[0].datos.clave, KEY); assert.equal(d.calls[0].entorno, "preview");
  assert.ok(!JSON.stringify(j).includes("Ana"));
});
test("cb-request: duplicado => medir false; sin fotos => sin permiso", async () => {
  const dup = await (await handleRequest(post(reqBody), mkDeps({ receptorReply: { ok: true, lead_id: "L", carpeta: "solicitudes/T-1-aaaaaaaa/", duplicado: true, fotos_esperadas: 1 } }))).json();
  assert.equal(dup.medir, false);
  const none = await (await handleRequest(post({ ...reqBody, fotos_esperadas: 0 }), mkDeps({ receptorReply: { ok: true, lead_id: "L", carpeta: "", duplicado: false, fotos_esperadas: 0 } }))).json();
  assert.equal(none.permiso, null);
});
test("cb-request: teléfono y correo obligatorios => 400 sin llamar al receptor ni emitir lead", async () => {
  const { telefono, correo, ...base } = valid;
  for (const [campos, falta] of [[{ ...base, telefono }, "correo"], [{ ...base, correo }, "telefono"]] as const) {
    const d = mkDeps();
    let fetched = 0;
    const inner = d.fetchImpl!;
    d.fetchImpl = ((...a: Parameters<typeof fetch>) => { fetched++; return inner(...a); }) as typeof fetch;
    const res = await handleRequest(post({ ...reqBody, campos }), d);
    assert.equal(res.status, 400);
    const j = await res.json();
    assert.deepEqual(j, { error: "invalid", campos: [falta] });
    assert.ok(!("lead_id" in j) && !("permiso" in j)); // no hay lead que medir
    assert.equal(fetched, 0); // ni Turnstile ni receptor
    assert.equal(d.calls.length, 0);
  }
});
test("cb-request: 400, 403, 405, 500 y errores del receptor", async () => {
  assert.equal((await handleRequest(post({ ...reqBody, campos: { ...valid, nombre: "" } }), mkDeps())).status, 400);
  assert.equal((await handleRequest(post({ ...reqBody, clave: "x" }), mkDeps())).status, 400);
  assert.equal((await handleRequest(post({ ...reqBody, fotos_esperadas: 4 }), mkDeps())).status, 400);
  assert.equal((await handleRequest(new Request("https://x", { method: "GET" }), mkDeps())).status, 405);
  assert.equal((await handleRequest(post(reqBody), mkDeps({ permitSecret: "" }))).status, 500);
  assert.equal((await handleRequest(post(reqBody), mkDeps({ entorno: "production" }))).status, 500); // falta TURNSTILE_SECRET_KEY
  for (const [error, status] of [["cupo", 429], ["datos", 400], ["ocupado", 503], ["firma", 500]] as const) {
    assert.equal((await handleRequest(post(reqBody), mkDeps({ receptorReply: { ok: false, error } }))).status, status);
  }
  const noTs = mkDeps(); noTs.fetchImpl = (async () => new Response(JSON.stringify({ success: false }))) as unknown as typeof fetch;
  const r = await handleRequest(post(reqBody), noTs);
  assert.equal(r.status, 403);
  assert.equal(noTs.calls.length, 0); // no llama al receptor
});

const permit = signPermit({ lead_id: "L-1", carpeta: "solicitudes/TEST-0001-aaaaaaaa/", n_max: 2, exp: NOW + 900 }, "ps");
test("cb-photo-urls: firma en la carpeta del permiso, rechaza tamaño, n y permiso", async () => {
  const d = mkDeps();
  const ok = await handlePhotoUrls(post({ permiso: permit, fotos: [{ n: 1, size: 1000 }, { n: 2, size: 3 * 1024 * 1024 }] }), d);
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.equal(j.urls[0].url, "https://r2.example/solicitudes/TEST-0001-aaaaaaaa/foto-1.jpg?size=1000");
  assert.equal((await handlePhotoUrls(post({ permiso: permit, fotos: [{ n: 1, size: 3 * 1024 * 1024 + 1 }] }), d)).status, 413);
  assert.equal((await handlePhotoUrls(post({ permiso: permit, fotos: [{ n: 3, size: 10 }] }), d)).status, 400);
  assert.equal((await handlePhotoUrls(post({ permiso: permit, fotos: [{ n: 1, size: 10 }, { n: 1, size: 10 }] }), d)).status, 400);
  assert.equal((await handlePhotoUrls(post({ permiso: permit, fotos: [{ n: 1, size: 0 }] }), d)).status, 400);
  assert.equal((await handlePhotoUrls(post({ permiso: "a.b", fotos: [{ n: 1, size: 10 }] }), d)).status, 401);
  assert.equal((await handlePhotoUrls(post({ permiso: permit, fotos: [{ n: 1, size: 10 }], carpeta: "../x/" }), d)).status, 200); // el cuerpo no manda la carpeta
});
test("cb-photos-done: verifica JPEG, borra lo inválido y manda al receptor solo lo verificado", async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const r2 = mkR2({ "solicitudes/TEST-0001-aaaaaaaa/foto-1.jpg": jpeg, "solicitudes/TEST-0001-aaaaaaaa/foto-2.jpg": png });
  const d = mkDeps({ r2: () => r2, receptorReply: { ok: true, folio: "TEST-0001", fotos: 1 } });
  const res = await handlePhotosDone(post({ permiso: permit, fotos: [{ n: 1, miniatura: "/9j/AAAA" }, { n: 2, miniatura: "/9j/BBBB" }] }), d);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { fotos: 1, rechazadas: [2] });
  assert.deepEqual(r2.removed, ["solicitudes/TEST-0001-aaaaaaaa/foto-2.jpg"]);
  assert.deepEqual(d.calls[0].datos, { lead_id: "L-1", fotos: [{ n: 1, miniatura: "/9j/AAAA" }] });
  assert.equal(d.calls[0].accion, "fotos");
});
test("cb-photos-done: miniatura inválida se omite; objeto ausente se rechaza; sobre 3 MB se borra; sin permiso 401", async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0]);
  const big = new Uint8Array(3 * 1024 * 1024 + 1); big.set([0xff, 0xd8, 0xff]);
  const r2 = mkR2({ "solicitudes/TEST-0001-aaaaaaaa/foto-1.jpg": jpeg, "solicitudes/TEST-0001-aaaaaaaa/foto-2.jpg": big });
  const d = mkDeps({ r2: () => r2, receptorReply: { ok: true, fotos: 1 } });
  await handlePhotosDone(post({ permiso: permit, fotos: [{ n: 1, miniatura: "<script>" }, { n: 2 }] }), d);
  assert.deepEqual(d.calls[0].datos.fotos, [{ n: 1 }]);
  assert.equal(r2.removed.length, 1);
  const none = mkDeps({ r2: () => mkR2({}) });
  assert.deepEqual(await (await handlePhotosDone(post({ permiso: permit, fotos: [{ n: 1 }] }), none)).json(), { fotos: 0, rechazadas: [1] });
  assert.equal(none.calls.length, 0);
  assert.equal((await handlePhotosDone(post({ fotos: [{ n: 1 }] }), d)).status, 401);
  const lead = mkDeps({ r2: () => mkR2({ "solicitudes/TEST-0001-aaaaaaaa/foto-1.jpg": jpeg }), receptorReply: { ok: false, error: "lead" } });
  assert.equal((await handlePhotosDone(post({ permiso: permit, fotos: [{ n: 1 }] }), lead)).status, 409);
});
