import { extractVidara } from "../_lib/vidara.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Safari/537.36";

const UPSTREAM_TIMEOUT_MS = 15000;
const MAX_PROXY_URL_LENGTH = 12000;

export async function onRequestGet(context) {
  const { request, env, params } = context;

  if (!env.DB) {
    return errorResponse(
      "D1 binding is missing",
      'Create a D1 binding named "DB".',
      500
    );
  }

  if (
    !env.PROXY_SECRET ||
    String(env.PROXY_SECRET).length < 16
  ) {
    return errorResponse(
      "PROXY_SECRET is missing",
      "Create an encrypted PROXY_SECRET with at least 16 characters.",
      500
    );
  }

  const id = String(params.id || "").trim();

  if (!/^[A-Za-z0-9_-]{4,100}$/.test(id)) {
    return errorResponse(
      "Invalid link ID",
      "The supplied proxy link ID is invalid.",
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
        "This proxy link does not exist.",
        404
      );
    }

    const requestUrl = new URL(request.url);

    const signedTarget =
      requestUrl.searchParams.get("u");

    const signedReferer =
      requestUrl.searchParams.get("r");

    const signature =
      requestUrl.searchParams.get("s");

    let targetUrl;
    let refererUrl;
    let cacheStatus = "SIGNED";

    if (signedTarget || signedReferer || signature) {
      if (
        !signedTarget ||
        !signedReferer ||
        !signature
      ) {
        return errorResponse(
          "Invalid proxy URL",
          "The proxy URL is missing signed parameters.",
          403
        );
      }

      if (
        signedTarget.length > MAX_PROXY_URL_LENGTH ||
        signedReferer.length > MAX_PROXY_URL_LENGTH ||
        signature.length > 200
      ) {
        return errorResponse(
          "Proxy URL is too long",
          "The supplied upstream URL exceeds the allowed size.",
          414
        );
      }

      const verified = await verifyProxySignature(
        id,
        signedTarget,
        signedReferer,
        signature,
        env.PROXY_SECRET
      );

      if (!verified) {
        return errorResponse(
          "Invalid proxy signature",
          "This proxy URL has been changed or is not valid.",
          403
        );
      }

      targetUrl = validateHttpUrl(signedTarget);
      refererUrl = validateHttpUrl(signedReferer);
    } else {
      /*
       * /p/ID ကိုပထမဆုံးဖွင့်ချိန်မှာ stream URL ကိုရှာမယ်။
       * Playlist ထဲက နောက် request တွေမှာ signed URL သုံးလို့
       * extract ထပ်လုပ်စရာမလိုပါ။
       */
      const stream = await extractVidara(
        link.filecode,
        {
          cacheOrigin: requestUrl.origin,
          waitUntil: context.waitUntil.bind(context),
        }
      );

      targetUrl = validateHttpUrl(
        stream.streaming_url
      );

      refererUrl = validateHttpUrl(
        stream.embed_url ||
        `${stream.embed_host}/e/${encodeURIComponent(
          stream.embed_filecode || link.filecode
        )}`
      );

      cacheStatus =
        stream.cache_status || "UNKNOWN";
    }

    return await proxyUpstream({
      context,
      id,
      targetUrl,
      refererUrl,
      proxySecret: env.PROXY_SECRET,
      cacheStatus,
    });
  } catch (error) {
    return errorResponse(
      "Could not proxy stream",
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
    headers: corsHeaders(),
  });
}

