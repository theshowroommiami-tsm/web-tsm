// Decisiones del formulario de Custom Builds sin React ni DOM, para probarlas con dobles (EstimateForm solo las llama).
import type { SubmitOutcome } from "./cbClient.ts";
import type { NoticeKind } from "./cbCopy.ts";
import type { ProcessedPhoto } from "./cbPhotos.ts";

// ---- Envío

/** Último intento que falló (retry, error, cupo, 400 o 403): su huella y si dejó consumido el token de Turnstile. */
export type FailedAttempt = { print: string; tokenUsed: boolean };

/** Estado que sobrevive entre intentos de una misma solicitud: la clave de idempotencia y el último fallo. */
export type SubmitSession = { clave: string; failed: FailedAttempt | null };

export type SubmitDeps = {
  postRequest(clave: string, token: string, campos: Record<string, string>, fotos: number): Promise<SubmitOutcome>;
  uploadPhotos(permiso: string, photos: ProcessedPhoto[]): Promise<number>;
  trackGenerateLead(leadId: string, medir: boolean): unknown;
  newKey(): string;
  /** La clave cambió: el borrador de la sesión tiene que guardar la nueva. */
  onKeyChange(clave: string): void;
  /** Reinicia el widget de Turnstile y borra el token (un token ya usado no sirve para otra solicitud). */
  resetTurnstile(): void;
  clearDraft(): void;
  /** Empieza la subida de fotos (la interfaz cambia su mensaje). */
  onUploading(): void;
};

export type SubmitResult =
  | { kind: "done"; note: NoticeKind | null } // el servidor aceptó y guardó la solicitud: se muestra la confirmación
  | { kind: "failed"; notice: NoticeKind };   // el formulario sigue abierto y con su información

/** Huella de lo que se envía: los campos ya validados (con la atribución) y la cantidad de fotos. */
export function fingerprint(campos: Record<string, string>, fotos: number): string {
  return JSON.stringify([Object.keys(campos).sort().map((k) => [k, campos[k]]), fotos]);
}

/**
 * Un intento de envío. Reglas:
 * - La clave de idempotencia se crea una vez y se conserva en los reintentos: el receptor devuelve el mismo lead y no
 *   crea otro. Solo se limpia tras el éxito.
 * - Si el intento anterior falló y lo que se envía ahora es distinto (el usuario corrigió un dato o cambió las fotos),
 *   va con clave nueva: con la misma, el receptor devolvería la fila original y la corrección se perdería en silencio
 *   mientras la página dice "received". Si ese intento dejó consumido el token de Turnstile, se reinicia el widget y
 *   este intento no sale (hay que esperar el token nuevo).
 * - generate_lead sale solo con un 201 válido, antes de las fotos y sin depender de ellas.
 * - Con 403 y con un reintento (502, 503, 504, red, tiempo) se reinicia Turnstile: su token es de un solo uso.
 * - Nada que no sea un 201 llega a "done".
 */
export async function runSubmit(
  input: { campos: Record<string, string>; token: string; photos: ProcessedPhoto[] },
  s: SubmitSession,
  deps: SubmitDeps,
): Promise<SubmitResult> {
  const { campos, token, photos } = input;
  const print = fingerprint(campos, photos.length);

  if (s.failed && s.failed.print !== print) {
    const staleToken = s.failed.tokenUsed;
    s.failed = null;
    s.clave = deps.newKey();
    deps.onKeyChange(s.clave);
    if (staleToken) {
      deps.resetTurnstile();
      return { kind: "failed", notice: "wait" };
    }
  }
  if (!s.clave) {
    s.clave = deps.newKey();
    deps.onKeyChange(s.clave);
  }

  const r = await deps.postRequest(s.clave, token, campos, photos.length);
  if (r.kind !== "ok") {
    const reset = r.kind === "turnstile" || r.kind === "retry";
    if (reset) deps.resetTurnstile();
    // Un 400 lo rechaza el servidor antes de verificar Turnstile: ese token sigue sin usar.
    s.failed = { print, tokenUsed: !(reset || r.kind === "invalid") };
    return { kind: "failed", notice: r.kind };
  }

  deps.trackGenerateLead(r.leadId, r.medir);

  let note: NoticeKind | null = null;
  if (photos.length) {
    if (r.permiso) {
      deps.onUploading();
      try {
        const ok = await deps.uploadPhotos(r.permiso, photos);
        if (ok < photos.length) note = "photos";
      } catch { note = "photos_lost"; }
    } else {
      // Sin permiso no hay dónde subirlas (p. ej. el reintento de una solicitud que se guardó sin fotos): se avisa.
      note = "photos_lost";
    }
  }
  s.clave = "";
  s.failed = null;
  deps.clearDraft();
  return { kind: "done", note };
}

/** El envío espera a que la página esté hidratada, no haya otro en curso ni fotos preparándose. */
export function canSubmit(s: { ready: boolean; busy: boolean; preparing: boolean }): boolean {
  return s.ready && !s.busy && !s.preparing;
}

// ---- Fotos

export const MSG_TOO_MANY = (max: number) => `You can attach up to ${max} photos.`;
export const MSG_UNREADABLE = (name: string) => `We couldn't read "${name}". Please use a JPG, PNG or WebP photo.`;

/**
 * Prepara las fotos elegidas (se recodifican en el navegador, y tarda): una a una, hasta `room`. Devuelve las listas
 * y el mensaje para el campo (un archivo que no se pudo leer gana sobre el aviso del tope).
 */
export async function prepareFiles(
  files: { name: string }[],
  room: number,
  max: number,
  process: (f: { name: string }) => Promise<ProcessedPhoto>,
): Promise<{ added: ProcessedPhoto[]; message: string }> {
  const added: ProcessedPhoto[] = [];
  let unreadable = "";
  for (const f of files.slice(0, Math.max(room, 0))) {
    try { added.push(await process(f)); } catch { unreadable = f.name; }
  }
  const message = unreadable ? MSG_UNREADABLE(unreadable) : files.length > room ? MSG_TOO_MANY(max) : "";
  return { added, message };
}

// ---- Turnstile

export const TURNSTILE_NORMAL_WIDTH = 300; // ancho del widget normal; el compacto mide 150 px

/** Con menos espacio que el widget normal se usa el compacto. Un ancho 0 (sin medir) deja el normal. */
export function turnstileSizeFor(containerWidth: number): "normal" | "compact" {
  return containerWidth > 0 && containerWidth < TURNSTILE_NORMAL_WIDTH ? "compact" : "normal";
}
