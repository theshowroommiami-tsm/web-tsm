// Firma S3 contra R2 con aws4fetch (igual que erp-tsm supabase/functions/_shared/r2.ts).
// Único archivo que importa aws4fetch: las pruebas unitarias de los handlers usan la interfaz R2Client.
import { AwsClient } from "aws4fetch";
import type { R2Client } from "./handlers.ts";

// Cada llamada a R2 tiene su tiempo máximo. cb-photos-done verifica hasta 3 fotos en serie (HEAD, GET de 3 bytes y, si
// no es JPEG, DELETE): 3 x 3 x 4 s = 36 s, más 8 s del receptor, queda bajo los 60 s de una Function síncrona de Netlify.
export const R2_TIMEOUT_MS = 4000;

export function createR2(
  env: { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string },
  opts: { timeoutMs?: number } = {},
): R2Client {
  // retries: 0. Por defecto aws4fetch reintenta 10 veces con espera exponencial ante 5xx y 429: un R2 degradado dejaría
  // la Function esperando decenas de segundos. Un fallo transitorio sube como 503 y el navegador reintenta.
  const aws = new AwsClient({
    accessKeyId: env.accessKeyId,
    secretAccessKey: env.secretAccessKey,
    service: "s3",
    region: "auto",
    retries: 0,
  });
  const timeoutMs = opts.timeoutMs ?? R2_TIMEOUT_MS;
  const base = `https://${env.accountId}.r2.cloudflarestorage.com/${env.bucket}`;
  const urlFor = (key: string) => `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const call = (key: string, init: RequestInit) => aws.fetch(urlFor(key), { ...init, signal: AbortSignal.timeout(timeoutMs) });

  return {
    async presignPut(key, size) {
      const signed = await aws.sign(
        new Request(`${urlFor(key)}?X-Amz-Expires=300`, {
          method: "PUT",
          headers: { "Content-Type": "image/jpeg", "Content-Length": String(size) },
        }),
        { aws: { signQuery: true, allHeaders: true } },
      );
      return signed.url;
    },
    // null solo cuando el objeto no existe (404) o está vacío (416 al pedir un rango). Cualquier otro estado (403 por una
    // credencial mala, 5xx, 429) lanza: el handler responde 503 reintentable en vez de dar por inválida una foto buena.
    async head(key) {
      const r = await call(key, { method: "HEAD" });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`r2 head ${r.status}`);
      return { size: Number(r.headers.get("content-length") || 0) };
    },
    async firstBytes(key) {
      const r = await call(key, { headers: { Range: "bytes=0-2" } });
      if (r.status === 404 || r.status === 416) return null;
      if (!r.ok) throw new Error(`r2 get ${r.status}`);
      return new Uint8Array(await r.arrayBuffer()).slice(0, 3);
    },
    // Borrar es de mejor esfuerzo: si falla, el objeto inválido queda sin registrarse (lo limpia el ciclo de vida del
    // bucket) y no se descartan las fotos buenas de la misma solicitud.
    async remove(key) {
      try { await call(key, { method: "DELETE" }); } catch { /* mejor esfuerzo */ }
    },
  };
}
