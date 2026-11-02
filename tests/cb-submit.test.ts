// Segunda ronda (auditoría del cierre): el envío del formulario como función pura con dobles (F1), la clave nueva cuando
// cambia lo que se envía (SRV-04), las fotos que se preparan (NAV-02), el HTML del servidor que no se puede enviar
// (NAV-01) y el tratamiento móvil (A7-1, NAV-03, NAV-04). Pruebas de comportamiento: no leen el .tsx con regex salvo
// para comprobar que el componente usa la función probada.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SubmitOutcome } from "../src/lib/cbClient.ts";
import type { ProcessedPhoto } from "../src/lib/cbPhotos.ts";
import { MSG_TOO_MANY, MSG_UNREADABLE, canSubmit, fingerprint, prepareFiles, runSubmit, type SubmitDeps, type SubmitSession } from "../src/lib/cbSubmit.ts";
import { createLeadReporter } from "../src/lib/cbDataLayer.ts";
import { CB_NOTICES, CB_PREPARING } from "../src/lib/cbCopy.ts";
import { MOBILE_QUERY, hideFloatingCall } from "../src/lib/cbFloatingCall.ts";
import { renderEstimateFormHtml } from "./helpers/render-form.ts";

const LEAD = "6f1c0a52-9a3e-4d0b-8f7c-2b5d4e1a9c33";
const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const FORM = read("src/components/custom-builds/EstimateForm.tsx");

const campos = { nombre: "Ana", telefono: "+13055550123", correo: "ana@example.com", marca: "BMW", modelo: "M3", anio: "2020", zona: "33101", servicio: "Full build", descripcion: "Widebody kit", origen: "unknown" };
const photo = (n: number) => ({ name: `f${n}.jpg`, blob: new Blob([new Uint8Array(10)]), thumb: "/9j/x", previewUrl: `blob:${n}` }) as ProcessedPhoto;
const ok = (permiso: string | null = null, medir = true): SubmitOutcome => ({ kind: "ok", leadId: LEAD, permiso, medir });
const session = (): SubmitSession => ({ clave: "", failed: null });

/** Dobles de las dependencias de runSubmit: anotan el orden de las llamadas y responden con los resultados dados. */
function fake(outcomes: SubmitOutcome[], upload?: (permiso: string, photos: ProcessedPhoto[]) => Promise<number>) {
  const calls: string[] = [];
  const posts: { clave: string; token: string; fotos: number }[] = [];
  const fails: number[] = []; // cuántas llamadas llevaba `calls` cuando se anotó cada fallo (el borrador guarda la huella)
  let i = 0, k = 0;
  const deps: SubmitDeps = {
    postRequest: async (clave, token, _c, fotos) => { calls.push("post"); posts.push({ clave, token, fotos }); return outcomes[Math.min(i++, outcomes.length - 1)]; },
    uploadPhotos: async (permiso, photos) => { calls.push("upload"); return upload ? upload(permiso, photos) : photos.length; },
    trackGenerateLead: (leadId, medir) => { calls.push(`lead:${leadId}:${medir}`); },
    newKey: () => `K${++k}`,
    onKeyChange: (c) => { calls.push(`key:${c}`); },
    onAttemptFailed: () => { fails.push(calls.length); },
    resetTurnstile: () => { calls.push("reset"); },
    clearDraft: () => { calls.push("clear"); },
    onUploading: () => { calls.push("uploading"); },
  };
  return { deps, calls, posts, fails };
}

// ---- F1 · el envío

