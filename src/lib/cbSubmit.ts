// Decisiones del formulario de Custom Builds sin React ni DOM, para probarlas con dobles (EstimateForm solo las llama).
import { ATTRIBUTION_FIELDS } from "../../shared/cb-attribution.ts";
import type { Draft, SubmitOutcome } from "./cbClient.ts";
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
  /** Un intento falló y quedó anotado en la sesión (`failed`): el borrador tiene que guardar su huella. */
  onAttemptFailed(): void;
  /** Reinicia el widget de Turnstile y borra el token (un token ya usado no sirve para otra solicitud). */
  resetTurnstile(): void;
  clearDraft(): void;
  /** Empieza la subida de fotos (la interfaz cambia su mensaje). */
  onUploading(): void;
};

export type SubmitResult =
  | { kind: "done"; note: NoticeKind | null } // el servidor aceptó y guardó la solicitud: se muestra la confirmación
  | { kind: "failed"; notice: NoticeKind };   // el formulario sigue abierto y con su información

/**
 * Huella de lo que el usuario envía: los campos que escribió ya validados y la cantidad de fotos. La atribución queda
 * fuera: puede cambiar entre dos intentos sin que el usuario toque nada (otra visita, otra señal más fuerte), y eso no
 * es una corrección que obligue a una clave nueva.
 */
export function fingerprint(campos: Record<string, string>, fotos: number): string {
  const escritos = Object.keys(campos).filter((k) => !ATTRIBUTION_FIELDS.includes(k)).sort();
  return JSON.stringify([escritos.map((k) => [k, campos[k]]), fotos]);
}

/** Borrador que se guarda: lo escrito, la clave y, si el último intento falló, su huella. */
export function draftOf(fields: Record<string, string>, s: SubmitSession): Draft {
  return s.failed ? { fields, clave: s.clave, huella: s.failed.print } : { fields, clave: s.clave };
}

/**
 * Sesión que se restaura de un borrador al cargar la página. Tras una recarga el widget de Turnstile entrega un token
 * nuevo, así que el del intento fallido ya no está en juego (tokenUsed false). Sin clave no hay nada que restaurar.
 */
