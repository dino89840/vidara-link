const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Safari/537.36";

const PAGE_TIMEOUT_MS = 12000;
const RESOLVE_TIMEOUT_MS = 15000;
const STREAM_CACHE_TTL = 8;

const LOADVID_HOSTS = new Set([
  "loadvid.com",
  "www.loadvid.com",
  "cdn.loadvid.com",
]);

const pendingExtractions = new Map();

/**
 * LoadVid URL ကနေ video hash/filecode ထုတ်ပေးမယ်။
 *
 * Supported:
 * https://cdn.loadvid.com/videos/play/HASH
 * https://loadvid.com/videos/play/HASH
 */
export function getLoadvidFilecode(input) {
  const value = String(input || "").trim();

  if (!value) {
    return null;
  }

  // Internal use အတွက် bare hash လက်ခံထားမယ်။
  if (/^[A-Za-z0-9_-]{4,200}$/.test(value)) {
    return value;
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  const hostname =
    parsed.hostname.toLowerCase();

  if (!LOADVID_HOSTS.has(hostname)) {
    return null;
  }

  const match = parsed.pathname.match(
    /^\/videos\/play\/([A-Za-z0-9_-]{4,200})(?:\/|$)/i
  );

  return match ? match[1] : null;
}

/**
 * LoadVid protected player ကို resolve လုပ်ပြီး
 * M3U8 playlist text ပြန်ပေးမယ်။
 *
 * LoadVid က direct M3U8 URL မပေးဘဲ
 * /videos/resolve-token response body ထဲမှာ
 * M3U8 playlist ကိုပေးထားတာဖြစ်ပါတယ်။
 */
export async function extractLoadvid(
  filecode,
  options = {}
) {
  if (
    !/^[A-Za-z0-9_-]{4,200}$/.test(filecode)
  ) {
    throw new Error(
      "Invalid LoadVid video hash"
    );
  }

  const cacheKey = createCacheKey(
    filecode,
    options.cacheOrigin
  );

  const cached =
    await readStreamCache(cacheKey);

  if (cached) {
    return {
      ...cached,
      cache_status: "HIT",
    };
  }

  if (pendingExtractions.has(filecode)) {
    return pendingExtractions.get(filecode);
  }

  const extractionPromise =
    extractFresh(filecode)
      .then((stream) => {
        const cachePromise =
          writeStreamCache(
            cacheKey,
            stream
          );

        if (
          typeof options.waitUntil ===
          "function"
        ) {
          options.waitUntil(cachePromise);
        } else {
          cachePromise.catch(() => {});
        }

        return {
          ...stream,
          cache_status: "MISS",
        };
      })
      .finally(() => {
        pendingExtractions.delete(filecode);
      });

  pendingExtractions.set(
    filecode,
    extractionPromise
  );

  return extractionPromise;
}

async function extractFresh(filecode) {
  const encoded =
    encodeURIComponent(filecode);

  const pageCandidates = [
    `https://cdn.loadvid.com/videos/play/${encoded}`,
    `https://loadvid.com/videos/play/${encoded}`,
    `https://www.loadvid.com/videos/play/${encoded}`,
  ];

  const errors = [];

  for (const pageUrl of pageCandidates) {
    try {
      const page =
        await fetchLoadvidPage(pageUrl);

      const config =
        extractLoadvidConfig(page.html);

      if (!config.videoToken) {
        throw new Error(
          "videoToken was not found"
        );
      }

      const resolvedHash =
        config.videoHash || filecode;

      const playlist =
        await resolveVideoToken({
          pageUrl:
            page.finalUrl || pageUrl,

          csrfToken:
            page.csrfToken,

          cookie:
            page.cookie,

          videoToken:
            config.videoToken,

          videoHash:
            resolvedHash,
        });

      return {
        provider: "loadvid",
        filecode,

        title:
          extractTitle(page.html),

        thumbnail:
          config.thumbnailUrl || null,

        subtitles: [],

        /*
         * LoadVid က direct URL အစား
         * playlist content ပြန်ပေးပါတယ်။
         */
        streaming_url: null,
        playlist_text:
          playlist.text,

        playlist_url:
          playlist.finalUrl,

        content_type:
          "application/vnd.apple.mpegurl",

        stream_type:
          "hls-inline",

        embed_url:
          page.finalUrl || pageUrl,

        referer_url:
          page.finalUrl || pageUrl,

        embed_host:
          new URL(
            page.finalUrl || pageUrl
          ).origin,

        verified: true,

        resolved_at:
          Math.floor(Date.now() / 1000),
      };
    } catch (error) {
      errors.push(
        `${pageUrl}: ${safeError(error)}`
      );
    }
  }

  throw new Error(
    (
      "LoadVid playlist could not be resolved. " +
      errors.slice(-5).join(" | ")
    ).slice(0, 1200)
  );
}

async function fetchLoadvidPage(pageUrl) {
  const response = await fetchWithTimeout(
    pageUrl,
    {
      method: "GET",
      redirect: "follow",

      headers: {
        "User-Agent": USER_AGENT,

        "Accept":
          "text/html,application/xhtml+xml," +
          "application/xml;q=0.9,*/*;q=0.8",

        "Accept-Language":
          "en-US,en;q=0.9",

        "Cache-Control":
          "no-cache",

        "Pragma":
          "no-cache",
      },
    },
    PAGE_TIMEOUT_MS
  );

  const html =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `LoadVid returned HTTP ${response.status}`
    );
  }

  if (!html || html.length < 100) {
    throw new Error(
      "LoadVid returned an empty page"
    );
  }

  const csrfToken =
    extractCsrfToken(html);

  if (!csrfToken) {
    throw new Error(
      "LoadVid CSRF token was not found"
    );
  }

  return {
    html,

    finalUrl:
      response.url || pageUrl,

    csrfToken,

    cookie:
      getCookieHeader(
        response.headers
      ),
  };
}

