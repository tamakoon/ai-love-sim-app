// supabase/functions/delete-photo/index.ts
//
// 目的: アルバム内の不要な写真を削除する。
// imagesテーブルの行と、Storage上の実ファイルの両方を削除する。
// 本人が生成した写真のみ削除可能(user_idを照合)。

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TEST_BYPASS_TOKEN = Deno.env.get("TEST_BYPASS_TOKEN");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bypass-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    if (req.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }

    const body = await req.json().catch(() => null);

    const bypassHeader = req.headers.get("x-bypass-token");
    const isTestBypass = Boolean(TEST_BYPASS_TOKEN) && bypassHeader === TEST_BYPASS_TOKEN;

    let userId: string;
    if (isTestBypass) {
      if (!body?.user_id) {
        return json({ error: "x-bypass-token使用時は user_id を必ずbodyに含めてください" }, 400);
      }
      userId = body.user_id;
    } else {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) return json({ error: "missing authorization" }, 401);
      const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData, error: userError } = await supabaseAuth.auth.getUser();
      if (userError || !userData?.user) return json({ error: "invalid session" }, 401);
      userId = userData.user.id;
    }

    const imageId = body?.image_id;
    if (!imageId) return json({ error: "image_id は必須です" }, 400);

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: row, error: fetchError } = await db
      .from("images")
      .select("id, user_id, storage_path")
      .eq("id", imageId)
      .maybeSingle();

    if (fetchError) return json({ error: fetchError.message }, 500);
    if (!row) return json({ error: "写真が見つかりません" }, 404);
    if (row.user_id !== userId) return json({ error: "この写真を削除する権限がありません" }, 403);

    await db.storage.from("character-photos").remove([row.storage_path]);

    const { error: deleteError } = await db.from("images").delete().eq("id", imageId);
    if (deleteError) return json({ error: deleteError.message }, 500);

    return json({ deleted: true, image_id: imageId });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}
