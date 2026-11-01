// Esquema único de la solicitud de Custom Builds (contrato web-01 v1.1.2, §3).
// Con la solicitud válida, `origen` siempre viaja: unknown cuando no hay ninguna señal (normalizeOrigin).
// Lo importan el navegador y las Netlify Functions: no depende de DOM ni de Node.
// Desde v1.1.2 el teléfono y el correo son obligatorios, cada uno con su formato válido.

export const MAX_LEN = {
  nombre: 120, telefono: 40, correo: 160, marca: 60, modelo: 80, anio: 4,
  zona: 80, servicio: 120, descripcion: 2000, presupuesto: 60, plazo: 60,
  origen: 20, utm_source: 120, utm_medium: 120, utm_campaign: 160,
  utm_term: 160, utm_content: 160, click_id_tipo: 10, click_id: 200,
  aterrizaje: 300, referrer: 200,
} as const;

// Las 13 marcas aprobadas por Hikashi (2026-11-01) más Other al final. "Land Rover / Range Rover" es UNA opción.
export const BRANDS = [
  "Porsche", "Mercedes-Benz", "BMW", "Land Rover / Range Rover", "Rolls-Royce", "Bentley", "Bugatti",
  "McLaren", "Ferrari", "Lamborghini", "Aston Martin", "Lexus", "Maserati", "Other",
] as const;

// Con Other, el formulario pide "Which make?" y la marca que viaja es "Other: <texto>" (el contrato no cambia:
// 7 + 50 caracteres caben en MAX_LEN.marca).
export const OTHER_BRAND = "Other";
export const OTHER_BRAND_PREFIX = "Other: ";
export const OTHER_BRAND_MAX = 50;

const otherBrandText = (marcaOtra: string) => (marcaOtra || "").trim().replace(/\s+/g, " ");

/** Marca que viaja en la solicitud: la elegida, o "Other: <texto>" si eligió Other y escribió cuál. */
export function brandToSend(marca: string, marcaOtra: string): string {
  if (marca !== OTHER_BRAND) return marca;
  const t = otherBrandText(marcaOtra);
  return t ? OTHER_BRAND_PREFIX + t : OTHER_BRAND;
}

/** Error de "Which make?" (solo aplica con Other). Devuelve "" si está bien. */
export function otherBrandError(marca: string, marcaOtra: string): string {
  if (marca !== OTHER_BRAND) return "";
  const t = otherBrandText(marcaOtra);
  if (!t) return "Enter the make.";
  if (t.length > OTHER_BRAND_MAX) return `Maximum ${OTHER_BRAND_MAX} characters.`;
  return "";
}

export const BUDGETS = [
  "Less than $5,000", "$5,000 to $10,000", "$10,000 to $30,000",
  "More than $30,000", "I need guidance",
] as const;

export const TIMELINES = [
  "As soon as possible", "Within 1-3 months", "In 3-6 months", "Just exploring",
] as const;

export const SERVICES = [
  "Performance upgrades", "Interior customization", "Paint and graphics",
  "Suspension and handling", "Audio system", "Body kit", "Full build", "Other",
] as const;

export const ORIGINS = ["google_ads", "utm", "referral", "unknown"] as const;
export const CLICK_ID_TYPES = ["gclid", "gbraid", "wbraid"] as const;
export const MAX_PHOTOS = 3;
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

export type CbFields = {
  nombre: string; telefono: string; correo: string; marca: string; modelo: string;
  anio: string; zona: string; servicio: string; descripcion: string;
  presupuesto?: string; plazo?: string; origen?: string;
  utm_source?: string; utm_medium?: string; utm_campaign?: string; utm_term?: string;
  utm_content?: string; click_id_tipo?: string; click_id?: string;
  aterrizaje?: string; referrer?: string;
};

// Tipo plano (no unión): el tsconfig del sitio corre sin strictNullChecks y no estrecha uniones.
export type ValidationResult = { ok: boolean; data?: CbFields; errors?: Record<string, string> };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuidV4 = (v: unknown): v is string => typeof v === "string" && UUID_V4.test(v);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const E164 = /^\+[1-9]\d{7,14}$/;
const NANP = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

