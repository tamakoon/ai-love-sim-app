// supabase/functions/list-photos/index.ts
//
// Phase1: 過去に生成した写真の一覧を、表示用の署名付きURL付きで返す

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
    if (!characterId) return json({ error: "character_id は必須です" }, 400);

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: rows, error } = await db
      .from("images")
      .select("*")
      .eq("user_id", userId)
      .eq("character_id", characterId)
      .eq("is_saved_to_album", true)
      .order("generated_at", { ascending: false })
      .limit(50);

    if (error) return json({ error: error.message }, 500);

    const photos = await Promise.all(
      (rows ?? []).map(async (row: { id: string; storage_path: string; taken_context: unknown; generated_at: string }) => {
        const { data: signed } = await db.storage
          .from("character-photos")
          .createSignedUrl(row.storage_path, 3600);
        return {
          id: row.id,
          url: signed?.signedUrl ?? null,
          taken_context: row.taken_context,
          generated_at: row.generated_at,
        };
      }),
    );

    return json({ photos });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
