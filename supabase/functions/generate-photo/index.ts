// supabase/functions/generate-photo/index.ts
//
// Phase1: 写真生成Edge Function
// - 初回: character_assets.face_reference_paths が空の場合、
//   文章のみからキャラクターの「基準となる顔写真」を生成し、
//   character-reference-assets バケットに保存 + character_assetsに記録する
// - 2回目以降: 保存済みの基準画像を参照画像として渡し、
//   同一人物を保ったまま状況（気分・行動・occasion）に応じた新しい写真を生成する
// - appearance_change が指定されていれば、髪型・髪色の変更も反映する
// - 生成結果は character-photos バケットに保存し、imagesテーブルに記録する
// - レスポンスとして、その場で表示できる期限付き署名URLを返す

import { createClient } from "npm:@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { json } from "../_shared/response.ts";
import { resolveUserId } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const TEST_BYPASS_TOKEN = Deno.env.get("TEST_BYPASS_TOKEN");

const GEMINI_MODEL = "gemini-2.5-flash-image";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const NO_TEXT_OVERLAY_INSTRUCTION =
  "IMPORTANT: Do not include any text, captions, name tags, watermarks, logos, subtitles, or written characters of any kind anywhere in the image. The image must be a plain photo with no overlaid text or UI elements.";

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
    const occasion = body?.occasion ?? null;
    const appearanceChange: string | null = body?.appearance_change ?? null;
    const clothingImageBase64: string | null = body?.clothing_image_base64 ?? null;
    const clothingMimeType: string = body?.clothing_mime_type ?? "image/jpeg";
    const hasClothing = Boolean(clothingImageBase64);
    if (!characterId) return json({ error: "character_id は必須です" }, 400);

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const [{ data: character }, { data: assets }, { data: state }] = await Promise.all([
      db.from("characters").select("*").eq("id", characterId).maybeSingle(),
      db.from("character_assets").select("*").eq("character_id", characterId).maybeSingle(),
      db.from("character_state").select("*").eq("character_id", characterId).maybeSingle(),
    ]);

    if (!character) return json({ error: "character not found" }, 404);

    const faceRefs: string[] = Array.isArray(assets?.face_reference_paths)
      ? assets.face_reference_paths
      : [];
    const hasReference = faceRefs.length > 0;

    if (hasClothing && !hasReference) {
      return json(
        { error: "まだ基準となる顔写真がありません。先に通常の写真を1枚生成してから、服を着せ替えてみてください。" },
        400,
      );
    }

    const contextLine = [
      state?.current_activity ? `現在の行動: ${state.current_activity}` : null,
      state?.current_mood ? `気分: ${state.current_mood}` : null,
      occasion ? `シーン: ${occasion}` : null,
    ]
      .filter(Boolean)
      .join(" / ");

    let promptText: string;
    if (!hasReference) {
      promptText = `
Photorealistic authentic front-camera selfie photo of a young Japanese woman named ${character.name}, ${character.occupation ?? ""}.
Atmosphere: ${character.base_atmosphere ?? "friendly and warm"}.
${assets?.base_generation_prompt ?? ""}
This must look like an actual photo captured by her own smartphone's front-facing camera — NOT a third-person photo of someone taking a selfie.
Choose ONE of these two authentic formats naturally:
(1) Direct front-camera selfie: close-up framing where her face fills much of the frame, slight wide-angle lens distortion typical of phone front cameras, extended-arm perspective, phone barely visible or not visible at all.
(2) Mirror selfie: her reflection in a bathroom or bedroom mirror, phone visibly held up in front of her face in the reflection, casual indoor lighting.
Casual natural expression, soft indoor lighting.
This will be used as a reference photo for a consistent character, so keep the face clearly visible and centered.
${NO_TEXT_OVERLAY_INSTRUCTION}
`.trim();
    } else if (hasClothing) {
      promptText = `
You are given two reference images.
Reference image 1 is a photo of a woman's face and identity — keep her face, identity, and body type exactly the same as reference image 1.
Reference image 2 shows a clothing item.
Generate a new authentic front-camera selfie photo (or mirror selfie) of the same person from reference image 1, now wearing the clothing item shown in reference image 2, naturally fitted to her body and pose.
This must look like an actual photo captured by her own smartphone's front-facing camera or a mirror selfie — NOT a third-person photo of someone taking a selfie.
Additional context to reflect naturally if relevant: ${contextLine || "a casual everyday moment"}.
${appearanceChange ? `Also apply this hairstyle/hair color change while keeping the same face: ${appearanceChange}.` : "Keep her hairstyle and hair color the same as reference image 1."}
${NO_TEXT_OVERLAY_INSTRUCTION}
`.trim();
    } else {
      promptText = `
Using the reference photo, generate a new authentic front-camera selfie photo of the same person (keep the same face and identity).
This must look like an actual photo captured by her own smartphone's front-facing camera — NOT a third-person photo of someone taking a selfie.
Choose ONE of these two authentic formats naturally:
(1) Direct front-camera selfie: close-up framing where her face fills much of the frame, slight wide-angle lens distortion typical of phone front cameras, extended-arm perspective, phone barely visible or not visible at all.
(2) Mirror selfie: her reflection in a bathroom or bedroom mirror, phone visibly held up in front of her face in the reflection.
Change the pose, expression, outfit, and background to naturally match this context: ${contextLine || "a casual everyday moment"}.
${appearanceChange ? `Also apply this hairstyle/hair color change while keeping the same face: ${appearanceChange}.` : "Keep her hairstyle and hair color the same as the reference photo."}
Style: natural everyday phone-camera selfie, not overly posed, soft natural lighting.
${NO_TEXT_OVERLAY_INSTRUCTION}
`.trim();
    }

    const parts: Record<string, unknown>[] = [{ text: promptText }];

    if (hasReference) {
      const refPath = faceRefs[0];
      const { data: refBlob, error: downloadError } = await db.storage
        .from("character-reference-assets")
        .download(refPath);
      if (downloadError || !refBlob) {
        return json({ error: `参照画像の取得に失敗: ${downloadError?.message}` }, 500);
      }
      const refBuffer = await refBlob.arrayBuffer();
      parts.push({
        inlineData: {
          mimeType: "image/png",
          data: arrayBufferToBase64(refBuffer),
        },
      });
    }

    if (hasClothing) {
      parts.push({
        inlineData: {
          mimeType: clothingMimeType,
          data: clothingImageBase64,
        },
      });
    }

    const geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify({ contents: [{ parts }] }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return json({ error: `画像生成API呼び出し失敗: ${errText}` }, 502);
    }

    const geminiJson = await geminiRes.json();
    const resultParts = geminiJson?.candidates?.[0]?.content?.parts ?? [];
    const imagePart = resultParts.find((p: { inlineData?: { data?: string } }) => p.inlineData?.data);

    if (!imagePart) {
      return json({ error: "画像生成結果に画像データが含まれていませんでした", raw: geminiJson }, 502);
    }

    const imageBytes = base64ToUint8Array(imagePart.inlineData.data);
    const imageBlob = new Blob([imageBytes], { type: "image/png" });

    if (!hasReference) {
      const refPath = `${characterId}/face_reference_1.png`;
      const { error: uploadRefError } = await db.storage
        .from("character-reference-assets")
        .upload(refPath, imageBlob, { contentType: "image/png", upsert: true });
      if (uploadRefError) {
        return json({ error: `基準画像の保存に失敗: ${uploadRefError.message}` }, 500);
      }

      await db
        .from("character_assets")
        .update({
          face_reference_paths: [refPath],
          updated_at: new Date().toISOString(),
        })
        .eq("character_id", characterId);
    }

    const photoPath = `${characterId}/${userId}/${Date.now()}.png`;
    const { error: uploadPhotoError } = await db.storage
      .from("character-photos")
      .upload(photoPath, imageBlob, { contentType: "image/png", upsert: false });
    if (uploadPhotoError) {
      return json({ error: `写真の保存に失敗: ${uploadPhotoError.message}` }, 500);
    }

    const { data: imageRow, error: insertError } = await db
      .from("images")
      .insert({
        character_id: characterId,
        user_id: userId,
        storage_path: photoPath,
        taken_context: {
          activity: state?.current_activity ?? null,
          mood: state?.current_mood ?? null,
          occasion,
          appearance_change: appearanceChange,
          is_reference_bootstrap: !hasReference,
          is_clothing_swap: hasClothing,
        },
        generation_status: "completed",
        generated_at: new Date().toISOString(),
        sent_at: new Date().toISOString(),
      })
      .select("*")
      .single();

    if (insertError) {
      return json({ error: `imagesテーブル登録に失敗: ${insertError.message}` }, 500);
    }

    const { data: signedUrlData, error: signedUrlError } = await db.storage
      .from("character-photos")
      .createSignedUrl(photoPath, 3600);

    if (signedUrlError) {
      return json({ error: `署名付きURL発行に失敗: ${signedUrlError.message}` }, 500);
    }

    return json({
      image_id: imageRow.id,
      url: signedUrlData.signedUrl,
      is_reference_bootstrap: !hasReference,
      taken_context: imageRow.taken_context,
    });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