test("F1: 503 -> retry: misma clave en el reintento, sin generate_lead, token de Turnstile reiniciado y borrador intacto", async () => {
  const f = fake([{ kind: "retry" }, ok()]);
  const s = session();
  const r1 = await runSubmit({ campos, token: "T1", photos: [] }, s, f.deps);
  assert.deepEqual(r1, { kind: "failed", notice: "retry" });
  assert.deepEqual(f.calls, ["key:K1", "post", "reset"]); // ni lead ni clear
  assert.equal(s.clave, "K1"); // la clave sobrevive al fallo: el reintento es un replay

  const r2 = await runSubmit({ campos, token: "T2", photos: [] }, s, f.deps);
  assert.deepEqual(r2, { kind: "done", note: null });
  assert.deepEqual(f.posts.map((p) => p.clave), ["K1", "K1"]); // la misma clave en los dos intentos
  assert.deepEqual(f.posts.map((p) => p.token), ["T1", "T2"]);
  assert.equal(f.calls.filter((c) => c.startsWith("lead:")).length, 1); // un solo generate_lead, tras el 201
  assert.equal(s.clave, ""); // y solo ahora se limpia la clave
  assert.equal(f.calls[f.calls.length - 1], "clear");
});

test("F1: 403 -> el token de Turnstile se reinicia (es de un solo uso) y no hay generate_lead", async () => {
  const f = fake([{ kind: "turnstile" }]);
  const s = session();
  assert.deepEqual(await runSubmit({ campos, token: "T1", photos: [] }, s, f.deps), { kind: "failed", notice: "turnstile" });
  assert.ok(f.calls.includes("reset"));
  assert.ok(!f.calls.some((c) => c.startsWith("lead:") || c === "clear"));
  assert.equal(s.clave, "K1");
});

test("F1: un fallo nunca llega a 'done': ni generate_lead, ni borrado de la clave o del borrador, ni subida de fotos", async () => {
  for (const kind of ["turnstile", "quota", "invalid", "retry", "error"] as const) {
    const f = fake([{ kind }]);
    const s = session();
    const r = await runSubmit({ campos, token: "T", photos: [photo(1)] }, s, f.deps);
    assert.deepEqual(r, { kind: "failed", notice: kind }, kind);
    assert.ok(!f.calls.some((c) => c.startsWith("lead:") || c === "clear" || c === "upload" || c === "uploading"), kind);
    assert.equal(s.clave, "K1", kind);
    assert.ok(s.failed, kind);
    assert.equal(f.fails.length, 1, kind); // y el borrador se entera: guarda la huella del intento fallido
  }
  // 429, 500 y 400 no reinician Turnstile (el token se reutiliza con la misma clave); 403 y 503 sí
  for (const [kind, reset] of [["quota", false], ["error", false], ["invalid", false], ["turnstile", true], ["retry", true]] as const) {
    const f = fake([{ kind }]);
    await runSubmit({ campos, token: "T", photos: [] }, session(), f.deps);
    assert.equal(f.calls.includes("reset"), reset, kind);
  }
});

test("F1: 201 -> un generate_lead, antes de las fotos, y después la confirmación con la clave y el borrador limpios", async () => {
  const f = fake([ok("a.b")]);
  const s = session();
  const r = await runSubmit({ campos, token: "T", photos: [photo(1), photo(2)] }, s, f.deps);
  assert.deepEqual(r, { kind: "done", note: null });
  assert.deepEqual(f.calls, ["key:K1", "post", `lead:${LEAD}:true`, "uploading", "upload", "clear"]);
  assert.equal(f.fails.length, 0); // un éxito no anota ningún fallo
  assert.equal(s.clave, "");
  assert.equal(s.failed, null);
  // medir false (posible duplicado) se le pasa tal cual a trackGenerateLead, que es quien decide no empujar
  const dup = fake([ok(null, false)]);
  await runSubmit({ campos, token: "T", photos: [] }, session(), dup.deps);
  assert.ok(dup.calls.includes(`lead:${LEAD}:false`));
});

