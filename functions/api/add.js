import {
  parseSourceInput,
} from "../_lib/provider.js";

export async function onRequestPost(
  context
) {
  const { request, env } = context;

  if (!env.DB) {
    return json(
      {
        error:
          "D1 binding is missing",
        detail:
          'Create a D1 binding named "DB".',
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
        detail:
          'Expected: {"url":"https://turbovidhls.com/t/XXXX"}',
      },
      400
    );
  }

  const input =
    body?.url ||
    body?.source_url;

  const source =
    parseSourceInput(input);

  if (!source) {
    return json(
      {
        error:
          "Unsupported or invalid URL",

        detail:
          "Supported providers: lugyiflix",

        examples: [
          "https://vidara.to/v/1ZtCr4uRKqKz",

          "https://streamtape.com/v/DQ2ma4kMGguk1G0/video.mp4",

          "https://turbovidhls.com/t/6a869ac97813d",

          "https://turbovidhls.com/t/68a5cc15370af",
        ],
      },
      400
    );
  }

  const {
    provider,
    filecode,
    source_url: sourceUrl,
  } = source;

  try {
    const existing =
      await env.DB.prepare(
        `
          SELECT
            id,
            provider,
            filecode,
            source_url,
            title,
            created_at
          FROM links
          WHERE provider = ?
            AND filecode = ?
          LIMIT 1
        `
      )
        .bind(provider, filecode)
        .first();

    if (existing) {
      return linkResponse(
        request,
        existing,
        false
      );
    }

    for (
      let attempt = 0;
      attempt < 5;
      attempt++
    ) {
      const id =
        createShortId(10);

      const createdAt =
        Math.floor(
          Date.now() / 1000
        );

      await env.DB.prepare(
        `
          INSERT OR IGNORE INTO links
            (
              id,
              provider,
              filecode,
              source_url,
              created_at
            )
          VALUES
            (?, ?, ?, ?, ?)
        `
      )
        .bind(
          id,
          provider,
          filecode,
          sourceUrl,
          createdAt
        )
        .run();

      const saved =
        await env.DB.prepare(
          `
            SELECT
              id,
              provider,
              filecode,
              source_url,
              title,
              created_at
            FROM links
            WHERE provider = ?
              AND filecode = ?
            LIMIT 1
          `
        )
          .bind(
            provider,
            filecode
          )
          .first();

      if (saved) {
        return linkResponse(
          request,
          saved,
          true
        );
      }
    }

    return json(
      {
        error:
          "Could not create a short link",
        detail:
          "Please try again.",
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

function linkResponse(
  request,
  record,
  created
) {
  const requestUrl =
    new URL(request.url);

  const redirectUrl =
    new URL(
      `/v/${encodeURIComponent(
        record.id
      )}`,
      requestUrl.origin
    ).toString();

  const proxyUrl =
    new URL(
      `/p/${encodeURIComponent(
        record.id
      )}`,
      requestUrl.origin
    ).toString();

  return json(
    {
      ok: true,
      created,

      id: record.id,
      provider: record.provider,
      filecode: record.filecode,
      source_url:
        record.source_url,

      // Old frontend compatibility
      public_url: redirectUrl,

      redirect_url: redirectUrl,
      proxy_url: proxyUrl,

      title:
        record.title || null,

      created_at:
        record.created_at,
    },
    created ? 201 : 200
  );
}

function createShortId(length = 10) {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZ" +
    "abcdefghijkmnopqrstuvwxyz" +
    "23456789";

  const bytes =
    new Uint8Array(length);

  crypto.getRandomValues(bytes);

  let output = "";

  for (
    let index = 0;
    index < length;
    index++
  ) {
    output +=
      alphabet[
        bytes[index] %
          alphabet.length
      ];
  }

  return output;
}

function safeError(error) {
  if (error instanceof Error) {
    return error.message.slice(
      0,
      800
    );
  }

  return String(error).slice(
    0,
    800
  );
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":
      "*",

    "Access-Control-Allow-Methods":
      "POST, OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type",

    "Access-Control-Max-Age":
      "86400",
  };
}

function json(
  data,
  status = 200,
  extraHeaders = {}
) {
  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store",

        ...corsHeaders(),
        ...extraHeaders,
      },
    }
  );
}
