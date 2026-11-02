// Tercera ronda del cierre de web-tsm#24: el observador de CALL NOW (NAV-R3-01), el aviso previo a la hidratación
// (NAV-R3-02), el tiempo máximo de las fotos (NAV-R3-03), la huella del último fallo en el borrador (F-A, F-C), el foco y
// el anuncio de las fotos (A11Y-01), la guardia por anfitrión (S-02), Turnstile (S-01, S-04, S-05, F-E) y los textos
// (TXT-01), y al final los hallazgos de la revisión de esta ronda (R3-REV-01 a 04, F-01 a F-03, F1 a F5). Pruebas de
// comportamiento: cada una ejercita la función o el HTML renderizado, no el código fuente; la única excepción, el cableado
// de EstimateForm, está rotulada (no hay DOM en el repo para montar el componente).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SubmitOutcome } from "../src/lib/cbClient.ts";
import { clearDraft, loadDraft, saveDraft } from "../src/lib/cbClient.ts";
import type { ProcessedPhoto } from "../src/lib/cbPhotos.ts";
import { CB_LOADING, CB_NOTICES, CB_PREPARING, CB_UPLOADING } from "../src/lib/cbCopy.ts";
import { latestVisibility, watchInView } from "../src/lib/cbFloatingCall.ts";
import {
  LOADING_FOLD_MS, MSG_TOO_MANY, MSG_UNPREPARED, MSG_UNREADABLE, PHOTO_PREPARE_TIMEOUT_MS, createBusyCounter, draftOf, fingerprint,
  photoFocusTarget, prepareFiles, runSubmit, sessionOf, shouldRestorePhotoFocus, type SubmitDeps, type SubmitSession,
} from "../src/lib/cbSubmit.ts";
import { BUSINESS_PHONE_DISPLAY, BUSINESS_PHONE_HREF } from "../src/config/business.ts";
import { ATTRIBUTION_FIELDS } from "../shared/cb-attribution.ts";
import { MAX_LEN } from "../shared/cb-schema.ts";
import { depsFromEnv, entornoFor, hostsOf, isDeployPreviewHost, isPreviewHost } from "../netlify/lib/env.ts";
import { configProblems, handleRequest, humanGate, type Deps, type R2Client } from "../netlify/lib/handlers.ts";
import { signPermit } from "../netlify/lib/permit.ts";
import { PROD_HOSTNAMES, TURNSTILE_TEST_SECRET, checkTurnstile } from "../netlify/lib/turnstile.ts";
import { renderCustomBuildsAnchors, renderCustomBuildsHtml, renderEstimateFormHtml, renderLoadingNoticeHtml } from "./helpers/render-form.ts";

const KEY = "3b1f5c2e-8d4a-4b7e-9a21-5f6c7d8e9a0b";
const NOW = 1_800_000_000;
const LEAD = "6f1c0a52-9a3e-4d0b-8f7c-2b5d4e1a9c33";
const REAL_SECRET = "0x4AAAAAAADRealSecretKeyNoLoguear1234567890";
const valid = { nombre: "Ana", telefono: "+13055550123", correo: "ana@example.com", marca: "BMW", modelo: "M3", anio: "2020", zona: "33101", servicio: "Full build", descripcion: "Widebody kit" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const photo = (n: number | string): ProcessedPhoto => ({ name: `f${n}.jpg`, blob: new Blob([new Uint8Array(10)]), thumb: "/9j/x", previewUrl: `blob:${n}` });

// ---- T2 · NAV-R3-01 · CALL NOW: la entrada más reciente manda

type Entry = { target: unknown; isIntersecting: boolean };

/** IntersectionObserver simulado: guarda el callback para entregar lotes a mano. */
function fakeObserver() {
  const made: { cb: (entries: Entry[]) => void; observed: unknown[]; disconnected: boolean }[] = [];
  class FakeIO {
    rec: (typeof made)[number];
    constructor(cb: (entries: Entry[]) => void) { this.rec = { cb, observed: [], disconnected: false }; made.push(this.rec); }
    observe(t: unknown) { this.rec.observed.push(t); }
    disconnect() { this.rec.disconnected = true; }
  }
  return { FakeIO, made };
}

test("NAV-R3-01: un lote con dos entradas del formulario (entra y sale) deja el estado de la ÚLTIMA", () => {
  const form = {};
  const { FakeIO, made } = fakeObserver();
  const states: boolean[] = [];
  watchInView(form, (v) => states.push(v), FakeIO);
  assert.deepEqual(made[0].observed, [form]);

  made[0].cb([{ target: form, isIntersecting: true }, { target: form, isIntersecting: false }]); // entró y salió
  assert.deepEqual(states, [false]); // fuera de pantalla: CALL NOW visible (la primera entrada lo habría ocultado)
  made[0].cb([{ target: form, isIntersecting: false }, { target: form, isIntersecting: true }]); // salió y entró
  assert.deepEqual(states, [false, true]);
  // y con tres
  made[0].cb([{ target: form, isIntersecting: false }, { target: form, isIntersecting: true }, { target: form, isIntersecting: false }]);
  assert.equal(states.at(-1), false);
});

test("NAV-R3-01: las entradas de otros elementos no cuentan; un lote sin el formulario no cambia nada; disconnect se propaga", () => {
  const form = {}, other = {};
  assert.equal(latestVisibility([{ target: form, isIntersecting: true }, { target: other, isIntersecting: false }], form), true);
  assert.equal(latestVisibility([{ target: other, isIntersecting: true }], form), null);
  assert.equal(latestVisibility([], form), null);

  const { FakeIO, made } = fakeObserver();
  const states: boolean[] = [];
  const stop = watchInView(form, (v) => states.push(v), FakeIO);
  made[0].cb([{ target: other, isIntersecting: true }]);
  assert.deepEqual(states, []);
  stop();
  assert.equal(made[0].disconnected, true);
});

test("NAV-R3-01: sin IntersectionObserver no avisa nunca (CALL NOW queda visible) y la función de parada no lanza", () => {
  const states: boolean[] = [];
  const stop = watchInView({}, (v) => states.push(v), null);
  assert.doesNotThrow(stop);
  assert.deepEqual(states, []);
});

// ---- T3 · NAV-R3-02 · aviso previo a la hidratación

/** Texto del HTML tal como lo lee el navegador: sin los comentarios que React deja entre textos contiguos y sin escapes. */
const unescape = (h: string) => h.replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

test("NAV-R3-02: el HTML del servidor trae el aviso con el enlace tel: antes de los campos, y los controles siguen deshabilitados", async () => {
  const html = await renderEstimateFormHtml();
  const text = unescape(html);
  assert.equal(CB_LOADING, "The form is loading. If it doesn't load, please call us at");
  const link = `<a href="${BUSINESS_PHONE_HREF}" data-call-location="page_body" class="font-semibold underline whitespace-nowrap">${BUSINESS_PHONE_DISPLAY}</a>`;
  const notice = `${CB_LOADING} ${link}.`;
  assert.ok(text.includes(notice), "el aviso con su enlace");
  assert.equal(BUSINESS_PHONE_HREF, "tel:+13054198379"); // el teléfono sale de @/config/business, nunca escrito a mano
  // dentro del formulario y antes de los campos
  const iForm = text.indexOf("<form"), iNotice = text.indexOf(notice), iFieldset = text.indexOf("<fieldset"), iName = text.indexOf('name="nombre"');
  assert.ok(iForm < iNotice && iNotice < iFieldset && iFieldset < iName, "form < aviso < fieldset < primer campo");
  // el formulario sigue sin poder enviarse: fieldset disabled y botón deshabilitado
  assert.match(/<fieldset\b[^>]*>/.exec(html)![0], /\bdisabled(=""|\s|>)/);
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""[^>]*>Request Estimate<\/button>/);
  // el aviso no es un control: no hay ningún control antes del fieldset
  assert.doesNotMatch(html.slice(iForm, iFieldset), /<(input|select|textarea|button)\b/);
});

