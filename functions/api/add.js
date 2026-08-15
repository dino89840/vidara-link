import { getVidaraFilecode } from "../_lib/vidara.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.DB) {
    return json(
      {
        error: "D1 binding is missing",
        detail: 'Create a D1 binding named "DB".',
      },
      500
    );
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json(
      {
        error: "Invalid JSON body",
        detail: 'Expected: {"url":"https://vidara.to/v/XXXX"}',
      },
      400
    );
  }

  const input = body?.url || body?.id;
  const filecode = getVidaraFilecode(input);

  if (!filecode) {
    return json(
      {
        error: "Invalid Vidara URL or filecode",
        detail:
          "Example: https://vidara.to/v/1ZtCr4uRKqKz",
      },
      400
    );
  }

  try {
    // အရင်က ဒီ filecode ထည့်ဖူးလား စစ်မယ်
    const existing = await env.DB.prepare(
      `
        SELECT id, filecode, source_url, created_at
        FROM links
        WHERE filecode = ?
        LIMIT 1
      `
    )
      .bind(filecode)
      .first();

    if (existing) {
      return linkResponse(request, existing, false);
    }

    const sourceUrl =
      `https://vidara.to/v/${encodeURIComponent(filecode)}`;

    // Random ID collision ဖြစ်နိုင်ချေ နည်းပေမယ့် retry လုပ်ထားမယ်
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = createShortId(10);
      const createdAt = Math.floor(Date.now() / 1000);

      await env.DB.prepare(
        `
          INSERT OR IGNORE INTO links
            (id, filecode, source_url, created_at)
          VALUES
            (?, ?, ?, ?)
        `
      )
        .bind(id, filecode, sourceUrl, createdAt)
        .run();

      /*
       * INSERT OR IGNORE ဖြစ်တာကြောင့်:
       * - id collision ဖြစ်နိုင်တယ်
       * - တစ်ချိန်တည်း filecode တူကို request နှစ်ခုဝင်နိုင်တယ်
       *
       * ဒါကြောင့် filecode နဲ့ပြန်ရှာမယ်။
       */
      const saved = await env.DB.prepare(
        `
          SELECT id, filecode, source_url, created_at
          FROM links
          WHERE filecode = ?
          LIMIT 1
        `
      )
        .bind(filecode)
        .first();

      if (saved) {
        return linkResponse(request, saved, true);
      }
    }

    return json(
      {
        error: "Could not create a short link",
        detail: "Please try again.",
      },
      500
    );
  } catch (error) {
    return json(
      {
        error: "Database error",
        detail: safeError(error),
      },
      500
    );
  }
}

export async function onRequestGet() {
  return json(
    {
      error: "Method not allowed",
      detail: "Use POST /api/add",
    },
    405,
    {
      "Allow": "POST, OPTIONS",
    }
  );
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

function linkResponse(request, record, created) {
  const requestUrl = new URL(request.url);

  const publicUrl = new URL(
    `/v/${encodeURIComponent(record.id)}`,
    requestUrl.origin
  ).toString();

  return json(
    {
      ok: true,
      created,
      id: record.id,
      filecode: record.filecode,
      source_url: record.source_url,
      public_url: publicUrl,
      created_at: record.created_at,
    },
    created ? 201 : 200
  );
}

function createShortId(length = 10) {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZ" +
    "abcdefghijkmnopqrstuvwxyz" +
    "23456789";

  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);

  let output = "";

  for (let i = 0; i < length; i++) {
    output += alphabet[bytes[i] % alphabet.length];
  }

  return output;
}

function safeError(error) {
  if (error instanceof Error) {
    return error.message.slice(0, 500);
  }

  return String(error).slice(0, 500);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}