/** Normaliza a E.164. US de 10 u 11 dígitos pasa a +1...; con "+" se respeta. Devuelve "" si no se puede. */
export function normalizePhone(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return "";
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+")) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return "";
}

/**
 * E.164 válido y que no sea un número inventado. Con el teléfono obligatorio, quien no quiere darlo escribe
 * 0000000000 o 5555555555; dos personas con el mismo número falso y el mismo auto en 24 h se marcarían como
 * duplicado y no se mediría el lead. Todo +1 es plan NANP: el código de área y la central empiezan en 2 a 9
 * (rechaza 0000000000 y 1234567890), y un número de un solo dígito repetido nunca es real.
 */
function isRealPhone(p: string): boolean {
  if (!E164.test(p)) return false;
  const national = p.startsWith("+1") ? p.slice(2) : p.slice(1);
  if (/^(\d)\1+$/.test(national)) return false;
  return !p.startsWith("+1") || NANP.test(p);
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * El origen sale de la evidencia que viaja, no de lo que declare el navegador: click_id con su tipo = google_ads;
 * si no, UTM = utm; si no, referrer = referral; si no, unknown. Un click_id sin click_id_tipo (o al revés) se
 * descarta: nada se atribuye a Google Ads sin un identificador de clic completo. Modifica `data` en el lugar.
 */
export function normalizeOrigin(data: Record<string, string>): void {
  if (!data.click_id || !data.click_id_tipo) { delete data.click_id; delete data.click_id_tipo; }
  data.origen = data.click_id ? "google_ads"
    : data.utm_source || data.utm_medium || data.utm_campaign ? "utm"
    : data.referrer ? "referral"
    : "unknown";
}

export function validateRequest(input: unknown): ValidationResult {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const data: Record<string, string> = {};

  for (const key of Object.keys(MAX_LEN) as (keyof typeof MAX_LEN)[]) {
    if (src[key] !== undefined && src[key] !== null && typeof src[key] !== "string") {
      errors[key] = "Invalid value.";
      continue;
    }
    // descripcion conserva saltos de línea; el resto se aplana
    let v = str(src[key]);
    if (key !== "descripcion") v = v.replace(/\s+/g, " ");
    if (v.length > MAX_LEN[key]) errors[key] = `Maximum ${MAX_LEN[key]} characters.`;
    else if (v) data[key] = v;
  }

  const required: [string, string][] = [
    ["nombre", "Enter your name."], ["telefono", "Enter your phone number."],
    ["correo", "Enter your email address."], ["marca", "Select a brand."], ["modelo", "Enter the model."],
    ["anio", "Enter the 4-digit year."], ["zona", "Enter your city or ZIP."],
    ["servicio", "Select the service."], ["descripcion", "Describe your project."],
  ];
  for (const [k, msg] of required) if (!data[k] && !errors[k]) errors[k] = msg;

  if (data.anio && !errors.anio) {
    const y = Number(data.anio);
    if (!/^\d{4}$/.test(data.anio) || y < 1900 || y > new Date().getFullYear() + 2) {
      errors.anio = "Enter a valid 4-digit year.";
    }
  }
  if (data.telefono && !errors.telefono && !isRealPhone(data.telefono)) {
    errors.telefono = "Enter a valid phone number.";
  }
  if (data.correo && !errors.correo && !EMAIL.test(data.correo)) {
    errors.correo = "Enter a valid email address.";
  }
  if (data.origen && !(ORIGINS as readonly string[]).includes(data.origen)) errors.origen = "Invalid value.";
  if (data.click_id_tipo && !(CLICK_ID_TYPES as readonly string[]).includes(data.click_id_tipo)) {
    errors.click_id_tipo = "Invalid value.";
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  normalizeOrigin(data); // también en el servidor: el origen que declare el navegador no cuenta
  return { ok: true, data: data as unknown as CbFields };
}

export function validatePhotosExpected(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_PHOTOS ? v : null;
}