async function proxyUpstream({
  context,
  id,
  targetUrl,
  refererUrl,
  proxySecret,
  cacheStatus,
}) {
  const request = context.request;
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, UPSTREAM_TIMEOUT_MS);

  const upstreamHeaders = new Headers({
    "User-Agent": USER_AGENT,
    "Accept": "*/*",
    "Referer": refererUrl.toString(),
    "Origin": refererUrl.origin,
    "Accept-Encoding": "identity",
  });

  const range = request.headers.get("Range");

  if (range) {
    upstreamHeaders.set("Range", range);
  }

  let upstream;

  try {
    upstream = await fetch(targetUrl.toString(), {
      method:
        request.method === "HEAD" ? "HEAD" : "GET",
      headers: upstreamHeaders,
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (error) {
    if (
      error?.name === "AbortError" ||
      controller.signal.aborted
    ) {
      throw new Error(
        `Upstream request timeout after ${UPSTREAM_TIMEOUT_MS}ms`
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!upstream.ok) {
    const detail = await readErrorBody(upstream);

    return errorResponse(
      "Upstream stream request failed",
      `HTTP ${upstream.status}` +
        (detail ? `: ${detail}` : ""),
      upstream.status >= 400 &&
      upstream.status <= 599
        ? upstream.status
        : 502
    );
  }

  const finalUrl = validateHttpUrl(
    upstream.url || targetUrl.toString()
  );

  const contentType =
    upstream.headers.get("Content-Type") || "";

  const isPlaylist =
    request.method !== "HEAD" &&
    (
      /(?:mpegurl|m3u8)/i.test(contentType) ||
      /\.m3u8(?:$|[?#])/i.test(finalUrl.toString()) ||
      /\.m3u8(?:$|[?#])/i.test(targetUrl.toString())
    );

  if (isPlaylist) {
    const playlistText = await upstream.text();

    if (!playlistText.trimStart().startsWith("#EXTM3U")) {
      return errorResponse(
        "Invalid HLS playlist",
        "The upstream response is not a valid m3u8 playlist.",
        502
      );
    }

    const proxyBase = new URL(
      `/p/${encodeURIComponent(id)}`,
      new URL(request.url).origin
    );

    const rewritten = await rewritePlaylist(
      playlistText,
      finalUrl,
      refererUrl,
      proxyBase,
      id,
      proxySecret
    );

    return new Response(rewritten, {
      status: upstream.status,
      headers: {
        ...corsHeaders(),
        "Content-Type":
          "application/vnd.apple.mpegurl; charset=utf-8",
        "Cache-Control":
          "public, max-age=5, s-maxage=5",
        "X-Content-Type-Options": "nosniff",
        "X-Stream-Cache": cacheStatus,
      },
    });
  }

  const responseHeaders =
    createBinaryResponseHeaders(upstream.headers);

  responseHeaders.set(
    "Access-Control-Allow-Origin",
    "*"
  );

  responseHeaders.set(
    "Access-Control-Expose-Headers",
    [
      "Content-Length",
      "Content-Range",
      "Accept-Ranges",
      "Content-Type",
      "ETag",
      "Last-Modified",
      "X-Stream-Cache",
    ].join(", ")
  );

  responseHeaders.set(
    "X-Stream-Cache",
    cacheStatus
  );

  if (!responseHeaders.has("Cache-Control")) {
    responseHeaders.set(
      "Cache-Control",
      "public, max-age=86400"
    );
  }

  return new Response(
    request.method === "HEAD"
      ? null
      : upstream.body,
    {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    }
  );
}

async function rewritePlaylist(
  playlistText,
  playlistUrl,
  refererUrl,
  proxyBase,
  id,
  proxySecret
) {
  const newline = playlistText.includes("\r\n")
    ? "\r\n"
    : "\n";

  const lines = playlistText.split(/\r?\n/);
  const output = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      output.push(line);
      continue;
    }

    if (trimmed.startsWith("#")) {
      output.push(
        await rewriteTagUriAttributes(
          line,
          playlistUrl,
          refererUrl,
          proxyBase,
          id,
          proxySecret
        )
      );

      continue;
    }

    const absoluteUrl = resolvePlaylistUrl(
      trimmed,
      playlistUrl
    );

    const proxyUrl = await makeSignedProxyUrl(
      proxyBase,
      id,
      absoluteUrl,
      refererUrl,
      proxySecret
    );

    const leadingSpace =
      line.match(/^\s*/)?.[0] || "";

    const trailingSpace =
      line.match(/\s*$/)?.[0] || "";

    output.push(
      leadingSpace + proxyUrl + trailingSpace
    );
  }

  return output.join(newline);
}

/**
 * #EXT-X-KEY:METHOD=AES-128,URI="key.key"
 * #EXT-X-MAP:URI="init.mp4"
 * #EXT-X-MEDIA:URI="audio.m3u8"
 * စတာတွေကို rewrite လုပ်မယ်။
 */
async function rewriteTagUriAttributes(
  line,
  playlistUrl,
  refererUrl,
  proxyBase,
  id,
  proxySecret
) {
  const regex = /\bURI\s*=\s*"([^"]+)"/gi;

  let result = "";
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(line)) !== null) {
    result += line.slice(lastIndex, match.index);

    const rawUrl = match[1];
    const absoluteUrl = resolvePlaylistUrl(
      rawUrl,
      playlistUrl
    );

    const proxyUrl = await makeSignedProxyUrl(
      proxyBase,
      id,
      absoluteUrl,
      refererUrl,
      proxySecret
    );

    const originalAttribute = match[0];
    const quoteIndex =
      originalAttribute.indexOf('"');

    const attributePrefix =
      originalAttribute.slice(0, quoteIndex + 1);

    result +=
      attributePrefix +
      proxyUrl +
      '"';

    lastIndex = match.index + match[0].length;
  }

  result += line.slice(lastIndex);

  return result;
}

function resolvePlaylistUrl(value, baseUrl) {
  const url = new URL(value, baseUrl);

  if (
    url.protocol !== "https:" &&
    url.protocol !== "http:"
  ) {
    throw new Error(
      `Unsupported playlist URL protocol: ${url.protocol}`
    );
  }

  return url;
}

async function makeSignedProxyUrl(
  proxyBase,
  id,
  targetUrl,
  refererUrl,
  proxySecret
) {
  const target = targetUrl.toString();
  const referer = refererUrl.toString();

  const signature = await createProxySignature(
    id,
    target,
    referer,
    proxySecret
  );

  const proxyUrl = new URL(proxyBase);

  proxyUrl.searchParams.set("u", target);
  proxyUrl.searchParams.set("r", referer);
  proxyUrl.searchParams.set("s", signature);

  return proxyUrl.toString();
}

async function createProxySignature(
  id,
  target,
  referer,
  secret
) {
  const key = await importHmacKey(secret);

  const data = new TextEncoder().encode(
    `${id}\n${target}\n${referer}`
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    data
  );

  return toBase64Url(new Uint8Array(signature));
}

async function verifyProxySignature(
  id,
  target,
  referer,
  signature,
  secret
) {
  let signatureBytes;

  try {
    signatureBytes = fromBase64Url(signature);
  } catch {
    return false;
  }

  const key = await importHmacKey(secret);

  const data = new TextEncoder().encode(
    `${id}\n${target}\n${referer}`
  );

  try {
    return await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      data
    );
  } catch {
    return false;
  }
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign", "verify"]
  );
}

