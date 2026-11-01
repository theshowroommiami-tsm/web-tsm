// dataLayer de Custom Builds (analytics-tsm anl-06). Las etiquetas viven en GTM, no en el código.
// Sin datos personales: estimate_cta_click lleva service y cta_location; generate_lead, service y lead_id.

export const CB_SERVICE = "custom_builds";
export const CTA_LOCATIONS = ["hero", "after_projects"];
export const LEAD_IDS_KEY = "tsm_cb_lead_ids";
export const LEAD_IDS_MAX = 20;

type DataLayerHost = { dataLayer?: Record<string, unknown>[] };
type LeadStore = { getItem(k: string): string | null; setItem(k: string, v: string): void };
type ClickTarget = { closest?(selector: string): { getAttribute(name: string): string | null } | null };
type ClickEvent = { target: unknown };
type ClickDocument = { addEventListener(type: "click", fn: (e: ClickEvent) => void, capture: boolean): void };

declare global {
  interface Window {
    __estimateCtaClickBound?: boolean;
  }
}

function layerOf(host: DataLayerHost): Record<string, unknown>[] {
  host.dataLayer = host.dataLayer || [];
  return host.dataLayer;
}

// ---- estimate_cta_click (nivel 1, anl-06 §2)

/** Valor de data-cta-location; lo que falte o sea nuevo es "unassigned" (los valores nuevos los pide ANL). */
export function ctaLocationOf(value: string | null | undefined): string {
  return value != null && CTA_LOCATIONS.includes(value) ? value : "unassigned";
}

/**
 * Un solo listener delegado en document, en fase de captura. Idempotente: el indicador vive en host,
 * así el remontaje o StrictMode no lo duplican. Sin preventDefault: no toca el clic.
 */
export function bindEstimateCtaTracking(doc: ClickDocument, host: DataLayerHost & { __estimateCtaClickBound?: boolean }) {
  if (host.__estimateCtaClickBound) return;
  host.__estimateCtaClickBound = true;

  doc.addEventListener(
    "click",
    (event) => {
      const target = event.target as ClickTarget | null;
      const button = target?.closest?.("[data-cta-location]");
      if (!button) return;
      layerOf(host).push({
        event: "estimate_cta_click",
        service: CB_SERVICE,
        cta_location: ctaLocationOf(button.getAttribute("data-cta-location")),
      });
    },
    true
  );
}

export function initEstimateCtaTracking() {
  if (typeof document === "undefined") return;
  bindEstimateCtaTracking(document, window);
}

// ---- generate_lead (nivel 2, anl-06 §3)

/**
 * Devuelve la función que empuja generate_lead. Solo con medir === true y una vez por lead_id:
 * la lista tsm_cb_lead_ids de localStorage (hasta 20, se descarta el más viejo) más un Set de esta carga.
 * Todo acceso al almacenamiento va en try/catch; si falla, rige el Set.
 */
export function createLeadReporter(host: () => DataLayerHost, store: () => LeadStore) {
  const seen = new Set<string>();

  const stored = (): string[] => {
    try {
      const parsed = JSON.parse(store().getItem(LEAD_IDS_KEY) ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch { return []; }
  };
  const remember = (leadId: string) => {
    seen.add(leadId);
    try { store().setItem(LEAD_IDS_KEY, JSON.stringify([...stored(), leadId].slice(-LEAD_IDS_MAX))); } catch { /* bloqueado */ }
  };

  return function pushGenerateLead(leadId: unknown, medir: unknown): boolean {
    if (medir !== true || typeof leadId !== "string" || !leadId) return false;
    if (seen.has(leadId) || stored().includes(leadId)) return false;
    layerOf(host()).push({ event: "generate_lead", service: CB_SERVICE, lead_id: leadId });
    remember(leadId);
    return true;
  };
}

/** Instancia del navegador: el Set vive mientras la página esté cargada. */
export const trackGenerateLead = createLeadReporter(() => window, () => window.localStorage);
