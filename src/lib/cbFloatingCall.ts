// En un teléfono el botón flotante CALL NOW (fixed, abajo a la derecha) tapa mensajes de error de campo y parte del botón
// de enviar. FloatingCallButton no se edita: la página de Custom Builds simplemente no lo dibuja mientras el formulario
// está en pantalla en móvil. Antes de hidratar y en escritorio sigue visible.

export const MOBILE_QUERY = "(max-width: 767px)";

export const hideFloatingCall = (mobile: boolean, formInView: boolean): boolean => mobile && formInView;

type VisibilityEntry = { target: unknown; isIntersecting: boolean };
type ObserverLike = { observe(target: unknown): void; disconnect(): void };
type ObserverCtor = new (callback: (entries: VisibilityEntry[]) => void) => ObserverLike;

/**
 * Visibilidad que dejó la ENTRADA MÁS RECIENTE de `target` en un lote. El navegador entrega las entradas en orden
 * cronológico y, con la página cargada, un lote puede traer varias del mismo elemento (entra y sale): la primera es la
 * más antigua y deja el estado al revés. null si el lote no trae ninguna de `target`.
 */
export function latestVisibility(entries: readonly VisibilityEntry[], target: unknown): boolean | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].target === target) return entries[i].isIntersecting;
  }
  return null;
}

/**
 * Avisa con `onChange(true|false)` cada vez que cambia si `target` está en pantalla y devuelve la función que deja de
 * observar. Sin IntersectionObserver (navegador viejo, o servidor) no avisa nunca: el botón queda visible. `Observer`
 * existe para probarlo con un observador simulado (null = el navegador no tiene uno).
 */
export function watchInView(
  target: unknown,
  onChange: (inView: boolean) => void,
  Observer: ObserverCtor | null = typeof IntersectionObserver === "undefined" ? null : (IntersectionObserver as unknown as ObserverCtor),
): () => void {
  if (!Observer) return () => {};
  const io = new Observer((entries) => {
    const inView = latestVisibility(entries, target);
    if (inView !== null) onChange(inView);
  });
  io.observe(target);
  return () => io.disconnect();
}