function toBase64Url(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const normalized = value
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const padding =
    normalized.length % 4 === 0
      ? ""
      : "=".repeat(4 - (normalized.length % 4));

  const binary = atob(normalized + padding);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function validateHttpUrl(value) {
  const url =
    value instanceof URL
      ? value
      : new URL(String(value));

  if (
    url.protocol !== "https:" &&
    url.protocol !== "http:"
  ) {
    throw new Error(
      `Unsupported upstream protocol: ${url.protocol}`
    );
  }

  if (url.username || url.password) {
    throw new Error(
      "Upstream URLs containing credentials are not allowed"
    );
  }

  return url;
}

function createBinaryResponseHeaders(
  upstreamHeaders
) {
  const headers = new Headers();

  const allowedHeaders = [
    "Content-Type",
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "Cache-Control",
    "ETag",
    "Last-Modified",
    "Content-Encoding",
    "Content-Language",
  ];

  for (const name of allowedHeaders) {
    const value = upstreamHeaders.get(name);

    if (value !== null) {
      headers.set(name, value);
    }
  }

  return headers;
}

async function readErrorBody(response) {
  try {
    const text = await response.text();
    return text.trim().slice(0, 300);
  } catch {
    return "";
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Range",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
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
        ...corsHeaders(),
      },
    }
  );
}

function safeError(error) {
  if (error instanceof Error) {
    return error.message.slice(0, 800);
  }

  return String(error).slice(0, 800);
}