function extractCsrfToken(html) {
  const match = String(html).match(
    /<meta\b[^>]*name\s*=\s*["']csrf-token["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/i
  );

  if (match) {
    return decodeHtmlEntities(
      match[1]
    );
  }

  /*
   * content attribute က name attribute
   * ရဲ့ရှေ့မှာရှိနိုင်တဲ့အတွက် fallback။
   */
  const reverseMatch =
    String(html).match(
      /<meta\b[^>]*content\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']csrf-token["'][^>]*>/i
    );

  return reverseMatch
    ? decodeHtmlEntities(
        reverseMatch[1]
      )
    : null;
}

function extractLoadvidConfig(html) {
  const source =
    String(html || "");

  return {
    videoHash:
      extractConfigString(
        source,
        "videoHash"
      ),

    videoToken:
      extractConfigString(
        source,
        "videoToken"
      ),

    thumbnailUrl:
      extractConfigString(
        source,
        "thumbnailUrl"
      ),
  };
}

function extractConfigString(
  html,
  property
) {
  const escapedProperty =
    property.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

  const regex = new RegExp(
    "\\b" +
      escapedProperty +
      "\\s*:\\s*(['\"])([\\s\\S]*?)\\1\\s*(?:,|\\n|\\r|})",
    "i"
  );

  const match =
    String(html).match(regex);

  if (!match) {
    return null;
  }

  return decodeJavaScriptString(
    match[2]
  );
}

async function resolveVideoToken({
  pageUrl,
  csrfToken,
  cookie,
  videoToken,
  videoHash,
}) {
  const page =
    new URL(pageUrl);

  const resolveUrl =
    new URL(
      "/videos/resolve-token",
      page.origin
    );

  const headers = new Headers({
    "User-Agent": USER_AGENT,

    "Content-Type":
      "application/json",

    "Accept":
      "application/vnd.apple.mpegurl," +
      "application/x-mpegURL," +
      "text/plain,*/*",

    "X-CSRF-TOKEN":
      csrfToken,

    "X-Requested-With":
      "XMLHttpRequest",

    "Referer":
      page.toString(),

    "Origin":
      page.origin,

    "Cache-Control":
      "no-cache",

    "Pragma":
      "no-cache",
  });

  if (cookie) {
    headers.set(
      "Cookie",
      cookie
    );
  }

  const response =
    await fetchWithTimeout(
      resolveUrl.toString(),
      {
        method: "POST",
        redirect: "follow",
        headers,

        body: JSON.stringify({
          token: videoToken,
          hash: videoHash,
        }),
      },
      RESOLVE_TIMEOUT_MS
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `LoadVid resolve-token returned HTTP ${response.status}: ` +
      text.trim().slice(0, 300)
    );
  }

  if (
    !text ||
    !text.trimStart().startsWith(
      "#EXTM3U"
    )
  ) {
    throw new Error(
      "LoadVid resolve-token returned an invalid M3U8 playlist"
    );
  }

  return {
    text,

    finalUrl:
      response.url ||
      resolveUrl.toString(),
  };
}

