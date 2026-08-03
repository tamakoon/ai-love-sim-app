// supabase/functions/chat-reply/index.ts

import { createClient } from "npm:@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { json } from "../_shared/response.ts";
import { resolveUserId } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const TEST_BYPASS_TOKEN = Deno.env.get("TEST_BYPASS_TOKEN");
const INTERNAL_SECRET = Deno.env.get("INTERNAL_SECRET");

const HISTORY_LIMIT = 20;
const MEMORY_LIMIT = 5;
const SUMMARIZE_EVERY_N_MESSAGES = 20;

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
    const channel = body?.channel;
    const messageText = body?.message_text;

    if (!characterId || !channel || !messageText) {
      return json({ error: "character_id, channel, message_text は必須です" }, 400);
    }
    if (!["store", "line", "date", "event"].includes(channel)) {
      return json({ error: "invalid channel" }, 400);
    }

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const [
      { data: character },
      { data: personalityRows },
      { data: state },
      { data: relationshipRow },
      { data: historyRows },
      { data: memoryRows },
    ] = await Promise.all([
      db.from("characters").select("*").eq("id", characterId).maybeSingle(),
      db
        .from("character_personality")
        .select("trait_key, trait_value")
        .eq("character_id", characterId),
      db.from("character_state").select("*").eq("character_id", characterId).maybeSingle(),
      db
        .from("relationships")
        .select("*, relationship_parameters(*)")
        .eq("user_id", userId)
        .eq("character_id", characterId)
        .maybeSingle(),
      db
        .from("messages")
        .select("role, content")
        .eq("user_id", userId)
        .eq("character_id", characterId)
        .order("created_at", { ascending: false })
        .limit(HISTORY_LIMIT),
      db
        .from("memories")
        .select("summary_text, importance")
        .eq("user_id", userId)
        .eq("character_id", characterId)
        .eq("memory_type", "long_term")
        .order("importance", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(MEMORY_LIMIT),
    ]);

    if (!character) return json({ error: "character not found" }, 404);

    let rel = relationshipRow;
    if (!rel) {
      const { data: newRel, error: relErr } = await db
        .from("relationships")
        .insert({ user_id: userId, character_id: characterId })
        .select("*")
        .single();
      if (relErr) return json({ error: relErr.message }, 500);

      const { data: newParams, error: paramErr } = await db
        .from("relationship_parameters")
        .insert({ relationship_id: newRel.id })
        .select("*")
        .single();
      if (paramErr) return json({ error: paramErr.message }, 500);

      rel = { ...newRel, relationship_parameters: [newParams] };
    }

    const params = Array.isArray(rel.relationship_parameters)
      ? rel.relationship_parameters[0]
      : rel.relationship_parameters;

    const history = (historyRows ?? []).slice().reverse();

    const personalityText = (personalityRows ?? [])
      .map((p: { trait_key: string; trait_value: string }) => `- ${p.trait_key}: ${p.trait_value}`)
      .join("\n");

    const memoryText = (memoryRows ?? [])
      .map((m: { summary_text: string }) => `- ${m.summary_text}`)
      .join("\n");

    const systemPrompt = `
あなたは恋愛ライフシミュレーションゲームのキャラクター「${character.name}」として振る舞います。

【人格】
${personalityText || "（未設定）"}

【覚えていること（過去の会話からの記憶）】
${memoryText || "（まだ特筆すべき記憶はありません）"}

【現在の関係性】
ステージ: ${rel.stage}
好意: ${params.affection}/100
信頼: ${params.trust}/100
恋愛感情: ${params.romance}/100
親密度: ${params.intimacy}/100
現在の気分: ${params.current_mood ?? "普通"}

【現在の状況】
現在の行動: ${state?.current_activity ?? "不明"}
気分: ${state?.current_mood ?? "普通"}

【チャネル】
${channel}（storeなら対面口調、lineなら親しみやすい短文中心）

【重要な制約】
関係性ステージ「${rel.stage}」にふさわしい距離感を保つこと。
現在のパラメータを大きく飛び越えるような急な態度変化はしないこと。

【出力形式】
必ず以下のJSON形式のみを出力してください。前置き、説明文、Markdownのコードブロック(\`\`\`)は一切付けないでください。

{"reply": "キャラクターとしての返答テキスト", "emotion_delta": {"affection": -5から5の整数, "trust": -5から5の整数, "romance": -5から5の整数, "intimacy": -5から5の整数}, "mood": "会話後の気分を表す短い単語"}
`.trim();

    const historyMessages = history.map((m: { role: string; content: string }) => ({
      role: m.role === "character" ? "assistant" : "user",
      content: m.content,
    }));

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 800,
        system: systemPrompt,
        messages: [...historyMessages, { role: "user", content: messageText }],
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

    let parsed: {
      reply: string;
      emotion_delta: { affection: number; trust: number; romance: number; intimacy: number };
      mood: string;
    };
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = {
        reply: rawText || "……ごめん、今ちょっとうまく言葉が出てこないや。",
        emotion_delta: { affection: 0, trust: 0, romance: 0, intimacy: 0 },
        mood: params.current_mood ?? "普通",
      };
    }

    const ruleDelta = computeRuleBasedDelta(messageText);

    const finalDelta = {
      affection: clip((ruleDelta.affection + (parsed.emotion_delta?.affection ?? 0)) / 2),
      trust: clip((ruleDelta.trust + (parsed.emotion_delta?.trust ?? 0)) / 2),
      romance: clip((ruleDelta.romance + (parsed.emotion_delta?.romance ?? 0)) / 2),
      intimacy: clip((ruleDelta.intimacy + (parsed.emotion_delta?.intimacy ?? 0)) / 2),
    };

    const updatedParams = {
      affection: clampScore(params.affection + finalDelta.affection),
      trust: clampScore(params.trust + finalDelta.trust),
      romance: clampScore(params.romance + finalDelta.romance),
      intimacy: clampScore(params.intimacy + finalDelta.intimacy),
      current_mood: parsed.mood ?? params.current_mood,
      updated_at: new Date().toISOString(),
    };

    const userMessageResult = await db.from("messages").insert({
      user_id: userId,
      character_id: characterId,
      channel,
      role: "user",
      content: messageText,
      metadata: {},
    });

    const [characterMessageResult, paramsUpdateResult, relUpdateResult] = await Promise.all([
      db.from("messages").insert({
        user_id: userId,
        character_id: characterId,
        channel,
        role: "character",
        content: parsed.reply,
        metadata: { emotion_delta: finalDelta, model: "claude-sonnet-5" },
      }),
      db.from("relationship_parameters").update(updatedParams).eq("relationship_id", rel.id),
      db
        .from("relationships")
        .update({
          last_interaction_at: new Date().toISOString(),
          visit_count: (rel.visit_count ?? 0) + 1,
        })
        .eq("id", rel.id),
    ]);

    const writeErrors = [
      userMessageResult.error && { step: "messages.insert(user)", message: userMessageResult.error.message },
      characterMessageResult.error && { step: "messages.insert(character)", message: characterMessageResult.error.message },
      paramsUpdateResult.error && { step: "relationship_parameters.update", message: paramsUpdateResult.error.message },
      relUpdateResult.error && { step: "relationships.update", message: relUpdateResult.error.message },
    ].filter(Boolean);

    if (writeErrors.length > 0) {
      console.error("chat-reply DB書き込みエラー:", writeErrors);
      return json({ error: "DB書き込みに失敗しました", details: writeErrors }, 500);
    }

    if (INTERNAL_SECRET) {
      const { count: totalCount } = await db
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("character_id", characterId);

      if (totalCount && totalCount % SUMMARIZE_EVERY_N_MESSAGES === 0) {
        const summarizeTask = fetch(`${SUPABASE_URL}/functions/v1/summarize-memory`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-secret": INTERNAL_SECRET },
          body: JSON.stringify({ user_id: userId, character_id: characterId }),
        }).catch((e) => console.error("summarize-memory呼び出し失敗:", e));

        const edgeRuntime = (globalThis as any).EdgeRuntime;
        if (edgeRuntime?.waitUntil) {
          edgeRuntime.waitUntil(summarizeTask);
        }
      }
    }

    return json({
      reply: parsed.reply,
      stage: rel.stage,
      parameters: updatedParams,
    });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});

function computeRuleBasedDelta(messageText: string) {
  const base = messageText.length > 5 ? 1 : 0;
  return { affection: base, trust: 0, romance: 0, intimacy: base };
}

function clip(value: number) {
  const rounded = Math.round(value);
  return Math.max(-5, Math.min(5, rounded));
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}
