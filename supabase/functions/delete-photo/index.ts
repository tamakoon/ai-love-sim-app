// supabase/functions/delete-photo/index.ts
//
// 目的: アルバム内の不要な写真を削除する。
// imagesテーブルの行と、Storage上の実ファイルの両方を削除する。
// 本人が生成した写真のみ削除可能(user_idを照合)。

import { createClient } from "npm:@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { json } from "../_shared/response.ts";
import { resolveUserId } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TEST_BYPASS_TOKEN = Deno.env.get("TEST_BYPASS_TOKEN");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    if (req.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }

    const body = await req.json().catch(() => null);

    const authResult = await resolveUserId(req, body, { SUPABASE_URL, SUPABASE_ANON_KEY, TEST_BYPASS_TOKEN });
    if (authResult.errorResponse) return authResult.errorResponse;
    const userId = authResult.userId as string;

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
