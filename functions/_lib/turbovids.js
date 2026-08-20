const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Safari/537.36";

const PAGE_TIMEOUT_MS = 10000;
const PROBE_TIMEOUT_MS = 10000;
const STREAM_CACHE_TTL = 20;

const TURBOVIDS_HOSTS = new Set([
  "turbovidhls.com",
  "www.turbovidhls.com",
  "turboviplay.com",
  "www.turboviplay.com",
]);

const pendingExtractions = new Map();

/**
 * TurboVids URL သို့မဟုတ် filecode ကနေ
 * filecode ထုတ်ပေးမယ်။
 */
export function getTurbovidsFilecode(input) {
  const value = String(input || "").trim();

  if (!value) {
    return null;
  }

  // Bare filecode
  if (/^[A-Za-z0-9_-]{4,100}$/.test(value)) {
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

  if (!TURBOVIDS_HOSTS.has(hostname)) {
    return null;
  }

  const match = parsed.pathname.match(
    /^\/(?:t|e|v)\/([A-Za-z0-9_-]{4,100})(?:\/|$)/i
  );

  return match ? match[1] : null;
}

/**
 * TurboVids page ကနေ လက်ရှိ MP4 သို့မဟုတ်
 * M3U8 direct URL ကိုထုတ်ပေးမယ်။
 */
export async function extractTurbovids(
  filecode,
  options = {}
) {
  if (
    !/^[A-Za-z0-9_-]{4,100}$/.test(filecode)
  ) {
    throw new Error(
      "Invalid TurboVids filecode"
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

  /*
   * Main page domain ပြောင်းထားနိုင်တဲ့အတွက်
   * သိထားတဲ့ TurboVids page domains တွေကို
   * fallback အဖြစ်စစ်မယ်။
   *
   * Direct MP4/M3U8 CDN domain ကိုတော့
   * ဒီနေရာမှာ hard-code မလုပ်ပါ။
   */
  const pageCandidates = [
    `https://turbovidhls.com/t/${encoded}`,
    `https://www.turbovidhls.com/t/${encoded}`,
    `https://turboviplay.com/t/${encoded}`,
    `https://www.turboviplay.com/t/${encoded}`,
  ];

  const errors = [];
  let unverifiedResult = null;

  for (const pageUrl of pageCandidates) {
    try {
      const page =
        await fetchTurboPage(pageUrl);

      const directCandidates =
        extractMediaCandidates(
          page.html,
          page.finalUrl || pageUrl
        );

      if (directCandidates.length === 0) {
        errors.push(
          `${pageUrl}: direct media URL not found`
        );

        continue;
      }

      /*
       * Probe မအောင်မြင်ရင်တောင် HTML ထဲက
       * candidate ကို fallback အဖြစ်သိမ်းထားမယ်။
       *
       * CDN တချို့က Range/HEAD probe ကိုပိတ်ထားပေမယ့်
       * player request ကိုတော့ လက်ခံနိုင်ပါတယ်။
       */
      if (!unverifiedResult) {
        unverifiedResult = makeResult({
          filecode,
          directUrl:
            directCandidates[0],
          pageUrl:
            page.finalUrl || pageUrl,
          title: page.title,
          contentType: inferContentType(
            directCandidates[0]
          ),
          verified: false,
        });
      }

      const verified =
        await verifyCandidates(
          directCandidates,
          page.finalUrl || pageUrl
        );

      if (verified) {
        return makeResult({
          filecode,
          directUrl: verified.url,
          pageUrl:
            page.finalUrl || pageUrl,
          title: page.title,
          contentType:
            verified.contentType,
          verified: true,
        });
      }

      errors.push(
        `${pageUrl}: media URL probe failed`
      );
    } catch (error) {
      errors.push(
        `${pageUrl}: ${safeError(error)}`
      );
    }
  }

  if (unverifiedResult) {
    return unverifiedResult;
  }

  throw new Error(
    (
      "TurboVids direct URL could not be resolved. " +
      errors.slice(-6).join(" | ")
    ).slice(0, 1200)
  );
}

async function fetchTurboPage(pageUrl) {
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
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Referer":
          "https://turbovidhls.com/",
      },
    },
    PAGE_TIMEOUT_MS
  );

  const html = await response.text();

  if (!response.ok) {
    throw new Error(
      `TurboVids returned HTTP ${response.status}`
    );
  }

  if (!html || html.length < 50) {
    throw new Error(
      "TurboVids returned an empty page"
    );
  }

  return {
    html,
    finalUrl: response.url || pageUrl,
    title: extractTitle(html),
  };
}

