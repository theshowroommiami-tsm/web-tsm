// Firma S3 contra R2 con aws4fetch (igual que erp-tsm supabase/functions/_shared/r2.ts).
// Único archivo que importa aws4fetch: las pruebas unitarias usan la interfaz R2Client.
import { AwsClient } from "aws4fetch";
import type { R2Client } from "./handlers.ts";

export function createR2(env: { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string }): R2Client {
  const aws = new AwsClient({
    accessKeyId: env.accessKeyId,
    secretAccessKey: env.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const base = `https://${env.accountId}.r2.cloudflarestorage.com/${env.bucket}`;
  const urlFor = (key: string) => `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;

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
    async head(key) {
      const r = await aws.fetch(urlFor(key), { method: "HEAD" });
      if (!r.ok) return null;
      return { size: Number(r.headers.get("content-length") || 0) };
    },
    async firstBytes(key) {
      const r = await aws.fetch(urlFor(key), { headers: { Range: "bytes=0-2" } });
      if (!r.ok) return null;
      return new Uint8Array(await r.arrayBuffer()).slice(0, 3);
    },
    async remove(key) {
      await aws.fetch(urlFor(key), { method: "DELETE" });
    },
  };
}
