// supabase/functions/_shared/response.ts

import { CORS_HEADERS } from "./cors.ts";

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}