test("NAV-R3-02: hidratado (ready) el aviso no se dibuja; sin hidratar sí", async () => {
  const antes = await renderLoadingNoticeHtml(false);
  assert.ok(unescape(antes).includes(CB_LOADING));
  assert.ok(antes.includes(`href="${BUSINESS_PHONE_HREF}"`));
  assert.doesNotMatch(antes, /aria-hidden/);
  assert.equal(await renderLoadingNoticeHtml(true), ""); // sin texto, sin teléfono, sin hueco
});

// ---- T4 · NAV-R3-03 · una foto que no termina no bloquea

const files = (...names: string[]) => names.map((name) => ({ name }));

test("NAV-R3-03: una promesa que nunca resuelve se descarta a su tiempo, con aviso, y las otras fotos del lote se conservan", async () => {
  assert.equal(PHOTO_PREPARE_TIMEOUT_MS, 20_000);
  const process = (f: { name: string }) => (f.name === "cuelga.jpg" ? new Promise<ProcessedPhoto>(() => {}) : Promise.resolve(photo(f.name)));
  const t0 = Date.now();
  const { added, message } = await prepareFiles(files("a.jpg", "cuelga.jpg", "c.jpg"), 3, 3, process, 40);
  assert.ok(Date.now() - t0 < 2000, "no espera a la promesa que nunca llega");
  assert.deepEqual(added.map((p) => p.name), ["fa.jpg.jpg", "fc.jpg.jpg"]); // photo() le pone "f" y ".jpg" al nombre
  assert.equal(message, MSG_UNPREPARED("cuelga.jpg"));
  assert.equal(MSG_UNPREPARED("cuelga.jpg"), 'We couldn\'t prepare "cuelga.jpg". Please try another photo.');
});

test("NAV-R3-03: el tiempo es POR foto: dos fotos lentas pero dentro de su tiempo se conservan las dos", async () => {
  const lenta = async (f: { name: string }) => { await sleep(60); return photo(f.name); };
  const { added, message } = await prepareFiles(files("a", "b"), 3, 3, lenta, 150); // 120 ms en total, pero cada una usa 60 de sus 150
  assert.equal(added.length, 2);
  assert.equal(message, "");
});

test("NAV-R3-03: una foto ilegible conserva su aviso propio; la que llega tarde libera su vista previa", async () => {
  const roto = await prepareFiles(files("ok", "roto.heic"), 3, 3, async (f) => { if (f.name === "roto.heic") throw new Error("decode"); return photo(f.name); }, 100);
  assert.equal(roto.added.length, 1);
  assert.equal(roto.message, MSG_UNREADABLE("roto.heic"));

  const revoked: string[] = [];
  const real = URL.revokeObjectURL;
  URL.revokeObjectURL = (u: string) => { revoked.push(u); };
  try {
    const tarde = await prepareFiles(files("tarde"), 3, 3, async () => { await sleep(80); return photo("tarde"); }, 20);
    assert.equal(tarde.added.length, 0);
    assert.equal(tarde.message, MSG_UNPREPARED("tarde"));
    await sleep(150);
    assert.deepEqual(revoked, ["blob:tarde"]); // no queda una URL de objeto huérfana
  } finally { URL.revokeObjectURL = real; }
});

test("NAV-R3-03: el tope de fotos sigue como antes y el aviso de la foto descartada gana sobre el del tope", async () => {
  const proc = async (f: { name: string }) => photo(f.name);
  const exceso = await prepareFiles(files("1", "2", "3", "4"), 2, 3, proc, 50);
  assert.deepEqual([exceso.added.length, exceso.message], [2, MSG_TOO_MANY(3)]);
  const ambos = await prepareFiles(files("cuelga", "2", "3"), 2, 3, (f) => (f.name === "cuelga" ? new Promise<ProcessedPhoto>(() => {}) : proc(f)), 30);
  assert.equal(ambos.message, MSG_UNPREPARED("cuelga"));
  assert.equal(ambos.added.length, 1);
});

