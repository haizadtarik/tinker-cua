import 'dotenv/config';
import { z } from 'zod';
const int = (fallback: number, max: number) => z.coerce.number().int().min(1).max(max).default(fallback);
export const config = z.object({
  OPENAI_MODEL: z.string().min(1).default('gpt-6-astra'),
  PORT: int(4317, 65535), MAX_ACTIONS: int(160, 500), MAX_RUNTIME_MS: int(720000, 1800000),
  MAX_TURNS: int(90, 200), API_TIMEOUT_MS: int(60000, 180000),
  BROWSER_CHANNEL: z.enum(['chrome', 'chromium']).default('chrome'),
}).parse(process.env);
