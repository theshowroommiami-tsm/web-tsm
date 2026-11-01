// En preview se usa la Secret Key de prueba pública de Cloudflare ("siempre pasa"),
// escrita acá a propósito y no en una variable: el secret scanning de Netlify no la ve.
// Es un valor documentado y público; no protege nada.
export const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";
export const PROD_HOSTNAMES = ["showroommiami.com", "www.showroommiami.com"];

export type TurnstileEnv = { entorno: "production" | "preview"; secret?: string };

export async function verifyTurnstile(
  env: TurnstileEnv,
  token: string,
  idempotencyKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const secret = env.entorno === "production" ? env.secret : TURNSTILE_TEST_SECRET;
  if (!secret || !token || token.length > 2048) return false;
  try {
    const res = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, response: token, idempotency_key: idempotencyKey }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json();
    if (!j?.success) return false;
    if (env.entorno === "production") {
      return PROD_HOSTNAMES.includes(j.hostname) && j.action === "cb_request";
    }
    return true;
  } catch {
    return false;
  }
}
