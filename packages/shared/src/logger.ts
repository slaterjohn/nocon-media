import pino from "pino";
import { redactUrl } from "./redact.js";

export function createLogger(name: string, level = process.env.LOG_LEVEL ?? "info") {
  return pino({
    name,
    level,
    redact: { paths: ["password", "*.password", "req.headers.cookie", "req.headers.authorization", "token", "*.token"], censor: "***" },
    serializers: {
      req: (req: { method?: string; url?: string; ip?: string }) => ({ method: req.method, url: redactUrl(req.url ?? ""), ip: req.ip }),
    },
  });
}
export type Logger = ReturnType<typeof createLogger>;
