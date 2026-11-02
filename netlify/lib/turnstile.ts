// En preview se usa la Secret Key de prueba pública de Cloudflare ("siempre pasa"),
// escrita acá a propósito y no en una variable: el secret scanning de Netlify no la ve.
// Es un valor documentado y público; no protege nada.
export const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";
export const PROD_HOSTNAMES = ["showroommiami.com", "www.showroommiami.com"];

export type TurnstileEnv = { entorno: "production" | "preview"; secret?: string };

/**
 * ok: el token es válido. rejected: lo rechaza Cloudflare por el usuario (token vencido, repetido o falso) o no es de
 * este sitio. unavailable: no se pudo verificar por un fallo del servicio o de nuestra configuración (secret inválido,
 * Cloudflare caído o lento); no es culpa de quien envía, así que la Function responde 503 reintentable y deja una línea
 * CB_ALERT con `cause` (una palabra fija).
 */
export type TurnstileResult = { outcome: "ok" } | { outcome: "rejected" } | { outcome: "unavailable"; cause: string };

// error-codes de siteverify que son del servicio o de la configuración, no de quien envía. Un Map, no un objeto: el
// código viene de la red y un objeto contesta por su prototipo ("constructor", "toString", "__proto__").
const SERVICE_ERRORS = new Map<string, string>([
  ["invalid-input-secret", "invalid_secret"],
  ["missing-input-secret", "missing_secret"],
  ["bad-request", "bad_request"],
  ["internal-error", "internal_error"],
]);
// error-codes que sí son de quien envía (token ausente, falso, vencido o repetido): rechazo, con el estado HTTP que sea.
const USER_ERRORS = new Set(["missing-input-response", "invalid-input-response", "timeout-or-duplicate"]);

export async function checkTurnstile(
  env: TurnstileEnv,
  token: string,
  idempotencyKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TurnstileResult> {
  const secret = env.entorno === "production" ? env.secret : TURNSTILE_TEST_SECRET;
  if (!secret || !token || token.length > 2048) return { outcome: "rejected" };
  try {
    const res = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, response: token, idempotency_key: idempotencyKey }),
      signal: AbortSignal.timeout(8000),
    });
    // Cloudflare puede contestar 400 con un JSON que dice la causa (p. ej. invalid-input-secret): se lee el cuerpo antes
    // de que el estado HTTP decida. Sin cuerpo JSON, manda el estado.
    let j: { success?: unknown; hostname?: unknown; action?: unknown; "error-codes"?: unknown } | null = null;
    try {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) j = parsed as typeof j;
    } catch { /* sin cuerpo JSON */ }
    // Solo el booleano true cuenta: "false", 1 o "true" son verdaderos para JavaScript y no son lo que Cloudflare contesta.
    if (!res.ok || j?.success !== true) {
      const codes = Array.isArray(j?.["error-codes"]) ? (j!["error-codes"] as unknown[]) : [];
      for (const c of codes) {
        const cause = typeof c === "string" ? SERVICE_ERRORS.get(c) : undefined;
        if (cause) return { outcome: "unavailable", cause };
      }
      if (codes.some((c) => typeof c === "string" && USER_ERRORS.has(c))) return { outcome: "rejected" };
      if (!res.ok) return { outcome: "unavailable", cause: `http_${res.status}` };
      if (!j) return { outcome: "unavailable", cause: "non_json" };
      return { outcome: "rejected" };
    }
    if (env.entorno === "production" && !(PROD_HOSTNAMES.includes(j.hostname as string) && j.action === "cb_request")) {
      return { outcome: "rejected" };
    }
    return { outcome: "ok" };
  } catch (e) {
    return { outcome: "unavailable", cause: e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network" };
  }
}

/** Compatibilidad: true solo si el token es válido. */
export async function verifyTurnstile(env: TurnstileEnv, token: string, idempotencyKey: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  return (await checkTurnstile(env, token, idempotencyKey, fetchImpl)).outcome === "ok";
}