export function sessionOf(d: Draft | null): SubmitSession {
  if (!d?.clave) return { clave: "", failed: null };
  return { clave: d.clave, failed: d.huella ? { print: d.huella, tokenUsed: false } : null };
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
    deps.onAttemptFailed();
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

/**
 * Lo que tarda en plegarse el aviso previo a la hidratación (la clase duration-300 del aviso tiene que coincidir). Los
 * controles se habilitan cuando termina: antes, el primer toque caería sobre un campo que todavía sube.
 */
export const LOADING_FOLD_MS = 300;

/** El envío espera a que la página esté lista (hidratada y con el aviso plegado), no haya otro en curso ni fotos preparándose. */
export function canSubmit(s: { ready: boolean; busy: boolean; preparing: boolean }): boolean {
  return s.ready && !s.busy && !s.preparing;
}

// ---- Fotos

export const MSG_TOO_MANY = (max: number) => `You can attach up to ${max} photos.`;
export const MSG_UNREADABLE = (name: string) => `We couldn't read "${name}". Please use a JPG, PNG or WebP photo.`;
export const MSG_UNPREPARED = (name: string) => `We couldn't prepare "${name}". Please try another photo.`;

/** Tiempo máximo para preparar UNA foto: pasado, se descarta y el resto del lote sigue. */
export const PHOTO_PREPARE_TIMEOUT_MS = 20_000;

class PrepareTimeout extends Error {}

/** La foto que llega después de vencido el tiempo ya no se usa: se libera su vista previa (URL de objeto). */
function releasePreview(p: ProcessedPhoto) {
  try { URL.revokeObjectURL(p.previewUrl); } catch { /* sin vista previa que liberar */ }
}

/** Espera a `work` hasta `ms`. Vencido el tiempo rechaza con PrepareTimeout y descarta lo que llegue después. */
function withinTime(work: Promise<ProcessedPhoto>, ms: number): Promise<ProcessedPhoto> {
  return new Promise((resolve, reject) => {
    let late = false;
    const timer = setTimeout(() => { late = true; reject(new PrepareTimeout()); }, ms);
    work.then(
      (p) => { clearTimeout(timer); if (late) releasePreview(p); else resolve(p); },
      (e) => { clearTimeout(timer); if (!late) reject(e); },
    );
  });
}

/**
 * Prepara las fotos elegidas (se recodifican en el navegador, y tarda): una a una, hasta `room`, y cada una con su tiempo
 * máximo (`timeoutMs`): una que no termina, o que no se puede leer, se descarta con su aviso y las demás se conservan.
 * Devuelve las listas y el mensaje para el campo (el aviso de la última foto descartada gana sobre el del tope).
 */
export async function prepareFiles(
  files: { name: string }[],
  room: number,
  max: number,
  process: (f: { name: string }) => Promise<ProcessedPhoto>,
  timeoutMs: number = PHOTO_PREPARE_TIMEOUT_MS,
): Promise<{ added: ProcessedPhoto[]; message: string }> {
  const added: ProcessedPhoto[] = [];
  let failure = "";
  for (const f of files.slice(0, Math.max(room, 0))) {
    try {
      added.push(await withinTime(Promise.resolve().then(() => process(f)), timeoutMs));
    } catch (e) {
      failure = e instanceof PrepareTimeout ? MSG_UNPREPARED(f.name) : MSG_UNREADABLE(f.name);
    }
  }
  const message = failure || (files.length > room ? MSG_TOO_MANY(max) : "");
  return { added, message };
}

/**
 * Cuenta tareas en curso (las fotos que se preparan): sube al empezar y baja SIEMPRE al terminar, también si la tarea
 * lanza. Mientras la cuenta no sea cero el envío y el selector de fotos esperan.
 */
export function createBusyCounter(onChange: (n: number) => void) {
  let n = 0;
  return {
    get count() { return n; },
    async track<T>(run: () => Promise<T>): Promise<T> {
      n += 1; onChange(n);
      try { return await run(); } finally { n -= 1; onChange(n); }
    },
  };
}

/**
 * Al terminar de preparar fotos el foco vuelve al selector si quedó en BODY (el selector se deshabilitó y el navegador
 * lo soltó) o sigue en él. Si el usuario ya pasó a otro campo, no se le quita.
 */
export function shouldRestorePhotoFocus(active: unknown, body: unknown, input: unknown): boolean {
  return !active || active === body || active === input;
}

type Focusable = { focus(o?: { preventScroll?: boolean }): void };

/**
 * A dónde va el foco al terminar de preparar fotos: al selector si quedó habilitado; si el tope de fotos lo dejó
 * deshabilitado (no se le puede dar el foco), a la lista de fotos (`list`, solo con el tope alcanzado), de modo que el
 * siguiente Tab llegue a "Remove photo 1" y no a un elemento lejos del formulario. Null: dejar el foco donde está.
 */
export function photoFocusTarget(
  active: unknown, body: unknown, input: (Focusable & { disabled?: boolean }) | null, list: Focusable | null,
): Focusable | null {
  if (!shouldRestorePhotoFocus(active, body, input)) return null;
  if (input && !input.disabled) return input;
  return list;
}

// ---- Turnstile

export const TURNSTILE_NORMAL_WIDTH = 300; // ancho del widget normal; el compacto mide 150 px

/** Con menos espacio que el widget normal se usa el compacto. Un ancho 0 (sin medir) deja el normal. */
export function turnstileSizeFor(containerWidth: number): "normal" | "compact" {
  return containerWidth > 0 && containerWidth < TURNSTILE_NORMAL_WIDTH ? "compact" : "normal";
}
