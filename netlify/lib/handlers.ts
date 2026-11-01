// Lógica de las tres Functions de Custom Builds, con dependencias inyectadas para probarla.
// Ninguna respuesta lleva datos personales.
import { MAX_PHOTOS, MAX_PHOTO_BYTES, isUuidV4, validatePhotosExpected, validateRequest } from "../../shared/cb-schema.ts";
import { signPermit, verifyPermit } from "./permit.ts";
import { callReceptor, receptorErrorStatus, type ReceptorResult } from "./receptor.ts";
import { verifyTurnstile } from "./turnstile.ts";

export interface R2Client {
  presignPut(key: string, size: number): Promise<string>;
  head(key: string): Promise<{ size: number } | null>;
  firstBytes(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
}

export type Entorno = "production" | "preview";
export type Deps = {
  entorno: Entorno;
  permitSecret: string;
  receptor: { url: string; secret: string };
  turnstileSecret?: string;
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

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  if (req.method !== "POST") return null;
  try {
    const text = await req.text();
    if (text.length > 400_000) return null;
    const j = JSON.parse(text);
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

function configured(d: Deps): boolean {
  return !!(d.permitSecret && d.receptor.url && d.receptor.secret && (d.entorno === "preview" || d.turnstileSecret));
}

function receptorFail(d: Deps, r: Extract<ReceptorResult, { ok: false }>) {
  const { status, alert } = receptorErrorStatus(r.error);
  if (alert) d.log?.(`ALERT cb receptor config error: ${r.error}`);
  return fail(status, status === 503 ? "unavailable" : status === 429 ? "quota" : status === 409 ? "conflict" : status === 400 ? "invalid" : "config");
}

export async function handleRequest(req: Request, d: Deps): Promise<Response> {
  if (req.method !== "POST") return fail(405, "method");
  if (!configured(d)) { d.log?.("ALERT cb-request: missing configuration"); return fail(500, "config"); }
  const body = await readJson(req);
  if (!body) return fail(400, "invalid");

  const clave = body.clave;
  if (!isUuidV4(clave)) return fail(400, "invalid");
  const esperadas = validatePhotosExpected(body.fotos_esperadas ?? 0);
  if (esperadas === null) return fail(400, "invalid");
  const v = validateRequest(body.campos);
  if (!v.ok) return fail(400, "invalid", { campos: Object.keys(v.errors) });

  const token = typeof body.token === "string" ? body.token : "";
  const human = await verifyTurnstile({ entorno: d.entorno, secret: d.turnstileSecret }, token, clave, d.fetchImpl);
  if (!human) return fail(403, "turnstile");

  const r = await callReceptor(
    { url: d.receptor.url, secret: d.receptor.secret, entorno: d.entorno },
    "crear",
    { clave, ...v.data, fotos_esperadas: esperadas },
    d.fetchImpl,
    nowSec(d),
  );
  if (!r.ok) return receptorFail(d, r);

  const leadId = String(r.lead_id || "");
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
  if (!configured(d)) { d.log?.("ALERT cb-photo-urls: missing configuration"); return fail(500, "config"); }
  const body = await readJson(req);
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
  const r2 = d.r2();
  try {
    const urls = await Promise.all(
      fotos.map(async (f: { n: number; size: number }) => ({
        n: f.n,
        url: await r2.presignPut(`${permit.carpeta}foto-${f.n}.jpg`, f.size),
      })),
    );
    return json(200, { urls });
  } catch {
    return fail(503, "unavailable");
  }
}

export async function handlePhotosDone(req: Request, d: Deps): Promise<Response> {
  if (req.method !== "POST") return fail(405, "method");
  if (!configured(d)) { d.log?.("ALERT cb-photos-done: missing configuration"); return fail(500, "config"); }
  const body = await readJson(req);
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

  const r2 = d.r2();
  const verified: { n: number; miniatura?: string }[] = [];
  const rejected: number[] = [];
  try {
    for (const f of fotos as { n: number; miniatura?: unknown }[]) {
      const key = `${permit.carpeta}foto-${f.n}.jpg`;
      const head = await r2.head(key);
      if (!head) { rejected.push(f.n); continue; }
      const bytes = head.size > 0 && head.size <= MAX_PHOTO_BYTES ? await r2.firstBytes(key) : null;
      const isJpeg = !!bytes && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      if (!isJpeg) { await r2.remove(key); rejected.push(f.n); continue; }
      const m = f.miniatura;
      const okThumb = typeof m === "string" && m.length <= 200_000 && m.startsWith("/9j/") && /^[A-Za-z0-9+/=]+$/.test(m);
      verified.push(okThumb ? { n: f.n, miniatura: m as string } : { n: f.n });
    }
  } catch {
    return fail(503, "unavailable");
  }

  if (verified.length === 0) return json(200, { fotos: 0, rechazadas: rejected });
  const r = await callReceptor(
    { url: d.receptor.url, secret: d.receptor.secret, entorno: d.entorno },
    "fotos",
    { lead_id: permit.lead_id, fotos: verified },
    d.fetchImpl,
    nowSec(d),
  );
  if (!r.ok) return receptorFail(d, r);
  return json(200, { fotos: verified.length, rechazadas: rejected });
}