test("F1: las fotos que fallan no cambian el éxito: confirmación con aviso y un solo generate_lead", async () => {
  let f = fake([ok("a.b")], async () => { throw new Error("done"); });
  assert.deepEqual(await runSubmit({ campos, token: "T", photos: [photo(1)] }, session(), f.deps), { kind: "done", note: "photos_lost" });
  assert.equal(f.calls.filter((c) => c.startsWith("lead:")).length, 1);
  f = fake([ok("a.b")], async () => 1);
  assert.deepEqual(await runSubmit({ campos, token: "T", photos: [photo(1), photo(2)] }, session(), f.deps), { kind: "done", note: "photos" });
  f = fake([ok(null)]); // sin permiso y con fotos: se avisa en vez de mostrar solo la confirmación (B7)
  assert.deepEqual(await runSubmit({ campos, token: "T", photos: [photo(1)] }, session(), f.deps), { kind: "done", note: "photos_lost" });
  assert.ok(!f.calls.includes("upload"));
});

test("F1: con el generate_lead real (createLeadReporter) un fallo seguido de reintentos empuja exactamente uno", async () => {
  const dataLayer: Record<string, unknown>[] = [];
  const mem = new Map<string, string>();
  const push = createLeadReporter(() => ({ dataLayer }), () => ({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) }));
  const f = fake([{ kind: "retry" }, { kind: "error" }, ok(), ok(), ok()]);
  f.deps.trackGenerateLead = push;
  const s = session();
  const kinds: string[] = [];
  for (let n = 0; n < 5; n++) kinds.push((await runSubmit({ campos, token: `T${n}`, photos: [] }, s, f.deps)).kind);
  assert.deepEqual(kinds, ["failed", "failed", "done", "done", "done"]);
  assert.deepEqual(dataLayer, [{ event: "generate_lead", service: "custom_builds", lead_id: LEAD }]); // el replay no duplica
});

