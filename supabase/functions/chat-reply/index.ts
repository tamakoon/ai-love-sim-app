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
季節: ${getJapaneseSeasonDescriptor(character.timezone)}(服装や体感を聞かれたら、この季節にふさわしい自然な返答をすること)

【チャネル】
${channel}（storeなら対面口調、lineなら親しみやすい短文中心）

【重要な制約】
関係性ステージ「${rel.stage}」にふさわしい距離感を保つこと。
現在のパラメータを大きく飛び越えるような急な態度変化はしないこと。

【emotion_deltaの判断基準】
- affection(好意): 親切な言葉、共感、褒め言葉があれば+1〜3。冷たい対応や無関心な発言には-1〜3。
- trust(信頼): 悩みや弱みを話した相手に寄り添った返答をした場合、約束や気遣いが感じられた場合は+1〜3。適当にあしらわれたと感じる場合は-1〜3。
- romance(恋愛感情): デートに誘う、好意をはっきり伝える、二人の関係性について踏み込んだ発言など「恋愛的な進展」がある場合は積極的に+2〜4。ただの日常会話や世間話ではそもそも0のままで問題ない。
- intimacy(親密度): 個人的な話題(趣味・過去・悩みなど)を共有した場合や会話が弾んだ場合に+1〜3。
これらはあくまで目安であり、会話の文脈が自然に感じられる範囲で判断すること。0のままでよい場合は無理に加点しないこと。

【出力形式】
必ず以下のJSON形式のみを出力してください。前置き、説明文、Markdownのコードブロック(\`\`\`)は一切付けないでください。

{"reply": "キャラクターとしての返答テキスト", "emotion_delta": {"affection": -5から5の整数, "trust": -5から5の整数, "romance": -5から5の整数, "intimacy": -5から5の整数}, "mood": "会話後の気分を表す短い単語", "outfit_mentioned": "この返答の中で今着ている服について具体的に言及した場合はその服装を日本語で簡潔に(例: 薄手の半袖パジャマ)。言及していなければnull"}
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
      outfit_mentioned?: string | null;
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
      // affection/intimacyはルールベースの加点も意味があるため平均を取る
      affection: clip((ruleDelta.affection + (parsed.emotion_delta?.affection ?? 0)) / 2),
      intimacy: clip((ruleDelta.intimacy + (parsed.emotion_delta?.intimacy ?? 0)) / 2),
      // trust/romanceはルールベース側が常に0のため、平均を取ると毎回半減してしまう。
      // AIの判断値をそのまま(クリップのみ)使う。
      trust: clip(parsed.emotion_delta?.trust ?? 0),
      romance: clip(parsed.emotion_delta?.romance ?? 0),
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

    if (parsed.outfit_mentioned && typeof parsed.outfit_mentioned === "string") {
      await db
        .from("character_state")
        .update({
          current_outfit_description: parsed.outfit_mentioned,
          current_outfit_updated_at: new Date().toISOString(),
        })
        .eq("character_id", characterId);
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

function getJapaneseSeasonDescriptor(timezone: string): string {
  const month = Number(
    new Intl.DateTimeFormat("en-US", { month: "numeric", timeZone: timezone || "Asia/Tokyo" }).format(new Date()),
  );
  if (month >= 3 && month <= 5) return "春(過ごしやすい気温、薄手の上着が欲しい時期)";
  if (month >= 6 && month <= 8) return "夏(暑くて湿度が高い、薄着・半袖・タンクトップや薄手のパジャマが快適な時期)";
  if (month >= 9 && month <= 11) return "秋(涼しい、セーターや長袖が欲しくなる時期)";
  return "冬(寒い、セーターやコート、長袖のパジャマが欲しい時期)";
}

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
