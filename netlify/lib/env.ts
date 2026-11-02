import { createR2 } from "./r2.ts";
import type { Deps, Entorno } from "./handlers.ts";
import { PROD_HOSTNAMES } from "./turnstile.ts";

declare const Netlify: { env: { get(k: string): string | undefined } };

// Cada entorno escribe en su propio bucket (web-01 §5). Un bucket cruzado falla cerrado en vez de escribir donde no toca.
export const R2_BUCKETS: Record<Entorno, string> = {
  production: "form-custom-builds",
  preview: "form-custom-builds-preview",
};

// Contextos de despliegue de Netlify que documenta "Deploy overview" y que reporta context.deploy.context en el handler.
const PRODUCTION_CONTEXT = "production";
const NON_PRODUCTION_CONTEXTS = ["deploy-preview", "branch-deploy", "preview-server", "dev"];

const NETLIFY_APP_SUFFIX = ".netlify.app";

/**
 * Anfitrión que parece de un deploy preview o de un branch deploy de Netlify: "deploy-preview-<n>--<sitio>.netlify.app" o
 * "<rama>--<sitio>.netlify.app" (también los deploys con permalink, "<id>--<sitio>.netlify.app"). El dominio de
 * producción del sitio, "<sitio>.netlify.app" sin "--", NO lo es: el sitio de producción también responde ahí. "Parece":
 * la forma con "--" sirve también a la rama y a los permalinks de producción (ver isDeployPreviewHost).
 */
export function isPreviewHost(host: string): boolean {
  const h = host.toLowerCase();
  return isDeployPreviewHost(h) || (h.endsWith(NETLIFY_APP_SUFFIX) && h.slice(0, -NETLIFY_APP_SUFFIX.length).includes("--"));
}

/**
 * Anfitrión de un deploy preview ("deploy-preview-<n>--<sitio>.netlify.app"): ese nunca es el sitio de producción. En
 * cambio un "<algo>--<sitio>.netlify.app" puede ser también el permalink de un despliegue de producción o la rama de
 * producción ("main--<sitio>.netlify.app"), así que solo con eso no se puede afirmar que sea un preview.
 */
export function isDeployPreviewHost(host: string): boolean {
  return host.toLowerCase().startsWith("deploy-preview-");
}

/** Anfitrión limpio: minúsculas, sin puerto y sin el punto final de un nombre DNS absoluto ("showroommiami.com."). */
const cleanHost = (h: string) => h.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");

/** Anfitriones de la petición por dos caminos: el de la URL y el encabezado Host. Los que no lleguen se omiten. */
export function hostsOf(req: Request): string[] {
  const hosts: string[] = [];
  try { hosts.push(cleanHost(new URL(req.url).hostname)); } catch { /* URL que no se puede leer */ }
  const header = cleanHost(req.headers.get("host") || "");
  if (header && !hosts.includes(header)) hosts.push(header);
  return hosts.filter(Boolean);
}

/**
 * CB_ENTORNO tiene que ser exactamente "production" o "preview" y no contradecir dónde corre el despliegue. Dos
 * mecanismos independientes, porque ninguno basta solo:
 * - contexto (context.deploy.context): "preview" en el contexto production dejaría Turnstile con la Secret Key de
 *   prueba (que siempre pasa) y los leads reales caerían en la hoja Tests; "production" en un deploy preview usaría
 *   secretos de producción. Un contexto que no se reconoce (o que no llega) no bloquea. Su valor en un despliegue real
 *   no está verificado.
 * - anfitrión (el de la petición): "preview" en showroommiami.com o www.showroommiami.com es el mismo error; "production"
 *   en un anfitrión de deploy preview ("deploy-preview-", que nunca es producción) es el otro. Un "<algo>--<sitio>.netlify.app"
 *   (branch deploy o permalink) también cuenta como preview, salvo que el contexto diga "production": ahí es el permalink
 *   de un despliegue de producción o la rama de producción, y bloquearlo dejaría sin formulario al sitio vivo. Cualquier
 *   otro anfitrión (localhost, desconocido, el dominio .netlify.app de producción) no bloquea: no se puede decir que contradiga.
 * Cada uno nombra su causa en la alerta: CB_ENTORNO(contexto) y CB_ENTORNO(anfitrion).
 */
export function entornoFor(raw: string, deployContext?: string, hosts: readonly string[] = []): { entorno: Entorno | null; problem?: string } {
  if (raw !== "production" && raw !== "preview") return { entorno: null, problem: "CB_ENTORNO" };
  if (raw === "preview" && deployContext === PRODUCTION_CONTEXT) return { entorno: null, problem: "CB_ENTORNO(contexto)" };
  if (raw === "production" && deployContext && NON_PRODUCTION_CONTEXTS.includes(deployContext)) return { entorno: null, problem: "CB_ENTORNO(contexto)" };
  if (raw === "preview" && hosts.some((h) => PROD_HOSTNAMES.includes(h))) return { entorno: null, problem: "CB_ENTORNO(anfitrion)" };
  if (raw === "production" && hosts.some((h) => isDeployPreviewHost(h) || (deployContext !== PRODUCTION_CONTEXT && isPreviewHost(h)))) {
    return { entorno: null, problem: "CB_ENTORNO(anfitrion)" };
  }
  return { entorno: raw };
}

/**
 * Lee la configuración del sitio. Falla cerrado: si CB_ENTORNO no es exactamente "production" o "preview", `entorno`
 * queda en null y las tres Functions responden 500 con alerta (antes caía a preview, con la Secret Key de prueba de
 * Turnstile, que siempre pasa). `r2Missing` lista NOMBRES de variables R2_* ausentes o que no corresponden al
 * entorno, nunca valores; la usan las dos Functions de fotos.
 */
export function depsFromEnv(deployContext?: string, hosts: readonly string[] = []): Deps {
  // trim(): un valor pegado con un salto de línea o un espacio al final no es el valor que se quiso cargar.
  const g = (k: string) => (Netlify.env.get(k) || "").trim();
  const { entorno, problem: entornoProblem } = entornoFor(g("CB_ENTORNO"), deployContext, hosts);

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

/** Las tres Functions arman su configuración igual: el entorno se contrasta con el contexto del despliegue y con el anfitrión. */
export const depsForRequest = (req: Request, context?: { deploy?: { context?: string } }): Deps =>
  depsFromEnv(context?.deploy?.context, hostsOf(req));
