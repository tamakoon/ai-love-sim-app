// supabase/functions/delete-character/index.ts
//
// 目的: キャラクターを完全に削除する。
// DB側は characters テーブルへの外部キーが ON DELETE CASCADE になっているため、
// characters行を削除するだけで character_personality / character_assets /
// character_state / user_character_settings / relationships /
// relationship_parameters / messages / memories / images が連動して削除される。
// Storage上の画像ファイル(顔参照画像・生成写真)はDBのcascadeでは消えないため、
// ここで明示的に削除する。

import { createClient } from "npm:@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { json } from "../_shared/response.ts";

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

    const bypassHeader = req.headers.get("x-bypass-token");
    const isTestBypass = Boolean(TEST_BYPASS_TOKEN) && bypassHeader === TEST_BYPASS_TOKEN;

    if (!isTestBypass) {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) return json({ error: "missing authorization" }, 401);
      const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData, error: userError } = await supabaseAuth.auth.getUser();
      if (userError || !userData?.user) return json({ error: "invalid session" }, 401);
    }

    const characterId = body?.character_id;
    if (!characterId) return json({ error: "character_id は必須です" }, 400);

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: character, error: fetchError } = await db
      .from("characters")
      .select("id, name")
      .eq("id", characterId)
      .maybeSingle();

    if (fetchError) return json({ error: fetchError.message }, 500);
    if (!character) return json({ error: "キャラクターが見つかりません" }, 404);

    await removeAllUnderPrefix(db, "character-reference-assets", `${characterId}`);
    await removeAllUnderPrefix(db, "character-photos", `${characterId}`);

    const { error: deleteError } = await db.from("characters").delete().eq("id", characterId);
    if (deleteError) return json({ error: deleteError.message }, 500);

    return json({ deleted: true, character_id: characterId, name: character.name });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});

async function removeAllUnderPrefix(
  db: ReturnType<typeof createClient>,
  bucket: string,
  prefix: string,
) {
  const { data: entries } = await db.storage.from(bucket).list(prefix);
  if (!entries || entries.length === 0) return;

  const filePaths: string[] = [];
  for (const entry of entries) {
    if (entry.id === null) {
      const { data: subEntries } = await db.storage.from(bucket).list(`${prefix}/${entry.name}`);
      (subEntries ?? []).forEach((sub) => {
        filePaths.push(`${prefix}/${entry.name}/${sub.name}`);
      });
    } else {
      filePaths.push(`${prefix}/${entry.name}`);
    }
  }

  if (filePaths.length > 0) {
    await db.storage.from(bucket).remove(filePaths);
  }
}
