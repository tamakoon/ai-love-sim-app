// supabase/functions/update-character-state/index.ts
//
// 目的: 全キャラクターのcharacter_stateを、現在時刻(キャラクターのtimezone基準)に
// 応じたルールベースのランダム選択で更新する。
// 日中の活動("day"枠)は、キャラクターの職業(occupation)を反映した表現にする。
// Scheduler(pg_cron)から定期的に呼び出される想定。
// クライアントから直接叩けないよう、CRON_SECRETによる認証を必須とする。

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET");

type SlotDef = { activities: string[]; moods: string[] };

const SCHEDULE: Record<string, SlotDef> = {
  morning: {
    activities: ["起床したところ", "身支度中", "出勤中", "朝食中"],
    moods: ["眠い", "すっきり", "普通"],
  },
  day: {
    // occupationがあればここに差し込む(下のbuildDayActivitiesで組み立てる)
    activities: [],
    moods: ["集中している", "忙しい", "普通"],
  },
  evening: {
    activities: ["帰宅中", "夕食の準備中", "買い物中", "趣味の時間"],
    moods: ["リラックスしている", "少し疲れ気味", "楽しい"],
  },
  night: {
    activities: ["自由時間", "お風呂上がり", "スマホを見ている", "読書中"],
    moods: ["まったりしている", "眠い", "落ち着いている"],
  },
  lateNight: {
    activities: ["就寝準備中", "就寝中"],
    moods: ["眠い", "静か"],
  },
};

function timeSlotFor(hour: number): keyof typeof SCHEDULE {
  if (hour >= 6 && hour < 10) return "morning";
  if (hour >= 10 && hour < 17) return "day";
  if (hour >= 17 && hour < 21) return "evening";
  if (hour >= 21 && hour < 24) return "night";
  return "lateNight";
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildDayActivities(occupation: string | null): string[] {
  if (occupation && occupation.trim().length > 0) {
    return [
      `${occupation}の仕事中`,
      `${occupation}の仕事の休憩中`,
      "ランチ休憩中",
    ];
  }
  return ["仕事中", "接客中", "ランチ休憩中", "会議中"];
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }

    const receivedSecret = req.headers.get("x-cron-secret");
    if (!CRON_SECRET || receivedSecret !== CRON_SECRET) {
      return json({ error: "unauthorized" }, 401);
    }

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: characters, error } = await db
      .from("characters")
      .select("id, timezone, occupation")
      .eq("status", "active");

    if (error) return json({ error: error.message }, 500);

    const now = new Date();
    const results: { character_id: string; activity: string; mood: string }[] = [];

    for (const c of characters ?? []) {
      const tz = c.timezone || "Asia/Tokyo";
      const hour = Number(
        new Intl.DateTimeFormat("en-US", { hour: "2-digit", hour12: false, timeZone: tz }).format(now),
      );
      const slot = timeSlotFor(hour);
      const def = SCHEDULE[slot];
      const activityList = slot === "day" ? buildDayActivities(c.occupation) : def.activities;
      const activity = pick(activityList);
      const mood = pick(def.moods);

      await db.from("character_state").upsert(
        {
          character_id: c.id,
          current_activity: activity,
          current_mood: mood,
          updated_at: now.toISOString(),
        },
        { onConflict: "character_id" },
      );

      results.push({ character_id: c.id, activity, mood });
    }

    return json({ updated_count: results.length, results });
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
