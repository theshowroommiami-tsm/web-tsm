// B8 · netlify/lib/r2.ts contra R2. presignPut es cálculo puro (sin red): firma la URL con aws4fetch y aquí se
// comprueba qué quedó firmado y, además, que la firma coincide con una recomputación independiente de AWS SigV4.
// head, firstBytes y remove se prueban con un fetch simulado (nunca se llama a R2).
// Necesita aws4fetch instalado (package.json lo declara desde 5a2a2a7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createR2, R2_TIMEOUT_MS } from "../netlify/lib/r2.ts";

const ENV = { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s" };
const KEY = "solicitudes/CB-0001-aaaaaaaa/foto-1.jpg";

test("presignPut firma content-type y content-length, 300 s y la ruta del bucket", async () => {
  const url = new URL(await createR2(ENV).presignPut(KEY, 1234));
  assert.equal(url.protocol, "https:");
  assert.equal(url.host, "a.r2.cloudflarestorage.com");
  assert.equal(url.pathname, "/b/solicitudes/CB-0001-aaaaaaaa/foto-1.jpg");
  const q = url.searchParams;
  assert.equal(q.get("X-Amz-Expires"), "300");
  assert.equal(q.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(q.get("X-Amz-SignedHeaders"), "content-length;content-type;host");
  assert.match(q.get("X-Amz-Date") ?? "", /^\d{8}T\d{6}Z$/);
  assert.match(q.get("X-Amz-Credential") ?? "", /^k\/\d{8}\/auto\/s3\/aws4_request$/);
  assert.match(q.get("X-Amz-Signature") ?? "", /^[0-9a-f]{64}$/);
  assert.ok(![...q.values()].includes("s"), "la Secret Access Key no viaja en la URL");
});

test("presignPut: el tamaño declarado entra a la firma (cambiar el Content-Length invalida la URL)", async () => {
  const r2 = createR2(ENV);
  const a = new URL(await r2.presignPut(KEY, 1234)).searchParams;
  const b = new URL(await r2.presignPut(KEY, 1235)).searchParams;
  assert.notEqual(a.get("X-Amz-Signature"), b.get("X-Amz-Signature"));
  const c = new URL(await r2.presignPut("solicitudes/CB-0001-aaaaaaaa/foto-2.jpg", 1234));
  assert.equal(c.pathname, "/b/solicitudes/CB-0001-aaaaaaaa/foto-2.jpg");
});

test("presignPut: la firma coincide con una recomputación independiente de AWS SigV4", async () => {
  const size = 987654;
  const url = new URL(await createR2(ENV).presignPut(KEY, size));
  const q = url.searchParams;
  const datetime = q.get("X-Amz-Date")!;
  const date = datetime.slice(0, 8);
  const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  const query = [...q.entries()].filter(([k]) => k !== "X-Amz-Signature")
    .map(([k, v]) => [enc(k), enc(v)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [
    "PUT",
    "/b/solicitudes/CB-0001-aaaaaaaa/foto-1.jpg",
    query,
    `content-length:${size}\ncontent-type:image/jpeg\nhost:a.r2.cloudflarestorage.com\n`,
    "content-length;content-type;host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const scope = `${date}/auto/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", datetime, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  const h = (k: string | Buffer, m: string) => createHmac("sha256", k).update(m).digest();
  const kSigning = h(h(h(h("AWS4s", date), "auto"), "s3"), "aws4_request");
  assert.equal(q.get("X-Amz-Signature"), createHmac("sha256", kSigning).update(toSign).digest("hex"));
});

// ---- head, firstBytes y remove con un fetch simulado

type Stub = { calls: { method: string; url: string; range: string | null; aborted: () => boolean }[]; restore: () => void };
function stubFetch(handler: (method: string) => Response | Promise<Response>): Stub {
  const real = globalThis.fetch;
  const calls: Stub["calls"] = [];
  globalThis.fetch = (async (input: Request) => {
    calls.push({ method: input.method, url: input.url, range: input.headers.get("range"), aborted: () => input.signal.aborted });
    return handler(input.method);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const status = (s: number, init: ResponseInit = {}, body?: BodyInit) => new Response(body ?? null, { status: s, ...init });

test("head: devuelve el tamaño; 404 es null; cualquier otro estado lanza (no se da por inválida una foto buena)", async () => {
  const r2 = createR2(ENV);
  let s = stubFetch(() => status(200, { headers: { "content-length": "2048" } }));
  try { assert.deepEqual(await r2.head(KEY), { size: 2048 }); } finally { s.restore(); }
  s = stubFetch(() => status(404));
  try { assert.equal(await r2.head(KEY), null); } finally { s.restore(); }
  for (const code of [403, 429, 500, 502, 503]) {
    s = stubFetch(() => status(code));
    try { await assert.rejects(() => r2.head(KEY), new RegExp(String(code)), String(code)); } finally { s.restore(); }
  }
});

test("firstBytes: los 3 primeros bytes; 404 y 416 son null; el resto lanza", async () => {
  const r2 = createR2(ENV);
  let s = stubFetch(() => status(206, {}, new Uint8Array([0xff, 0xd8, 0xff])));
  try {
    assert.deepEqual([...(await r2.firstBytes(KEY))!], [0xff, 0xd8, 0xff]);
    assert.equal(s.calls[0].range, "bytes=0-2");
  } finally { s.restore(); }
  for (const code of [404, 416]) {
    s = stubFetch(() => status(code));
    try { assert.equal(await r2.firstBytes(KEY), null, String(code)); } finally { s.restore(); }
  }
  for (const code of [403, 429, 500, 503]) {
    s = stubFetch(() => status(code));
    try { await assert.rejects(() => r2.firstBytes(KEY), new RegExp(String(code)), String(code)); } finally { s.restore(); }
  }
});

test("retries 0: un 5xx o 429 de R2 hace una sola llamada (por defecto aws4fetch reintenta 10 veces)", async () => {
  const r2 = createR2(ENV);
  for (const code of [500, 503, 429]) {
    const s = stubFetch(() => status(code));
    try {
      await assert.rejects(() => r2.head(KEY));
      assert.equal(s.calls.length, 1, `estado ${code}`);
    } finally { s.restore(); }
  }
});

test("cada llamada a R2 lleva su tiempo máximo: una respuesta colgada se aborta y sube como error", async () => {
  assert.ok(R2_TIMEOUT_MS * 3 * 3 + 8000 < 60_000, "3 fotos x 3 llamadas + receptor caben en los 60 s de la Function");
  const r2 = createR2(ENV, { timeoutMs: 30 });
  const real = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = ((input: Request) => new Promise((_resolve, reject) => {
    input.signal.addEventListener("abort", () => { aborted = true; reject(input.signal.reason); });
  })) as typeof fetch;
  try {
    await assert.rejects(() => r2.head(KEY));
    assert.equal(aborted, true);
  } finally { globalThis.fetch = real; }
});

test("remove es de mejor esfuerzo: si el DELETE falla no descarta las fotos buenas de la solicitud", async () => {
  const r2 = createR2(ENV);
  let s = stubFetch(() => status(204));
  try {
    await r2.remove(KEY);
    assert.equal(s.calls[0].method, "DELETE");
  } finally { s.restore(); }
  for (const code of [403, 500]) {
    s = stubFetch(() => status(code));
    try { await assert.doesNotReject(() => r2.remove(KEY), String(code)); } finally { s.restore(); }
  }
  const real = globalThis.fetch;
  globalThis.fetch = (async () => { throw new TypeError("network"); }) as typeof fetch;
  try { await assert.doesNotReject(() => r2.remove(KEY)); } finally { globalThis.fetch = real; }
});
