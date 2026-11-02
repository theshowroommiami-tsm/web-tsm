// Cliente de las Functions de Custom Builds: borrador, clave de idempotencia y subida de fotos.
import { isUuidV4, type CbFields } from "../../shared/cb-schema.ts";
import type { ProcessedPhoto } from "./cbPhotos.ts";

const DRAFT_KEY = "tsm_cb_draft";

/**
 * `huella` es la del último intento que falló con esta clave (ver fingerprint en cbSubmit). Sin ella, tras recargar la
 * página una corrección reusaría la clave y el receptor devolvería la fila original: la corrección se perdería en
 * silencio. Los borradores viejos no la traen y cargan igual.
 */
export type Draft = { fields: Record<string, string>; clave: string; huella?: string };

const HUELLA_MAX = 50_000; // la huella es el JSON de los campos: sobra para el máximo de cada uno

/**
 * Borrador de la sesión. Se queda solo con las entradas cuyo valor es texto: un valor de otro tipo (borrador viejo o
 * manipulado) hacía lanzar TypeError a normalizePhone al enviar. Una clave que no es UUID v4 se descarta: el servidor
 * la rechazaría con 400 y el usuario quedaría atascado; sin clave, el formulario crea una nueva (y una huella sin clave
 * no significa nada, así que también se descarta).
 */
export function loadDraft(): Draft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) return null;
    const { fields, clave, huella } = j as { fields?: unknown; clave?: unknown; huella?: unknown };
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) if (typeof v === "string") clean[k] = v;
    if (!isUuidV4(clave)) return { fields: clean, clave: "" };
    return typeof huella === "string" && huella && huella.length <= HUELLA_MAX ? { fields: clean, clave, huella } : { fields: clean, clave };
  } catch { return null; }
}
export function saveDraft(d: Draft) {
  try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* bloqueado */ }
}
export function clearDraft() {
  try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* bloqueado */ }
}
export function newIdempotencyKey(): string {
  return crypto.randomUUID(); // UUID v4
}

export type SubmitOutcome =
  | { kind: "ok"; leadId: string; permiso: string | null; medir: boolean }
  | { kind: "turnstile" | "quota" | "invalid" | "retry" | "error" };

// Tiempos del cliente. cb-request: la Function tarda como máximo ~16 s (Turnstile 8 s + receptor 8 s). cb-photos-done: el
// peor caso del servidor son 3 fotos x 3 llamadas a R2 x 4 s = 36 s más 8 s del receptor = 44 s, y Netlify corta a los
// 60 s; el cliente espera 50 s, más que el servidor y menos que el corte, para no rendirse mientras el servidor aún
// registra las fotos. El PUT prefirmado vence a los 300 s y el permiso a los 15 min: tres fotos en serie a 40 s suman
// 120 s, y el total (15 + 120 + 50 s) cabe en las dos ventanas.
export const CB_TIMEOUTS = { request: 30_000, photoUrls: 15_000, put: 40_000, photosDone: 50_000 } as const;
export type CbTimeouts = { [K in keyof typeof CB_TIMEOUTS]: number };

/** Ejecuta `run` con una señal que se aborta a los `ms` (AbortController: AbortSignal.timeout no existe en Safari < 16). */
async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await run(ctl.signal); } finally { clearTimeout(timer); }
}

/** Forma mínima del 201 ({lead_id, permiso, medir}): lead_id texto no vacío; permiso texto o null; medir solo cuenta si es true. */
async function readCreated(res: Response): Promise<{ leadId: string; permiso: string | null; medir: boolean } | null> {
  let j: unknown;
  try { j = await res.json(); } catch { return null; }
  if (!j || typeof j !== "object") return null;
  const { lead_id, permiso, medir } = j as Record<string, unknown>;
  if (typeof lead_id !== "string" || !lead_id) return null;
  if (permiso != null && typeof permiso !== "string") return null;
  return { leadId: lead_id, permiso: typeof permiso === "string" ? permiso : null, medir: medir === true };
}

export async function postRequest(
  clave: string, token: string, campos: Partial<CbFields>, fotosEsperadas: number, timeoutMs: number = CB_TIMEOUTS.request,
): Promise<SubmitOutcome> {
  return withTimeout(timeoutMs, async (signal): Promise<SubmitOutcome> => {
    let res: Response;
    try {
      res = await fetch("/api/cb-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clave, token, campos, fotos_esperadas: fotosEsperadas }),
        signal,
      });
    } catch { return { kind: "retry" }; } // sin red o vencido el tiempo: se reintenta con la misma clave
    if (res.status === 201) {
      // Un 201 sin cuerpo utilizable (no es JSON, o falta lead_id) no trae un lead_id confiable: se trata como
      // "retry" (la tabla de web-01: una respuesta que no sea el JSON esperado = reintentable). La clave de
      // idempotencia no se toca, así el reintento recibe el replay del mismo lead y no crea otro.
      const j = await readCreated(res);
      return j ? { kind: "ok", ...j } : { kind: "retry" };
    }
    if (res.status === 403) return { kind: "turnstile" };
    if (res.status === 429) return { kind: "quota" };
    if (res.status === 400) return { kind: "invalid" };
    // 503 del receptor; 502 y 504 de Netlify cuando la Function se corta o tarda. Reintentar es seguro: la clave de
    // idempotencia hace que el reintento reciba el replay del mismo lead y no cree otro.
    if (res.status === 503 || res.status === 502 || res.status === 504) return { kind: "retry" };
    return { kind: "error" };
  });
}

/** POST JSON con tiempo máximo; devuelve el estado y el cuerpo ya leído (null si no es JSON). */
async function postJson(url: string, body: unknown, ms: number): Promise<{ ok: boolean; json: unknown }> {
  return withTimeout(ms, async (signal) => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    let json: unknown = null;
    try { json = await res.json(); } catch { /* sin cuerpo utilizable */ }
    return { ok: res.ok, json };
  });
}

/**
 * Sube las fotos por PUT prefirmado y confirma. Devuelve cuántas quedaron verificadas. Cada PUT va con su propio tiempo
 * máximo y su propio try/catch: una foto caída no aborta las demás ni deja el formulario esperando, y cb-photos-done
 * se llama con las que sí subieron.
 */
export async function uploadPhotos(permiso: string, photos: ProcessedPhoto[], t: CbTimeouts = CB_TIMEOUTS): Promise<number> {
  const r1 = await postJson("/api/cb-photo-urls", { permiso, fotos: photos.map((p, i) => ({ n: i + 1, size: p.blob.size })) }, t.photoUrls);
  if (!r1.ok) throw new Error("urls");
  const urls = (r1.json as { urls?: { n: number; url: string }[] } | null)?.urls;
  if (!Array.isArray(urls)) throw new Error("urls");

  const done: { n: number; miniatura?: string }[] = [];
  for (const { n, url } of urls) {
    const p = photos[n - 1];
    if (!p) continue;
    try {
      const ok = await withTimeout(t.put, async (signal) => {
        const put = await fetch(url, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: p.blob, signal });
        return put.ok;
      });
      if (ok) done.push(p.thumb ? { n, miniatura: p.thumb } : { n });
    } catch { /* esta foto no subió (red, CORS o tiempo); las demás siguen */ }
  }
  if (!done.length) return 0;
  const r2 = await postJson("/api/cb-photos-done", { permiso, fotos: done }, t.photosDone);
  if (!r2.ok) throw new Error("done");
  const fotos = (r2.json as { fotos?: unknown } | null)?.fotos;
  return typeof fotos === "number" ? fotos : 0;
}
