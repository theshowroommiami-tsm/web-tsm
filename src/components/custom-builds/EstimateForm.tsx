import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  BRANDS, BUDGETS, MAX_LEN, MAX_PHOTOS, OTHER_BRAND, OTHER_BRAND_MAX, SERVICES, TIMELINES,
  brandToSend, normalizePhone, otherBrandError, validateRequest, type CbFields,
} from "../../../shared/cb-schema.ts";
import { currentAttribution } from "@/lib/cbAttribution";
import { processPhoto, type ProcessedPhoto } from "@/lib/cbPhotos";
import { clearDraft, loadDraft, newIdempotencyKey, postRequest, saveDraft, uploadPhotos } from "@/lib/cbClient";
import { trackGenerateLead } from "@/lib/cbDataLayer";
import {
  CB_CONFIRMATION, CB_INTRO, CB_LOADING, CB_NOTICES, CB_PHOTO_NOTE, CB_PREPARING, CB_PRICE_NOTE, CB_PRIVACY_LEAD, CB_PRIVACY_LINK, CB_SENDING, CB_UPLOADING, type NoticeKind,
} from "@/lib/cbCopy";
import {
  LOADING_FOLD_MS, canSubmit, createBusyCounter, draftOf, photoFocusTarget, prepareFiles, runSubmit, sessionOf, turnstileSizeFor, type SubmitSession,
} from "@/lib/cbSubmit";
import { BUSINESS_PHONE_DISPLAY, BUSINESS_PHONE_HREF } from "@/config/business";

export const ESTIMATE_SECTION_ID = "estimate";
export const ESTIMATE_HEADING_ID = "estimate-heading";

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, o: Record<string, unknown>): string;
      reset(id?: string): void;
      remove?(id?: string): void;
    };
  }
}

type Status = "idle" | "sending" | "uploading" | "done";
const FIELD_ORDER = ["nombre", "telefono", "correo", "marca", "marca_otra", "modelo", "anio", "zona", "servicio", "descripcion"];
const VISIBLE_FIELDS = [...FIELD_ORDER, "presupuesto", "plazo"];
// Parejas de campos. Ningún campo baja de 160 px: el formulario ocupa todo el ancho hasta lg y media columna
// desde lg (390 px útiles en 1024, 518 px desde 1280), así que entre lg y xl cada pareja pasa a una columna.
// Teléfono y correo solo van en pareja desde md: un correo de 30 caracteres necesita unos 245 px.
const CONTACT = "grid gap-5 md:grid-cols-2 lg:grid-cols-1";
const PAIR = "grid gap-5 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2";
// Móvil: 44 px de alto, 16 px de letra explícita (iOS no hace zoom) y márgenes de desplazamiento para que el campo
// enfocado no quede bajo la barra fija de arriba (~97 px) ni bajo el botón CALL NOW de abajo (~80 px).
const inputCls =
  "w-full min-h-11 text-base scroll-mt-32 scroll-mb-28 rounded-md border border-neon-purple/40 bg-background px-3 py-2 text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-neon-cyan";

/** Ancla interceptada: scroll al formulario y foco en su encabezado, sin tocar el historial. */
export function goToEstimate(e: React.MouseEvent) {
  e.preventDefault();
  const section = document.getElementById(ESTIMATE_SECTION_ID);
  if (!section) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  section.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  document.getElementById(ESTIMATE_HEADING_ID)?.focus({ preventScroll: true });
}

const FieldWrap = ({ k, label, required, error, children }: { k: string; label: string; required?: boolean; error?: string; children: React.ReactNode }) => (
  <div>
    <label htmlFor={`cb-${k}`} className="block text-sm font-medium text-gray-200 mb-1">
      {label}{required ? <span aria-hidden="true"> *</span> : <span className="text-gray-400"> (optional)</span>}
    </label>
    {children}
    {error && <p id={`cb-${k}-err`} className="mt-1 text-sm text-red-400">{error}</p>}
  </div>
);

