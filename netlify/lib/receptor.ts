import { createHmac } from "node:crypto";

export type ReceptorResult = { ok: true; [k: string]: unknown } | { ok: false; error: string };

export function signPayload(payload: string, secretHex: string): string {
  // La clave es el texto hex en UTF-8, no los bytes que representa (contrato §2).
  return createHmac("sha256", secretHex).update(payload, "utf8").digest("hex");
}

/** POST firmado al receptor. Timeout o respuesta ilegible = error "interno" (503). */
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
    const j = await res.json();
    if (j && typeof j === "object" && typeof j.ok === "boolean") {
      return j.ok ? j : { ok: false, error: String(j.error || "interno") };
    }
    return { ok: false, error: "interno" };
  } catch {
    return { ok: false, error: "interno" };
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
