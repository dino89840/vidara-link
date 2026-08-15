const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Safari/537.36";

/**
 * Vidara URL သို့မဟုတ် bare filecode ကနေ filecode ထုတ်ပေးမယ်။
 */
export function getVidaraFilecode(input) {
  const value = String(input || "").trim();

  if (!value) {
    return null;
  }

  // Bare filecode လက်ခံမယ်
  if (/^[A-Za-z0-9]{4,100}$/.test(value)) {
    return value;
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  // တခြား domain တွေ မလက်ခံပါ
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
 * Vidara filecode ကနေ လက်ရှိအသုံးပြုလို့ရတဲ့ m3u8 URL ထုတ်ပေးမယ်။
 *
 * ဒီ function ကို stable pages.dev link ဖွင့်တဲ့အချိန်မှ ခေါ်မယ်။
 */
export async function extractVidara(filecode) {
  if (!/^[A-Za-z0-9]{4,100}$/.test(filecode)) {
    throw new Error("Invalid Vidara filecode");
  }

  const vidaraUrl =
    `https://vidara.to/v/${encodeURIComponent(filecode)}`;

  // ၁။ Vidara page ကို fetch လုပ်မယ်
  const pageRes = await fetch(vidaraUrl, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": USER_AGENT,
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!pageRes.ok) {
    throw new Error(`vidara.to returned HTTP ${pageRes.status}`);
  }

  const html = await pageRes.text();

  // ၂။ iframe src ရှာမယ်
  const embedUrl = findEmbedUrl(html, vidaraUrl);

  if (!embedUrl) {
    throw new Error("Embed iframe not found on Vidara page");
  }

  const embedParsed = new URL(embedUrl);
  const embedOrigin = embedParsed.origin;

  // iframe URL ထဲက embed filecode ကိုယူမယ်
  const embedCodeMatch = embedParsed.pathname.match(
    /\/e\/([A-Za-z0-9]+)/i
  );

  const embedFilecode = embedCodeMatch
    ? embedCodeMatch[1]
    : filecode;

  // ၃။ Embed host ရဲ့ stream API ကိုခေါ်မယ်
  const apiRes = await fetch(`${embedOrigin}/api/stream`, {
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
  });

  const responseText = await apiRes.text();

  if (!apiRes.ok) {
    throw new Error(
      `Stream API returned HTTP ${apiRes.status}: ` +
      responseText.slice(0, 200)
    );
  }

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Stream API returned invalid JSON: ${responseText.slice(0, 200)}`
    );
  }

  if (!data || !data.streaming_url) {
    throw new Error("No streaming_url in Stream API response");
  }

  let streamingUrl;

  try {
    streamingUrl = new URL(data.streaming_url);
  } catch {
    throw new Error("Stream API returned an invalid streaming URL");
  }

  if (
    streamingUrl.protocol !== "https:" &&
    streamingUrl.protocol !== "http:"
  ) {
    throw new Error("Unsupported streaming URL protocol");
  }

  return {
    filecode,
    embed_filecode: embedFilecode,
    title: data.title || null,
    thumbnail: data.thumbnail || null,
    streaming_url: streamingUrl.toString(),
    subtitles: Array.isArray(data.subtitles)
      ? data.subtitles
      : [],
    embed_host: embedOrigin,
  };
}

function findEmbedUrl(html, pageUrl) {
  const iframeRegex =
    /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;

  let match;

  while ((match = iframeRegex.exec(html)) !== null) {
    const rawSrc = decodeHtmlEntities(match[1].trim());

    try {
      const iframeUrl = new URL(rawSrc, pageUrl);

      if (
        (iframeUrl.protocol === "https:" ||
          iframeUrl.protocol === "http:") &&
        /\/e\/[A-Za-z0-9]+/i.test(iframeUrl.pathname)
      ) {
        return iframeUrl.toString();
      }
    } catch {
      // Invalid iframe URL ဖြစ်ရင် နောက်တစ်ခုဆက်ရှာမယ်
    }
  }

  return null;
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}
