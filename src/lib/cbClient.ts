// Cliente de las Functions de Custom Builds: borrador, clave de idempotencia y subida de fotos.
import type { CbFields } from "../../shared/cb-schema.ts";
import type { ProcessedPhoto } from "./cbPhotos.ts";

const DRAFT_KEY = "tsm_cb_draft";

export type Draft = { fields: Record<string, string>; clave: string };

export function loadDraft(): Draft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Draft) : null;
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

export async function postRequest(clave: string, token: string, campos: Partial<CbFields>, fotosEsperadas: number): Promise<SubmitOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/cb-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clave, token, campos, fotos_esperadas: fotosEsperadas }),
    });
  } catch { return { kind: "retry" }; }
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
  if (res.status === 503) return { kind: "retry" };
  return { kind: "error" };
}

/** Sube las fotos por PUT prefirmado y confirma. Devuelve cuántas quedaron verificadas. */
export async function uploadPhotos(permiso: string, photos: ProcessedPhoto[]): Promise<number> {
  const post = (url: string, body: unknown) =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const r1 = await post("/api/cb-photo-urls", { permiso, fotos: photos.map((p, i) => ({ n: i + 1, size: p.blob.size })) });
  if (!r1.ok) throw new Error("urls");
  const { urls } = (await r1.json()) as { urls: { n: number; url: string }[] };

  const done: { n: number; miniatura?: string }[] = [];
  for (const { n, url } of urls) {
    const p = photos[n - 1];
    const put = await fetch(url, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: p.blob });
    if (put.ok) done.push(p.thumb ? { n, miniatura: p.thumb } : { n });
  }
  if (!done.length) return 0;
  const r2 = await post("/api/cb-photos-done", { permiso, fotos: done });
  if (!r2.ok) throw new Error("done");
  return ((await r2.json()) as { fotos: number }).fotos;
}
