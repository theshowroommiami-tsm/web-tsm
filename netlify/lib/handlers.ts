// Lógica de las tres Functions de Custom Builds, con dependencias inyectadas para probarla.
// Ninguna respuesta lleva datos personales.
import { MAX_PHOTOS, MAX_PHOTO_BYTES, MAX_THUMB_CHARS, isUuidV4, validatePhotosExpected, validateRequest } from "../../shared/cb-schema.ts";
import { signPermit, verifyPermit } from "./permit.ts";
import { callReceptor, receptorErrorStatus, type ReceptorResult } from "./receptor.ts";
import { TURNSTILE_TEST_SECRET, checkTurnstile } from "./turnstile.ts";

export interface R2Client {
  presignPut(key: string, size: number): Promise<string>;
  head(key: string): Promise<{ size: number } | null>;
  firstBytes(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
}

export type Entorno = "production" | "preview";
export type Deps = {
  entorno: Entorno | null; // null = CB_ENTORNO ausente, mal escrito o contrario al contexto: las Functions fallan cerrado
  entornoProblem?: string; // nombre que se escribe en la alerta cuando entorno es null (por defecto CB_ENTORNO)
  permitSecret: string;
  receptor: { url: string; secret: string };
  turnstileSecret?: string;
  r2Missing?: string[]; // nombres (nunca valores) de las R2_* ausentes o que no corresponden al entorno
  r2: () => R2Client;
  fetchImpl?: typeof fetch;
  now?: () => number; // segundos unix
  log?: (msg: string) => void;
};

const PERMIT_TTL_S = 15 * 60;
const nowSec = (d: Deps) => (d.now ? d.now() : Math.floor(Date.now() / 1000));

function json(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}
const fail = (status: number, error: string, extra?: Record<string, unknown>) => json(status, { error, ...extra });

// Tope del cuerpo de cada Function (caracteres). cb-photos-done lleva hasta 3 miniaturas de MAX_THUMB_CHARS (web-01 §2,
// acción fotos) más el permiso (máximo 2000) y la estructura: el tope sale de esas cifras, no de una inventada. El
// contrato no escribe el tope del cuerpo; la pregunta para GOB quedó en el paquete de entrega.
const BODY_ENVELOPE = 4_000;
export const BODY_MAX = { request: 400_000, photoUrls: 400_000, photosDone: MAX_PHOTOS * MAX_THUMB_CHARS + BODY_ENVELOPE } as const;

async function readJson(req: Request, max: number): Promise<Record<string, unknown> | null> {
  if (req.method !== "POST") return null;
  try {
    const text = await req.text();
    if (text.length > max) return null;
    const j = JSON.parse(text);
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

/**
 * Nombres de las variables que faltan o están mal (nunca sus valores). Vacío = configurado. Las dos Functions de
 * fotos exigen además las R2_*; cb-request no las usa y sigue guardando solicitudes aunque R2 esté mal.
 */
export function configProblems(d: Deps, needsR2 = false): string[] {
  const p: string[] = [];
  if (d.entorno !== "production" && d.entorno !== "preview") p.push(d.entornoProblem ?? "CB_ENTORNO");
  if (!d.permitSecret) p.push("CB_PERMIT_SECRET");
  if (!d.receptor.url) p.push("RECEPTOR_URL");
  if (!d.receptor.secret) p.push("RECEPTOR_SECRET");
  if (d.entorno === "production" && !d.turnstileSecret) p.push("TURNSTILE_SECRET_KEY");
  // Las Secret Keys de prueba de Cloudflare empiezan con 1x, 2x o 3x (las reales, con 0x): en producción no valen.
  if (d.entorno === "production" && d.turnstileSecret && (d.turnstileSecret === TURNSTILE_TEST_SECRET || /^[123]x/.test(d.turnstileSecret))) {
    p.push("TURNSTILE_SECRET_KEY(prueba)");
  }
  if (needsR2) p.push(...(d.r2Missing ?? []));
  return p;
}

/** Si la configuración no está completa: 500 y una línea CB_ALERT con los nombres (no los valores) que faltan. */
function configFail(d: Deps, fn: string, needsR2 = false): Response | null {
  const bad = configProblems(d, needsR2);
  if (!bad.length) return null;
  d.log?.(`CB_ALERT config fn=${fn} missing=${bad.join(",")}`);
  return fail(500, "config");
}

/** Causa de un fallo de R2 para el log: una palabra fija (head_403, get_500, timeout, error), nunca el mensaje ni claves. */
function r2Cause(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "TimeoutError" || e.name === "AbortError") return "timeout";
    const m = /^r2 (head|get) (\d{3})$/.exec(e.message); // los mensajes que arma netlify/lib/r2.ts
    if (m) return `${m[1]}_${m[2]}`;
  }
  return "error";
}

/** Causa que se escribe en el log: una palabra fija (transporte o código del receptor), nunca texto libre ni datos de la solicitud. */
const safeCause = (c: string) => (/^[a-z0-9_]{1,24}$/.test(c) ? c : "desconocida");

/**
 * Cada fallo del receptor deja una línea fija, sin datos personales, con el prefijo CB_ALERT y la causa (timeout,
 * http_<status>, non_json, network, o el código que contestó el receptor). Las líneas CB_ALERT quedan en el log
 * de la Function: leerlas requiere un log drain o revisión manual (Netlify no alerta por patrón de log por sí mismo).
 */
function receptorFail(d: Deps, accion: "crear" | "fotos", r: Extract<ReceptorResult, { ok: false }>) {
  d.log?.(`CB_ALERT receptor accion=${accion} causa=${safeCause(r.cause ?? r.error)}`);
  const { status } = receptorErrorStatus(r.error);
  return fail(status, status === 503 ? "unavailable" : status === 429 ? "quota" : status === 409 ? "conflict" : status === 400 ? "invalid" : "config");
}

export async function handleRequest(req: Request, d: Deps): Promise<Response> {
  if (req.method !== "POST") return fail(405, "method");
  const bad = configFail(d, "cb-request");
  if (bad) return bad;
  const body = await readJson(req, BODY_MAX.request);
  if (!body) return fail(400, "invalid");

  const clave = body.clave;
  if (!isUuidV4(clave)) return fail(400, "invalid");
  const esperadas = validatePhotosExpected(body.fotos_esperadas ?? 0);
  if (esperadas === null) return fail(400, "invalid");
  const v = validateRequest(body.campos);
  if (!v.ok) return fail(400, "invalid", { campos: Object.keys(v.errors) });

  const entorno = d.entorno as Entorno; // configFail ya descartó el null
  const token = typeof body.token === "string" ? body.token : "";
  const human = await checkTurnstile({ entorno, secret: d.turnstileSecret }, token, clave, d.fetchImpl);
  if (human.outcome === "unavailable") {
    // No es quien envía: Cloudflare caído o lento, o un secret inválido. 503 reintentable, no "verify you're human".
    d.log?.(`CB_ALERT turnstile causa=${human.cause}`);
    return fail(503, "unavailable");
  }
  if (human.outcome === "rejected") return fail(403, "turnstile");

  const r = await callReceptor(
    { url: d.receptor.url, secret: d.receptor.secret, entorno },
    "crear",
    { clave, ...v.data, fotos_esperadas: esperadas },
    d.fetchImpl,
    nowSec(d),
  );
  if (!r.ok) return receptorFail(d, "crear", r);

  const leadId = String(r.lead_id || "");
  // ok:true sin lead_id no trae nada que medir ni a qué atar las fotos: reintentable (la misma clave devuelve el replay).
  if (!leadId) {
    d.log?.("CB_ALERT receptor accion=crear causa=sin_lead_id");
    return fail(503, "unavailable");
  }
  const carpeta = String(r.carpeta || "");
  const nMax = Number(r.fotos_esperadas || 0);
  const medir = r.duplicado !== true;
  let permiso: string | null = null;
  if (carpeta && nMax > 0 && leadId) {
    permiso = signPermit({ lead_id: leadId, carpeta, n_max: Math.min(nMax, MAX_PHOTOS), exp: nowSec(d) + PERMIT_TTL_S }, d.permitSecret);
  }
  return json(201, { lead_id: leadId, permiso, medir });
}

export async function handlePhotoUrls(req: Request, d: Deps): Promise<Response> {
  if (req.method !== "POST") return fail(405, "method");
  const bad = configFail(d, "cb-photo-urls", true);
  if (bad) return bad;
  const body = await readJson(req, BODY_MAX.photoUrls);
  if (!body) return fail(400, "invalid");
  const permit = verifyPermit(body.permiso, d.permitSecret, nowSec(d));
  if (!permit) return fail(401, "permit");

  const fotos = body.fotos;
  if (!Array.isArray(fotos) || fotos.length < 1 || fotos.length > permit.n_max) return fail(400, "invalid");
  const seen = new Set<number>();
  for (const f of fotos) {
    const n = f?.n, size = f?.size;
    if (!Number.isInteger(n) || n < 1 || n > permit.n_max || seen.has(n)) return fail(400, "invalid");
    if (!Number.isInteger(size) || size < 1) return fail(400, "invalid");
    if (size > MAX_PHOTO_BYTES) return fail(413, "too_large");
    seen.add(n);
  }
  try {
    const r2 = d.r2();
    const urls = await Promise.all(
      fotos.map(async (f: { n: number; size: number }) => ({
        n: f.n,
        url: await r2.presignPut(`${permit.carpeta}foto-${f.n}.jpg`, f.size),
      })),
    );
    return json(200, { urls });
  } catch (e) {
    d.log?.(`CB_ALERT r2 fn=cb-photo-urls causa=${r2Cause(e)}`);
    return fail(503, "unavailable");
  }
}

export async function handlePhotosDone(req: Request, d: Deps): Promise<Response> {
  if (req.method !== "POST") return fail(405, "method");
  const bad = configFail(d, "cb-photos-done", true);
  if (bad) return bad;
  const body = await readJson(req, BODY_MAX.photosDone);
  if (!body) return fail(400, "invalid");
  const permit = verifyPermit(body.permiso, d.permitSecret, nowSec(d));
  if (!permit) return fail(401, "permit");

  const fotos = body.fotos;
  if (!Array.isArray(fotos) || fotos.length < 1 || fotos.length > permit.n_max) return fail(400, "invalid");
  const seen = new Set<number>();
  for (const f of fotos) {
    if (!Number.isInteger(f?.n) || f.n < 1 || f.n > permit.n_max || seen.has(f.n)) return fail(400, "invalid");
    seen.add(f.n);
  }

  const verified: { n: number; miniatura?: string }[] = [];
  const rejected: number[] = [];
  try {
    const r2 = d.r2();
    for (const f of fotos as { n: number; miniatura?: unknown }[]) {
      const key = `${permit.carpeta}foto-${f.n}.jpg`;
      const head = await r2.head(key);
      if (!head) { rejected.push(f.n); continue; }
      const bytes = head.size > 0 && head.size <= MAX_PHOTO_BYTES ? await r2.firstBytes(key) : null;
      const isJpeg = !!bytes && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      if (!isJpeg) { await r2.remove(key); rejected.push(f.n); continue; }
      const m = f.miniatura;
      const okThumb = typeof m === "string" && m.length <= MAX_THUMB_CHARS && m.startsWith("/9j/") && /^[A-Za-z0-9+/=]+$/.test(m);
      verified.push(okThumb ? { n: f.n, miniatura: m as string } : { n: f.n });
    }
  } catch (e) {
    d.log?.(`CB_ALERT r2 fn=cb-photos-done causa=${r2Cause(e)}`);
    return fail(503, "unavailable");
  }

  if (verified.length === 0) return json(200, { fotos: 0, rechazadas: rejected });
  const r = await callReceptor(
    { url: d.receptor.url, secret: d.receptor.secret, entorno: d.entorno as Entorno },
    "fotos",
    { lead_id: permit.lead_id, fotos: verified },
    d.fetchImpl,
    nowSec(d),
  );
  if (!r.ok) return receptorFail(d, "fotos", r);
  return json(200, { fotos: verified.length, rechazadas: rejected });
}
