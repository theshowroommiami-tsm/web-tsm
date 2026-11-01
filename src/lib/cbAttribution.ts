// Captura la atribución al aterrizar en cualquier página (localStorage, 90 días).
import { captureAttribution, saveAttribution } from "../../shared/cb-attribution.ts";

export function initAttribution() {
  if (typeof window === "undefined") return;
  try {
    const a = captureAttribution(window.location.search, window.location.pathname, document.referrer, window.location.hostname);
    if (a) saveAttribution(window.localStorage, a);
  } catch { /* almacenamiento bloqueado */ }
}
