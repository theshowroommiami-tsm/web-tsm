# web-tsm — showroommiami.com

Sitio web de The Showroom Miami. React, Vite, TypeScript, Tailwind y Supabase, desplegado en Netlify.
Las reglas del repositorio están en `CLAUDE.md`; la gobernanza, en `theshowroommiami-tsm/gobernanza-tsm`.

## Comandos

```sh
npm run dev      # servidor de desarrollo
npm run build    # cliente, servidor y prerender
npm run lint
npm test         # pruebas unitarias de Custom Builds (node:test, Node 22.6 o superior)
```

## Custom Builds (TRD-049)

- Formulario: `src/components/custom-builds/EstimateForm.tsx`, en `/custom-builds`.
- Esquema compartido por el navegador y las Functions: `shared/cb-schema.ts`.
- Netlify Functions: `netlify/functions/cb-request.ts`, `cb-photo-urls.ts` y `cb-photos-done.ts`
  (lógica en `netlify/lib/`). Requieren `aws4fetch`.
- Receptor temporal (Apps Script): `receptor/apps-script/Code.gs`. Contrato en
  gobernanza-tsm, `docs/satelites/web-tsm/anexos/web-01-receptor-custom-builds.md`.
- Variables de entorno: ver §6 del contrato. Los valores no se versionan.
