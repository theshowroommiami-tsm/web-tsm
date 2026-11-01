// Atribución de Custom Builds (alcance 6). Funciones puras; el almacenamiento se inyecta.
import { CLICK_ID_TYPES, MAX_LEN, ORIGINS } from "./cb-schema.ts";

export const ATTRIBUTION_KEY = "tsm_cb_attribution";
export const ATTRIBUTION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export type Attribution = {
  origen: "google_ads" | "utm" | "referral" | "unknown";
  utm_source?: string; utm_medium?: string; utm_campaign?: string; utm_term?: string; utm_content?: string;
  click_id_tipo?: "gclid" | "gbraid" | "wbraid"; click_id?: string;
  aterrizaje?: string; referrer?: string;
};

export type StoredAttribution = { savedAt: number; data: Attribution };

export function referrerHost(referrer: string, ownHost: string): string {
  if (!referrer) return "";
  try {
    const h = new URL(referrer).hostname.toLowerCase();
    const strip = (x: string) => x.replace(/^www\./, "");
    return strip(h) === strip(ownHost.toLowerCase()) ? "" : h.slice(0, 200);
  } catch {
    return "";
  }
}

/** Lee la atribución de la URL de aterrizaje. Devuelve null si no hay nada que guardar. */
export function captureAttribution(search: string, pathname: string, referrer: string, ownHost: string): Attribution | null {
  const q = new URLSearchParams(search);
  const get = (k: string, max: number) => (q.get(k) || "").trim().slice(0, max);
  const a: Attribution = { origen: "unknown" };
  for (const [k, max] of [["utm_source", 120], ["utm_medium", 120], ["utm_campaign", 160], ["utm_term", 160], ["utm_content", 160]] as const) {
    const v = get(k, max);
    if (v) a[k] = v;
  }
  for (const t of ["gclid", "gbraid", "wbraid"] as const) {
    const v = get(t, 200);
    if (v) { a.click_id_tipo = t; a.click_id = v; break; }
  }
  const host = referrerHost(referrer, ownHost);
  if (host) a.referrer = host;

  if (a.click_id) a.origen = "google_ads";
  else if (a.utm_source || a.utm_medium || a.utm_campaign) a.origen = "utm";
  else if (host) a.origen = "referral";

  a.aterrizaje = pathname.slice(0, 300);
  // Sin señal alguna (visita directa) no se guarda nada.
  return a.origen === "unknown" ? null : a;
}

type StorageLike = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

/** Rango de cada señal: una más débil no pisa a una más fuerte vigente (google_ads 3, utm 2, referral 1). */
export const ORIGIN_RANK: Record<Attribution["origen"], number> = { google_ads: 3, utm: 2, referral: 1, unknown: 0 };

const TEXT_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "aterrizaje", "referrer"] as const;

/**
 * Reconstruye una atribución desde algo leído del almacenamiento: solo claves conocidas, textos dentro de MAX_LEN,
 * origen y tipo de click_id de sus listas, y el origen respaldado por su evidencia (google_ads con click_id y su
 * tipo, utm con alguna UTM, referral con referrer). Si algo no cumple devuelve null: una atribución guardada
 * (vieja, manipulada o de otra versión) nunca puede invalidar el envío de una solicitud.
 */
export function sanitizeAttribution(raw: unknown): Attribution | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const text = (k: keyof typeof MAX_LEN): string | null | undefined => {
    const v = src[k];
    if (v === undefined || v === null) return undefined;
    return typeof v === "string" && v.length <= MAX_LEN[k] ? v : null; // null = inválido
  };

  const origen = src.origen;
  if (typeof origen !== "string" || origen === "unknown" || !(ORIGINS as readonly string[]).includes(origen)) return null;
  const a: Attribution = { origen: origen as Attribution["origen"] };

  for (const k of TEXT_KEYS) {
    const v = text(k);
    if (v === null) return null;
    if (v) a[k] = v;
  }
  const tipo = src.click_id_tipo;
  const id = text("click_id");
  if (id === null) return null;
  if (tipo !== undefined && tipo !== null && !(CLICK_ID_TYPES as readonly string[]).includes(tipo as string)) return null;
  if (!!tipo !== !!id) return null; // el tipo y el valor van juntos
  if (tipo && id) { a.click_id_tipo = tipo as Attribution["click_id_tipo"]; a.click_id = id; }

  const evidence = a.origen === "google_ads" ? !!a.click_id
    : a.origen === "utm" ? !!(a.utm_source || a.utm_medium || a.utm_campaign)
    : !!a.referrer;
  return evidence ? a : null;
}

/** La señal que gana: la guardada si es más fuerte que la nueva; con igual o mayor rango, la nueva (último clic). */
export function mergeAttribution(prev: Attribution | null, next: Attribution): Attribution {
  return prev && ORIGIN_RANK[prev.origen] > ORIGIN_RANK[next.origen] ? prev : next;
}

export function saveAttribution(store: StorageLike, a: Attribution, now = Date.now()) {
  try {
    store.setItem(ATTRIBUTION_KEY, JSON.stringify({ savedAt: now, data: a } satisfies StoredAttribution));
  } catch { /* almacenamiento bloqueado */ }
}

export function loadAttribution(store: StorageLike, now = Date.now()): Attribution | null {
  try {
    const raw = store.getItem(ATTRIBUTION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredAttribution;
    if (!s || typeof s.savedAt !== "number" || now - s.savedAt > ATTRIBUTION_TTL_MS) {
      store.removeItem(ATTRIBUTION_KEY);
      return null;
    }
    return sanitizeAttribution(s.data);
  } catch {
    return null;
  }
}

/**
 * Guarda la señal de un aterrizaje sin pisar una más fuerte vigente. Si la guardada es más fuerte no se toca (ni se
 * renueva su savedAt); si la nueva es de igual o mayor rango la reemplaza y renueva savedAt. Devuelve lo que quedó.
 */
export function recordAttribution(store: StorageLike, next: Attribution, now = Date.now()): Attribution {
  const kept = mergeAttribution(loadAttribution(store, now), next);
  if (kept === next) saveAttribution(store, next, now);
  return kept;
}
