const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Safari/537.36";

const PAGE_TIMEOUT_MS = 8000;
const API_TIMEOUT_MS = 8000;
const STREAM_CACHE_TTL = 15;

// Worker isolate တစ်ခုအတွင်း request တူတွေကို ထပ်မလုပ်စေရန်
const pendingExtractions = new Map();

/**
 * Vidara URL သို့မဟုတ် bare filecode ကနေ filecode ထုတ်ပေးမယ်။
 */
export function getVidaraFilecode(input) {
  const value = String(input || "").trim();

  if (!value) {
    return null;
  }

  // Bare filecode
  if (/^[A-Za-z0-9]{4,100}$/.test(value)) {
    return value;
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();

  if (hostname !== "vidara.to" && hostname !== "www.vidara.to") {
    return null;
  }

  const match = parsed.pathname.match(
    /^\/(?:v|e|f|d)\/([A-Za-z0-9]{4,100})(?:\/|$)/i
  );

  return match ? match[1] : null;
}

/**
 * Vidara filecode ကနေ လက်ရှိအသုံးပြုလို့ရတဲ့ streaming URL ရှာမယ်။
 *
 * options:
 * - cacheOrigin: Cache API key ပြုလုပ်ဖို့ လက်ရှိ site origin
 * - waitUntil: cache write ကို background မှာလုပ်ဖို့
 */
export async function extractVidara(filecode, options = {}) {
  if (!/^[A-Za-z0-9]{4,100}$/.test(filecode)) {
    throw new Error("Invalid Vidara filecode");
  }

  const cacheKey = createCacheKey(
    filecode,
    options.cacheOrigin
  );

  // Cloudflare edge cache ကို အရင်စစ်မယ်
  const cached = await readStreamCache(cacheKey);

  if (cached) {
    return {
      ...cached,
      cache_status: "HIT",
    };
  }

  /*
   * တူညီတဲ့ filecode ကို request အများကြီးတစ်ချိန်တည်းဝင်ရင်
   * Vidara API ကိုတစ်ခါပဲခေါ်မယ်။
   */
  if (pendingExtractions.has(filecode)) {
    return pendingExtractions.get(filecode);
  }

  const extractionPromise = extractFresh(filecode)
    .then(async (stream) => {
      const cachePromise = writeStreamCache(
        cacheKey,
        stream
      );

      if (typeof options.waitUntil === "function") {
        options.waitUntil(cachePromise);
      } else {
        // Cache write ကြောင့် response နှေးမသွားစေရန်
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

  pendingExtractions.set(filecode, extractionPromise);

  return extractionPromise;
}

async function extractFresh(filecode) {
  const encodedFilecode = encodeURIComponent(filecode);
  const vidaraUrl = `https://vidara.to/v/${encodedFilecode}`;

  // ၁။ Main Vidara page
  const pageRes = await fetchWithTimeout(
    vidaraUrl,
    {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
    },
    PAGE_TIMEOUT_MS
  );

  if (!pageRes.ok) {
    throw new Error(
      `vidara.to returned HTTP ${pageRes.status}`
    );
  }

  const html = await pageRes.text();
  let embedUrls = findEmbedUrls(html, vidaraUrl);

  /*
   * Main page မှာ iframe မတွေ့ရင် /e/ page ကို fallback
   * အနေနဲ့စစ်မယ်။ /e/ page ထဲမှာ JavaScript redirect URL
   * ရှိနိုင်ပါတယ်။
   */
  if (embedUrls.length === 0) {
    const fallbackUrl =
      `https://vidara.to/e/${encodedFilecode}`;

    try {
      const fallbackRes = await fetchWithTimeout(
        fallbackUrl,
        {
          method: "GET",
          redirect: "follow",
          headers: {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
        },
        PAGE_TIMEOUT_MS
      );

      if (fallbackRes.ok) {
        const fallbackHtml = await fallbackRes.text();

        embedUrls = findEmbedUrls(
          fallbackHtml,
          fallbackUrl
        );
      }
    } catch {
      // Fallback မအောင်မြင်လည်း အောက်မှာ proper error ပြန်မယ်
    }
  }

  if (embedUrls.length === 0) {
    throw new Error(
      "Embed iframe or redirect URL not found"
    );
  }

  /*
   * Embed candidate တစ်ခုထက်ပိုရှိရင် parallel ခေါ်မယ်။
   * အရင်ဆုံးအောင်မြင်တဲ့ API response ကိုယူမယ်။
   */
  const requests = embedUrls.map((embedUrl) =>
    requestStreamApi(embedUrl, filecode)
  );

  try {
    return await Promise.any(requests);
  } catch (error) {
    const messages =
      error instanceof AggregateError
        ? error.errors
            .map((item) => safeError(item))
            .join(" | ")
        : safeError(error);

    throw new Error(
      `All stream API requests failed: ${messages}`.slice(
        0,
        800
      )
    );
  }
}

async function requestStreamApi(embedUrl, fallbackFilecode) {
  const embedParsed = new URL(embedUrl);
  const embedOrigin = embedParsed.origin;

  const embedCodeMatch = embedParsed.pathname.match(
    /\/e\/([A-Za-z0-9]{4,100})(?:\/|$)/i
  );

  const embedFilecode = embedCodeMatch
    ? embedCodeMatch[1]
    : fallbackFilecode;

  const apiUrl = new URL("/api/stream", embedOrigin);

  /*
   * iframe URL မှာ permanentToken စတဲ့ query ရှိရင်
   * stream API ဆီဆက်ပို့မယ်။
   */
  for (const [key, value] of embedParsed.searchParams) {
    if (
      key.toLowerCase() !== "filecode" &&
      key.length <= 100 &&
      value.length <= 2000
    ) {
      apiUrl.searchParams.set(key, value);
    }
  }

  const apiRes = await fetchWithTimeout(
    apiUrl.toString(),
    {
      method: "POST",
      redirect: "follow",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "Referer": embedUrl,
        "Origin": embedOrigin,
        "Accept": "application/json, text/plain, */*",
      },
      body: JSON.stringify({
        filecode: embedFilecode,
        device: "web",
      }),
    },
    API_TIMEOUT_MS
  );

  const responseText = await apiRes.text();

  if (!apiRes.ok) {
    throw new Error(
      `${embedOrigin} returned HTTP ${apiRes.status}: ` +
      responseText.slice(0, 200)
    );
  }

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `${embedOrigin} returned invalid JSON: ` +
      responseText.slice(0, 200)
    );
  }

  if (!data || !data.streaming_url) {
    throw new Error(
      `${embedOrigin} returned no streaming_url`
    );
  }

  let streamingUrl;

  try {
    streamingUrl = new URL(data.streaming_url);
  } catch {
    throw new Error(
      "Stream API returned an invalid streaming URL"
    );
  }

  if (
    streamingUrl.protocol !== "https:" &&
    streamingUrl.protocol !== "http:"
  ) {
    throw new Error(
      "Unsupported streaming URL protocol"
    );
  }

  return {
    filecode: fallbackFilecode,
    embed_filecode: embedFilecode,
    title:
      typeof data.title === "string"
        ? data.title
        : null,
    thumbnail:
      typeof data.thumbnail === "string"
        ? data.thumbnail
        : null,
    streaming_url: streamingUrl.toString(),
    subtitles: Array.isArray(data.subtitles)
      ? data.subtitles
      : [],
    embed_url: embedUrl,
    embed_host: embedOrigin,
    resolved_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * iframe src နဲ့ JavaScript redirect URL နှစ်မျိုးလုံးရှာမယ်။
 */
function findEmbedUrls(html, pageUrl) {
  const results = new Set();

  const iframeRegex =
    /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;

  let match;

  while ((match = iframeRegex.exec(html)) !== null) {
    addEmbedCandidate(
      results,
      decodeHtmlEntities(match[1].trim()),
      pageUrl
    );
  }

  /*
   * ဥပမာ:
   * window.location.href = 'https://example.com/e/filecode'
   * location.href = "..."
   */
  const redirectRegex =
    /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/gi;

  while ((match = redirectRegex.exec(html)) !== null) {
    addEmbedCandidate(
      results,
      decodeHtmlEntities(match[1].trim()),
      pageUrl
    );
  }

  /*
   * HTML/JS ထဲမှာ direct /e/filecode URL ရှိပေမယ့်
   * iframe syntax မဟုတ်တဲ့အခြေအနေအတွက် fallback။
   */
  const directEmbedRegex =
    /https?:\/\/[A-Za-z0-9.-]+(?::\d+)?\/e\/[A-Za-z0-9]{4,100}(?:\?[^"'<>\\\s]*)?/gi;

  while ((match = directEmbedRegex.exec(html)) !== null) {
    addEmbedCandidate(results, match[0], pageUrl);
  }

  return [...results];
}

function addEmbedCandidate(results, rawUrl, pageUrl) {
  try {
    const url = new URL(rawUrl, pageUrl);

    if (
      (url.protocol === "https:" ||
        url.protocol === "http:") &&
      /\/e\/[A-Za-z0-9]{4,100}(?:\/|$)/i.test(
        url.pathname
      )
    ) {
      results.add(url.toString());
    }
  } catch {
    // Invalid URL ကိုကျော်မယ်
  }
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();

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

function createCacheKey(filecode, cacheOrigin) {
  let origin = "https://vidara-stream-cache.invalid";

  try {
    if (cacheOrigin) {
      origin = new URL(cacheOrigin).origin;
    }
  } catch {
    // Default internal origin ကိုသုံးမယ်
  }

  return new Request(
    `${origin}/__vidara_stream_cache/${encodeURIComponent(
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

    const data = await response.json();

    if (!data?.streaming_url) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

async function writeStreamCache(cacheKey, stream) {
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
    await caches.default.put(cacheKey, response);
  } catch {
    // Cache fail ဖြစ်လည်း extraction result ကိုသုံးလို့ရမယ်
  }
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x2F;/gi, "/");
}

function safeError(error) {
  if (error instanceof Error) {
    return error.message.slice(0, 500);
  }

  return String(error).slice(0, 500);
}
