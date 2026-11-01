import { handlePhotosDone } from "../lib/handlers.ts";
import { depsFromEnv } from "../lib/env.ts";

export default async (req: Request) => handlePhotosDone(req, depsFromEnv());

export const config = {
  path: "/api/cb-photos-done",
  method: "POST" as const,
  rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ["ip", "domain"] as ("ip" | "domain")[] },
};
