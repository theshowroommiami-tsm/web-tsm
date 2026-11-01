import { createR2 } from "./r2.ts";
import type { Deps, Entorno } from "./handlers.ts";

declare const Netlify: { env: { get(k: string): string | undefined } };

// Cada entorno escribe en su propio bucket (web-01 §5). Un bucket cruzado falla cerrado en vez de escribir donde no toca.
export const R2_BUCKETS: Record<Entorno, string> = {
  production: "form-custom-builds",
  preview: "form-custom-builds-preview",
};

// Contextos de despliegue de Netlify que documenta "Deploy overview" y que reporta context.deploy.context en el handler.
const PRODUCTION_CONTEXT = "production";
const NON_PRODUCTION_CONTEXTS = ["deploy-preview", "branch-deploy", "preview-server", "dev"];

/**
 * CB_ENTORNO tiene que ser exactamente "production" o "preview" y no contradecir el contexto del despliegue: "preview"
 * en el contexto production dejaría Turnstile con la Secret Key de prueba (que siempre pasa) y los leads reales caerían
 * en la hoja Tests; "production" en un deploy preview usaría secretos de producción. Un contexto que no se reconoce (o
 * que no llega) no bloquea: no se puede verificar, y no se inventa.
 */
export function entornoFor(raw: string, deployContext?: string): { entorno: Entorno | null; problem?: string } {
  if (raw !== "production" && raw !== "preview") return { entorno: null, problem: "CB_ENTORNO" };
  if (raw === "preview" && deployContext === PRODUCTION_CONTEXT) return { entorno: null, problem: "CB_ENTORNO(contexto)" };
  if (raw === "production" && deployContext && NON_PRODUCTION_CONTEXTS.includes(deployContext)) return { entorno: null, problem: "CB_ENTORNO(contexto)" };
  return { entorno: raw };
}

/**
 * Lee la configuración del sitio. Falla cerrado: si CB_ENTORNO no es exactamente "production" o "preview", `entorno`
 * queda en null y las tres Functions responden 500 con alerta (antes caía a preview, con la Secret Key de prueba de
 * Turnstile, que siempre pasa). `r2Missing` lista NOMBRES de variables R2_* ausentes o que no corresponden al
 * entorno, nunca valores; la usan las dos Functions de fotos.
 */
export function depsFromEnv(deployContext?: string): Deps {
  // trim(): un valor pegado con un salto de línea o un espacio al final no es el valor que se quiso cargar.
  const g = (k: string) => (Netlify.env.get(k) || "").trim();
  const { entorno, problem: entornoProblem } = entornoFor(g("CB_ENTORNO"), deployContext);

  const r2Missing = ["R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"].filter((k) => !g(k));
  if (entorno && g("R2_BUCKET") && g("R2_BUCKET") !== R2_BUCKETS[entorno]) r2Missing.push("R2_BUCKET(entorno)");

  return {
    entorno,
    entornoProblem,
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
