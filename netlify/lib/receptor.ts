import { createHmac } from "node:crypto";

// `cause` solo viaja cuando el fallo es de transporte (timeout, http_<status>, non_json, network): lo usa la línea CB_ALERT.
export type ReceptorResult = { ok: true; [k: string]: unknown } | { ok: false; error: string; cause?: string };

export function signPayload(payload: string, secretHex: string): string {
  // La clave es el texto hex en UTF-8, no los bytes que representa (contrato §2).
  return createHmac("sha256", secretHex).update(payload, "utf8").digest("hex");
}

const isTimeout = (e: unknown) => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

/** POST firmado al receptor. Timeout o respuesta ilegible = error "interno" (503), con la causa para la alerta. */
export async function callReceptor(
  env: { url: string; secret: string; entorno: "production" | "preview" },
  accion: "crear" | "fotos" | "ping",
  datos: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<ReceptorResult> {
  const payload = JSON.stringify({ v: 1, accion, entorno: env.entorno, ts: nowSec, datos });
  try {
    const res = await fetchImpl(env.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload, firma: signPayload(payload, env.secret) }),
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: "interno", cause: `http_${res.status}` };
    let j: unknown;
    try { j = await res.json(); } catch { return { ok: false, error: "interno", cause: "non_json" }; }
    const r = j as { ok?: unknown; error?: unknown } | null;
    if (r && typeof r === "object" && typeof r.ok === "boolean") {
      return r.ok ? (j as ReceptorResult) : { ok: false, error: String(r.error || "interno") };
    }
    return { ok: false, error: "interno", cause: "non_json" };
  } catch (e) {
    return { ok: false, error: "interno", cause: isTimeout(e) ? "timeout" : "network" };
  }
}

/** Traducción de errores del receptor a HTTP (contrato §2, Errores). */
export function receptorErrorStatus(error: string): { status: number; alert: boolean } {
  switch (error) {
    case "cupo": return { status: 429, alert: false };
    case "datos": case "clave": return { status: 400, alert: false };
    case "lead": return { status: 409, alert: false };
    case "firma": case "vencido": case "entorno": case "formato": case "accion": case "metodo": case "config":
      return { status: 500, alert: true };
    default: return { status: 503, alert: false }; // ocupado, interno, timeout, desconocido
  }
}
