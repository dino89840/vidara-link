import { extractVidara } from "../_lib/vidara.js";

export async function onRequestGet(context) {
  const { request, env, params } = context;

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

    const requestUrl = new URL(request.url);

    /*
     * 15-second edge cache နဲ့ duplicate-request
     * deduplication ပါဝင်တဲ့ extractor ကိုခေါ်မယ်။
     */
    const stream = await extractVidara(
      link.filecode,
      {
        cacheOrigin: requestUrl.origin,
        waitUntil: context.waitUntil.bind(context),
      }
    );

    if (!stream.streaming_url) {
      return errorResponse(
        "Stream not found",
        "No streaming URL was returned.",
        404
      );
    }

    const now = Math.floor(Date.now() / 1000);

    context.waitUntil(
      updateResolvedInfo(
        env.DB,
        id,
        stream.title,
        link.title,
        now
      )
    );

    // Direct m3u8 link ဆီ 302 redirect
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
        "Access-Control-Expose-Headers":
          "Location, X-Stream-Cache",
        "X-Stream-Cache":
          stream.cache_status || "UNKNOWN",
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

export async function onRequestHead(context) {
  return onRequestGet(context);
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods":
        "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Range",
      "Access-Control-Max-Age": "86400",
    },
  });
}

async function updateResolvedInfo(
  db,
  id,
  newTitle,
  oldTitle,
  timestamp
) {
  try {
    if (newTitle && newTitle !== oldTitle) {
      await db.prepare(
        `
          UPDATE links
          SET title = ?, last_resolved_at = ?
          WHERE id = ?
        `
      )
        .bind(newTitle, timestamp, id)
        .run();
    } else {
      await db.prepare(
        `
          UPDATE links
          SET last_resolved_at = ?
          WHERE id = ?
        `
      )
        .bind(timestamp, id)
        .run();
    }
  } catch {
    // Background database update fail ဖြစ်လည်း
    // redirect ကို မထိခိုက်စေပါ
  }
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
        "Content-Type":
          "application/json; charset=utf-8",
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
