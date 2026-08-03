// supabase/functions/create-character/index.ts
//
// 目的: ユーザーがアップロードした顔画像を基準画像として、
// 新しいキャラクター一式(characters, character_personality,
// character_assets, character_state, user_character_settings)を作成する。
// 画像はAI生成ではなく実在人物の写真である可能性を考慮し、
// 「既存の顔画像をそのまま基準画像として使う」用途に限定する
// (テキストからの新規顔生成はgenerate-photo側が担当)。

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

    const name: string = body?.name;
    const gender: string | null = body?.gender ?? null;
    const occupation: string | null = body?.occupation ?? null;
    const baseAtmosphere: string | null = body?.base_atmosphere ?? null;
    const personalityTraits: { trait_key: string; trait_value: string }[] = Array.isArray(body?.personality_traits)
      ? body.personality_traits
      : [];
    const faceImageBase64: string | null = body?.face_image_base64 ?? null;
    const faceImageMimeType: string = body?.face_image_mime_type ?? "image/jpeg";

    if (!name) return json({ error: "name は必須です" }, 400);
    if (!faceImageBase64) return json({ error: "face_image_base64 は必須です" }, 400);

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: character, error: charError } = await db
      .from("characters")
      .insert({
        name,
        gender,
        occupation,
        base_atmosphere: baseAtmosphere,
        is_romanceable: true,
        status: "active",
        timezone: "Asia/Tokyo",
        daily_photo_target: 1,
      })
      .select("*")
      .single();

    if (charError) return json({ error: `characters作成失敗: ${charError.message}` }, 500);

    const characterId = character.id;

    if (personalityTraits.length > 0) {
      const rows = personalityTraits
        .filter((t) => t?.trait_key && t?.trait_value)
        .map((t) => ({ character_id: characterId, trait_key: t.trait_key, trait_value: t.trait_value }));
      if (rows.length > 0) {
        const { error: personalityError } = await db.from("character_personality").insert(rows);
        if (personalityError) {
          return json({ error: `character_personality作成失敗: ${personalityError.message}` }, 500);
        }
      }
    }

    const imageBytes = base64ToUint8Array(faceImageBase64);
    const imageBlob = new Blob([imageBytes], { type: faceImageMimeType });
    const refPath = `${characterId}/face_reference_1.png`;

    const { error: uploadError } = await db.storage
      .from("character-reference-assets")
      .upload(refPath, imageBlob, { contentType: faceImageMimeType, upsert: true });

    if (uploadError) {
      return json({ error: `画像アップロード失敗: ${uploadError.message}` }, 500);
    }

    const { error: assetsError } = await db.from("character_assets").insert({
      character_id: characterId,
      face_reference_paths: [refPath],
      base_generation_prompt: baseAtmosphere ?? "",
    });
    if (assetsError) {
      return json({ error: `character_assets作成失敗: ${assetsError.message}` }, 500);
    }

    await db.from("character_state").insert({
      character_id: characterId,
      current_activity: null,
      current_mood: "普通",
    });

    await db.from("user_character_settings").insert({
      user_id: userId,
      character_id: characterId,
      notification_enabled: true,
      is_favorite: false,
    });

    return json({ character_id: characterId, name: character.name });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
