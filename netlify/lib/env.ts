import { createR2 } from "./r2.ts";
import type { Deps, Entorno } from "./handlers.ts";

declare const Netlify: { env: { get(k: string): string | undefined } };

// Cada entorno escribe en su propio bucket (web-01 §5). Un bucket cruzado falla cerrado en vez de escribir donde no toca.
export const R2_BUCKETS: Record<Entorno, string> = {
  production: "form-custom-builds",
  preview: "form-custom-builds-preview",
};

/**
 * Lee la configuración del sitio. Falla cerrado: si CB_ENTORNO no es exactamente "production" o "preview", `entorno`
 * queda en null y las tres Functions responden 500 con alerta (antes caía a preview, con la Secret Key de prueba de
 * Turnstile, que siempre pasa). `r2Missing` lista NOMBRES de variables R2_* ausentes o que no corresponden al
 * entorno, nunca valores; la usan las dos Functions de fotos.
 */
export function depsFromEnv(): Deps {
  const g = (k: string) => Netlify.env.get(k) || "";
  const raw = g("CB_ENTORNO");
  const entorno: Entorno | null = raw === "production" || raw === "preview" ? raw : null;

  const r2Missing = ["R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"].filter((k) => !g(k));
  if (entorno && g("R2_BUCKET") && g("R2_BUCKET") !== R2_BUCKETS[entorno]) r2Missing.push("R2_BUCKET(entorno)");

  return {
    entorno,
    permitSecret: g("CB_PERMIT_SECRET"),
    receptor: { url: g("RECEPTOR_URL"), secret: g("RECEPTOR_SECRET") },
    turnstileSecret: g("TURNSTILE_SECRET_KEY") || undefined,
    r2Missing,
    r2: () => createR2({
      accountId: g("R2_ACCOUNT_ID"), bucket: g("R2_BUCKET"),
      accessKeyId: g("R2_ACCESS_KEY_ID"), secretAccessKey: g("R2_SECRET_ACCESS_KEY"),
    }),
    log: (m) => console.error(m),
  };
}