/**
 * အောက်ပါပုံစံတွေကို support လုပ်ထားပါတယ်။
 *
 * var urlPlay = "https://cdn.example/video.mp4";
 *
 * <div
 *   id="video_player"
 *   data-hash="https://cdn.example/video.m3u8"
 * >
 *
 * file: "https://cdn.example/video.m3u8"
 *
 * <source src="https://cdn.example/video.mp4">
 */
function extractMediaCandidates(
  html,
  pageUrl
) {
  const results = new Map();

  const normalized =
    normalizeEscapedText(
      decodeHtmlEntities(html)
    );

  /*
   * data-hash, data-file, data-url,
   * data-src နဲ့ source src attributes။
   */
  const attributeRegex =
    /\b(?:data-hash|data-file|data-url|data-src|src)\s*=\s*(["'])([^"']+)\1/gi;

  let match;

  while (
    (match =
      attributeRegex.exec(normalized)) !==
    null
  ) {
    addMediaCandidate(
      results,
      match[2],
      pageUrl,
      true
    );
  }

  /*
   * var urlPlay = "...";
   * let file = "...";
   * file: "...";
   * source: "...";
   */
  const variableRegex =
    /\b(?:var|let|const)?\s*(?:urlPlay|playUrl|videoUrl|streamUrl|file|source)\s*(?:=|:)\s*(["'`])([^"'`]+)\1/gi;

  while (
    (match =
      variableRegex.exec(normalized)) !==
    null
  ) {
    addMediaCandidate(
      results,
      match[2],
      pageUrl,
      true
    );
  }

  /*
   * JWPlayer setup object:
   * "file": "https://..."
   */
  const jwFileRegex =
    /["']file["']\s*:\s*(["'`])([^"'`]+)\1/gi;

  while (
    (match =
      jwFileRegex.exec(normalized)) !==
    null
  ) {
    addMediaCandidate(
      results,
      match[2],
      pageUrl,
      true
    );
  }

  /*
   * HTML/JavaScript ထဲမှာ media URL တန်းပါနေရင်
   * fallback အဖြစ်ရှာမယ်။
   */
  const directUrlRegex =
    /https?:\/\/[^\s"'`<>\\]+/gi;

  while (
    (match =
      directUrlRegex.exec(normalized)) !==
    null
  ) {
    addMediaCandidate(
      results,
      match[0],
      pageUrl,
      false
    );
  }

  return [...results.values()]
    .sort(
      (first, second) =>
        getCandidateScore(second) -
        getCandidateScore(first)
    )
    .slice(0, 12);
}

function addMediaCandidate(
  results,
  rawValue,
  pageUrl,
  force
) {
  let value =
    normalizeEscapedText(
      String(rawValue || "").trim()
    );

  value = value
    .replace(/^["'`]+/, "")
    .replace(/["'`,;]+$/, "")
    .trim();

  if (!value) {
    return;
  }

  let url;

  try {
    url = new URL(value, pageUrl);
  } catch {
    return;
  }

  if (
    url.protocol !== "https:" &&
    url.protocol !== "http:"
  ) {
    return;
  }

  if (url.username || url.password) {
    return;
  }

  if (
    !force &&
    !isLikelyMediaUrl(url)
  ) {
    return;
  }

  /*
   * Poster / thumbnail ကို video URL အဖြစ်
   * မယူမိစေရန် filter လုပ်မယ်။
   */
  if (
    /\.(?:png|jpe?g|gif|webp|svg)(?:$|[?#])/i.test(
      url.toString()
    )
  ) {
    return;
  }

  const key = url.toString();

  if (!results.has(key)) {
    results.set(key, key);
  }
}

function isLikelyMediaUrl(url) {
  const value =
    url.toString().toLowerCase();

  return (
    /\.(?:m3u8|mp4)(?:$|[?#])/i.test(value) ||
    /[?&](?:file|url|src|source)=[^&]*(?:m3u8|mp4)/i.test(
      value
    )
  );
}

function getCandidateScore(value) {
  const url =
    String(value).toLowerCase();

  let score = 0;

  if (/\.m3u8(?:$|[?#])/.test(url)) {
    score += 100;
  }

  if (/\.mp4(?:$|[?#])/.test(url)) {
    score += 90;
  }

  if (url.includes("/data")) {
    score += 10;
  }

  if (url.includes("/uploads/")) {
    score += 10;
  }

  if (url.includes("poster")) {
    score -= 100;
  }

  return score;
}

async function verifyCandidates(
  candidates,
  refererUrl
) {
  const limitedCandidates =
    candidates.slice(0, 8);

  if (limitedCandidates.length === 0) {
    return null;
  }

  const requests =
    limitedCandidates.map((candidate) =>
      probeMediaUrl(
        candidate,
        refererUrl
      )
    );

  try {
    return await Promise.any(requests);
  } catch {
    return null;
  }
}

async function probeMediaUrl(
  candidate,
  refererUrl
) {
  const target = new URL(candidate);
  const referer = new URL(refererUrl);

  const response = await fetchWithTimeout(
    target.toString(),
    {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept":
          "video/*,application/vnd.apple.mpegurl," +
          "application/x-mpegURL,*/*;q=0.8",
        "Referer": referer.toString(),
        "Origin": referer.origin,
        "Range": "bytes=0-2047",
        "Accept-Encoding": "identity",
      },
    },
    PROBE_TIMEOUT_MS
  );

  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // Ignore body cancel failure
    }

    throw new Error(
      `Media probe returned HTTP ${response.status}`
    );
  }

  const contentType =
    response.headers.get("Content-Type") ||
    "";

  const finalUrl =
    response.url || target.toString();

  const validByType =
    /video\/|audio\/|mpegurl|octet-stream/i.test(
      contentType
    );

  const validByUrl =
    /\.(?:m3u8|mp4)(?:$|[?#])/i.test(
      finalUrl
    );

  const isHtml =
    /text\/html|application\/xhtml/i.test(
      contentType
    );

  try {
    await response.body?.cancel();
  } catch {
    // Ignore body cancel failure
  }

  if (
    isHtml ||
    (!validByType && !validByUrl)
  ) {
    throw new Error(
      `Unexpected media content type: ${
        contentType || "unknown"
      }`
    );
  }

  return {
    url: finalUrl,
    contentType:
      contentType ||
      inferContentType(finalUrl),
  };
}

function makeResult({
  filecode,
  directUrl,
  pageUrl,
  title,
  contentType,
  verified,
}) {
  const direct = new URL(directUrl);
  const page = new URL(pageUrl);

  return {
    provider: "turbovids",
    filecode,

    title: title || null,
    thumbnail: null,
    subtitles: [],

    streaming_url: direct.toString(),

    content_type:
      contentType ||
      inferContentType(
        direct.toString()
      ),

    stream_type:
      /\.m3u8(?:$|[?#])/i.test(
        direct.toString()
      )
        ? "hls"
        : /\.mp4(?:$|[?#])/i.test(
            direct.toString()
          )
        ? "mp4"
        : "unknown",

    embed_url: page.toString(),
    referer_url: page.toString(),
    embed_host: page.origin,

    verified,
    resolved_at:
      Math.floor(Date.now() / 1000),
  };
}

function inferContentType(value) {
  const url = String(value || "");

  if (/\.m3u8(?:$|[?#])/i.test(url)) {
    return "application/vnd.apple.mpegurl";
  }

  if (/\.mp4(?:$|[?#])/i.test(url)) {
    return "video/mp4";
  }

  return null;
}

function extractTitle(html) {
  const match = String(html).match(
    /<title\b[^>]*>([\s\S]*?)<\/title>/i
  );

  if (!match) {
    return null;
  }

  const title = decodeHtmlEntities(
    match[1]
  )
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return title
    ? title.slice(0, 500)
    : null;
}

function normalizeEscapedText(value) {
  return String(value || "")
    .replace(/\\\//g, "/")
    .replace(/\\u002f/gi, "/")
    .replace(/\\u003a/gi, ":")
    .replace(/\\u0026/gi, "&")
    .replace(/\\x2f/gi, "/")
    .replace(/\\x3a/gi, ":")
    .replace(/\\x26/gi, "&");
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
    .replace(/&#x26;/gi, "&")
    .replace(
      /&#(\d+);/g,
      (match, code) => {
        const number = Number(code);

        if (
          !Number.isInteger(number) ||
          number < 0 ||
          number > 0x10ffff
        ) {
          return match;
        }

        try {
          return String.fromCodePoint(number);
        } catch {
          return match;
        }
      }
    );
}

async function fetchWithTimeout(
  url,
  init,
  timeoutMs
) {
  const controller =
    new AbortController();

  const timeout = setTimeout(() => {
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
    "https://turbovids-stream-cache.invalid";

  try {
    if (cacheOrigin) {
      origin =
        new URL(cacheOrigin).origin;
    }
  } catch {
    // Internal fallback origin
  }

  return new Request(
    `${origin}/__turbovids_stream_cache/${encodeURIComponent(
      filecode
    )}`,
    {
      method: "GET",
    }
  );
}

async function readStreamCache(cacheKey) {
  if (
    typeof caches === "undefined" ||
    !caches.default
  ) {
    return null;
  }

  try {
    const response =
      await caches.default.match(cacheKey);

    if (!response || !response.ok) {
      return null;
    }

    const data =
      await response.json();

    if (!data?.streaming_url) {
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

  const response = new Response(
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
    // Cache failure ကို ignore လုပ်မယ်
  }
}

function safeError(error) {
  if (error instanceof Error) {
    return error.message.slice(0, 600);
  }

  return String(error).slice(0, 600);
}