/**
 * Laravel session cookies ကို နောက် POST request မှာ
 * ပြန်ပို့ရန် Set-Cookie headers ထုတ်ပေးမယ်။
 */
function getCookieHeader(headers) {
  let setCookies = [];

  try {
    if (
      typeof headers.getAll ===
      "function"
    ) {
      setCookies =
        headers.getAll("Set-Cookie");
    }
  } catch {
    // Continue with fallback
  }

  try {
    if (
      setCookies.length === 0 &&
      typeof headers.getSetCookie ===
        "function"
    ) {
      setCookies =
        headers.getSetCookie();
    }
  } catch {
    // Continue with fallback
  }

  if (setCookies.length === 0) {
    const combined =
      headers.get("Set-Cookie");

    if (combined) {
      /*
       * Expires=Wed, ... ထဲက comma ကို
       * cookie separator မထင်စေရန်
       * cookie-name= ရှိတဲ့ comma မှသာခွဲမယ်။
       */
      setCookies = combined.split(
        /,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/
      );
    }
  }

  return setCookies
    .map((value) =>
      String(value)
        .split(";", 1)[0]
        .trim()
    )
    .filter(Boolean)
    .join("; ");
}

function extractTitle(html) {
  const match =
    String(html).match(
      /<title\b[^>]*>([\s\S]*?)<\/title>/i
    );

  if (!match) {
    return null;
  }

  const title =
    decodeHtmlEntities(match[1])
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .replace(/\s*\|\s*Loadvid.*$/i, "")
      .trim();

  return title
    ? title.slice(0, 500)
    : null;
}

function decodeJavaScriptString(value) {
  return decodeHtmlEntities(
    String(value || "")
      .replace(/\\\//g, "/")
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/\\r/g, "\r")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(
        /\\u([0-9a-f]{4})/gi,
        (match, code) =>
          String.fromCharCode(
            parseInt(code, 16)
          )
      )
  );
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&#x2f;/gi, "/")
    .replace(/&#x3a;/gi, ":")
    .replace(/&#x26;/gi, "&");
}

async function fetchWithTimeout(
  url,
  init,
  timeoutMs
) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(() => {
      controller.abort();
    }, timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (
      error?.name === "AbortError" ||
      controller.signal.aborted
    ) {
      throw new Error(
        `Request timeout after ${timeoutMs}ms: ${url}`
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function createCacheKey(
  filecode,
  cacheOrigin
) {
  let origin =
    "https://loadvid-stream-cache.invalid";

  try {
    if (cacheOrigin) {
      origin =
        new URL(cacheOrigin).origin;
    }
  } catch {
    // Internal fallback origin
  }

  return new Request(
    `${origin}/__loadvid_stream_cache/${encodeURIComponent(
      filecode
    )}`,
    {
      method: "GET",
    }
  );
}

async function readStreamCache(
  cacheKey
) {
  if (
    typeof caches === "undefined" ||
    !caches.default
  ) {
    return null;
  }

  try {
    const response =
      await caches.default.match(
        cacheKey
      );

    if (
      !response ||
      !response.ok
    ) {
      return null;
    }

    const data =
      await response.json();

    if (!data?.playlist_text) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

async function writeStreamCache(
  cacheKey,
  stream
) {
  if (
    typeof caches === "undefined" ||
    !caches.default
  ) {
    return;
  }

  const response =
    new Response(
      JSON.stringify(stream),
      {
        status: 200,

        headers: {
          "Content-Type":
            "application/json; charset=utf-8",

          "Cache-Control":
            `public, max-age=${STREAM_CACHE_TTL}`,
        },
      }
    );

  try {
    await caches.default.put(
      cacheKey,
      response
    );
  } catch {
    // Cache failure is ignored
  }
}

function safeError(error) {
  if (error instanceof Error) {
    return error.message.slice(
      0,
      700
    );
  }

  return String(error).slice(
    0,
    700
  );
}
