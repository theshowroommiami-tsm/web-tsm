import { createR2 } from "./r2.ts";
import type { Deps } from "./handlers.ts";

declare const Netlify: { env: { get(k: string): string | undefined } };

export function depsFromEnv(): Deps {
  const g = (k: string) => Netlify.env.get(k) || "";
  const entorno = g("CB_ENTORNO") === "production" ? "production" : "preview";
  return {
    entorno,
    permitSecret: g("CB_PERMIT_SECRET"),
    receptor: { url: g("RECEPTOR_URL"), secret: g("RECEPTOR_SECRET") },
    turnstileSecret: g("TURNSTILE_SECRET_KEY") || undefined,
    r2: () => createR2({
      accountId: g("R2_ACCOUNT_ID"), bucket: g("R2_BUCKET"),
      accessKeyId: g("R2_ACCESS_KEY_ID"), secretAccessKey: g("R2_SECRET_ACCESS_KEY"),
    }),
    log: (m) => console.error(m),
  };
}
