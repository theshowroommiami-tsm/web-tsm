// Atribución de Custom Builds (alcance 6). Funciones puras; el almacenamiento se inyecta.

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
    return s.data;
  } catch {
    return null;
  }
}
