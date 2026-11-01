import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  BRANDS, BUDGETS, MAX_LEN, MAX_PHOTOS, SERVICES, TIMELINES,
  normalizePhone, validateRequest, type CbFields,
} from "../../../shared/cb-schema.ts";
import { loadAttribution } from "../../../shared/cb-attribution.ts";
import { processPhoto, type ProcessedPhoto } from "@/lib/cbPhotos";
import { clearDraft, loadDraft, newIdempotencyKey, postRequest, saveDraft, uploadPhotos } from "@/lib/cbClient";
import { trackGenerateLead } from "@/lib/cbDataLayer";

export const ESTIMATE_SECTION_ID = "estimate";
export const ESTIMATE_HEADING_ID = "estimate-heading";

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, o: Record<string, unknown>): string;
      reset(id?: string): void;
    };
  }
}

type Status = "idle" | "sending" | "uploading" | "done";
const FIELD_ORDER = ["nombre", "telefono", "correo", "marca", "modelo", "anio", "zona", "servicio", "descripcion"];
const inputCls =
  "w-full rounded-md border border-neon-purple/40 bg-background px-3 py-2 text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-neon-cyan";

/** Ancla interceptada: scroll al formulario y foco en su encabezado, sin tocar el historial. */
export function goToEstimate(e: React.MouseEvent) {
  e.preventDefault();
  const section = document.getElementById(ESTIMATE_SECTION_ID);
  if (!section) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  section.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  document.getElementById(ESTIMATE_HEADING_ID)?.focus({ preventScroll: true });
}

const MSG = {
  turnstile: "We couldn't verify you're human. Please try again.",
  quota: "We can't take more requests right now. Please call us instead.",
  invalid: "Some details didn't pass our checks. Please review the form.",
  retry: "We couldn't reach our server. Please try again in a moment.",
  error: "Something went wrong. Please try again or call us.",
} as const;

const FieldWrap = ({ k, label, required, error, children }: { k: string; label: string; required?: boolean; error?: string; children: React.ReactNode }) => (
  <div>
    <label htmlFor={`cb-${k}`} className="block text-sm font-medium text-gray-200 mb-1">
      {label}{required ? <span aria-hidden="true"> *</span> : <span className="text-gray-400"> (optional)</span>}
    </label>
    {children}
    {error && <p id={`cb-${k}-err`} className="mt-1 text-sm text-red-400">{error}</p>}
  </div>
);

