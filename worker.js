export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return handleOptions(req);

    // root info
    if (url.pathname === "/" && req.method === "GET") {
      return new Response(
        JSON.stringify({
          success: true,
          discord: "https://discord.gg/cwDTVKyKJz",
          website: "https://ish.junioralive.in",
          repo: "https://github.com/junioralive/gptoss-proxy",
        }),
        { status: 200, headers: corsHeaders({ "content-type": "application/json" }) }
      );
    }

    // OpenAI-like: list models
    if (url.pathname === "/v1/models" && req.method === "GET") {
      return listModels();
    }

    // OpenAI-compatible chat completions (single endpoint)
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      return openAICompatible(req);
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: corsHeaders({ "content-type": "application/json" }),
    });
  },
};

/* ----------------------- constants ----------------------- */

const GPT_OSS_URL = "https://api.gpt-oss.com/chatkit";
const SUPPORTED_MODELS = new Set(["gpt-oss-120b", "gpt-oss-20b"]);

const BASE_HEADERS = {
  accept: "text/event-stream",
  "accept-language": "ms-MY,ms;q=0.9,en-US;q=0.8,en;q=0.7,id;q=0.6",
  "content-type": "application/json",
  origin: "https://gpt-oss.com",
  referer: "https://gpt-oss.com/",
  "sec-ch-ua": '"Not A(Brand";v="8", "Chromium";v="132"',
  "sec-ch-ua-mobile": "?1",
  "sec-ch-ua-platform": '"Android"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-site",
  // match original UA quirks
  "user-agent":
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTMLFg, silike FGeckosi) Chrome/132.0.0.0 Mobile Safari/537.36.fgsi",
  "x-selected-model": "gpt-oss-120b",
  // NOTE: we no longer hardcode x-show-reasoning here; we set it per-request below
};

/* ----------------------- helpers ----------------------- */

function corsHeaders(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers":
      // added x-show-reasoning to allow client override
      "content-type, x-reasoning-effort, x-gptoss-thread-id, x-gptoss-user-id, x-show-reasoning, authorization",
    "access-control-expose-headers": "x-gptoss-user-id, x-gptoss-thread-id",
    ...extra,
  };
}

function handleOptions(_req) {
  return new Response(null, { headers: corsHeaders() });
}

function getReasoningLevel(bodyMeta, headers) {
  const hdr =
    headers.get("X-Reasoning-Effort") ||
    headers.get("x-reasoning-effort") ||
    "";
  const meta =
    bodyMeta && typeof bodyMeta === "object" ? bodyMeta.reasoning_effort : "";
  const level = (hdr || meta || "medium").toLowerCase();
  return ["none", "low", "medium", "high"].includes(level) ? level : "medium";
}

// NEW: show reasoning (default = true). Clients can override via header or metadata.
function getShowReasoning(bodyMeta, headers) {
  const hdr = (headers.get("X-Show-Reasoning") || headers.get("x-show-reasoning") || "").toLowerCase();
  if (hdr === "true" || hdr === "1" || hdr === "yes") return true;
  if (hdr === "false" || hdr === "0" || hdr === "no") return false;
  const meta = bodyMeta && typeof bodyMeta === "object" ? bodyMeta.show_reasoning : undefined;
  if (typeof meta === "boolean") return meta;
  return true; // default: ON
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") {
      const c = m.content;
      if (Array.isArray(c)) {
        return c
          .map((p) =>
            typeof p === "object" && (p.type === undefined || p.type === "text")
              ? p.text ?? ""
              : typeof p === "string"
              ? p
              : ""
          )
          .join("");
      }
      return typeof c === "string" ? c : JSON.stringify(c ?? "");
    }
  }
  return "";
}

