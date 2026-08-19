import {
  getVidaraFilecode,
  extractVidara,
} from "./vidara.js";

import {
  getStreamtapeFilecode,
  extractStreamtape,
} from "./streamtape.js";

export function parseSourceInput(input) {
  const value = String(input || "").trim();

  if (!value) {
    return null;
  }

  /*
   * URL ဖြစ်ရင် host အလိုက်စစ်မယ်။
   * Bare filecode ကိုတော့ provider မသေချာလို့
   * Vidara အဖြစ် default မလုပ်တော့ပါ။
   */
  let parsedUrl = null;

  try {
    parsedUrl = new URL(value);
  } catch {
    // Not a URL
  }

  if (parsedUrl) {
    const hostname =
      parsedUrl.hostname.toLowerCase();

    if (
      hostname === "vidara.to" ||
      hostname === "www.vidara.to"
    ) {
      const filecode =
        getVidaraFilecode(value);

      if (!filecode) {
        return null;
      }

      return {
        provider: "vidara",
        filecode,
        source_url:
          `https://vidara.to/v/` +
          encodeURIComponent(filecode),
      };
    }

    if (
      hostname === "streamtape.com" ||
      hostname === "www.streamtape.com" ||
      hostname === "streamta.pe" ||
      hostname === "www.streamta.pe" ||
      hostname ===
        "streamtapeadblockuser.art" ||
      hostname ===
        "www.streamtapeadblockuser.art"
    ) {
      const filecode =
        getStreamtapeFilecode(value);

      if (!filecode) {
        return null;
      }

      return {
        provider: "streamtape",
        filecode,
        source_url:
          `https://streamtape.com/v/` +
          encodeURIComponent(filecode) +
          "/",
      };
    }

    return null;
  }

  return null;
}

export async function extractProviderStream(
  provider,
  filecode,
  options = {}
) {
  switch (String(provider).toLowerCase()) {
    case "vidara":
      return extractVidara(filecode, options);

    case "streamtape":
      return extractStreamtape(
        filecode,
        options
      );

    default:
      throw new Error(
        `Unsupported provider: ${provider}`
      );
  }
}

export function getProviderReferer(
  provider,
  stream,
  filecode
) {
  if (stream?.referer_url) {
    return stream.referer_url;
  }

  if (stream?.embed_url) {
    return stream.embed_url;
  }

  if (provider === "streamtape") {
    return (
      `https://streamtape.com/e/` +
      encodeURIComponent(filecode) +
      "/"
    );
  }

  if (stream?.embed_host) {
    return (
      `${stream.embed_host}/e/` +
      encodeURIComponent(
        stream.embed_filecode || filecode
      )
    );
  }

  return (
    `https://vidara.to/e/` +
    encodeURIComponent(filecode)
  );
}
