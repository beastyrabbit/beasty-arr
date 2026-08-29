import { z } from "zod";

const externalArrUrl = z.url().refine(
  (value) => {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  },
  {
    message: "must be an http(s) base URL without credentials, query parameters, or a fragment",
  },
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(9898),
  API_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  DATA_DIR: z.string().default("./data"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  SONARR_URL: z.url().optional(),
  SONARR_EXTERNAL_URL: externalArrUrl.optional(),
  SONARR_API_KEY: z.string().min(1).optional(),
  RADARR_URL: z.url().optional(),
  RADARR_EXTERNAL_URL: externalArrUrl.optional(),
  RADARR_API_KEY: z.string().min(1).optional(),
  PROWLARR_URL: z.url().optional(),
  PROWLARR_API_KEY: z.string().min(1).optional(),

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
  return parsed.data;
}