function sseResponseHeaders() {
  return {
    ...corsHeaders(),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
}

function cryptoRandomId(n) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

// filters trivial recaps (e.g., "Done")
function isTrivialReasoning(text) {
  if (!text) return true;
  const t = String(text).trim().toLowerCase();
  return t === "" || t === "done";
}

/* ----------------------- /v1/models ----------------------- */

function listModels() {
  const now = Math.floor(Date.now() / 1000);
  const models = [...SUPPORTED_MODELS].map((id) => ({
    id,
    object: "model",
    created: now,
    owned_by: "gpt-oss",
    permission: [],
    root: id,
    parent: null,
  }));
  return new Response(
    JSON.stringify({ object: "list", data: models }),
    { status: 200, headers: corsHeaders({ "content-type": "application/json" }) }
  );
}

/* --------------- /v1/chat/completions (OpenAI) --------------- */

async function openAICompatible(req) {
  const body = await req.json().catch(() => ({}));
  const model = (body && body.model) || "gpt-oss-120b";
  const stream = Boolean(body && body.stream);
  const messages = (body && Array.isArray(body.messages) && body.messages) || [];
  const metadata = (body && typeof body.metadata === "object" && body.metadata) || {};

  if (!SUPPORTED_MODELS.has(model)) {
    return new Response(
      JSON.stringify({
        error: { message: `Unsupported model: ${model}`, supported: [...SUPPORTED_MODELS] },
      }),
      { status: 400, headers: corsHeaders({ "content-type": "application/json" }) }
    );
  }

  // options
  const reasoning = getReasoningLevel(metadata, req.headers);
  const showReasoning = getShowReasoning(metadata, req.headers); // DEFAULT TRUE
  const threadId = req.headers.get("x-gptoss-thread-id") || metadata.gptoss_thread_id || null;
  const userId = req.headers.get("x-gptoss-user-id") || metadata.gptoss_user_id || null;

  const text = lastUserText(messages);

  const upstreamBody = JSON.stringify({
    op: threadId ? "threads.addMessage" : "threads.create",
    params: {
      input: {
        text,
        content: [{ type: "input_text", text }],
        quoted_text: "",
        attachments: [],
      },
      threadId,
    },
  });

  const headers = {
    ...BASE_HEADERS,
    "x-selected-model": model,
    "x-reasoning-effort": reasoning,
    "x-show-reasoning": showReasoning ? "true" : "false",
  };
  if (userId) headers["cookie"] = `user_id=${userId}`;

  const upstream = await fetch(GPT_OSS_URL, {
    method: "POST",
    headers,
    body: upstreamBody,
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(
      JSON.stringify({ error: `Upstream ${upstream.status}` }),
      { status: 502, headers: corsHeaders({ "content-type": "application/json" }) }
    );
  }

  const created = Math.floor(Date.now() / 1000);
  const openaiId = `chatcmpl_${cryptoRandomId(24)}`;

  if (!stream) {
    const aggregated = await collectFromSSE(upstream.body);
    const resp = {
      id: openaiId,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: aggregated.textOut },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null },
      system_fingerprint: JSON.stringify({
        gptoss_thread_id: aggregated.threadOut,
        reasoning_joined: aggregated.reasoningOut.join("\n"),
      }),
    };
    return new Response(JSON.stringify(resp), {
      status: 200,
      headers: corsHeaders({ "content-type": "application/json" }),
    });
  }

  // streaming transform (GPT-OSS SSE -> OpenAI SSE)
  const streamOut = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      // initial empty delta
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id: openaiId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: null }],
          })}\n\n`
        )
      );

      let buffer = "";
      const reader = upstream.body.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          let nl;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);

            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (!payload || payload === "[DONE]") continue;

            let evt;
            try {
              evt = JSON.parse(payload);
            } catch {
              continue;
            }

            // reasoning: cot.entry_added -> reasoning_content
            if (
              evt &&
              evt.type === "thread.item_updated" &&
              evt.update &&
              evt.update.type === "cot.entry_added"
            ) {
              const entry = evt.update.entry || {};
              const rtext = (entry.content || entry.summary || "").trim();
              if (!isTrivialReasoning(rtext)) {
                const chunk = {
                  id: openaiId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [
                    { index: 0, delta: { reasoning_content: rtext }, finish_reason: null },
                  ],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
              continue;
            }

            // content deltas
            const isDeltaType =
              evt &&
              (evt.type === "assistant_message.content_part.text_delta" ||
                (evt.type === "thread.item_updated" &&
                  evt.update &&
                  evt.update.type === "assistant_message.content_part.text_delta"));

            if (isDeltaType) {
              const delta = evt.delta !== undefined ? evt.delta : evt.update ? evt.update.delta : undefined;
              if (typeof delta === "string" && delta.length > 0) {
                const chunk = {
                  id: openaiId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
              continue;
            }

            // finish
            if (evt && evt.type === "thread.item_done" && evt.item && evt.item.type === "assistant_message") {
              const end = {
                id: openaiId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(end)}\n\n`));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            }
          }
        }
      } catch (_e) {
        // ignore
      } finally {
        controller.close();
      }
    },
  });

  return new Response(streamOut, {
    status: 200,
    headers: sseResponseHeaders(),
  });
}

/* ----------------------- SSE aggregation ----------------------- */

async function collectFromSSE(body) {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let textOut = "";
  const reasoningOut = [];
  let threadOut = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);

      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;

      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }

      if (!threadOut) {
        if (evt && evt.threadId) threadOut = evt.threadId;
        else if (evt && evt.thread && evt.thread.id) threadOut = evt.thread.id;
      }

      if (
        evt &&
        evt.type === "thread.item_updated" &&
        evt.update &&
        evt.update.type === "cot.entry_added"
      ) {
        const entry = evt.update.entry || {};
        const rtext = (entry.content || entry.summary || "").trim();
        if (!isTrivialReasoning(rtext)) reasoningOut.push(rtext);
        continue;
      }

      const isDeltaType =
        evt &&
        (evt.type === "assistant_message.content_part.text_delta" ||
          (evt.type === "thread.item_updated" &&
            evt.update &&
            evt.update.type === "assistant_message.content_part.text_delta"));

      if (isDeltaType) {
        const delta = evt.delta !== undefined ? evt.delta : evt.update ? evt.update.delta : "";
        if (typeof delta === "string") textOut += delta;
      }
    }
  }

  return { textOut, reasoningOut, threadOut };
}
