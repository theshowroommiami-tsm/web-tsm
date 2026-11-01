// En un teléfono el botón flotante CALL NOW (fixed, abajo a la derecha) tapa mensajes de error de campo y parte del botón
// de enviar. FloatingCallButton no se edita: la página de Custom Builds simplemente no lo dibuja mientras el formulario
// está en pantalla en móvil. Antes de hidratar y en escritorio sigue visible.

export const MOBILE_QUERY = "(max-width: 767px)";

export const hideFloatingCall = (mobile: boolean, formInView: boolean): boolean => mobile && formInView;
