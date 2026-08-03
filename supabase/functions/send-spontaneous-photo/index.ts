// supabase/functions/send-spontaneous-photo/index.ts
//
// 目的: プレイヤーが要求していなくても、キャラクターから自発的に写真を送る。
// pg_cronから1日数回呼び出される想定(x-cron-secretで認証)。
// 1. 通知が有効な user_character_settings の組み合わせごとに generate-photo を内部呼び出し
// 2. 生成された写真の taken_context に spontaneous: true を記録
// 3. その利用者のpush_subscriptions全てにWeb Push通知を送信

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET");
const TEST_BYPASS_TOKEN = Deno.env.get("TEST_BYPASS_TOKEN");

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT")!;

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }

    const receivedSecret = req.headers.get("x-cron-secret");
    if (!CRON_SECRET || receivedSecret !== CRON_SECRET) {
      return json({ error: "unauthorized" }, 401);
    }

    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: settingsRows, error: settingsError } = await db
      .from("user_character_settings")
      .select("user_id, character_id")
      .eq("notification_enabled", true);

    if (settingsError) return json({ error: settingsError.message }, 500);

    const results: Record<string, unknown>[] = [];

    for (const row of settingsRows ?? []) {
      const entry: Record<string, unknown> = { user_id: row.user_id, character_id: row.character_id };
      try {
        const genRes = await fetch(`${SUPABASE_URL}/functions/v1/generate-photo`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-bypass-token": TEST_BYPASS_TOKEN ?? "" },
          body: JSON.stringify({ user_id: row.user_id, character_id: row.character_id }),
        });
        const genData = await genRes.json();

        if (!genRes.ok) {
          entry.error = `写真生成失敗: ${genData.error}`;
          results.push(entry);
          continue;
        }

        if (genData.image_id) {
          await db
            .from("images")
            .update({ taken_context: { ...(genData.taken_context ?? {}), spontaneous: true } })
            .eq("id", genData.image_id);
        }

        const { data: character } = await db
          .from("characters")
          .select("name")
          .eq("id", row.character_id)
          .maybeSingle();

        const { data: subs } = await db
          .from("push_subscriptions")
          .select("*")
          .eq("user_id", row.user_id);

        let sentCount = 0;
        for (const sub of subs ?? []) {
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              JSON.stringify({
                title: `${character?.name ?? "キャラクター"}から写真が届きました`,
                body: "アプリを開いて確認してみましょう",
                url: "./",
              }),
            );
            sentCount++;
          } catch (pushErr) {
            const statusCode = (pushErr as { statusCode?: number })?.statusCode;
            if (statusCode === 404 || statusCode === 410) {
              await db.from("push_subscriptions").delete().eq("id", sub.id);
            }
            console.error("push送信失敗:", pushErr);
          }
        }

        entry.photo_generated = true;
        entry.notifications_sent = sentCount;
        results.push(entry);
      } catch (e) {
        entry.error = String(e);
        results.push(entry);
      }
    }

    return json({ processed: results.length, results });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
