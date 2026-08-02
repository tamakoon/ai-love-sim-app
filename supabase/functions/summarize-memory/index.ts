// supabase/functions/summarize-memory/index.ts
//
// 目的: 未要約の会話（前回要約以降のmessages）をLLMで要約し、
// memoriesテーブルへ長期記憶として保存する。
// chat-replyから内部的に呼び出される想定（x-internal-secretで認証）。
// 単独でTest画面から呼び出して動作確認することもできる。

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const INTERNAL_SECRET = Deno.env.get("INTERNAL_SECRET");

const MIN_NEW_MESSAGES = 6;
const MAX_MESSAGES_PER_BATCH = 40;

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }

    const receivedSecret = req.headers.get("x-internal-secret");
    if (!INTERNAL_SECRET || receivedSecret !== INTERNAL_SECRET) {
      return json({ error: "unauthorized" }, 401);
    }

    const body = await req.json().catch(() => null);
    const userId = body?.user_id;
    const characterId = body?.character_id;
    if (!userId || !characterId) {
      return json({ error: "user_id, character_id は必須です" }, 400);
    }

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: lastMemory } = await db
      .from("memories")
      .select("source_message_range")
      .eq("user_id", userId)
      .eq("character_id", characterId)
      .eq("memory_type", "long_term")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const lastUntil: string | null = lastMemory?.source_message_range?.until ?? null;

    let query = db
      .from("messages")
      .select("id, role, content, created_at")
      .eq("user_id", userId)
      .eq("character_id", characterId)
      .order("created_at", { ascending: true })
      .limit(MAX_MESSAGES_PER_BATCH);

    if (lastUntil) {
      query = query.gt("created_at", lastUntil);
    }

    const { data: newMessages, error: msgError } = await query;
    if (msgError) return json({ error: msgError.message }, 500);

    if (!newMessages || newMessages.length < MIN_NEW_MESSAGES) {
      return json({ skipped: true, reason: "not enough new messages", new_message_count: newMessages?.length ?? 0 });
    }

    const conversationText = newMessages
      .map((m: { role: string; content: string }) => `${m.role === "user" ? "プレイヤー" : "キャラクター"}: ${m.content}`)
      .join("\n");

    const summarizePrompt = `
以下はプレイヤーとキャラクターの会話ログです。この中から、将来の会話で覚えておくと自然な「重要な情報」を最大3件抽出してください。
好み・約束・記念日・重要な出来事・感情の動きなど、後で参照する価値があるものだけを抽出し、瑣末な世間話は無視してください。
該当する情報が無ければ空配列を返してください。

会話ログ:
${conversationText}

必ず以下のJSON配列形式のみで出力してください。前置き・説明文は不要です。
[{"category": "preference" | "promise" | "anniversary" | "past_conversation" | "emotion" | "other", "summary_text": "簡潔な日本語の要約(1〜2文)", "importance": 1から5の整数}]
`.trim();

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 600,
        messages: [{ role: "user", content: summarizePrompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return json({ error: `LLM呼び出し失敗: ${errText}` }, 502);
    }

    const anthropicJson = await anthropicRes.json();
    const rawText = (anthropicJson.content ?? [])
      .map((block: { type: string; text?: string }) => (block.type === "text" ? block.text ?? "" : ""))
      .join("");

    let items: { category: string; summary_text: string; importance: number }[] = [];
    try {
      items = JSON.parse(rawText);
      if (!Array.isArray(items)) items = [];
    } catch {
      items = [];
    }

    const firstMsgTime = newMessages[0].created_at;
    const lastMsgTime = newMessages[newMessages.length - 1].created_at;
    const validCategories = ["preference", "promise", "anniversary", "past_conversation", "emotion", "other"];

    const rowsToInsert = items
      .filter((it) => it && typeof it.summary_text === "string" && it.summary_text.trim().length > 0)
      .slice(0, 3)
      .map((it) => ({
        character_id: characterId,
        user_id: userId,
        memory_type: "long_term",
        memory_category: validCategories.includes(it.category) ? it.category : "other",
        summary_text: it.summary_text.trim(),
        importance: Number.isInteger(it.importance) ? Math.max(1, Math.min(5, it.importance)) : 3,
        source_message_range: { from: firstMsgTime, until: lastMsgTime },
        occurred_at: lastMsgTime,
      }));

    if (rowsToInsert.length === 0) {
      await db.from("memories").insert({
        character_id: characterId,
        user_id: userId,
        memory_type: "long_term",
        memory_category: "other",
        summary_text: "(この期間に特筆すべき情報はありませんでした)",
        importance: 1,
        source_message_range: { from: firstMsgTime, until: lastMsgTime },
        occurred_at: lastMsgTime,
      });
      return json({ inserted_count: 0, note: "no notable content, range advanced" });
    }

    const { error: insertError } = await db.from("memories").insert(rowsToInsert);
    if (insertError) return json({ error: insertError.message }, 500);

    return json({ inserted_count: rowsToInsert.length, items: rowsToInsert });
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
