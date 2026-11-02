// Ronda 4 de web-tsm#24: avisos de privacidad junto al formulario (P-06 de la auditoría; textos aprobados por Liza el
// 2026-11-02). El cableado se comprueba sobre el código fuente de EstimateForm (no hay DOM en el repo para montarlo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CB_NOTICES, CB_PHOTO_NOTE, CB_PRIVACY_LEAD, CB_PRIVACY_LINK } from "../src/lib/cbCopy.ts";

const FORM = readFileSync(new URL("../src/components/custom-builds/EstimateForm.tsx", import.meta.url), "utf8");

test("el aviso de fotos es el texto de la política (2.7) y no promete nada", () => {
  assert.equal(CB_PHOTO_NOTE, "Photos can show license plates, addresses, or people; please do not upload documents or other people's personal information.");
});

test("el texto del enlace a la política es el aprobado", () => {
  assert.equal(`${CB_PRIVACY_LEAD} ${CB_PRIVACY_LINK}.`, "By submitting, you agree to our Privacy Policy.");
});

test("el formulario muestra el aviso de fotos y lo asocia al campo", () => {
  assert.match(FORM, /id="cb-fotos-note"[^>]*>\{CB_PHOTO_NOTE\}/);
  assert.match(FORM, /aria-describedby="cb-fotos-note cb-fotos-msg"/);
});

test("el enlace a /privacy-policy va después del botón de enviar y abre en pestaña nueva", () => {
  const submit = FORM.indexOf("Request Estimate");
  const link = FORM.indexOf('href="/privacy-policy"');
  assert.ok(submit > 0 && link > submit);
  assert.match(FORM.slice(link, link + 120), /target="_blank" rel="noopener noreferrer"/);
});

test("los avisos que dicen 'call us' llevan el teléfono (Q1)", () => {
  for (const [kind, n] of Object.entries(CB_NOTICES)) {
    if (/call us/.test(n.text)) assert.equal(n.phone, true, kind);
  }
});
