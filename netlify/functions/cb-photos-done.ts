import { handlePhotosDone } from "../lib/handlers.ts";
import { depsForRequest } from "../lib/env.ts";

// CB_ENTORNO no puede contradecir el contexto del despliegue (context.deploy.context) ni el anfitrión de la petición.
export default async (req: Request, context?: { deploy?: { context?: string } }) =>
  handlePhotosDone(req, depsForRequest(req, context));

export const config = {
  path: "/api/cb-photos-done",
  method: "POST" as const,
  rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ["ip", "domain"] as ("ip" | "domain")[] },
};
