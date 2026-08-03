// supabase/functions/set-character-reference/index.ts
//
// 目的: キャラクターの「基準となる顔画像」を変更する。
// - use_original: true の場合、作成時の元の基準画像に戻す
// - image_id が指定された場合、アルバム内のその写真を新しい基準画像にする
//   (character-photos バケットから character-reference-assets バケットへコピーする)

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

    const characterId = body?.character_id;
    const useOriginal = Boolean(body?.use_original);
    const imageId = body?.image_id ?? null;

    if (!characterId) return json({ error: "character_id は必須です" }, 400);
    if (!useOriginal && !imageId) {
      return json({ error: "use_original か image_id のどちらかを指定してください" }, 400);
    }

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: assets, error: assetsError } = await db
      .from("character_assets")
      .select("*")
      .eq("character_id", characterId)
      .maybeSingle();

    if (assetsError) return json({ error: assetsError.message }, 500);
    if (!assets) return json({ error: "character_assets が見つかりません" }, 404);

    let newReferencePath: string;

    if (useOriginal) {
      if (!assets.original_face_reference_path) {
        return json({ error: "元の基準画像が記録されていません" }, 400);
      }
      newReferencePath = assets.original_face_reference_path;
    } else {
      const { data: imageRow, error: imageError } = await db
        .from("images")
        .select("id, user_id, character_id, storage_path")
        .eq("id", imageId)
        .maybeSingle();

      if (imageError) return json({ error: imageError.message }, 500);
      if (!imageRow) return json({ error: "写真が見つかりません" }, 404);
      if (imageRow.user_id !== userId || imageRow.character_id !== characterId) {
        return json({ error: "この写真を基準画像にする権限がありません" }, 403);
      }

      const { data: photoBlob, error: downloadError } = await db.storage
        .from("character-photos")
        .download(imageRow.storage_path);
      if (downloadError || !photoBlob) {
        return json({ error: `写真の取得に失敗: ${downloadError?.message}` }, 500);
      }

      newReferencePath = `${characterId}/face_reference_${Date.now()}.png`;
      const { error: uploadError } = await db.storage
        .from("character-reference-assets")
        .upload(newReferencePath, photoBlob, { contentType: "image/png", upsert: true });
      if (uploadError) {
        return json({ error: `基準画像の保存に失敗: ${uploadError.message}` }, 500);
      }
    }

    const { error: updateError } = await db
      .from("character_assets")
      .update({
        face_reference_paths: [newReferencePath],
        updated_at: new Date().toISOString(),
      })
      .eq("character_id", characterId);

    if (updateError) return json({ error: updateError.message }, 500);

    return json({ success: true, reference_path: newReferencePath });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
