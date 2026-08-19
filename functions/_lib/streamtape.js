const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Safari/537.36";

const PAGE_TIMEOUT_MS = 10000;
const PROBE_TIMEOUT_MS = 12000;

const MAX_ROUNDS = 4;
const CACHE_TTL_SECONDS = 20;

const STREAMTAPE_HOSTS = new Set([
  "streamtape.com",
  "www.streamtape.com",
  "streamta.pe",
  "www.streamta.pe",
  "streamtapeadblockuser.art",
  "www.streamtapeadblockuser.art",
]);

const LINK_ELEMENT_IDS = [
  "robotlink",
  "norobotlink",
  "botlink",
  "ideoolink",
  "ideoooolink",
  "videolink",
  "vidlink",
];

const pendingExtractions = new Map();

/**
 * Streamtape URL သို့မဟုတ် bare filecode ကနေ ID ထုတ်ပေးမယ်။
 */
export function getStreamtapeFilecode(input) {
  const value = String(input || "").trim();

  if (!value) {
    return null;
  }

  // Bare Streamtape filecode
  if (/^[A-Za-z0-9_-]{6,100}$/.test(value)) {
    return value;
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();

  if (!STREAMTAPE_HOSTS.has(hostname)) {
    return null;
  }

  const match = parsed.pathname.match(
    /^\/(?:v|e)\/([A-Za-z0-9_-]{6,100})(?:\/|$)/i
  );

  return match ? match[1] : null;
}

/**
 * Streamtape ID ကနေ direct video URL ရှာမယ်။
 */
export async function extractStreamtape(
  filecode,
  options = {}
) {
  if (!/^[A-Za-z0-9_-]{6,100}$/.test(filecode)) {
    throw new Error("Invalid Streamtape filecode");
  }

  const cacheKey = createCacheKey(
    filecode,
    options.cacheOrigin
  );

  const cached = await readStreamCache(cacheKey);

  if (cached) {
    return {
      ...cached,
      cache_status: "HIT",
    };
  }

  if (pendingExtractions.has(filecode)) {
    return pendingExtractions.get(filecode);
  }

  const extractionPromise = extractFresh(filecode)
    .then((stream) => {
      const cachePromise = writeStreamCache(
        cacheKey,
        stream
      );

      if (typeof options.waitUntil === "function") {
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
  const cookieJar = new Map();
  const errors = [];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const candidates = buildPageCandidates(
      filecode,
      round
    );

    /*
     * Main /v/ page ကိုအရင်ခေါ်မယ်။
     * Set-Cookie ရလာရင် embed requests မှာပြန်သုံးမယ်။
     */
    const mainPage = candidates[0];

    try {
      const page = await fetchStreamtapePage(
        mainPage,
        cookieJar
      );

      const directCandidates =
        extractDirectCandidates(page.html);

      const verified = await verifyCandidates(
        directCandidates,
        page.finalUrl || mainPage
      );

      if (verified) {
        return makeResult(
          filecode,
          verified,
          page.finalUrl || mainPage,
          round + 1
        );
      }
    } catch (error) {
      errors.push(
        `round ${round + 1} main: ${safeError(error)}`
      );
    }

    /*
     * /e/ နှင့် alternate domains တွေကို parallel ခေါ်မယ်။
     */
    const fallbackPages = candidates.slice(1);

    const results = await Promise.allSettled(
      fallbackPages.map((pageUrl) =>
        fetchStreamtapePage(
          pageUrl,
          cookieJar
        )
      )
    );

    for (let index = 0; index < results.length; index++) {
      const result = results[index];

      if (result.status === "rejected") {
        errors.push(
          `round ${round + 1} ${fallbackPages[index]}: ` +
          safeError(result.reason)
        );

        continue;
      }

      const page = result.value;

      try {
        const directCandidates =
          extractDirectCandidates(page.html);

        const verified = await verifyCandidates(
          directCandidates,
          page.finalUrl || fallbackPages[index]
        );

        if (verified) {
          return makeResult(
            filecode,
            verified,
            page.finalUrl || fallbackPages[index],
            round + 1
          );
        }
      } catch (error) {
        errors.push(
          `round ${round + 1} parse: ${safeError(error)}`
        );
      }
    }

    if (round < MAX_ROUNDS - 1) {
      await delay(150 * (round + 1));
    }
  }

  const detail = errors
    .slice(-8)
    .join(" | ")
    .slice(0, 1200);

  throw new Error(
    "Streamtape direct URL could not be resolved. " +
    "The server may have returned a loader or anti-bot page." +
    (detail ? ` Details: ${detail}` : "")
  );
}

function makeResult(
  filecode,
  verified,
  pageUrl,
  attempts
) {
  return {
    provider: "streamtape",
    filecode,
    title: null,
    thumbnail: null,
    subtitles: [],

    streaming_url: verified.url,
    content_type: verified.contentType || null,

    embed_url: pageUrl,
    referer_url: pageUrl,
    embed_host: new URL(pageUrl).origin,

    attempts,
    resolved_at: Math.floor(Date.now() / 1000),
  };
}

function buildPageCandidates(filecode, round) {
  const encoded = encodeURIComponent(filecode);

  const cacheBust =
    `${Date.now().toString(36)}${round}` +
    randomText(5);

  return [
    `https://streamtape.com/v/${encoded}/?st_round=${cacheBust}`,
    `https://streamtape.com/e/${encoded}/?st_round=${cacheBust}`,
    `https://streamta.pe/e/${encoded}/?st_round=${cacheBust}`,
    `https://streamtapeadblockuser.art/e/${encoded}/?st_round=${cacheBust}`,
  ];
}

async function fetchStreamtapePage(
  pageUrl,
  cookieJar
) {
  const headers = new Headers({
    "User-Agent": USER_AGENT,
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9," +
      "image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Referer": "https://streamtape.com/",
  });

  const cookieHeader = serializeCookies(cookieJar);

  if (cookieHeader) {
    headers.set("Cookie", cookieHeader);
  }

  const response = await fetchWithTimeout(
    pageUrl,
    {
      method: "GET",
      redirect: "follow",
      headers,
    },
    PAGE_TIMEOUT_MS
  );

  collectResponseCookies(
    response.headers,
    cookieJar
  );

  /*
   * Streamtape က fake 404 HTML ထဲမှာတောင်
   * လိုအပ်တဲ့ script တစ်ခါတလေ ပါနိုင်လို့
   * response.ok မဟုတ်လည်း body ကိုဖတ်မယ်။
   */
  const html = await response.text();

  if (!html || html.length < 50) {
    throw new Error(
      `Empty Streamtape response, HTTP ${response.status}`
    );
  }

  return {
    status: response.status,
    html,
    finalUrl: response.url || pageUrl,
  };
}

/**
 * HTML/JavaScript ထဲက direct URL candidates ရှာမယ်။
 */
function extractDirectCandidates(html) {
  const results = new Set();

  if (!html) {
    return [];
  }

  const normalizedHtml = decodeHtmlEntities(
    html.replace(/\\\//g, "/")
  );

  /*
   * Strategy 1:
   * document.getElementById(...).innerHTML = expression
   *
   * eval/new Function မသုံးဘဲ string concatenation,
   * substring, substr, slice ကို parser နဲ့ဖြေမယ်။
   */
  const assignmentRegex =
    /(?:document\s*\.\s*)?getElementById\s*\(\s*(["'])([A-Za-z0-9_-]+)\1\s*\)\s*\.\s*(?:innerHTML|href)\s*=/gi;

  let assignmentMatch;

  while (
    (assignmentMatch =
      assignmentRegex.exec(normalizedHtml)) !== null
  ) {
    const elementId =
      assignmentMatch[2].toLowerCase();

    if (
      !LINK_ELEMENT_IDS.includes(elementId) &&
      !elementId.includes("link")
    ) {
      continue;
    }

    const expression = readAssignmentExpression(
      normalizedHtml,
      assignmentRegex.lastIndex
    );

    if (!expression) {
      continue;
    }

    const evaluated =
      safelyEvaluateStringExpression(expression);

    if (evaluated) {
      addDirectCandidate(results, evaluated);
    }

    /*
     * Expression တစ်ခုလုံး parse မရလည်း
     * အထဲက get_video fragment ကိုရှာမယ်။
     */
    findLiteralDirectUrls(expression, results);
  }

  /*
   * Strategy 2:
   * HTML ထဲက hidden element:
   *
   * <div id="ideoooolink">/get_video?id=...</div>
   */
  const hiddenLinkRegex =
    /<(?:div|span|a)\b[^>]*\bid\s*=\s*["']([^"']*link[^"']*)["'][^>]*>([\s\S]*?)<\/(?:div|span|a)>/gi;

  const hiddenBases = [];
  let hiddenMatch;

  while (
    (hiddenMatch = hiddenLinkRegex.exec(
      normalizedHtml
    )) !== null
  ) {
    const text = stripHtml(hiddenMatch[2]).trim();

    if (
      text &&
      (
        /get_video\?/i.test(text) ||
        /[?&]id=[A-Za-z0-9_-]+/i.test(text)
      )
    ) {
      hiddenBases.push(text);
      addDirectCandidate(results, text);
    }
  }

  /*
   * Strategy 3:
   * Any literal get_video URL/path.
   */
  findLiteralDirectUrls(normalizedHtml, results);

  /*
   * Strategy 4:
   * Hidden base URL + token ကိုပြန်ဆက်မယ်။
   */
  const tokens = findTokens(normalizedHtml);

  for (const base of hiddenBases) {
    for (const token of tokens) {
      let joined = base;

      if (/[?&]token=/i.test(joined)) {
        joined = joined.replace(
          /([?&]token=)[A-Za-z0-9_-]*/i,
          `$1${token}`
        );
      } else {
        joined +=
          (joined.includes("?") ? "&" : "?") +
          `token=${token}`;
      }

      addDirectCandidate(results, joined);
    }
  }

  /*
   * Strategy 5:
   * id/expires/ip နဲ့ token တွေကို ပြန်တည်ဆောက်မယ်။
   */
  const baseRegex =
    /(?:get_video\?)?id=([A-Za-z0-9_-]+)&(?:amp;)?expires=(\d+)&(?:amp;)?ip=([A-Za-z0-9_.:-]+)/gi;

  let baseMatch;

  while (
    (baseMatch = baseRegex.exec(normalizedHtml)) !== null
  ) {
    for (const token of tokens) {
      addDirectCandidate(
        results,
        `https://streamtape.com/get_video` +
        `?id=${encodeURIComponent(baseMatch[1])}` +
        `&expires=${encodeURIComponent(baseMatch[2])}` +
        `&ip=${encodeURIComponent(baseMatch[3])}` +
        `&token=${encodeURIComponent(token)}` +
        `&stream=1`
      );
    }
  }

  return [...results];
}

function findLiteralDirectUrls(text, results) {
  const absoluteRegex =
    /(?:https?:)?\/\/[A-Za-z0-9.-]+(?::\d+)?\/get_video\?[^"'<>\\\s)]+/gi;

  let match;

  while ((match = absoluteRegex.exec(text)) !== null) {
    addDirectCandidate(results, match[0]);
  }

  const relativeRegex =
    /(?:\/+)?get_video\?[^"'<>\\\s)]+/gi;

  while ((match = relativeRegex.exec(text)) !== null) {
    addDirectCandidate(results, match[0]);
  }
}

function findTokens(html) {
  const results = new Set();

  const regex =
    /(?:[?&]|&amp;)token=([A-Za-z0-9_-]{4,500})/gi;

  let match;

  while ((match = regex.exec(html)) !== null) {
    results.add(match[1]);
  }

  return [...results];
}

function addDirectCandidate(results, rawValue) {
  if (!rawValue) {
    return;
  }

  let value = decodeHtmlEntities(
    String(rawValue)
      .trim()
      .replace(/\\\//g, "/")
      .replace(/^["']|["']$/g, "")
  );

  if (!value) {
    return;
  }

  if (value.startsWith("//")) {
    value = `https:${value}`;
  } else if (value.startsWith("/")) {
    value = `https://streamtape.com${value}`;
  } else if (!/^https?:\/\//i.test(value)) {
    if (/^get_video\?/i.test(value)) {
      value = `https://streamtape.com/${value}`;
    } else {
      return;
    }
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    return;
  }

  if (
    parsed.protocol !== "https:" &&
    parsed.protocol !== "http:"
  ) {
    return;
  }

  if (!/\/get_video$/i.test(parsed.pathname)) {
    return;
  }

  if (!parsed.searchParams.get("id")) {
    return;
  }

  if (!parsed.searchParams.get("token")) {
    return;
  }

  if (!parsed.searchParams.has("stream")) {
    parsed.searchParams.set("stream", "1");
  }

  results.add(parsed.toString());
}

async function verifyCandidates(
  candidates,
  refererUrl
) {
  let lastFallback = null;

  for (const candidate of candidates) {
    lastFallback = candidate;

    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, PROBE_TIMEOUT_MS);

    try {
      const response = await fetch(candidate, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "*/*",
          "Accept-Encoding": "identity",
          "Referer": refererUrl,
          "Origin": new URL(refererUrl).origin,
          "Range": "bytes=0-1",
        },
      });

      const contentType =
        response.headers.get("Content-Type") || "";

      const finalUrl =
        response.url || candidate;

      try {
        await response.body?.cancel?.();
      } catch {
        // Ignore body cancellation errors
      }

      if (
        (response.status === 200 ||
          response.status === 206) &&
        !/text\/html/i.test(contentType)
      ) {
        return {
          url: finalUrl,
          contentType,
          status: response.status,
        };
      }

      /*
       * တချို့ Streamtape CDN တွေက Range request ကို
       * 416 ပြန်နိုင်ပေမယ့် URL က CDN URL ဖြစ်နေတတ်တယ်။
       */
      if (
        response.status === 416 &&
        isLikelyMediaUrl(finalUrl)
      ) {
        return {
          url: finalUrl,
          contentType,
          status: response.status,
        };
      }
    } catch (error) {
      /*
       * Probe network error ဖြစ်ပေမယ့် parse ရထားတဲ့ URL ကို
       * ချက်ချင်းမပယ်ပါ။ နောက် candidates ကိုအရင်စစ်မယ်။
       */
      if (
        error?.name !== "AbortError" &&
        !controller.signal.aborted
      ) {
        lastFallback = candidate;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /*
   * Candidate ရှိပြီး probe ပဲ network-level မှာ fail သွားရင်
   * parsed URL ကို fallback အဖြစ်သုံးမယ်။
   */
  if (lastFallback) {
    return {
      url: lastFallback,
      contentType: null,
      status: null,
    };
  }

  return null;
}

function isLikelyMediaUrl(value) {
  try {
    const url = new URL(value);

    return (
      /\/get_video$/i.test(url.pathname) ||
      /\.(?:mp4|mkv|webm|m3u8)(?:$|[?#])/i.test(
        url.toString()
      ) ||
      /tapecontent|streamtape/i.test(url.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Assignment ရဲ့ semicolon အထိ quote/parentheses-aware ဖတ်မယ်။
 */
function readAssignmentExpression(
  source,
  startIndex
) {
  let quote = null;
  let escaped = false;
  let depth = 0;

  for (
    let index = startIndex;
    index < source.length;
    index++
  ) {
    const char = source[index];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === quote) {
        quote = null;
      }

      continue;
    }

    if (
      char === "'" ||
      char === '"' ||
      char === "`"
    ) {
      quote = char;
      continue;
    }

    if (char === "(") {
      depth++;
      continue;
    }

    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (char === ";" && depth === 0) {
      return source
        .slice(startIndex, index)
        .trim();
    }

    if (
      (char === "\n" || char === "\r") &&
      depth === 0 &&
      index - startIndex > 4000
    ) {
      break;
    }
  }

  return null;
}

/**
 * Safe grammar:
 *
 * "abc" + ('xyz').substring(1)
 * '//host/get_video?...' + "&token=..."
 *
 * Identifier/function/eval/array/object တွေကိုလက်မခံပါ။
 */
function safelyEvaluateStringExpression(expression) {
  try {
    const parser = new SafeStringParser(expression);
    return parser.parse();
  } catch {
    return null;
  }
}

class SafeStringParser {
  constructor(source) {
    this.source = String(source);
    this.index = 0;
  }

  parse() {
    if (this.source.length > 10000) {
      throw new Error("Expression too long");
    }

    const value = this.parseExpression();

    this.skipWhitespace();

    while (this.peek() === ";") {
      this.index++;
      this.skipWhitespace();
    }

    if (this.index !== this.source.length) {
      throw new Error("Unsupported expression");
    }

    return value;
  }

  parseExpression(stopCharacter = null) {
    let value = this.parseTerm();

    while (true) {
      this.skipWhitespace();

      if (
        stopCharacter &&
        this.peek() === stopCharacter
      ) {
        break;
      }

      if (this.peek() !== "+") {
        break;
      }

      this.index++;
      value += this.parseTerm();

      if (value.length > 20000) {
        throw new Error("Evaluated string too long");
      }
    }

    return value;
  }

  parseTerm() {
    this.skipWhitespace();

    let value;

    const char = this.peek();

    if (char === "'" || char === '"') {
      value = this.parseStringLiteral();
    } else if (char === "(") {
      this.index++;
      value = this.parseExpression(")");

      this.skipWhitespace();

      if (this.peek() !== ")") {
        throw new Error("Missing closing parenthesis");
      }

      this.index++;
    } else {
      throw new Error("Unsupported expression term");
    }

    while (true) {
      this.skipWhitespace();

      if (this.peek() !== ".") {
        break;
      }

      this.index++;
      const method = this.parseIdentifier();

      if (
        method !== "substring" &&
        method !== "substr" &&
        method !== "slice"
      ) {
        throw new Error("Unsupported string method");
      }

      this.skipWhitespace();

      if (this.peek() !== "(") {
        throw new Error("Missing method parenthesis");
      }

      this.index++;

      const first = this.parseNumber();

      this.skipWhitespace();

      let second;

      if (this.peek() === ",") {
        this.index++;
        second = this.parseNumber();
      }

      this.skipWhitespace();

      if (this.peek() !== ")") {
        throw new Error("Missing method closing parenthesis");
      }

      this.index++;

      if (method === "substring") {
        value =
          second === undefined
            ? value.substring(first)
            : value.substring(first, second);
      } else if (method === "substr") {
        value =
          second === undefined
            ? value.substr(first)
            : value.substr(first, second);
      } else {
        value =
          second === undefined
            ? value.slice(first)
            : value.slice(first, second);
      }
    }

    return value;
  }

  parseStringLiteral() {
    const quote = this.peek();
    this.index++;

    let output = "";

    while (this.index < this.source.length) {
      const char = this.source[this.index++];

      if (char === quote) {
        return output;
      }

      if (char !== "\\") {
        output += char;
        continue;
      }

      if (this.index >= this.source.length) {
        throw new Error("Invalid string escape");
      }

      const escaped = this.source[this.index++];

      const simpleEscapes = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        v: "\v",
        0: "\0",
        "\\": "\\",
        "'": "'",
        '"': '"',
        "/": "/",
      };

      if (
        Object.prototype.hasOwnProperty.call(
          simpleEscapes,
          escaped
        )
      ) {
        output += simpleEscapes[escaped];
        continue;
      }

      if (escaped === "x") {
        const hex = this.source.slice(
          this.index,
          this.index + 2
        );

        if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
          throw new Error("Invalid hex escape");
        }

        output += String.fromCharCode(
          parseInt(hex, 16)
        );

        this.index += 2;
        continue;
      }

      if (escaped === "u") {
        const hex = this.source.slice(
          this.index,
          this.index + 4
        );

        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
          throw new Error("Invalid unicode escape");
        }

        output += String.fromCharCode(
          parseInt(hex, 16)
        );

        this.index += 4;
        continue;
      }

      output += escaped;
    }

    throw new Error("Unterminated string literal");
  }

  parseIdentifier() {
    this.skipWhitespace();

    const start = this.index;

    while (
      /[A-Za-z]/.test(this.peek() || "")
    ) {
      this.index++;
    }

    if (start === this.index) {
      throw new Error("Expected identifier");
    }

    return this.source.slice(start, this.index);
  }

  parseNumber() {
    this.skipWhitespace();

    const start = this.index;

    if (
      this.peek() === "-" ||
      this.peek() === "+"
    ) {
      this.index++;
    }

    while (/\d/.test(this.peek() || "")) {
      this.index++;
    }

    const value = this.source.slice(
      start,
      this.index
    );

    if (!/^[+-]?\d+$/.test(value)) {
      throw new Error("Expected number");
    }

    return Number(value);
  }

  skipWhitespace() {
    while (
      /\s/.test(this.peek() || "")
    ) {
      this.index++;
    }
  }

  peek() {
    return this.source[this.index];
  }
}

function collectResponseCookies(
  headers,
  cookieJar
) {
  const combined = headers.get("Set-Cookie");

  if (!combined) {
    return;
  }

  /*
   * Cloudflare Headers မှာ Set-Cookie စုထားနိုင်လို့
   * cookie-name=value အစိတ်အပိုင်းတွေကိုပဲယူမယ်။
   */
  const regex =
    /(?:^|,\s*)([!#$%&'*+\-.^_`|~0-9A-Za-z]+)=([^;,\r\n]*)/g;

  let match;

  while ((match = regex.exec(combined)) !== null) {
    const name = match[1];
    const value = match[2];

    if (
      name &&
      !/^(?:path|expires|max-age|domain|samesite)$/i.test(
        name
      )
    ) {
      cookieJar.set(name, value);
    }
  }
}

function serializeCookies(cookieJar) {
  return [...cookieJar.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

async function fetchWithTimeout(
  url,
  init,
  timeoutMs
) {
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

function createCacheKey(
  filecode,
  cacheOrigin
) {
  let origin =
    "https://streamtape-stream-cache.invalid";

  try {
    if (cacheOrigin) {
      origin = new URL(cacheOrigin).origin;
    }
  } catch {
    // Use internal cache origin
  }

  return new Request(
    `${origin}/__streamtape_stream_cache/` +
    encodeURIComponent(filecode),
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
          `public, max-age=${CACHE_TTL_SECONDS}`,
      },
    }
  );

  try {
    await caches.default.put(
      cacheKey,
      response
    );
  } catch {
    // Extraction result remains usable
  }
}

function stripHtml(value) {
  return decodeHtmlEntities(
    value.replace(/<[^>]*>/g, "")
  );
}

function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x2F;/gi, "/");
}

function randomText(length) {
  const alphabet =
    "abcdefghijklmnopqrstuvwxyz0123456789";

  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);

  let output = "";

  for (const byte of bytes) {
    output += alphabet[byte % alphabet.length];
  }

  return output;
}

function delay(milliseconds) {
  if (
    globalThis.scheduler &&
    typeof globalThis.scheduler.wait === "function"
  ) {
    return globalThis.scheduler.wait(milliseconds);
  }

  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function safeError(error) {
  if (error instanceof Error) {
    return error.message.slice(0, 500);
  }

  return String(error).slice(0, 500);
}
