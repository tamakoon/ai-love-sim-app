// supabase/functions/_shared/auth.ts
//
// x-bypass-tokenによるテスト用認証迂回、またはSupabase AuthのJWTから
// userIdを解決する。クライアント向けの各Edge Functionで共通して使う。

import { createClient } from "npm:@supabase/supabase-js@2";
import { json } from "./response.ts";

export async function resolveUserId(
  req: Request,
  body: { user_id?: string } | null,
  env: { SUPABASE_URL: string; SUPABASE_ANON_KEY: string; TEST_BYPASS_TOKEN?: string },
): Promise<{ userId: string | null; errorResponse: Response | null }> {
  const bypassHeader = req.headers.get("x-bypass-token");
  const isTestBypass = Boolean(env.TEST_BYPASS_TOKEN) && bypassHeader === env.TEST_BYPASS_TOKEN;

  if (isTestBypass) {
    if (!body?.user_id) {
      return {
        userId: null,
        errorResponse: json({ error: "x-bypass-token使用時は user_id を必ずbodyに含めてください" }, 400),
      };
    }
    return { userId: body.user_id, errorResponse: null };
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return { userId: null, errorResponse: json({ error: "missing authorization" }, 401) };
  }

  const supabaseAuth = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await supabaseAuth.auth.getUser();
  if (userError || !userData?.user) {
    return { userId: null, errorResponse: json({ error: "invalid session" }, 401) };
  }
  return { userId: userData.user.id, errorResponse: null };
}
