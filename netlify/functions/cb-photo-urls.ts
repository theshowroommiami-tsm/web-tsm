import { handlePhotoUrls } from "../lib/handlers.ts";
import { depsFromEnv } from "../lib/env.ts";

export default async (req: Request) => handlePhotoUrls(req, depsFromEnv());

export const config = {
  path: "/api/cb-photo-urls",
  method: "POST" as const,
  rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ["ip", "domain"] as ("ip" | "domain")[] },
};