/** El teléfono del negocio (siempre de @/config/business) como enlace de llamada. */
const PhoneLink = () => (
  <a href={BUSINESS_PHONE_HREF} data-call-location="page_body" className="font-semibold underline whitespace-nowrap">
    {BUSINESS_PHONE_DISPLAY}
  </a>
);

/** Texto del aviso y, si corresponde, el teléfono del negocio como enlace de llamada. */
const NoticeText = ({ kind }: { kind: NoticeKind }) => {
  const n = CB_NOTICES[kind];
  return (
    <>
      {n.text}
      {n.phone && (
        <>
          {" "}
          <PhoneLink />
          .
        </>
      )}
    </>
  );
};

/**
 * Aviso mientras el formulario no está listo. Sin JavaScript, con el bundle bloqueado o antes de hidratar los controles
 * están deshabilitados y el formulario no dice por qué: esta línea (que también sale en el HTML del servidor) da el
 * teléfono. Al hidratar se pliega en LOADING_FOLD_MS (la altura baja a 0 en vez de saltar) y se quita; los controles se
 * habilitan cuando termina (EstimateForm), para que ningún toque caiga sobre un campo que todavía sube. Va fuera del
 * fieldset: no es un control.
 */
export const LoadingNotice = ({ ready }: { ready: boolean }) => {
  const [gone, setGone] = useState(ready); // montado ya listo: no hay nada que mostrar
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => setGone(true), LOADING_FOLD_MS);
    return () => clearTimeout(t);
  }, [ready]);
  if (gone) return null;
  return (
    <div
      aria-hidden={ready || undefined}
      className={cn("grid transition-[grid-template-rows,opacity] duration-300 motion-reduce:transition-none", ready ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100")}
    >
      <div className="overflow-hidden">
        <p className="pb-5 text-sm text-gray-300">{CB_LOADING} <PhoneLink />.</p>
      </div>
    </div>
  );
};

/** Columna del formulario. La página decide su lugar en la cuadrícula (className); el ancla #estimate es esta sección. */
const EstimateForm = ({ className }: { className?: string }) => {
  const [fields, setFields] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<ProcessedPhoto[]>([]);
  const [photoMsg, setPhotoMsg] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [notice, setNotice] = useState<{ kind: NoticeKind } | null>(null);
  const [token, setToken] = useState("");
  // El HTML que sirve el servidor no se puede enviar: los controles quedan deshabilitados hasta que la página hidrata Y el
  // aviso previo termina de plegarse. Sin JavaScript (o antes de hidratar) el envío nativo sería un GET con los datos del
  // cliente en la URL.
  const [hydrated, setHydrated] = useState(false);
  const [ready, setReady] = useState(false);
  const [preparing, setPreparing] = useState(0); // fotos que se están recodificando
  const [preparer] = useState(() => createBusyCounter(setPreparing)); // su cuenta baja siempre, también si una foto no termina
  const wasPreparing = useRef(false);
  const sessionRef = useRef<SubmitSession>({ clave: "", failed: null }); // clave de idempotencia y último fallo (también en el borrador)
  const busyRef = useRef(false);
  const tsEl = useRef<HTMLDivElement>(null);
  const tsId = useRef<string>();
  const formRef = useRef<HTMLFormElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const photosRef = useRef<HTMLInputElement>(null);
  const photoListRef = useRef<HTMLUListElement>(null);
  const doneRef = useRef<HTMLDivElement>(null);
  const scrollNoticeRef = useRef(false);

  /** Muestra un aviso junto al botón de enviar. `scroll` lo lleva a la vista (no al cargar la página). */
  const showNotice = useCallback((kind: NoticeKind, scroll = true) => {
    scrollNoticeRef.current = scroll;
    setNotice({ kind });
  }, []);

  // Borrador de la sesión (solo en el navegador, después de hidratar).
  useEffect(() => {
    setHydrated(true);
    const d = loadDraft();
    if (d) { setFields(d.fields); sessionRef.current = sessionOf(d); } // la clave y la huella del último fallo sobreviven a la recarga
  }, []);

  // Los controles se habilitan cuando el aviso previo terminó de plegarse (los campos dejan de subir).
  useEffect(() => {
    if (!hydrated) return;
    const t = setTimeout(() => setReady(true), LOADING_FOLD_MS);
    return () => clearTimeout(t);
  }, [hydrated]);

  // Turnstile, acción cb_request. El widget compacto (150 px) entra donde el normal (300 px) no cabe, p. ej. 320 y 360 px.
  useEffect(() => {
    if (!SITE_KEY) {
      console.error("VITE_TURNSTILE_SITE_KEY is missing from this build: the Custom Builds form cannot verify requests.");
      showNotice("nokey", false);
      return;
    }
    if (!tsEl.current) return;
    let size = turnstileSizeFor(0);
    const wanted = () => turnstileSizeFor(tsEl.current?.clientWidth ?? 0);
    const mount = () => {
      if (!window.turnstile || !tsEl.current || tsId.current) return;
      size = wanted();
      tsId.current = window.turnstile.render(tsEl.current, {
        sitekey: SITE_KEY, action: "cb_request", size,
        callback: (t: string) => {
          setToken(t);
          setNotice((n) => (n && (n.kind === "tserror" || n.kind === "wait") ? null : n));
        },
        "expired-callback": () => setToken(""),
        "error-callback": () => { setToken(""); showNotice("tserror", false); },
      });
    };
    const onLoadError = () => showNotice("tserror", false);

    let s: HTMLScriptElement | null = null;
    if (window.turnstile) {
      mount();
    } else {
      s = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SRC}"]`);
      if (!s) { s = document.createElement("script"); s.src = TURNSTILE_SRC; s.async = true; document.head.appendChild(s); }
      s.addEventListener("load", mount);
      s.addEventListener("error", onLoadError);
    }

    // Al girar el teléfono el espacio cambia: si ya no corresponde el tamaño, se vuelve a dibujar el widget.
    const ro = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          if (!tsId.current || !window.turnstile?.remove || wanted() === size) return;
          window.turnstile.remove(tsId.current);
          tsId.current = undefined;
          setToken("");
          mount();
        })
      : null;
    ro?.observe(tsEl.current);

    return () => {
      s?.removeEventListener("load", mount);
      s?.removeEventListener("error", onLoadError);
      ro?.disconnect();
    };
  }, [showNotice]);

  // Un aviso del servidor o del control de seguridad se lleva a la vista junto al botón; el foco vuelve al botón
  // (se deshabilita al enviar y el navegador lo pierde). Los errores de campo los atiende focusFirstError.
  useEffect(() => {
    if (!notice || !scrollNoticeRef.current) return;
    scrollNoticeRef.current = false;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    noticeRef.current?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    submitRef.current?.focus({ preventScroll: true });
  }, [notice]);

  // Al deshabilitarse el selector de fotos mientras se preparan, el navegador suelta el foco en BODY: al terminar vuelve al
  // selector, o a la lista de fotos si el tope lo dejó deshabilitado (el siguiente Tab llega a "Remove photo 1").
  const atPhotoLimit = photos.length >= MAX_PHOTOS;
  useEffect(() => {
    if (preparing > 0) { wasPreparing.current = true; return; }
    if (!wasPreparing.current) return;
    wasPreparing.current = false;
    photoFocusTarget(document.activeElement, document.body, photosRef.current, atPhotoLimit ? photoListRef.current : null)?.focus({ preventScroll: true });
  }, [preparing, atPhotoLimit]);

  // Al terminar bien, el foco va a la confirmación (role="status") y el lector de pantalla la lee.
  useEffect(() => {
    if (status === "done") doneRef.current?.focus();
  }, [status]);

  const set = (k: string, v: string) => {
    setFields((prev) => {
      const next = { ...prev, [k]: v };
      if (!sessionRef.current.clave) sessionRef.current.clave = newIdempotencyKey();
      saveDraft(draftOf(next, sessionRef.current));
      return next;
    });
    if (errors[k] || (k === "marca" && errors.marca_otra)) {
      setErrors((e) => { const { [k]: _, ...rest } = e; if (k === "marca") delete rest.marca_otra; return rest; });
    }
  };

  const onFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = "";
    setPhotoMsg("");
    // Recodificar tarda: mientras tanto el botón de enviar espera (si no, la solicitud saldría sin las fotos).
    await preparer.track(async () => {
      const { added, message } = await prepareFiles(list, MAX_PHOTOS - photos.length, MAX_PHOTOS, (f) => processPhoto(f as File));
      setPhotoMsg(message);
      setPhotos((p) => [...p, ...added].slice(0, MAX_PHOTOS));
    });
  };
  const removePhoto = (i: number) => setPhotos((p) => { URL.revokeObjectURL(p[i].previewUrl); return p.filter((_, j) => j !== i); });

  const focusFirstError = (errs: Record<string, string>) => {
    const first = FIELD_ORDER.find((k) => errs[k]);
    const el = first ? formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`) : null;
    if (!el) return;
    el.focus({ preventScroll: true });
    // La barra fija llega a unos 97 px. Si el campo quedó debajo de ella (el navegador no desplaza porque ya está
    // dentro de la ventana) o con su mensaje fuera de la vista, se centra.
    const r = el.getBoundingClientRect();
    if (r.top < 112 || r.bottom + 40 > window.innerHeight) el.scrollIntoView({ block: "center" });
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit({ ready, busy: busyRef.current, preparing: preparer.count > 0 })) return; // doble clic, o fotos aún en proceso
    const otherErr = otherBrandError(fields.marca ?? "", fields.marca_otra ?? ""); // "Which make?" con Other
    const raw: Record<string, string> = {
      ...fields,
      marca: brandToSend(fields.marca ?? "", fields.marca_otra ?? ""),
      telefono: fields.telefono ? normalizePhone(fields.telefono) || fields.telefono : "",
    };
    delete raw.marca_otra; // la marca que viaja es "Other: <texto>"; el campo auxiliar no es parte del contrato
    const a = currentAttribution(); // null si no hay o el navegador bloquea el almacenamiento: el envío sigue
    const campos = { ...raw, ...(a ?? {}) } as Partial<CbFields>;
    const v = validateRequest(campos);
    if (!v.ok || otherErr) {
      const errs = { ...(v.errors ?? {}), ...(otherErr ? { marca_otra: otherErr } : {}) };
      setErrors(errs);
      // Si el error está en una clave que el formulario no muestra, el aviso general no manda a buscar campos resaltados.
      showNotice(VISIBLE_FIELDS.some((k) => errs[k]) ? "fields" : "invalid", false);
      focusFirstError(errs);
      return;
    }
    if (!token) {
      if (!SITE_KEY) console.error("VITE_TURNSTILE_SITE_KEY is missing from this build: the Custom Builds form cannot verify requests.");
      showNotice(SITE_KEY ? "wait" : "nokey");
      return;
    }

    busyRef.current = true;
    setErrors({}); setNotice(null); setStatus("sending");
    // La decisión (clave, reintento, generate_lead, fotos) vive en runSubmit y se prueba con dobles.
    const result = await runSubmit({ campos: v.data as unknown as Record<string, string>, token, photos }, sessionRef.current, {
      postRequest,
      uploadPhotos,
      trackGenerateLead,
      newKey: newIdempotencyKey,
      onKeyChange: () => saveDraft(draftOf(fields, sessionRef.current)),
      onAttemptFailed: () => saveDraft(draftOf(fields, sessionRef.current)),
      resetTurnstile: () => { window.turnstile?.reset(tsId.current); setToken(""); },
      clearDraft,
      onUploading: () => setStatus("uploading"),
    });

    if (result.kind !== "done") {
      setStatus("idle"); busyRef.current = false;
      showNotice(result.notice);
      return;
    }
    photos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    scrollNoticeRef.current = false;
    setNotice(result.note ? { kind: result.note } : null); setStatus("done"); busyRef.current = false;
  };

  const busy = status === "sending" || status === "uploading";
  const err = (k: string) => errors[k];
  const common = (k: string, required = false) => ({
    id: `cb-${k}`, name: k, value: fields[k] ?? "",
    onChange: (ev: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => set(k, ev.target.value),
    "aria-required": required ? true : undefined,
    "aria-invalid": err(k) ? true : undefined,
    "aria-describedby": err(k) ? `cb-${k}-err` : undefined,
    maxLength: k === "marca_otra" ? OTHER_BRAND_MAX : k in MAX_LEN ? (MAX_LEN as Record<string, number>)[k] : undefined,
    disabled: busy,
    className: inputCls,
  });
  // appearance-none: WebKit ignora min-height y padding de un select nativo (medía 26 px); la flecha es propia.
  const select = (k: string, options: readonly string[], required = false) => (
    <div className="relative">
      <select {...(common(k, required) as React.SelectHTMLAttributes<HTMLSelectElement>)} className={cn(inputCls, "appearance-none pr-10")}>
        <option value="">Select…</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-300" />
    </div>
  );
  const canSend = canSubmit({ ready, busy, preparing: preparing > 0 });

  return (
    <section id={ESTIMATE_SECTION_ID} className={cn("min-w-0 scroll-mt-28", className)} aria-labelledby={ESTIMATE_HEADING_ID}>
      <h2 id={ESTIMATE_HEADING_ID} tabIndex={-1} className="text-3xl font-orbitron font-bold mb-3 focus:outline-none">
        <span className="neon-text">Request a Custom Build Estimate</span>
      </h2>
      <p className="text-gray-300 mb-3">{CB_INTRO}</p>
      <p className="text-sm text-gray-400 mb-8">{CB_PRICE_NOTE}</p>

      {status === "done" ? (
        <div ref={doneRef} tabIndex={-1} role="status" className="scroll-mt-28 rounded-lg border border-neon-green/50 bg-card p-8 text-center focus:outline-none">
          <h3 className="text-2xl font-orbitron font-bold text-white mb-2">Request received</h3>
          <p className="text-gray-300">{CB_CONFIRMATION}</p>
          {notice && <p className="text-gray-400 mt-3"><NoticeText kind={notice.kind} /></p>}
        </div>
      ) : (
        <form ref={formRef} method="post" onSubmit={onSubmit} noValidate className="rounded-lg border border-neon-purple/30 bg-card p-4 min-[400px]:p-6 sm:p-8">
         <LoadingNotice ready={hydrated} />
         <fieldset disabled={!ready} className="m-0 min-w-0 space-y-5 border-0 p-0">
          <FieldWrap error={errors.nombre} k="nombre" label="Full name" required><input type="text" autoComplete="name" {...common("nombre", true)} /></FieldWrap>
          <div className={CONTACT}>
            <FieldWrap error={errors.telefono} k="telefono" label="Phone" required><input type="tel" autoComplete="tel" inputMode="tel" {...common("telefono", true)} /></FieldWrap>
            <FieldWrap error={errors.correo} k="correo" label="Email" required><input type="email" autoComplete="email" {...common("correo", true)} /></FieldWrap>
          </div>
          <FieldWrap error={errors.marca} k="marca" label="Make" required>{select("marca", BRANDS, true)}</FieldWrap>
          {fields.marca === OTHER_BRAND && (
            <FieldWrap error={errors.marca_otra} k="marca_otra" label="Which make?" required>
              <input type="text" {...common("marca_otra", true)} />
            </FieldWrap>
          )}
          <div className={PAIR}>
            <FieldWrap error={errors.modelo} k="modelo" label="Model" required><input type="text" {...common("modelo", true)} /></FieldWrap>
            <FieldWrap error={errors.anio} k="anio" label="Year" required><input type="text" inputMode="numeric" {...common("anio", true)} /></FieldWrap>
          </div>
          <FieldWrap error={errors.zona} k="zona" label="City or ZIP" required><input type="text" autoComplete="postal-code" {...common("zona", true)} /></FieldWrap>
          <FieldWrap error={errors.servicio} k="servicio" label="Service" required>{select("servicio", SERVICES, true)}</FieldWrap>
          <FieldWrap error={errors.descripcion} k="descripcion" label="Describe your project" required><textarea rows={5} {...(common("descripcion", true) as React.TextareaHTMLAttributes<HTMLTextAreaElement>)} /></FieldWrap>
          <div className={PAIR}>
            <FieldWrap error={errors.presupuesto} k="presupuesto" label="Budget">{select("presupuesto", BUDGETS)}</FieldWrap>
            <FieldWrap error={errors.plazo} k="plazo" label="Timeline">{select("plazo", TIMELINES)}</FieldWrap>
          </div>

          <div className="min-w-0">
            <label htmlFor="cb-fotos" className="block text-sm font-medium text-gray-200 mb-1">
              Photos <span className="text-gray-400">(optional, up to {MAX_PHOTOS})</span>
            </label>
            <input ref={photosRef} id="cb-fotos" type="file" accept="image/*" multiple onChange={onFiles}
              disabled={busy || preparing > 0 || atPhotoLimit} aria-describedby="cb-fotos-note cb-fotos-msg"
              className="block w-full min-h-11 scroll-mt-32 scroll-mb-28 text-base text-gray-300 file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-md file:border-0 file:bg-neon-purple/30 file:px-4 file:py-2 file:text-base file:font-medium file:text-white" />
            <p id="cb-fotos-note" className="mt-1 text-sm text-gray-400">{CB_PHOTO_NOTE}</p>
            {/* La región existe siempre (vacía) y solo cambia su texto: un role="status" que se monta ya con el texto no se anuncia. */}
            <p role="status" aria-live="polite" className="mt-1 text-sm text-neon-cyan">{preparing > 0 ? CB_PREPARING : ""}</p>
            {/* El aviso lleva el nombre del archivo, que puede ser largo y sin espacios: se parte en vez de desbordar. */}
            <p id="cb-fotos-msg" className="mt-1 break-words text-sm text-red-400" aria-live="polite">{photoMsg}</p>
            {photos.length > 0 && (
              <ul ref={photoListRef} tabIndex={-1} className="mt-3 flex gap-3 flex-wrap focus:outline-none">
                {photos.map((p, i) => (
                  <li key={p.previewUrl} className="relative">
                    <img src={p.previewUrl} alt={`Selected photo ${i + 1}`} className="h-20 w-20 rounded object-cover" />
                    <button type="button" onClick={() => removePhoto(i)} disabled={busy}
                      aria-label={`Remove photo ${i + 1}`} className="absolute top-1 right-1 h-8 w-8 rounded-full bg-black/80 text-white text-lg leading-none">×</button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div ref={tsEl} />

          {/* Estado y errores junto al botón de enviar: en un teléfono el botón queda al final de un formulario largo. */}
          <div ref={noticeRef} className="scroll-mt-32 scroll-mb-28 min-h-[1.5rem] space-y-2">
            <div role="status" aria-live="polite">
              {status === "sending" && <p className="text-neon-cyan">{CB_SENDING}</p>}
              {status === "uploading" && <p className="text-neon-cyan">{CB_UPLOADING}</p>}
            </div>
            {notice && <p role="alert" className="text-red-400"><NoticeText kind={notice.kind} /></p>}
          </div>

          <Button ref={submitRef} type="submit" size="lg" disabled={!canSend} aria-disabled={!canSend}
            className="w-full scroll-mt-32 scroll-mb-28 bg-gradient-to-r from-neon-pink to-neon-purple text-white font-bold">
            {busy ? "Sending…" : "Request Estimate"}
          </Button>
          <p className="text-sm text-gray-400 text-center">
            {CB_PRIVACY_LEAD}{" "}
            <a href="/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-neon-cyan underline">{CB_PRIVACY_LINK}</a>.
          </p>
         </fieldset>
        </form>
      )}
    </section>
  );
};

export default EstimateForm;
