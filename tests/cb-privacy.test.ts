// Bloque C · política de privacidad según anl-05 v1.1 (§2.1, 2.2, 2.5, 2.7, §3 y §5). Pruebas de texto sobre
// src/pages/PrivacyPolicy.tsx: no sustituyen la revisión del abogado ni la aprobación de Liza y de Hikashi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/pages/PrivacyPolicy.tsx", import.meta.url), "utf8");
// Texto plano: sin etiquetas JSX, con los espacios aplanados.
const TEXT = SRC.replace(/<[^>]+>/g, " ").replace(/\{" "\}/g, " ").replace(/\s+/g, " ");

/** Trozo de la política entre dos encabezados numerados. */
const section = (from: string, to: string) => {
  const a = SRC.indexOf(from);
  const b = SRC.indexOf(to);
  assert.ok(a > 0 && b > a, `${from} -> ${to}`);
  return SRC.slice(a, b).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
};

test("(j) y §3: la frase 'We do not send Google any information you type on our website' ya no figura", () => {
  assert.doesNotMatch(TEXT, /We do not send Google any information/i);
  assert.doesNotMatch(TEXT, /do not send Google/i);
});

test("2.1 (§12): GA4 mide el clic del botón de estimado y que se envió una solicitud (el hecho, no el contenido)", () => {
  const s12 = section("12. Cookies and Tracking Technologies", "13. Contact Us");
  assert.match(s12, /Google Analytics 4, through Google Tag Manager/);
  assert.match(s12, /clicks on our call buttons and on the Request a Custom Build Estimate button, including where on the site the button was clicked/);
  assert.match(s12, /that a repair authorization was completed or that a Custom Builds request was submitted \(the fact, not its content\)/);
  assert.match(s12, /_ga and _ga_\* cookies/);
  assert.match(s12, /Google Signals is turned off/);
  // la frase sobre la medición vale solo para la medición: no dice que Google no recibe nada
  assert.match(s12, /Google Analytics and Google Ads do not receive what you type into our forms or the photos you attach/);
  assert.match(s12, /requests sent through our Custom Builds form are saved in Google Workspace, as described in Section 4/);
  assert.doesNotMatch(s12, /Google (does|will) not receive (any|anything)|no information .* Google/i);
});

test("(a) (b) (c): nombra Google Analytics y Google Ads, enlaza a partner-sites y conserva los enlaces de exclusión", () => {
  assert.match(TEXT, /Google Analytics\./);
  assert.match(TEXT, /Google Ads\./);
  for (const url of [
    "https://policies.google.com/technologies/partner-sites", "https://tools.google.com/dlpage/gaoptout",
    "https://myadcenter.google.com", "https://optout.aboutads.info", "https://optout.networkadvertising.org",
  ]) assert.ok(SRC.includes(`href="${url}"`), url);
});

test("2.2 (§12): una solicitud de Custom Builds y una autorización firmada se informan a Ads como hecho, con un identificador aleatorio", () => {
  const ads = section("Google Ads.</strong>", "Calls from our ads.</strong>");
  assert.match(ads, /gclid/);
  assert.match(ads, /_gcl_au cookie, set through the Conversion Linker/);
  assert.match(ads, /A Custom Builds request or a signed repair authorization is reported to Google Ads as a fact, together with a random internal identifier \(transaction ID\) that is not personal data/);
  assert.match(ads, /remarketing and personalized advertising/); // sigue declarado como posible
});

test("(l) 2.5 (§4): nombra a Cloudflare y a Google Workspace, y a Netlify con su función", () => {
  const s4 = section("4. How We Share Your Information", "5. Text Message (SMS) Communications");
  assert.match(s4, /Google \(Google Analytics, Google Ads, Google Tag Manager, and Google Workspace\)/);
  assert.match(s4, /Cloudflare, for the security check \(Turnstile\) on our Custom Builds form and for the private storage of the photos you attach to it/);
  assert.match(s4, /Netlify, for hosting our website and processing our Custom Builds form/);
  assert.match(s4, /RingCentral, our telephony provider/);
  assert.match(s4, /JotForm, for our repair authorization form/);
});

