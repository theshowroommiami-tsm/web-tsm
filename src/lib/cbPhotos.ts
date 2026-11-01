// Recodifica fotos por canvas a JPEG (sin EXIF) y genera la miniatura para el receptor.
import { MAX_PHOTO_BYTES, MAX_THUMB_CHARS } from "../../shared/cb-schema.ts";

export const PHOTO_LONG_SIDE = 2000; // contrato: 1600 a 2400 px de lado largo
export const THUMB_LONG_SIDE = 560; // contrato: 480 a 640 px

export type ProcessedPhoto = { name: string; blob: Blob; thumb: string; previewUrl: string };

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/jpeg", quality),
  );
}

function draw(bmp: ImageBitmap, longSide: number): HTMLCanvasElement {
  const scale = Math.min(1, longSide / Math.max(bmp.width, bmp.height)); // nunca agranda
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.fillStyle = "#fff"; // PNG con transparencia
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}

/**
 * Decodifica respetando la orientación EXIF (las fotos de iPhone vienen giradas). Algunos motores no aceptan el valor
 * "from-image" en las opciones y lanzan TypeError: se reintenta sin opciones, que en la especificación actual ya
 * es "from-image". Si el archivo no es una imagen, el segundo intento también falla y el error sube.
 */
export async function decodeImage(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return await createImageBitmap(file);
  }
}

export async function processPhoto(file: File): Promise<ProcessedPhoto> {
  const bmp = await decodeImage(file);
  try {
    const main = draw(bmp, PHOTO_LONG_SIDE);
    let q = 0.85;
    let blob = await toBlob(main, q);
    while (blob.size > MAX_PHOTO_BYTES && q > 0.4) {
      q -= 0.1;
      blob = await toBlob(main, q);
    }
    if (blob.size > MAX_PHOTO_BYTES) throw new Error("size");

    const tc = draw(bmp, THUMB_LONG_SIDE);
    let tq = 0.7;
    let thumb = "";
    for (;;) {
      thumb = (await toBlobBase64(tc, tq));
      if (thumb.length <= MAX_THUMB_CHARS || tq <= 0.3) break;
      tq -= 0.1;
    }
    if (thumb.length > MAX_THUMB_CHARS) thumb = "";
    return { name: file.name, blob, thumb, previewUrl: URL.createObjectURL(blob) };
  } finally {
    bmp.close();
  }
}

async function toBlobBase64(canvas: HTMLCanvasElement, q: number): Promise<string> {
  const b = await toBlob(canvas, q);
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}
