import { handleRequest } from "../lib/handlers.ts";
import { depsFromEnv } from "../lib/env.ts";

// context.deploy.context: contexto del despliegue (production, deploy-preview...). CB_ENTORNO no puede contradecirlo.
export default async (req: Request, context?: { deploy?: { context?: string } }) =>
  handleRequest(req, depsFromEnv(context?.deploy?.context));

export const config = {
  path: "/api/cb-request",
  method: "POST" as const,
  rateLimit: { windowLimit: 5, windowSize: 60, aggregateBy: ["ip", "domain"] as ("ip" | "domain")[] },
};