test("NAV-R3-03: el contador de 'preparando' vuelve a cero siempre: con una foto colgada, con error y con éxito", async () => {
  const seen: number[] = [];
  const c = createBusyCounter((n) => seen.push(n));
  const cuelga = () => new Promise<ProcessedPhoto>(() => {});
  const r = await c.track(() => prepareFiles(files("a", "b"), 3, 3, (f) => (f.name === "a" ? cuelga() : Promise.resolve(photo("b"))), 30));
  assert.equal(r.added.length, 1);
  assert.equal(c.count, 0);
  assert.deepEqual(seen, [1, 0]);

  await assert.rejects(c.track(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(c.count, 0);
  // dos cargas a la vez: sube a 2 y baja a 0 solo cuando terminan las dos (el envío espera a ambas)
  seen.length = 0;
  await Promise.all([c.track(() => sleep(20)), c.track(() => sleep(40))]);
  assert.deepEqual(seen, [1, 2, 1, 0]);
  assert.equal(c.count, 0);
});

// ---- T5 · F-A, F-C · la huella del último fallo sobrevive a la recarga

/** sessionStorage en memoria para loadDraft, saveDraft y clearDraft. */
async function withMemorySession(fn: (raw: () => string | null) => Promise<void>): Promise<void> {
  const m = new Map<string, string>();
  const g = globalThis as { sessionStorage?: unknown };
  const had = g.sessionStorage;
  g.sessionStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  try { await fn(() => m.get("tsm_cb_draft") ?? null); } finally { if (had === undefined) delete g.sessionStorage; else g.sessionStorage = had; }
}

const base = { ...valid, origen: "unknown" };
const ok = (): SubmitOutcome => ({ kind: "ok", leadId: LEAD, permiso: null, medir: true });

let keySeq = 0; // las claves nuevas no se repiten entre páginas, como los UUID reales
/** La página como la arma EstimateForm: la sesión sale del borrador y cada callback guarda el borrador con draftOf. */
function openPage(outcomes: SubmitOutcome[]) {
  const draft = loadDraft();
  const s: SubmitSession = sessionOf(draft);
  const fields = draft?.fields ?? { nombre: "Ana" };
  const posts: { clave: string; token: string }[] = [];
  const resets: number[] = [];
  let i = 0;
  const deps: SubmitDeps = {
    postRequest: async (clave, token) => { posts.push({ clave, token }); return outcomes[Math.min(i++, outcomes.length - 1)]; },
    uploadPhotos: async () => 0,
    trackGenerateLead: () => {},
    newKey: () => `3b1f5c2e-8d4a-4b7e-9a21-5f6c7d8e${String(++keySeq).padStart(4, "0")}`,
    onKeyChange: () => saveDraft(draftOf(fields, s)),
    onAttemptFailed: () => saveDraft(draftOf(fields, s)),
    resetTurnstile: () => { resets.push(posts.length); },
    clearDraft,
    onUploading: () => {},
  };
  return { s, deps, posts, resets, send: (campos: Record<string, string>, token = "T") => runSubmit({ campos, token, photos: [] }, s, deps) };
}

test("F-A: fallo 503, recarga, cambio de un dato y reenvío => clave NUEVA (la corrección no se pierde)", async () => {
  await withMemorySession(async (raw) => {
    const p1 = openPage([{ kind: "retry" }, ok()]);
    await p1.send(base, "T1");
    const claveFallida = p1.posts[0].clave;
    assert.ok(raw()!.includes('"huella"'), "el borrador lleva la huella del fallo");

    // recarga simulada: otra página, la sesión sale del borrador guardado
    const p2 = openPage([ok()]);
    assert.equal(p2.s.clave, claveFallida);
    assert.deepEqual(p2.s.failed, { print: fingerprint(base, 0), tokenUsed: false });
    const r = await p2.send({ ...base, telefono: "+13055550999" }, "T2");
    assert.deepEqual(r, { kind: "done", note: null });
    assert.notEqual(p2.posts[0].clave, claveFallida);
    assert.deepEqual(p2.resets, []); // el widget recargó con la página: su token es nuevo, no hay nada que reiniciar
    assert.equal(raw(), null); // y el éxito borra el borrador
  });
});

test("F-A: fallo 503, recarga y reenvío SIN cambios => la misma clave (replay); un 500 también", async () => {
  for (const fallo of [{ kind: "retry" }, { kind: "error" }] as SubmitOutcome[]) {
    await withMemorySession(async () => {
      const p1 = openPage([fallo]);
      await p1.send(base, "T1");
      const p2 = openPage([ok()]);
      await p2.send({ ...base }, "T2");
      assert.equal(p2.posts[0].clave, p1.posts[0].clave, fallo.kind);
    });
  }
});

test("F-A: un cambio solo de ATRIBUCIÓN conserva la clave, antes y después de la recarga (F-C)", async () => {
  const gads = { origen: "google_ads", click_id_tipo: "gclid", click_id: "Cj0KCQ-lunes", utm_source: "google", aterrizaje: "/custom-builds" };
  await withMemorySession(async () => {
    const p1 = openPage([{ kind: "retry" }, { kind: "retry" }, ok()]);
    await p1.send(base, "T1");
    await p1.send({ ...base, ...gads }, "T2"); // la atribución apareció entre intentos sin que el usuario tocara nada
    assert.equal(p1.posts[1].clave, p1.posts[0].clave);
    const p2 = openPage([ok()]);
    await p2.send({ ...base, origen: "utm", utm_source: "ig", utm_campaign: "spring", aterrizaje: "/custom-builds" }, "T3");
    assert.equal(p2.posts[0].clave, p1.posts[0].clave); // y otra distinta tras recargar
  });
  // en la huella: cada campo de atribución queda fuera; los que escribe el usuario entran
  for (const k of ATTRIBUTION_FIELDS) assert.equal(fingerprint({ ...base, [k]: "a" }, 0), fingerprint({ ...base, [k]: "b" }, 0), k);
  for (const k of Object.keys(valid)) assert.notEqual(fingerprint({ ...base, [k]: "a" }, 0), fingerprint({ ...base, [k]: "b" }, 0), k);
  assert.notEqual(fingerprint(base, 0), fingerprint(base, 1)); // las fotos siguen contando
});

test("F-A: un borrador viejo (sin huella) carga igual y su clave se conserva; sin clave no hay nada que restaurar; el éxito lo borra", async () => {
  await withMemorySession(async (raw) => {
    saveDraft({ fields: { nombre: "Ana" }, clave: KEY }); // forma vieja: {fields, clave}
    assert.equal(raw(), JSON.stringify({ fields: { nombre: "Ana" }, clave: KEY }));
    assert.deepEqual(loadDraft(), { fields: { nombre: "Ana" }, clave: KEY });
    assert.deepEqual(sessionOf(loadDraft()), { clave: KEY, failed: null });
    const p = openPage([ok()]);
    await p.send(base);
    assert.equal(p.posts[0].clave, KEY);
    assert.equal(raw(), null);
    assert.deepEqual(sessionOf(null), { clave: "", failed: null });
  });
});

test("F-A: loadDraft ignora una huella que no es texto, vacía, demasiado larga o sin clave válida", async () => {
  const con = (huella: unknown, clave: unknown = KEY) => JSON.stringify({ fields: { nombre: "Ana" }, clave, huella });
  await withMemorySession(async () => {
    const g = globalThis as unknown as { sessionStorage: { setItem(k: string, v: string): void } };
    const load = (raw: string) => { g.sessionStorage.setItem("tsm_cb_draft", raw); return loadDraft(); };
    assert.deepEqual(load(con("[[],0]")), { fields: { nombre: "Ana" }, clave: KEY, huella: "[[],0]" });
    for (const malo of [42, null, "", { a: 1 }, ["x"], "x".repeat(50_001)]) assert.deepEqual(load(con(malo)), { fields: { nombre: "Ana" }, clave: KEY }, String(malo).slice(0, 10));
    assert.deepEqual(load(con("[[],0]", "no-es-uuid")), { fields: { nombre: "Ana" }, clave: "" }); // huella sin clave: no significa nada
  });
});

// ---- T6 · A11Y-01 · fotos: anuncio y foco

test("A11Y-01: la región role=status aria-live=polite de las fotos existe SIEMPRE (vacía) y solo cambia su texto", async () => {
  const html = await renderEstimateFormHtml();
  const region = /<p role="status" aria-live="polite" class="mt-1 text-sm text-neon-cyan">([^<]*)<\/p>/.exec(html);
  assert.ok(region, "la región está en el HTML aunque no se prepare nada");
  assert.equal(region![1], ""); // sin foto en proceso, vacía
  assert.doesNotMatch(html, new RegExp(CB_PREPARING));
  // y está junto al selector de fotos
  assert.ok(html.indexOf('id="cb-fotos"') < html.indexOf(region![0]) && html.indexOf(region![0]) < html.indexOf('id="cb-fotos-msg"'));
});

test("A11Y-01: el foco vuelve al selector de fotos si estaba en BODY o en él; si el usuario fue a otro campo, no se le quita", () => {
  const body = {}, input = {}, otro = {};
  assert.equal(shouldRestorePhotoFocus(body, body, input), true);
  assert.equal(shouldRestorePhotoFocus(input, body, input), true);
  assert.equal(shouldRestorePhotoFocus(null, body, input), true);
  assert.equal(shouldRestorePhotoFocus(undefined, body, input), true);
  assert.equal(shouldRestorePhotoFocus(otro, body, input), false);
});

// ---- T7 · S-02 · guardia por anfitrión (y por contexto)

test("S-02: isPreviewHost reconoce deploy previews y branch deploys, no el .netlify.app de producción", () => {
  for (const h of ["deploy-preview-24--web-tsm.netlify.app", "feature-x--web-tsm.netlify.app", "64f1a2b3c4--web-tsm.netlify.app", "DEPLOY-PREVIEW-3--Web-TSM.netlify.app", "deploy-preview-3.example.com"]) assert.equal(isPreviewHost(h), true, h);
  for (const h of ["web-tsm.netlify.app", "showroommiami.com", "www.showroommiami.com", "localhost", "a--b.example.com", "x--y.netlify.app.evil.com", ""]) assert.equal(isPreviewHost(h), false, h);
});

test("S-02: entornoFor, tabla de los dos mecanismos (contexto y anfitrión)", () => {
  const PREV = "deploy-preview-24--web-tsm.netlify.app", BRANCH = "feature-x--web-tsm.netlify.app", PROD_NETLIFY = "web-tsm.netlify.app";
  // [CB_ENTORNO, contexto, anfitriones, entorno, problema]
  const casos: [string, string | undefined, string[], string | null, string?][] = [
    // anfitrión: preview en el dominio de producción
    ["preview", undefined, ["showroommiami.com"], null, "CB_ENTORNO(anfitrion)"],
    ["preview", undefined, ["www.showroommiami.com"], null, "CB_ENTORNO(anfitrion)"],
    ["preview", "deploy-preview", ["showroommiami.com"], null, "CB_ENTORNO(anfitrion)"], // el contexto dice preview y el anfitrión lo desmiente
    ["preview", undefined, ["localhost", "www.showroommiami.com"], null, "CB_ENTORNO(anfitrion)"], // basta con que uno de los dos caminos lo diga
    ["preview", undefined, [PREV], "preview"],
    ["preview", undefined, [BRANCH], "preview"],
    ["preview", undefined, [PROD_NETLIFY], "preview"],
    ["preview", undefined, ["localhost"], "preview"],
    ["preview", undefined, ["algo.desconocido.org"], "preview"],
    ["preview", undefined, [], "preview"],
    // anfitrión: production en un deploy preview o un branch deploy
    ["production", undefined, [PREV], null, "CB_ENTORNO(anfitrion)"],
    ["production", undefined, [BRANCH], null, "CB_ENTORNO(anfitrion)"],
    ["production", undefined, ["64f1a2b3c4--web-tsm.netlify.app"], null, "CB_ENTORNO(anfitrion)"],
    ["production", undefined, ["deploy-preview-9.example.com"], null, "CB_ENTORNO(anfitrion)"],
    ["production", "production", [PREV], null, "CB_ENTORNO(anfitrion)"], // el contexto dice production y el anfitrión lo desmiente
    ["production", undefined, ["localhost", PREV], null, "CB_ENTORNO(anfitrion)"],
    // production NO se bloquea en el dominio .netlify.app de producción, ni en el propio, ni en otros
    ["production", undefined, [PROD_NETLIFY], "production"],
    ["production", "production", [PROD_NETLIFY, "showroommiami.com"], "production"],
    ["production", undefined, ["showroommiami.com"], "production"],
    ["production", undefined, ["www.showroommiami.com"], "production"],
    ["production", undefined, ["localhost"], "production"],
    ["production", undefined, ["algo.desconocido.org"], "production"],
    ["production", undefined, ["a--b.example.com"], "production"], // "--" solo cuenta antes de .netlify.app
    ["production", undefined, [], "production"],
    // contexto (sin cambios): tiene prioridad en el nombre de la causa
    ["preview", "production", ["localhost"], null, "CB_ENTORNO(contexto)"],
    ["production", "deploy-preview", ["showroommiami.com"], null, "CB_ENTORNO(contexto)"],
    ["production", "branch-deploy", [PROD_NETLIFY], null, "CB_ENTORNO(contexto)"],
    ["production", "deploy-preview", [PREV], null, "CB_ENTORNO(contexto)"],
    // el valor de CB_ENTORNO sigue siendo exacto
    ["Production", undefined, ["showroommiami.com"], null, "CB_ENTORNO"],
    ["", undefined, [PREV], null, "CB_ENTORNO"],
  ];
  for (const [raw, ctx, hosts, entorno, problem] of casos) {
    const r = entornoFor(raw, ctx, hosts);
    assert.equal(r.entorno, entorno, `${raw} | ${ctx} | ${hosts}`);
    assert.equal(r.problem, problem, `${raw} | ${ctx} | ${hosts}`);
  }
  assert.deepEqual(PROD_HOSTNAMES, ["showroommiami.com", "www.showroommiami.com"]);
});

test("S-02: hostsOf junta el anfitrión de la URL y el del encabezado Host, sin puerto, en minúsculas y sin punto final", () => {
  const req = (url: string, host?: string) => new Request(url, { method: "POST", headers: host ? { host } : {} });
  assert.deepEqual(hostsOf(req("https://www.showroommiami.com/api/cb-request")), ["www.showroommiami.com"]);
  assert.deepEqual(hostsOf(req("https://SHOWROOMMIAMI.com:443/api/x")), ["showroommiami.com"]);
  assert.deepEqual(hostsOf(req("https://showroommiami.com./api/x")), ["showroommiami.com"]);
  assert.deepEqual(hostsOf(req("https://localhost/api/x", "Showroommiami.com:8888")), ["localhost", "showroommiami.com"]);
  assert.deepEqual(hostsOf(req("https://showroommiami.com/api/x", "showroommiami.com")), ["showroommiami.com"]); // sin repetir
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
const ENV_BUCKET = { production: "form-custom-builds", preview: "form-custom-builds-preview" } as const;
const FUNCTIONS = ["cb-request", "cb-photo-urls", "cb-photos-done"] as const;

/** Llama a la Function de verdad (su export por defecto), con las variables, la URL, el Host y el contexto dados. */
async function callFunction(fn: (typeof FUNCTIONS)[number], o: { entorno: string; url: string; host?: string; context?: string }) {
  const mod = await import(`../netlify/functions/${fn}.ts`);
  const permit = signPermit({ lead_id: "L-1", carpeta: "solicitudes/TEST-0001-aaaaaaaa/", n_max: 2, exp: NOW + 900 }, "otro-secreto");
  const body = fn === "cb-request" ? {} : { permiso: permit, fotos: [{ n: 1, size: 10 }] };
  const req = new Request(`${o.url}/api/${fn}`, { method: "POST", headers: o.host ? { host: o.host } : {}, body: JSON.stringify(body) });
  const logs: string[] = [];
  const realError = console.error;
  console.error = (m: unknown) => { logs.push(String(m)); };
  try {
    const res: Response = await withNetlifyEnv(
      { ...FULL, CB_ENTORNO: o.entorno, R2_BUCKET: ENV_BUCKET[o.entorno as "production" | "preview"] },
      () => mod.default(req, { deploy: { context: o.context } }),
    );
    return { status: res.status, logs };
  } finally { console.error = realError; }
}

test("S-02: las tres Functions, de verdad: preview en showroommiami.com (por URL o por Host) => 500 con CB_ENTORNO(anfitrion)", async () => {
  for (const fn of FUNCTIONS) {
    for (const o of [
      { entorno: "preview", url: "https://showroommiami.com" },
      { entorno: "preview", url: "https://www.showroommiami.com" },
      { entorno: "preview", url: "https://localhost", host: "www.showroommiami.com" }, // solo el encabezado Host lo dice
      { entorno: "preview", url: "https://showroommiami.com", context: "deploy-preview" },
    ]) {
      const r = await callFunction(fn, o);
      assert.equal(r.status, 500, `${fn} ${o.url} ${o.host ?? ""}`);
      assert.deepEqual(r.logs, [`CB_ALERT config fn=${fn} missing=CB_ENTORNO(anfitrion)`], fn);
    }
  }
});

test("S-02: las tres Functions, de verdad: production en deploy preview o branch deploy => 500; en el .netlify.app de producción NO", async () => {
  for (const fn of FUNCTIONS) {
    for (const url of ["https://deploy-preview-24--web-tsm.netlify.app", "https://feature-x--web-tsm.netlify.app"]) {
      const r = await callFunction(fn, { entorno: "production", url });
      assert.equal(r.status, 500, `${fn} ${url}`);
      assert.deepEqual(r.logs, [`CB_ALERT config fn=${fn} missing=CB_ENTORNO(anfitrion)`], fn);
    }
    const r = await callFunction(fn, { entorno: "production", url: "https://localhost", host: "deploy-preview-24--web-tsm.netlify.app" });
    assert.equal(r.status, 500, `${fn} Host`);

    // no bloquea: la configuración pasa y la petición vacía cae en su propio rechazo (400 o 401), nunca en 500 config
    for (const [entorno, url] of [["production", "https://web-tsm.netlify.app"], ["production", "https://showroommiami.com"], ["production", "https://localhost"], ["preview", "https://deploy-preview-24--web-tsm.netlify.app"], ["preview", "https://localhost"]] as const) {
      const ok = await callFunction(fn, { entorno, url });
      assert.ok([400, 401].includes(ok.status), `${fn} ${entorno} ${url}: ${ok.status}`);
      assert.deepEqual(ok.logs, [], `${fn} ${entorno} ${url}`);
    }
  }
});

test("S-02: las tres Functions siguen contrastando el contexto del despliegue", async () => {
  for (const fn of FUNCTIONS) {
    const r = await callFunction(fn, { entorno: "preview", url: "https://localhost", context: "production" });
    assert.equal(r.status, 500, fn);
    assert.deepEqual(r.logs, [`CB_ALERT config fn=${fn} missing=CB_ENTORNO(contexto)`], fn);
    const v = await callFunction(fn, { entorno: "production", url: "https://localhost", context: "deploy-preview" });
    assert.equal(v.status, 500, fn);
    assert.deepEqual(v.logs, [`CB_ALERT config fn=${fn} missing=CB_ENTORNO(contexto)`], fn);
  }
});

test("S-02: depsFromEnv deja el problema en la configuración que lee configProblems", () => {
  const d = withNetlifyEnv({ ...FULL, CB_ENTORNO: "preview", R2_BUCKET: ENV_BUCKET.preview }, () => depsFromEnv(undefined, ["showroommiami.com"]));
  assert.equal(d.entorno, null);
  assert.equal(d.entornoProblem, "CB_ENTORNO(anfitrion)");
  assert.deepEqual(configProblems(d), ["CB_ENTORNO(anfitrion)"]);
  const bien = withNetlifyEnv({ ...FULL, CB_ENTORNO: "preview", R2_BUCKET: ENV_BUCKET.preview }, () => depsFromEnv(undefined, ["localhost"]));
  assert.equal(bien.entorno, "preview");
});

// ---- T8 · S-01, S-04, S-05 · Turnstile

const siteverify = (status: number, body?: unknown) => (async () =>
  new Response(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
const prod = { entorno: "production" as const, secret: REAL_SECRET };

test("S-01: HTTP 400 con JSON de error-codes se clasifica por los códigos; sin cuerpo JSON, http_<status>", async () => {
  const c = (status: number, body?: unknown) => checkTurnstile(prod, "tok", KEY, siteverify(status, body));
  assert.deepEqual(await c(400, { success: false, "error-codes": ["invalid-input-secret"] }), { outcome: "unavailable", cause: "invalid_secret" });
  assert.deepEqual(await c(400, { success: false, "error-codes": ["missing-input-secret"] }), { outcome: "unavailable", cause: "missing_secret" });
  assert.deepEqual(await c(400, { "error-codes": ["bad-request"] }), { outcome: "unavailable", cause: "bad_request" });
  assert.deepEqual(await c(500, { success: false, "error-codes": ["internal-error"] }), { outcome: "unavailable", cause: "internal_error" });
  assert.deepEqual(await c(200, { success: false, "error-codes": ["invalid-input-secret"] }), { outcome: "unavailable", cause: "invalid_secret" }); // como antes
  // la causa del servicio gana aunque venga junto a una del usuario
  assert.deepEqual(await c(400, { "error-codes": ["invalid-input-response", "invalid-input-secret"] }), { outcome: "unavailable", cause: "invalid_secret" });
  // errores de quien envía: rechazo (403), también con un 400
  assert.deepEqual(await c(400, { "error-codes": ["invalid-input-response"] }), { outcome: "rejected" });
  assert.deepEqual(await c(200, { success: false, "error-codes": ["timeout-or-duplicate"] }), { outcome: "rejected" });
  // sin cuerpo JSON (o sin códigos conocidos) manda el estado HTTP
  assert.deepEqual(await c(400), { outcome: "unavailable", cause: "http_400" });
  assert.deepEqual(await c(502, "<html>Bad gateway</html>"), { outcome: "unavailable", cause: "http_502" });
  assert.deepEqual(await c(500, { success: false }), { outcome: "unavailable", cause: "http_500" });
  assert.deepEqual(await c(400, { "error-codes": ["algo-nuevo"] }), { outcome: "unavailable", cause: "http_400" });
  assert.deepEqual(await c(429, { success: true }), { outcome: "unavailable", cause: "http_429" }); // el estado HTTP no se pasa por alto
  // lo de siempre
  assert.deepEqual(await c(200, "no es json"), { outcome: "unavailable", cause: "non_json" });
  assert.deepEqual(await c(200, { success: false, "error-codes": [] }), { outcome: "rejected" });
  assert.deepEqual(await c(200, { success: true, hostname: "www.showroommiami.com", action: "cb_request" }), { outcome: "ok" });
});

test("S-01: cb-request responde 503 con CB_ALERT turnstile causa=invalid_secret ante un 400 con ese código", async () => {
  const logs: string[] = [];
  const d = depsFor({ entorno: "production", turnstileSecret: REAL_SECRET, log: (m) => logs.push(m) }, siteverify(400, { success: false, "error-codes": ["invalid-input-secret"] }));
  const res = await handleRequest(post(reqBody), d);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "unavailable" });
  assert.deepEqual(logs, ["CB_ALERT turnstile causa=invalid_secret"]);
});

test("S-04: un error-code llamado __proto__, constructor, toString... es un rechazo normal, no una causa que no es palabra fija", async () => {
  for (const code of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"]) {
    const r = await checkTurnstile(prod, "tok", KEY, siteverify(200, `{"success": false, "error-codes": ["${code}"]}`));
    assert.deepEqual(r, { outcome: "rejected" }, code);
    // con un 400 tampoco se cuela: manda el estado HTTP, con su causa fija
    assert.deepEqual(await checkTurnstile(prod, "tok", KEY, siteverify(400, { "error-codes": [code] })), { outcome: "unavailable", cause: "http_400" }, code);
    // y por la Function: 403 "verify you're human", sin línea CB_ALERT
    const logs: string[] = [];
    const res = await handleRequest(post(reqBody), depsFor({ log: (m) => logs.push(m) }, siteverify(200, { success: false, "error-codes": [code] })));
    assert.equal(res.status, 403, code);
    assert.deepEqual(logs, [], code);
  }
});

test("S-05: handleRequest falla cerrada: solo 'ok' avanza; rejected es 403; unavailable y cualquier otra cosa, 503 con CB_ALERT fija", async () => {
  const gate = (human: unknown) => { const logs: string[] = []; const res = humanGate(depsFor({ log: (m) => logs.push(m) }), human); return { res, logs }; };
  assert.equal(gate({ outcome: "ok" }).res, null);
  const rej = gate({ outcome: "rejected" });
  assert.equal(rej.res!.status, 403);
  assert.deepEqual(await rej.res!.json(), { error: "turnstile" });
  assert.deepEqual(rej.logs, []);
  const un = gate({ outcome: "unavailable", cause: "invalid_secret" });
  assert.equal(un.res!.status, 503);
  assert.deepEqual(un.logs, ["CB_ALERT turnstile causa=invalid_secret"]);
  // cualquier otro valor: 503 con la línea fija, nunca null
  for (const raro of [{ outcome: "maybe" }, { outcome: "OK" }, { outcome: "ok " }, { outcome: undefined }, { outcome: true }, {}, null, undefined, "ok", 1, [], { outcome: "unavailable", cause: "Texto libre con datos <script>" }]) {
    const g = gate(raro);
    assert.equal(g.res?.status, 503, JSON.stringify(raro));
    assert.deepEqual(await g.res!.json(), { error: "unavailable" });
    assert.equal(g.logs.length, 1);
    assert.match(g.logs[0], /^CB_ALERT turnstile causa=(desconocida|invalid_secret)$/, JSON.stringify(raro));
  }
  assert.deepEqual(gate({ outcome: "maybe" }).logs, ["CB_ALERT turnstile causa=desconocida"]);
  assert.deepEqual(gate({ outcome: "unavailable", cause: "Texto libre con datos <script>" }).logs, ["CB_ALERT turnstile causa=desconocida"]);
});

// ---- T9 · F-E · el secret que viaja a siteverify

/** Deps de cb-request con un fetch que guarda los cuerpos enviados a siteverify. */
const post = (body: unknown) => new Request("https://x/api", { method: "POST", body: JSON.stringify(body) });
const reqBody = { clave: KEY, token: "TOKEN-DE-PRUEBA", campos: valid, fotos_esperadas: 0 };
function depsFor(over: Partial<Deps> = {}, verify?: typeof fetch, sent: { url: string; body: Record<string, unknown> }[] = []): Deps {
  const fetchImpl = (async (url: string, init: { body: string }) => {
    if (String(url).includes("turnstile")) {
      sent.push({ url: String(url), body: JSON.parse(init.body) });
      return verify ? (verify as unknown as (u: string, i: unknown) => Promise<Response>)(url, init) : new Response(JSON.stringify({ success: true, hostname: "showroommiami.com", action: "cb_request" }));
    }
    return new Response(JSON.stringify({ ok: true, lead_id: "L-1", folio: "TEST-1", carpeta: "", duplicado: false, fotos_esperadas: 0 }));
  }) as unknown as typeof fetch;
  return { entorno: "preview", permitSecret: "ps", receptor: { url: "https://rec", secret: "cd".repeat(32) }, r2: () => ({}) as R2Client, fetchImpl, now: () => NOW, ...over };
}

test("F-E: en producción a siteverify viaja el secret CONFIGURADO; en preview, el de prueba aunque haya uno configurado", async () => {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const ok = (async () => new Response(JSON.stringify({ success: true, hostname: "showroommiami.com", action: "cb_request" }))) as unknown as typeof fetch;
  const capture = (async (url: string, init: { body: string }) => { sent.push({ url, body: JSON.parse(init.body) }); return ok(url as never); }) as unknown as typeof fetch;

  // directo
  assert.deepEqual(await checkTurnstile({ entorno: "production", secret: REAL_SECRET }, "tok", KEY, capture), { outcome: "ok" });
  assert.equal(sent[0].url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.equal(sent[0].body.secret, REAL_SECRET);
  assert.notEqual(sent[0].body.secret, TURNSTILE_TEST_SECRET);
  assert.equal(sent[0].body.response, "tok");
  assert.equal(sent[0].body.idempotency_key, KEY);

  await checkTurnstile({ entorno: "preview", secret: REAL_SECRET }, "tok", KEY, capture);
  assert.equal(sent[1].body.secret, TURNSTILE_TEST_SECRET);
  await checkTurnstile({ entorno: "preview" }, "tok", KEY, capture);
  assert.equal(sent[2].body.secret, TURNSTILE_TEST_SECRET);

  // y por la Function, de punta a punta
  const porFunction: { url: string; body: Record<string, unknown> }[] = [];
  assert.equal((await handleRequest(post(reqBody), depsFor({ entorno: "production", turnstileSecret: REAL_SECRET }, undefined, porFunction))).status, 201);
  assert.equal(porFunction[0].body.secret, REAL_SECRET);
  assert.equal((await handleRequest(post(reqBody), depsFor({ entorno: "preview", turnstileSecret: REAL_SECRET }, undefined, porFunction))).status, 201);
  assert.equal(porFunction[1].body.secret, TURNSTILE_TEST_SECRET);
  // producción sin secret no manda nada a siteverify (500 de configuración antes)
  const sinSecret: { url: string; body: Record<string, unknown> }[] = [];
  assert.equal((await handleRequest(post(reqBody), depsFor({ entorno: "production" }, undefined, sinSecret))).status, 500);
  assert.equal(sinSecret.length, 0);
});

// ---- T10 · TXT-01 · puntuación de los textos

test("TXT-01: los avisos de fallo con teléfono terminan igual y sin dobles puntos ni espacios de más", () => {
  for (const [kind, n] of Object.entries(CB_NOTICES)) {
    assert.doesNotMatch(n.text, /\.\.|,,|\s{2,}|\s$|^\s/, kind);
    assert.match(n.text, /^[A-Z]/, kind);
    if (n.phone) assert.match(n.text, /(\. Please call us at|, or call us at|, please call us at)$/, kind); // y la UI agrega " <tel>."
    else assert.match(n.text, /[.]$/, kind);
  }
  assert.match(CB_LOADING, /^The form is loading\. If it doesn't load, please call us at$/);
  assert.deepEqual(Object.fromEntries(Object.entries(CB_NOTICES).filter(([, n]) => n.phone).map(([k, n]) => [k, n.text])), {
    wait: "Please wait for the security check to finish, then try again. If it doesn't finish, please call us at",
    tserror: "The security check couldn't load. Please reload the page, or call us at",
    nokey: "This form isn't available right now. Please call us at",
    turnstile: "We couldn't verify you're human. Please try again, or call us at",
    quota: "We can't take more requests right now. Please call us at",
    invalid: "Some details didn't pass our checks. Please review the form, or call us at",
    retry: "We couldn't reach our server. Please try again in a moment, or call us at",
    error: "Something went wrong. Please try again, or call us at",
  });
  assert.equal(CB_UPLOADING, "Uploading your photos. Please keep this page open.");
});

test("TXT-01: la página renderizada trae el teléfono solo desde @/config/business (ni el aviso previo ni los botones lo escriben a mano)", async () => {
  const html = await renderCustomBuildsHtml();
  assert.ok(html.includes(`href="${BUSINESS_PHONE_HREF}"`));
  // todo enlace tel: de la página es el del negocio
  const tels = new Set([...html.matchAll(/href="(tel:[^"]*)"/g)].map((m) => m[1]));
  assert.deepEqual([...tels], [BUSINESS_PHONE_HREF]);
});

// ======================================================================================================================
// Revisión de la ronda 3

// ---- R3-REV-01 · el aviso de fotos lleva el nombre del archivo: se parte, no desborda

test("R3-REV-01: el aviso de fotos (nombre de archivo largo y sin espacios) se parte en vez de desbordar, en el HTML renderizado", async () => {
  const html = await renderEstimateFormHtml();
  const msg = /<p id="cb-fotos-msg" class="([^"]*)"/.exec(html);
  assert.ok(msg, "el aviso existe siempre (vacío)");
  assert.ok(msg![1].split(/\s+/).includes("break-words"), `clases: ${msg![1]}`);
  // y su contenedor puede encogerse dentro del formulario
  assert.match(html, /<div class="min-w-0"><label for="cb-fotos"/);
});

// ---- R3-REV-03 · con el tope de fotos el foco no se pierde

test("R3-REV-03: photoFocusTarget: al selector si quedó habilitado; a la lista de fotos si el tope lo dejó deshabilitado; a ninguna parte si el usuario se fue a otro campo", () => {
  const body = {}, otro = {};
  const list = { focus() {} };
  const habilitado = { disabled: false, focus() {} };
  const deshabilitado = { disabled: true, focus() {} };
  // foco perdido en BODY (el selector se deshabilitó mientras se preparaba)
  assert.equal(photoFocusTarget(body, body, habilitado, null), habilitado);
  assert.equal(photoFocusTarget(body, body, habilitado, list), habilitado); // habilitado manda sobre la lista
  assert.equal(photoFocusTarget(body, body, deshabilitado, list), list); // el tope: a la lista, no a BODY
  assert.equal(photoFocusTarget(null, body, deshabilitado, list), list);
  assert.equal(photoFocusTarget(deshabilitado, body, deshabilitado, list), list);
  assert.equal(photoFocusTarget(body, body, deshabilitado, null), null); // sin lista que enfocar, no hay a dónde
  assert.equal(photoFocusTarget(body, body, null, list), list);
  // el usuario ya pasó a otro campo: no se le quita, haya o no tope
  assert.equal(photoFocusTarget(otro, body, habilitado, list), null);
  assert.equal(photoFocusTarget(otro, body, deshabilitado, list), null);
});

// ---- F2 · los controles se habilitan cuando el aviso termina de plegarse

test("F2: el pliegue del aviso dura LOADING_FOLD_MS (300 ms) y la clase de transición del aviso dura lo mismo", async () => {
  assert.equal(LOADING_FOLD_MS, 300);
  const antes = await renderLoadingNoticeHtml(false);
  assert.match(antes, /class="grid transition-\[grid-template-rows,opacity\] duration-300 /); // la transición dura lo mismo que el temporizador
  assert.ok(antes.includes("grid-rows-[1fr]") && !antes.includes("grid-rows-[0fr]"));
});

// ---- F-03 · success tiene que ser el booleano true

test("F-03: un 200 con success no booleano (\"false\", \"true\", 1, 0, {}, [], null) es rechazo, en producción y en preview; true avanza", async () => {
  const body = (success: unknown) => ({ success, hostname: "www.showroommiami.com", action: "cb_request" });
  for (const success of ["false", "true", "1", "yes", 1, 0, {}, [], null]) {
    assert.deepEqual(await checkTurnstile(prod, "tok", KEY, siteverify(200, body(success))), { outcome: "rejected" }, `prod ${JSON.stringify(success)}`);
    assert.deepEqual(await checkTurnstile({ entorno: "preview" }, "tok", KEY, siteverify(200, body(success))), { outcome: "rejected" }, `preview ${JSON.stringify(success)}`);
  }
  assert.deepEqual(await checkTurnstile(prod, "tok", KEY, siteverify(200, body(true))), { outcome: "ok" });
  assert.deepEqual(await checkTurnstile({ entorno: "preview" }, "tok", KEY, siteverify(200, body(true))), { outcome: "ok" });
  // y por la Function: 403, no 201
  const res = await handleRequest(post(reqBody), depsFor({}, siteverify(200, { success: "false" })));
  assert.equal(res.status, 403);
});

// ---- F1 / F-01 · la regla del anfitrión no puede tumbar producción

test("F1: isDeployPreviewHost solo reconoce 'deploy-preview-'; el '--' de rama o permalink no lo es", () => {
  for (const h of ["deploy-preview-24--web-tsm.netlify.app", "DEPLOY-PREVIEW-3--Web-TSM.netlify.app", "deploy-preview-3.example.com"]) assert.equal(isDeployPreviewHost(h), true, h);
  for (const h of ["feature-x--web-tsm.netlify.app", "main--web-tsm.netlify.app", "64f1a2b3c4--web-tsm.netlify.app", "web-tsm.netlify.app", "showroommiami.com", ""]) assert.equal(isDeployPreviewHost(h), false, h);
});

test("F1: con el contexto en 'production', un anfitrión con '--' (rama de producción, permalink) NO bloquea; un deploy-preview- sí; sin contexto, como antes", () => {
  const MAIN = "main--web-tsm.netlify.app", PERMA = "64f1a2b3c4--web-tsm.netlify.app", BRANCH = "feature-x--web-tsm.netlify.app", PREV = "deploy-preview-24--web-tsm.netlify.app";
  const casos: [string, string | undefined, string[], string | null, string?][] = [
    ["production", "production", [MAIN], "production"],
    ["production", "production", [PERMA], "production"],
    ["production", "production", [BRANCH, "showroommiami.com"], "production"],
    ["production", "production", [PREV], null, "CB_ENTORNO(anfitrion)"], // un deploy-preview- nunca es producción, diga lo que diga el contexto
    ["production", "production", ["localhost", PREV], null, "CB_ENTORNO(anfitrion)"],
    ["production", undefined, [MAIN], null, "CB_ENTORNO(anfitrion)"], // sin contexto no hay nada que lo desmienta
    ["production", undefined, [PERMA], null, "CB_ENTORNO(anfitrion)"],
    ["production", "deploy-preview", [MAIN], null, "CB_ENTORNO(contexto)"], // y el contexto de preview sigue mandando
    ["production", "branch-deploy", [BRANCH], null, "CB_ENTORNO(contexto)"],
    ["preview", "production", [MAIN], null, "CB_ENTORNO(contexto)"], // preview en un despliegue de producción sigue bloqueado
    ["preview", undefined, [MAIN], "preview"],
  ];
  for (const [raw, ctx, hosts, entorno, problem] of casos) {
    const r = entornoFor(raw, ctx, hosts);
    assert.equal(r.entorno, entorno, `${raw} | ${ctx} | ${hosts}`);
    assert.equal(r.problem, problem, `${raw} | ${ctx} | ${hosts}`);
  }
});

test("F1: las tres Functions, de verdad: la rama de producción o el permalink de un despliegue de producción NO dan 500 de configuración", async () => {
  for (const fn of FUNCTIONS) {
    for (const url of ["https://main--web-tsm.netlify.app", "https://64f1a2b3c4--web-tsm.netlify.app"]) {
      const ok = await callFunction(fn, { entorno: "production", url, context: "production" });
      assert.ok([400, 401].includes(ok.status), `${fn} ${url}: ${ok.status}`); // cae en su propio rechazo, no en el 500 de config
      assert.deepEqual(ok.logs, [], `${fn} ${url}`);
      const sinContexto = await callFunction(fn, { entorno: "production", url });
      assert.equal(sinContexto.status, 500, `${fn} ${url} sin contexto`);
      assert.deepEqual(sinContexto.logs, [`CB_ALERT config fn=${fn} missing=CB_ENTORNO(anfitrion)`], fn);
    }
    const prev = await callFunction(fn, { entorno: "production", url: "https://deploy-preview-24--web-tsm.netlify.app", context: "production" });
    assert.equal(prev.status, 500, fn);
  }
});

// ---- F3 · la atribución no entra en la huella, campo por campo

test("F3: ATTRIBUTION_FIELDS es la lista literal de los 10 campos de atribución y, con los del usuario, cubre todo el contrato", () => {
  assert.deepEqual([...ATTRIBUTION_FIELDS], ["origen", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "click_id_tipo", "click_id", "aterrizaje", "referrer"]);
  const delUsuario = ["nombre", "telefono", "correo", "marca", "modelo", "anio", "zona", "servicio", "descripcion", "presupuesto", "plazo"];
  assert.deepEqual([...delUsuario, ...ATTRIBUTION_FIELDS].sort(), Object.keys(MAX_LEN).sort()); // un campo nuevo del contrato obliga a clasificarlo
});

test("F3: un cambio de CUALQUIERA de los 10 campos de atribución, tras un fallo, conserva la clave (también tras recargar); los del usuario no", async () => {
  for (const k of ATTRIBUTION_FIELDS) {
    await withMemorySession(async () => {
      const p1 = openPage([{ kind: "retry" }, { kind: "retry" }]);
      await p1.send(base, "T1");
      await p1.send({ ...base, [k]: "valor-nuevo" }, "T2");
      assert.equal(p1.posts[1].clave, p1.posts[0].clave, `${k} en la misma página`);
      const p2 = openPage([ok()]);
      await p2.send({ ...base, [k]: "otro-valor" }, "T3");
      assert.equal(p2.posts[0].clave, p1.posts[0].clave, `${k} tras recargar`);
    });
  }
  for (const k of ["nombre", "telefono", "modelo", "descripcion"]) {
    await withMemorySession(async () => {
      const p = openPage([{ kind: "retry" }, ok()]);
      await p.send(base, "T1");
      await p.send({ ...base, [k]: "corregido" }, "T2");
      assert.notEqual(p.posts[1].clave, p.posts[0].clave, k);
    });
  }
});

// ---- F-02 / F4 / R3-REV-04 · el cableado de EstimateForm y de la página

test("cableado: los tres botones 'Request a Custom Build Estimate' de la página llaman a goToEstimate (elementos que React crea al renderizar)", async () => {
  const { anchors, goToEstimate } = await renderCustomBuildsAnchors();
  assert.deepEqual(anchors.map((a) => a.cta), ["hero", "after_projects", "after_process"]);
  for (const a of anchors) assert.equal(a.onClick, goToEstimate, String(a.cta));
});

test("cableado: goToEstimate evita la navegación, desplaza a la sección #estimate y enfoca su encabezado sin desplazar de nuevo", async () => {
  const { goToEstimate } = await renderCustomBuildsAnchors();
  const call = (reduce: boolean, conSeccion = true) => {
    const log: unknown[][] = [];
    const g = globalThis as Record<string, unknown>;
    const had = { window: g.window, document: g.document };
    g.window = { matchMedia: () => ({ matches: reduce }) };
    g.document = {
      getElementById: (id: string) => id === "estimate" ? (conSeccion ? { scrollIntoView: (o: unknown) => log.push(["scroll", o]) } : null)
        : id === "estimate-heading" ? { focus: (o: unknown) => log.push(["focus", o]) } : null,
    };
    try { (goToEstimate as (e: unknown) => void)({ preventDefault: () => log.push(["prevent"]) }); }
    finally { g.window = had.window; g.document = had.document; if (had.window === undefined) delete g.window; if (had.document === undefined) delete g.document; }
    return log;
  };
  assert.deepEqual(call(false), [["prevent"], ["scroll", { behavior: "smooth", block: "start" }], ["focus", { preventScroll: true }]]);
  assert.deepEqual(call(true), [["prevent"], ["scroll", { behavior: "auto", block: "start" }], ["focus", { preventScroll: true }]]); // reduced motion
  assert.deepEqual(call(false, false), [["prevent"]]); // sin la sección no hace nada más
});

// Rotulado: estas son aserciones sobre la FUENTE, porque el repo no tiene DOM (jsdom, testing-library) para montar el
// componente. Fijan el cableado que ninguna otra prueba ejercita; cada una se probó con su mutación de una línea.
const FORM_SRC = readFileSync(new URL("../src/components/custom-builds/EstimateForm.tsx", import.meta.url), "utf8");

test("cableado (fuente): EstimateForm restaura la sesión del borrador, guarda la huella en cada fallo y en cada cambio de clave", () => {
  assert.match(FORM_SRC, /if \(d\) \{ setFields\(d\.fields\); sessionRef\.current = sessionOf\(d\); \}/); // la recarga recupera clave y huella
  assert.match(FORM_SRC, /onKeyChange: \(\) => saveDraft\(draftOf\(fields, sessionRef\.current\)\),/);
  assert.match(FORM_SRC, /onAttemptFailed: \(\) => saveDraft\(draftOf\(fields, sessionRef\.current\)\),/); // el fallo deja la huella
  assert.match(FORM_SRC, /saveDraft\(draftOf\(next, sessionRef\.current\)\)/); // y cada cambio de un campo
});

test("cableado (fuente): las fotos se preparan con el tiempo por defecto y, al terminar, el foco va a photoFocusTarget", () => {
  assert.match(FORM_SRC, /prepareFiles\(list, MAX_PHOTOS - photos\.length, MAX_PHOTOS, \(f\) => processPhoto\(f as File\)\)/); // sin un tiempo propio
  assert.match(FORM_SRC, /photoFocusTarget\(document\.activeElement, document\.body, photosRef\.current, atPhotoLimit \? photoListRef\.current : null\)\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(FORM_SRC, /const atPhotoLimit = photos\.length >= MAX_PHOTOS;/);
  assert.match(FORM_SRC, /<ul ref=\{photoListRef\} tabIndex=\{-1\}/); // la lista puede recibir el foco
});

test("cableado (fuente): los controles se habilitan LOADING_FOLD_MS después de hidratar, no al hidratar", () => {
  assert.match(FORM_SRC, /useEffect\(\(\) => \{\n {4}setHydrated\(true\);\n/); // al hidratar solo se marca hydrated
  assert.doesNotMatch(FORM_SRC, /setReady\(true\);\n {4}const d = loadDraft/);
  assert.match(FORM_SRC, /if \(!hydrated\) return;\n {4}const t = setTimeout\(\(\) => setReady\(true\), LOADING_FOLD_MS\);\n {4}return \(\) => clearTimeout\(t\);\n {2}\}, \[hydrated\]\);/);
  assert.match(FORM_SRC, /<LoadingNotice ready=\{hydrated\} \/>/);
  assert.match(FORM_SRC, /<fieldset disabled=\{!ready\}/);
  assert.match(FORM_SRC, /setTimeout\(\(\) => setGone\(true\), LOADING_FOLD_MS\)/); // el aviso se quita al mismo tiempo
});
