import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(9898),
  API_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  DATA_DIR: z.string().default("./data"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  SONARR_URL: z.url().optional(),
  SONARR_API_KEY: z.string().min(1).optional(),
  RADARR_URL: z.url().optional(),
  RADARR_API_KEY: z.string().min(1).optional(),
  PROWLARR_URL: z.url().optional(),
  PROWLARR_API_KEY: z.string().min(1).optional(),

  APP_API_KEY: z.string().min(16).optional(),

  AIBOX_URL: z.url().optional(),
  SEARXNG_URL: z.url().optional(),
  PI_INFERENCE_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.message}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === "production" && !env.APP_API_KEY) {
    // Huntarr died by shipping unauthenticated. We refuse to.
    throw new Error(
      "APP_API_KEY is required in production. Set it (>=16 chars) — there is no way to disable auth.",
    );
  }
  return env;
}
