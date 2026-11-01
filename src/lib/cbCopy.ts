// Textos del formulario de Custom Builds que fija el requerimiento (secciones 2 y 4) o que aprueba Liza en el
// Deploy Preview. Viven aquí, sin JSX, para que las pruebas los comparen carácter por carácter.
// El plazo de 1 día hábil es un objetivo interno de John (TRD-049), no un compromiso con el cliente: no va en ningún texto.

export const CB_INTRO =
  "Tell us about your vehicle and the custom work you have in mind. Our team will review your request and contact you to discuss your project.";

// Pendiente de Liza. Aclara junto al formulario que el precio no es fijo y que enviar no es una cotización ni una cita.
export const CB_PRICE_NOTE =
  "Final pricing depends on the scope of work, the materials selected and an evaluation of your vehicle. Submitting this form sends a request; it is not a final quote or a confirmed appointment.";

// Texto exacto del requerimiento (sección 4): solo se muestra cuando el servidor aceptó y guardó la solicitud.
export const CB_CONFIRMATION = "Your request has been received. Our team will contact you to discuss your project.";

// Avisos. Los que llevan teléfono (phone) se dibujan con el enlace de @/config/business al final.
export type NoticeKind =
  | "fields" | "wait" | "tserror" | "nokey" | "turnstile" | "quota" | "invalid" | "retry" | "error" | "photos" | "photos_lost";

export const CB_NOTICES: Record<NoticeKind, { text: string; phone: boolean }> = {
  fields: { text: "Please fix the highlighted fields.", phone: false },
  wait: { text: "Please wait for the security check to finish, then try again. If it doesn't finish, call us at", phone: true },
  tserror: { text: "The security check couldn't load. Please reload the page or call us at", phone: true },
  nokey: { text: "This form isn't available right now. Please call us at", phone: true },
  turnstile: { text: "We couldn't verify you're human. Please try again.", phone: false },
  quota: { text: "We can't take more requests right now. Please call us at", phone: true },
  invalid: { text: "Some details didn't pass our checks. Please review the form.", phone: false },
  retry: { text: "We couldn't reach our server. Please try again in a moment.", phone: false },
  error: { text: "Something went wrong. Please try again or call us at", phone: true },
  photos: { text: "Some photos couldn't be uploaded. We'll reach out if we need them.", phone: false },
  photos_lost: { text: "Your photos couldn't be uploaded. We'll reach out if we need them.", phone: false },
};

export const CB_SENDING = "Sending your request…";
export const CB_UPLOADING = "Uploading your photos, please keep this page open";
