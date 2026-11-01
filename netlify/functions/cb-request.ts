import { handleRequest } from "../lib/handlers.ts";
import { depsFromEnv } from "../lib/env.ts";

export default async (req: Request) => handleRequest(req, depsFromEnv());

export const config = {
  path: "/api/cb-request",
  method: "POST" as const,
  rateLimit: { windowLimit: 5, windowSize: 60, aggregateBy: ["ip", "domain"] as ("ip" | "domain")[] },
};
