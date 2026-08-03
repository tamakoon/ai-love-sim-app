// supabase/functions/_shared/cors.ts

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bypass-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