test("F1: EstimateForm solo llama a runSubmit y solo muestra la confirmación cuando devuelve 'done'", () => {
  assert.match(FORM, /runSubmit\(\s*\{/);
  assert.match(FORM, /if \(result\.kind !== "done"\)/);
  assert.match(FORM, /setStatus\("done"\)/);
  assert.equal((FORM.match(/setStatus\("done"\)/g) ?? []).length, 1);
  assert.doesNotMatch(FORM, /postRequest\(/); // la decisión ya no vive en el componente
});

// ---- SRV-04 · la clave cambia si lo que se envía cambia después de un fallo

test("SRV-04: tras un 503, si el usuario corrige un dato el reintento va con clave nueva (la corrección no se pierde)", async () => {
  const f = fake([{ kind: "retry" }, ok()]);
  const s = session();
  await runSubmit({ campos, token: "T1", photos: [] }, s, f.deps);
  const corregido = { ...campos, telefono: "+13055550999", descripcion: "texto corregido" };
  // el 503 ya reinició Turnstile: el token T2 es nuevo y sin usar, así que este intento sale en seguida
  const r = await runSubmit({ campos: corregido, token: "T2", photos: [] }, s, f.deps);
  assert.deepEqual(r, { kind: "done", note: null });
  assert.deepEqual(f.posts.map((p) => p.clave), ["K1", "K2"]);
  assert.ok(f.calls.includes("key:K2")); // el borrador guarda la clave nueva
  assert.equal(f.calls.filter((c) => c === "reset").length, 1); // solo el del 503, ninguno extra
});

test("SRV-04: tras un 500 (token ya usado) un cambio da clave nueva, reinicia Turnstile y NO sale hasta tener token nuevo", async () => {
  const f = fake([{ kind: "error" }, ok()]);
  const s = session();
  await runSubmit({ campos, token: "T1", photos: [] }, s, f.deps);
  assert.ok(!f.calls.includes("reset")); // un 500 no reinicia el widget
  const corregido = { ...campos, correo: "otro@example.com" };

  const r2 = await runSubmit({ campos: corregido, token: "T1", photos: [] }, s, f.deps);
  assert.deepEqual(r2, { kind: "failed", notice: "wait" }); // el token T1 ya se usó con la clave anterior
  assert.equal(f.posts.length, 1); // no se envió nada
  assert.ok(f.calls.includes("reset"));
  assert.equal(s.clave, "K2");

  const r3 = await runSubmit({ campos: corregido, token: "T2", photos: [] }, s, f.deps);
  assert.deepEqual(r3, { kind: "done", note: null });
  assert.deepEqual(f.posts.map((p) => [p.clave, p.token]), [["K1", "T1"], ["K2", "T2"]]);
});

test("SRV-04: sin cambios, el reintento conserva la clave; cambiar solo las fotos o un 400 también cuentan", async () => {
  // mismo cuerpo -> misma clave y el mismo token (un 500 no lo consumió)
  let f = fake([{ kind: "error" }, ok()]);
  let s = session();
  await runSubmit({ campos, token: "T1", photos: [photo(1)] }, s, f.deps);
  await runSubmit({ campos: { ...campos }, token: "T1", photos: [photo(1)] }, s, f.deps);
  assert.deepEqual(f.posts.map((p) => p.clave), ["K1", "K1"]);
  assert.ok(!f.calls.includes("reset"));

  // otra cantidad de fotos = otro cuerpo
  f = fake([{ kind: "retry" }, ok("a.b")]);
  s = session();
  await runSubmit({ campos, token: "T1", photos: [] }, s, f.deps);
  await runSubmit({ campos, token: "T2", photos: [photo(1)] }, s, f.deps);
  assert.deepEqual(f.posts.map((p) => [p.clave, p.fotos]), [["K1", 0], ["K2", 1]]);

  // un 400 lo rechaza el servidor antes de Turnstile: el token sigue sin usar y el intento corregido sale en seguida
  f = fake([{ kind: "invalid" }, ok()]);
  s = session();
  await runSubmit({ campos, token: "T1", photos: [] }, s, f.deps);
  const r = await runSubmit({ campos: { ...campos, anio: "2021" }, token: "T1", photos: [] }, s, f.deps);
  assert.deepEqual(r, { kind: "done", note: null });
  assert.deepEqual(f.posts.map((p) => [p.clave, p.token]), [["K1", "T1"], ["K2", "T1"]]);
  assert.ok(!f.calls.includes("reset"));
});

test("SRV-04: la huella no depende del orden de los campos y distingue valores y fotos", () => {
  assert.equal(fingerprint({ a: "1", b: "2" }, 0), fingerprint({ b: "2", a: "1" }, 0));
  assert.notEqual(fingerprint({ a: "1", b: "2" }, 0), fingerprint({ a: "1", b: "3" }, 0));
  assert.notEqual(fingerprint({ a: "1" }, 0), fingerprint({ a: "1" }, 1));
  assert.notEqual(fingerprint({ a: "1" }, 0), fingerprint({ a: "1", b: "" }, 0));
});

// ---- NAV-02 · fotos que se preparan

test("NAV-02: prepareFiles no termina hasta que todas las fotos están procesadas (el botón espera ese tiempo)", async () => {
  const gates: Array<() => void> = [];
  const process = (f: { name: string }) => new Promise<ProcessedPhoto>((resolve) => { gates.push(() => resolve(photo(Number(f.name)))); });
  let finished = false;
  const run = prepareFiles([{ name: "1" }, { name: "2" }], 3, 3, process).then((r) => { finished = true; return r; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(finished, false); // la primera foto aún no termina
  gates[0]();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(finished, false); // falta la segunda
  gates[1]();
  const { added, message } = await run;
  assert.equal(finished, true);
  assert.equal(added.length, 2);
  assert.equal(message, "");
});

test("NAV-02: tope de fotos y archivos ilegibles (un archivo ilegible gana sobre el aviso del tope)", async () => {
  const proc = async (f: { name: string }) => photo(Number(f.name));
  const exceso = await prepareFiles([{ name: "1" }, { name: "2" }, { name: "3" }, { name: "4" }], 2, 3, proc);
  assert.equal(exceso.added.length, 2);
  assert.equal(exceso.message, MSG_TOO_MANY(3));
  const sinCupo = await prepareFiles([{ name: "1" }], 0, 3, proc);
  assert.deepEqual([sinCupo.added.length, sinCupo.message], [0, MSG_TOO_MANY(3)]);
  const malo = await prepareFiles([{ name: "1" }, { name: "roto.heic" }], 3, 3, async (f) => { if (f.name === "roto.heic") throw new Error("decode"); return photo(1); });
  assert.equal(malo.added.length, 1);
  assert.equal(malo.message, MSG_UNREADABLE("roto.heic"));
  const ambos = await prepareFiles([{ name: "x" }, { name: "2" }, { name: "3" }], 2, 3, async (f) => { if (f.name === "x") throw new Error("decode"); return photo(2); });
  assert.equal(ambos.message, MSG_UNREADABLE("x"));
});

test("NAV-02: canSubmit bloquea mientras se hidrata, se envía o se preparan fotos; EstimateForm lo usa en el botón y en onSubmit", () => {
  for (const ready of [true, false]) for (const busy of [true, false]) for (const preparing of [true, false]) {
    assert.equal(canSubmit({ ready, busy, preparing }), ready && !busy && !preparing);
  }
  assert.equal(CB_PREPARING, "Preparing your photos…");
  assert.match(FORM, /canSubmit\(\{ ready, busy: busyRef\.current, preparing: preparer\.count > 0 \}\)/); // onSubmit
  assert.match(FORM, /const canSend = canSubmit\(\{ ready, busy, preparing: preparing > 0 \}\)/);
  assert.match(FORM, /disabled=\{!canSend\}/);
  assert.match(FORM, /<p role="status" aria-live="polite"[^>]*>\{preparing > 0 \? CB_PREPARING : ""\}<\/p>/); // el aviso junto al input, en una región que existe siempre
  assert.match(FORM, /const atPhotoLimit = photos\.length >= MAX_PHOTOS;/);
  assert.match(FORM, /disabled=\{busy \|\| preparing > 0 \|\| atPhotoLimit\}/); // y no se eligen más a la vez
  assert.match(FORM, /await preparer\.track\(async \(\) => \{\s*const \{ added, message \} = await prepareFiles\(/); // la cuenta baja siempre (createBusyCounter, probado aparte)
});

// ---- NAV-01 · el HTML del servidor no se puede enviar

test("NAV-01: el HTML prerenderizado del formulario no es enviable: method post y todos los controles dentro de un fieldset disabled", async () => {
  const html = await renderEstimateFormHtml();
  const form = /<form\b[^>]*>/.exec(html)?.[0] ?? "";
  assert.ok(form, "hay un <form>");
  assert.match(form, /\bmethod="post"/);
  assert.doesNotMatch(form, /method="get"/i);
  assert.doesNotMatch(form, /\baction=/);

  const open = /<fieldset\b[^>]*>/.exec(html);
  assert.ok(open, "hay un <fieldset>");
  assert.match(open![0], /\bdisabled(=""|\s|>)/);
  const start = html.indexOf(open![0]);
  const end = html.indexOf("</fieldset>");
  assert.ok(end > start);
  // todo control del formulario está dentro de ese fieldset (y por eso deshabilitado), no antes ni después
  const controls = [...html.matchAll(/<(input|select|textarea|button)\b/g)].map((m) => m.index!);
  assert.ok(controls.length >= 12, `controles: ${controls.length}`);
  for (const i of controls) assert.ok(i > start && i < end, `control fuera del fieldset en ${i}`);
  // ninguno trae un submit habilitado fuera de él
  assert.doesNotMatch(html.slice(0, start) + html.slice(end), /<button\b[^>]*type="submit"/);
});

test("NAV-01: el servidor entrega el formulario con la marca nueva, el texto exacto y el botón deshabilitado", async () => {
  const html = await renderEstimateFormHtml();
  assert.match(html, /Tell us about your vehicle and the custom work you have in mind\./);
  assert.match(html, /<option value="Land Rover \/ Range Rover">/);
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""[^>]*>Request Estimate<\/button>/);
  assert.doesNotMatch(html, /Preparing your photos/); // el aviso de fotos solo aparece mientras se preparan
  assert.doesNotMatch(html, /Which make\?/); // y "Which make?" solo con Other
});

test("NAV-01: el componente se habilita al hidratar y al terminar de plegarse el aviso (ready) y no antes", () => {
  assert.match(FORM, /const \[hydrated, setHydrated\] = useState\(false\)/);
  assert.match(FORM, /const \[ready, setReady\] = useState\(false\)/);
  assert.match(FORM, /useEffect\(\(\) => \{\s*setHydrated\(true\);/); // al hidratar solo se marca hydrated
  assert.match(FORM, /setTimeout\(\(\) => setReady\(true\), LOADING_FOLD_MS\)/); // y ready llega cuando el aviso terminó de plegarse
  assert.match(FORM, /<fieldset disabled=\{!ready\}/);
});

// ---- A7-1, NAV-04 · tratamiento móvil del botón de enviar, las fotos y los select

test("A7-1 y NAV-04: el botón de enviar y el selector de fotos con margen de desplazamiento y 44 px de alto; el select con flecha propia", () => {
  const button = /<Button ref=\{submitRef\}[\s\S]*?className="([^"]+)"/.exec(FORM)?.[1].split(/\s+/) ?? [];
  for (const c of ["scroll-mt-32", "scroll-mb-28"]) assert.ok(button.includes(c), `botón: ${c}`);
  const file = /<input ref=\{photosRef\} id="cb-fotos"[\s\S]*?className="([^"]+)"/.exec(FORM)?.[1].split(/\s+/) ?? [];
  for (const c of ["min-h-11", "text-base", "scroll-mt-32", "scroll-mb-28", "file:min-h-11", "file:text-base"]) assert.ok(file.includes(c), `fotos: ${c}`);
  assert.ok(!file.includes("text-sm"));
  assert.match(FORM, /className=\{cn\(inputCls, "appearance-none pr-10"\)\}/); // WebKit ignora min-height de un select nativo
  assert.match(FORM, /<ChevronDown aria-hidden="true" className="pointer-events-none/);
});

// ---- NAV-03 · CALL NOW

test("NAV-03: CALL NOW no se dibuja mientras el formulario está en pantalla en móvil; en escritorio y antes de hidratar sí", () => {
  assert.equal(hideFloatingCall(true, true), true);
  assert.equal(hideFloatingCall(true, false), false);
  assert.equal(hideFloatingCall(false, true), false);
  assert.equal(hideFloatingCall(false, false), false);
  assert.equal(MOBILE_QUERY, "(max-width: 767px)");
  const page = read("src/pages/CustomBuilds.tsx");
  assert.match(page, /const \[mobile, setMobile\] = useState\(false\)/); // visible por defecto
  assert.match(page, /const \[formInView, setFormInView\] = useState\(false\)/);
  assert.match(page, /watchInView\(form, setFormInView\)/); // el observador y su regla de la entrada más reciente viven en cbFloatingCall (probados aparte)
  assert.match(page, /\{!hideFloatingCall\(mobile, formInView\) && <FloatingCallButton \/>\}/);
});

// ---- A6-1 y NAV-05 · teléfono en los avisos de fallo

test("A6-1 y NAV-05: retry, 403 y 400 llevan el teléfono (los textos van a la lista de Liza)", () => {
  for (const kind of ["retry", "turnstile", "invalid"] as const) {
    assert.equal(CB_NOTICES[kind].phone, true, kind);
    assert.match(CB_NOTICES[kind].text, /call us at$/, kind); // el enlace del teléfono se dibuja después del texto
  }
});