test("(k) 2.7: Custom Builds cubre qué se recoge, para qué, dónde se guarda, quién accede, fotos y los plazos de 12 y 24 meses", () => {
  const s2 = section("2. Information We Collect", "3. How We Use Your Information");
  const s4 = section("4. How We Share Your Information", "5. Text Message (SMS) Communications");
  const s10 = section("10. Data Retention", "11. Children's Privacy");

  // qué se recoge: teléfono Y correo (los dos son obligatorios), no "o"
  assert.match(s2, /your name, phone number, and email address/);
  assert.doesNotMatch(s2, /phone number or email|phone or email|email or phone/i);
  for (const dato of ["make, model, and year", "city or ZIP code", "description of your project", "approximate budget and timeline", "up to 3 photos"]) {
    assert.ok(s2.includes(dato), dato);
  }
  assert.match(s2, /campaign \(UTM\) parameters, the type and value of the Google click identifier \(gclid, gbraid, or wbraid\), the page you landed on, and the website that referred you/);
  // para qué
  assert.match(s2, /respond to your request and to follow up with you about it/);
  // fotos: pueden mostrar placas, direcciones o personas; se pide no subir documentos ni datos de terceros
  assert.match(s2, /Photos can show license plates, addresses, or people; please do not upload documents or other people's personal information/);
  // dónde se guarda y quién accede
  assert.match(s4, /processed by Netlify and saved in a Google Workspace spreadsheet that belongs to The Showroom Miami/);
  assert.match(s4, /photos you attach are stored in private Cloudflare storage/);
  assert.match(s4, /Cloudflare Turnstile checks that the submission is not automated and may receive technical data from your browser/);
  assert.match(s4, /Only authorized personnel of The Showroom Miami can access your request and photos/);
  assert.match(s4, /Google acts as our service provider for that storage/);
  // conservación
  assert.match(s10, /Custom Builds photos: retained for 12 months/);
  assert.match(s10, /Custom Builds requests that do not become a service: retained for 24 months/);
  assert.doesNotMatch(s10, /automatically|deleted after/i); // la retención de 24 meses se aplica a mano: no se promete automatismo
});

test("§3: ninguna afirmación prohibida (promesa de plazo, 'nunca', banner o preferencias de cookies, sin cookies publicitarias, sin grabación ni IA)", () => {
  assert.doesNotMatch(TEXT, /business day|within \d+ (hours?|days?)|within 24|24 hours|same[- ]day response/i);
  assert.doesNotMatch(TEXT, /\bnever (share|sell|disclose|send)|will never|do not share your (personal )?information with anyone/i);
  assert.doesNotMatch(TEXT, /cookie (banner|preferences|settings center)|consent (banner|manager)|cookie consent/i);
  assert.doesNotMatch(TEXT, /do not use (advertising|marketing) cookies|no remarketing|do not use remarketing/i);
  assert.doesNotMatch(TEXT, /calls (are|is) not recorded|we do not record calls/i);
  assert.match(TEXT, /We do not transcribe call recordings or analyze them with artificial intelligence/); // §6 sigue como estaba
  assert.doesNotMatch(TEXT, /contact form on (the|our) home ?page|home ?page contact form/i);
  // no se nombra a ningún proveedor que anl-05 no nombre
  for (const otro of ["Amazon", "AWS", "Microsoft", "Meta ", "Facebook", "Mailchimp", "HubSpot", "Zapier", "Stripe", "Twilio"]) {
    assert.ok(!TEXT.includes(otro), otro);
  }
});

test("(f) la Sección 5 (SMS) queda intacta: forma parte del registro de la campaña 10DLC", () => {
  const s5 = SRC.slice(SRC.indexOf("5. Text Message (SMS) Communications"), SRC.indexOf("6. Call Recording")).replace(/\s+/g, " ").trim();
  assert.equal(s5.length, 849);
  assert.equal(createHash("sha256").update(s5).digest("hex"), "ef43f40b37da884e400e74f32784113c1a814c12c431f959e24a54ded5af6a10");
});

test("(d) (e) (h) (m): RingCentral con 90 días y 12 meses, sin 'unrecorded line', fecha actualizada y revisión pendiente anotada", () => {
  assert.match(TEXT, /RingCentral/);
  assert.match(TEXT, /Call recordings are retained on RingCentral's servers for 90 days, and call logs are retained for up to 12 months/);
  assert.match(TEXT, /Call recordings: retained on the servers of our telephony provider, RingCentral, for 90 days/);
  assert.doesNotMatch(TEXT, /unrecorded line/i);
  assert.match(TEXT, /Last Updated: November 1, 2026/);
  assert.match(SRC, /pendiente de la revisión del abogado \[SC\] y de la\s+\/\/ aprobación de Liza y de Hikashi/);
});

test("el teléfono de contacto sigue saliendo de business.ts y la política no escribe uno a mano", () => {
  assert.match(SRC, /href=\{BUSINESS_PHONE_HREF\} data-call-location="page_body"/);
  assert.doesNotMatch(SRC, /305[-. )]*419[-. ]*8379|3054198379/);
});
