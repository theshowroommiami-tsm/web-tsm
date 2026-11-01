// Captura la atribución al aterrizar en cualquier página (localStorage, 90 días).
import { captureAttribution, loadAttribution, saveAttribution, type Attribution } from "../../shared/cb-attribution.ts";

/**
 * Atribución guardada, o null si no hay o el almacenamiento está bloqueado. Con los datos del sitio
 * bloqueados, el solo acceso a window.localStorage lanza SecurityError, antes de que loadAttribution
 * (que ya protege sus lecturas) llegue a ejecutarse: por eso el almacenamiento se resuelve aquí adentro.
 */
export function readAttribution(store: () => Parameters<typeof loadAttribution>[0], now?: number): Attribution | null {
  try { return loadAttribution(store(), now); } catch { return null; }
}

export const currentAttribution = () => readAttribution(() => window.localStorage);

export function initAttribution() {
  if (typeof window === "undefined") return;
  try {
    const a = captureAttribution(window.location.search, window.location.pathname, document.referrer, window.location.hostname);
    if (a) saveAttribution(window.localStorage, a);
  } catch { /* almacenamiento bloqueado */ }
}
