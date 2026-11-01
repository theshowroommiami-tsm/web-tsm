import { handlePhotosDone } from "../lib/handlers.ts";
import { depsFromEnv } from "../lib/env.ts";

// context.deploy.context: contexto del despliegue (production, deploy-preview...). CB_ENTORNO no puede contradecirlo.
export default async (req: Request, context?: { deploy?: { context?: string } }) =>
  handlePhotosDone(req, depsFromEnv(context?.deploy?.context));

export const config = {
  path: "/api/cb-photos-done",
  method: "POST" as const,
  rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ["ip", "domain"] as ("ip" | "domain")[] },
};