const EstimateForm = () => {
  const [fields, setFields] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<ProcessedPhoto[]>([]);
  const [photoMsg, setPhotoMsg] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [notice, setNotice] = useState("");
  const [token, setToken] = useState("");
  const claveRef = useRef("");
  const busyRef = useRef(false);
  const tsEl = useRef<HTMLDivElement>(null);
  const tsId = useRef<string>();
  const formRef = useRef<HTMLFormElement>(null);

  // Borrador de la sesión (solo en el navegador, después de hidratar).
  useEffect(() => {
    const d = loadDraft();
    if (d) { setFields(d.fields); claveRef.current = d.clave; }
  }, []);

  // Turnstile, acción cb_request.
  useEffect(() => {
    if (!SITE_KEY || !tsEl.current) return;
    const mount = () => {
      if (!window.turnstile || !tsEl.current || tsId.current) return;
      tsId.current = window.turnstile.render(tsEl.current, {
        sitekey: SITE_KEY, action: "cb_request",
        callback: (t: string) => setToken(t),
        "expired-callback": () => setToken(""),
        "error-callback": () => setToken(""),
      });
    };
    if (window.turnstile) { mount(); return; }
    let s = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SRC}"]`);
    if (!s) { s = document.createElement("script"); s.src = TURNSTILE_SRC; s.async = true; document.head.appendChild(s); }
    s.addEventListener("load", mount);
    return () => s?.removeEventListener("load", mount);
  }, []);

  const set = (k: string, v: string) => {
    setFields((prev) => {
      const next = { ...prev, [k]: v };
      if (!claveRef.current) claveRef.current = newIdempotencyKey();
      saveDraft({ fields: next, clave: claveRef.current });
      return next;
    });
    if (errors[k]) setErrors((e) => { const { [k]: _, ...rest } = e; return rest; });
  };

  const onFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = "";
    setPhotoMsg("");
    const room = MAX_PHOTOS - photos.length;
    if (list.length > room) setPhotoMsg(`You can attach up to ${MAX_PHOTOS} photos.`);
    const added: ProcessedPhoto[] = [];
    for (const f of list.slice(0, Math.max(room, 0))) {
      try { added.push(await processPhoto(f)); }
      catch { setPhotoMsg(`We couldn't read "${f.name}". Please use a JPG, PNG or WebP photo.`); }
    }
    setPhotos((p) => [...p, ...added].slice(0, MAX_PHOTOS));
  };
  const removePhoto = (i: number) => setPhotos((p) => { URL.revokeObjectURL(p[i].previewUrl); return p.filter((_, j) => j !== i); });

  const focusFirstError = (errs: Record<string, string>) => {
    const first = FIELD_ORDER.find((k) => errs[k]);
    if (first) formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busyRef.current) return; // doble clic
    const raw: Record<string, string> = { ...fields, telefono: fields.telefono ? normalizePhone(fields.telefono) || fields.telefono : "" };
    const a = loadAttribution(window.localStorage);
    const campos = { ...raw, ...(a ?? {}) } as Partial<CbFields>;
    const v = validateRequest(campos);
    if (!v.ok) { setErrors(v.errors); setNotice("Please fix the highlighted fields."); focusFirstError(v.errors); return; }
    if (!token) { setNotice(SITE_KEY ? "Please wait for the security check to finish, then try again." : MSG.error); return; }

    busyRef.current = true;
    setErrors({}); setNotice(""); setStatus("sending");
    if (!claveRef.current) claveRef.current = newIdempotencyKey();
    const r = await postRequest(claveRef.current, token, v.data, photos.length);

    if (r.kind !== "ok") {
      if (r.kind === "turnstile" || r.kind === "retry") { window.turnstile?.reset(tsId.current); setToken(""); }
      setNotice(MSG[r.kind]);
      setStatus("idle"); busyRef.current = false;
      return;
    }

    // Nivel 2 (anl-06 §3): sale con el 201, antes de pedir el permiso de fotos. No depende de ellas.
    trackGenerateLead(r.leadId, r.medir);

    let note = "";
    if (r.permiso && photos.length) {
      setStatus("uploading");
      try {
        const ok = await uploadPhotos(r.permiso, photos);
        if (ok < photos.length) note = "Some photos couldn't be uploaded. We'll reach out if we need them.";
      } catch { note = "Your photos couldn't be uploaded. We'll reach out if we need them."; }
    }
    photos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    clearDraft(); claveRef.current = "";
    setNotice(note); setStatus("done"); busyRef.current = false;
    document.getElementById(ESTIMATE_HEADING_ID)?.focus();
  };

  const busy = status === "sending" || status === "uploading";
  const err = (k: string) => errors[k];
  const common = (k: string) => ({
    id: `cb-${k}`, name: k, value: fields[k] ?? "",
    onChange: (ev: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => set(k, ev.target.value),
    "aria-invalid": err(k) ? true : undefined,
    "aria-describedby": err(k) ? `cb-${k}-err` : undefined,
    maxLength: k in MAX_LEN ? (MAX_LEN as Record<string, number>)[k] : undefined,
    disabled: busy,
    className: inputCls,
  });
  const select = (k: string, options: readonly string[]) => (
    <select {...(common(k) as React.SelectHTMLAttributes<HTMLSelectElement>)}>
      <option value="">Select…</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );

  return (
    <section id={ESTIMATE_SECTION_ID} className="py-16 scroll-mt-28" aria-labelledby={ESTIMATE_HEADING_ID}>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <h2 id={ESTIMATE_HEADING_ID} tabIndex={-1} className="text-3xl font-orbitron font-bold mb-3 text-center focus:outline-none">
          <span className="neon-text">Request a Custom Build Estimate</span>
        </h2>
        <p className="text-gray-300 text-center mb-8">Tell us about your vehicle and your project. We reply within one business day.</p>

        <div aria-live="polite" role="status" className="mb-4 min-h-[1.5rem]">
          {status === "uploading" && <p className="text-neon-cyan">Uploading your photos, please keep this page open</p>}
          {status === "sending" && <p className="text-neon-cyan">Sending your request…</p>}
          {status !== "done" && notice && <p className="text-red-400">{notice}</p>}
        </div>

        {status === "done" ? (
          <div className="rounded-lg border border-neon-green/50 bg-card p-8 text-center">
            <h3 className="text-2xl font-orbitron font-bold text-white mb-2">Request received</h3>
            <p className="text-gray-300">Thank you. Our team will contact you within one business day.</p>
            {notice && <p className="text-gray-400 mt-3">{notice}</p>}
          </div>
        ) : (
          <form ref={formRef} onSubmit={onSubmit} noValidate className="space-y-5 rounded-lg border border-neon-purple/30 bg-card p-6 sm:p-8">
            <FieldWrap error={errors.nombre} k="nombre" label="Full name" required><input type="text" autoComplete="name" {...common("nombre")} /></FieldWrap>
            <p className="text-sm text-gray-400">Enter a phone number, an email address, or both.</p>
            <div className="grid sm:grid-cols-2 gap-5">
              <FieldWrap error={errors.telefono} k="telefono" label="Phone"><input type="tel" autoComplete="tel" inputMode="tel" {...common("telefono")} /></FieldWrap>
              <FieldWrap error={errors.correo} k="correo" label="Email"><input type="email" autoComplete="email" {...common("correo")} /></FieldWrap>
            </div>
            <div className="grid sm:grid-cols-3 gap-5">
              <FieldWrap error={errors.marca} k="marca" label="Make" required>{select("marca", BRANDS)}</FieldWrap>
              <FieldWrap error={errors.modelo} k="modelo" label="Model" required><input type="text" {...common("modelo")} /></FieldWrap>
              <FieldWrap error={errors.anio} k="anio" label="Year" required><input type="text" inputMode="numeric" {...common("anio")} /></FieldWrap>
            </div>
            <FieldWrap error={errors.zona} k="zona" label="City or ZIP" required><input type="text" autoComplete="postal-code" {...common("zona")} /></FieldWrap>
            <FieldWrap error={errors.servicio} k="servicio" label="Service" required>{select("servicio", SERVICES)}</FieldWrap>
            <FieldWrap error={errors.descripcion} k="descripcion" label="Describe your project" required><textarea rows={5} {...(common("descripcion") as React.TextareaHTMLAttributes<HTMLTextAreaElement>)} /></FieldWrap>
            <div className="grid sm:grid-cols-2 gap-5">
              <FieldWrap error={errors.presupuesto} k="presupuesto" label="Budget">{select("presupuesto", BUDGETS)}</FieldWrap>
              <FieldWrap error={errors.plazo} k="plazo" label="Timeline">{select("plazo", TIMELINES)}</FieldWrap>
            </div>

            <div>
              <label htmlFor="cb-fotos" className="block text-sm font-medium text-gray-200 mb-1">
                Photos <span className="text-gray-400">(optional, up to {MAX_PHOTOS})</span>
              </label>
              <input id="cb-fotos" type="file" accept="image/*" multiple onChange={onFiles}
                disabled={busy || photos.length >= MAX_PHOTOS} className="block w-full text-sm text-gray-300" aria-describedby="cb-fotos-msg" />
              <p id="cb-fotos-msg" className="mt-1 text-sm text-red-400" aria-live="polite">{photoMsg}</p>
              {photos.length > 0 && (
                <ul className="mt-3 flex gap-3 flex-wrap">
                  {photos.map((p, i) => (
                    <li key={p.previewUrl} className="relative">
                      <img src={p.previewUrl} alt={`Selected photo ${i + 1}`} className="h-20 w-20 rounded object-cover" />
                      <button type="button" onClick={() => removePhoto(i)} disabled={busy}
                        aria-label={`Remove photo ${i + 1}`} className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-black text-white text-sm">×</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div ref={tsEl} />
            <Button type="submit" size="lg" disabled={busy} aria-disabled={busy}
              className="w-full bg-gradient-to-r from-neon-pink to-neon-purple text-white font-bold">
              {busy ? "Sending…" : "Request Estimate"}
            </Button>
          </form>
        )}
      </div>
    </section>
  );
};

export default EstimateForm;
