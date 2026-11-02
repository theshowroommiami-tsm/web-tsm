import { createHmac, timingSafeEqual } from "node:crypto";

export type Permit = { lead_id: string; carpeta: string; n_max: number; exp: number };

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (seg: string, secret: string) => createHmac("sha256", secret).update(seg).digest();

export function signPermit(p: Permit, secret: string): string {
  const seg = b64u(JSON.stringify(p));
  return `${seg}.${b64u(mac(seg, secret))}`;
}

/** Devuelve el permiso si la firma coincide y no venció (now >= exp lo rechaza); null en otro caso. */
export function verifyPermit(token: unknown, secret: string, nowSec = Math.floor(Date.now() / 1000)): Permit | null {
  if (typeof token !== "string" || token.length > 2000) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const given = Buffer.from(parts[1], "base64url");
  const expected = mac(parts[0], secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (
      typeof p?.lead_id !== "string" || typeof p?.carpeta !== "string" ||
      !Number.isInteger(p?.n_max) || p.n_max < 1 || p.n_max > 3 ||
      !Number.isInteger(p?.exp) || nowSec >= p.exp ||
      !/^solicitudes\/[A-Za-z0-9-]+\/$/.test(p.carpeta)
    ) return null;
    return p as Permit;
  } catch {
    return null;
  }
}
