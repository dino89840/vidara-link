import { extractVidara } from "../_lib/vidara.js";

export async function onRequestGet(context) {
  const { env, params } = context;

  if (!env.DB) {
    return errorResponse(
      "D1 binding is missing",
      'Create a D1 binding named "DB".',
      500
    );
  }

  const id = String(params.id || "").trim();

  if (!/^[A-Za-z0-9_-]{4,100}$/.test(id)) {
    return errorResponse(
      "Invalid link ID",
      "The supplied stable link ID is invalid.",
      400
    );
  }

  try {
    // Stable ID နဲ့ filecode ပြန်ရှာမယ်
    const link = await env.DB.prepare(
      `
        SELECT id, filecode, source_url, title, created_at
        FROM links
        WHERE id = ?
        LIMIT 1
      `
    )
      .bind(id)
      .first();

    if (!link) {
      return errorResponse(
        "Link not found",
        "This stable link does not exist.",
        404
      );
    }

    /*
     * Stable link ဖွင့်တဲ့အချိန်မှ Vidara ကိုခေါ်ပြီး
     * လက်ရှိ m3u8 အသစ်ထုတ်မယ်။
     */
    const stream = await extractVidara(link.filecode);

    if (!stream.streaming_url) {
      return errorResponse(
        "Stream not found",
        "No streaming URL was returned.",
        404
      );
    }

    // Title သိရရင် database ထဲ background update လုပ်မယ်
    if (stream.title && stream.title !== link.title) {
      context.waitUntil(
        env.DB.prepare(
          `
            UPDATE links
            SET title = ?, last_resolved_at = ?
            WHERE id = ?
          `
        )
          .bind(
            stream.title,
            Math.floor(Date.now() / 1000),
            id
          )
          .run()
          .catch(() => {})
      );
    } else {
      context.waitUntil(
        env.DB.prepare(
          `
            UPDATE links
            SET last_resolved_at = ?
            WHERE id = ?
          `
        )
          .bind(Math.floor(Date.now() / 1000), id)
          .run()
          .catch(() => {})
      );
    }

    // m3u8 direct link ဆီသို့ redirect
    return new Response(null, {
      status: 302,
      headers: {
        "Location": stream.streaming_url,
        "Cache-Control":
          "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
        "Referrer-Policy": "no-referrer",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    return errorResponse(
      "Could not resolve stream",
      safeError(error),
      502
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function errorResponse(error, detail, status) {
  return new Response(
    JSON.stringify(
      {
        ok: false,
        error,
        detail,
      },
      null,
      2
    ),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

function safeError(error) {
  if (error instanceof Error) {
    return error.message.slice(0, 500);
  }

  return String(error).slice(0, 500);
}
