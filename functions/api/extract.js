// functions/api/extract.js
// GET /api/extract?url=https://vidara.to/v/XXXX
// GET /api/extract?id=XXXX
// returns: { streaming_url, title, thumbnail, subtitles }

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);

  let filecode = url.searchParams.get("id");
  const inputUrl = url.searchParams.get("url");

  // URL ကနေ filecode ထုတ်
  if (!filecode && inputUrl) {
    const m = inputUrl.match(/\/(?:v|e|f|d)\/([A-Za-z0-9]+)/i);
    if (m) filecode = m[1];
  }

  if (!filecode) {
    return json({ error: "Missing ?url= or ?id= parameter" }, 400);
  }

  try {
    // ၁။ vidara.to က page ကို fetch လုပ်ပြီး iframe embed URL ကို ရှာ
    const vidaraUrl = `https://vidara.to/v/${filecode}`;
    const pageRes = await fetch(vidaraUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
    });

    if (!pageRes.ok) {
      return json({ error: `vidara.to returned ${pageRes.status}` }, 502);
    }

    const html = await pageRes.text();

    // iframe src ရှာ:  <iframe src="https://merivo.fit/e/XXXX" ...>
    const iframeMatch = html.match(
      /<iframe[^>]+src=["'](https?:\/\/[^"']+\/e\/[A-Za-z0-9]+)["']/i
    );

    if (!iframeMatch) {
      return json({ error: "Embed iframe not found on vidara page" }, 404);
    }

    const embedUrl = iframeMatch[1];
    const embedOrigin = new URL(embedUrl).origin; // e.g. https://merivo.fit

    // ၂။ embed origin ရဲ့ /api/stream ကို POST လုပ်
    const apiRes = await fetch(`${embedOrigin}/api/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Referer": embedUrl,
        "Origin": embedOrigin,
        "Accept": "application/json",
      },
      body: JSON.stringify({
        filecode: filecode,
        device: "web",
      }),
    });

    if (!apiRes.ok) {
      const txt = await apiRes.text();
      return json(
        { error: `Stream API ${apiRes.status}`, detail: txt.slice(0, 300) },
        502
      );
    }

    const data = await apiRes.json();

    if (!data.streaming_url) {
      return json(
        { error: "No streaming_url in response", raw: data },
        404
      );
    }

    return json({
      ok: true,
      filecode,
      title: data.title || null,
      thumbnail: data.thumbnail || null,
      streaming_url: data.streaming_url,
      subtitles: data.subtitles || [],
      embed_host: embedOrigin,
    });
  } catch (err) {
    return json({ error: "Server error", detail: String(err) }, 500);
  }
}

// CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(),
    },
  });
}
