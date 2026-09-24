// Talks to whichever AI provider you point it at.
//
//   openai   any OpenAI-compatible endpoint: OpenAI, Azure OpenAI's /openai/v1,
//            DeepSeek, Groq, Mistral, OpenRouter, Together, Ollama, LM Studio…
//   azure    older Azure OpenAI resources (/openai/deployments/... with an api-key header)
//   anthropic  api.anthropic.com
//   gemini   Google's own generativelanguage endpoint
//
// Leave the format as "auto" and it works the shape out from the address.

function detect(base, forced) {
  const f = (forced || "auto").toLowerCase();
  if (f !== "auto" && f !== "") return f;
  if (/api\.anthropic\.com/i.test(base)) return "anthropic";
  if (/generativelanguage\.googleapis\.com/i.test(base)) return "gemini";
  if (/\.(openai\.azure\.com|services\.ai\.azure\.com|cognitiveservices\.azure\.com)/i.test(base) && !/\/openai\/v1\/?$/i.test(base)) return "azure";
  return "openai";
}

// ---------- message shapes ----------
// Everything is written in the OpenAI shape and converted here, so the rest of
// the app never needs to care which provider is in use.
function splitSystem(messages) {
  const system = messages.filter(m => m.role === "system").map(m => typeof m.content === "string" ? m.content : "").join("\n\n");
  return { system, rest: messages.filter(m => m.role !== "system") };
}
const dataUrlParts = url => {
  const m = String(url).match(/^data:([^;]+);base64,(.*)$/);
  return m ? { mime: m[1], data: m[2] } : null;
};

function toAnthropic(messages, maxTokens, temperature, model) {
  const { system, rest } = splitSystem(messages);
  return {
    model, max_tokens: maxTokens, temperature, system: system || undefined,
    messages: rest.map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: typeof m.content === "string" ? m.content : m.content.map(p => {
        if (p.type === "text") return { type: "text", text: p.text };
        const img = dataUrlParts(p.image_url && p.image_url.url);
        return img ? { type: "image", source: { type: "base64", media_type: img.mime, data: img.data } } : { type: "text", text: "" };
      })
    }))
  };
}

function toGemini(messages, maxTokens, temperature) {
  const { system, rest } = splitSystem(messages);
  return {
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    generationConfig: { maxOutputTokens: maxTokens, temperature },
    contents: rest.map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: typeof m.content === "string" ? [{ text: m.content }] : m.content.map(p => {
        if (p.type === "text") return { text: p.text };
        const img = dataUrlParts(p.image_url && p.image_url.url);
        return img ? { inline_data: { mime_type: img.mime, data: img.data } } : { text: "" };
      })
    }))
  };
}

// getConfig() returns { baseUrl, model, key, format, apiVersion } and is called
// on every request, so changing the keys on the Settings page takes effect at once.
function client(getConfig) {
  const cfg = () => {
    const c = getConfig() || {};
    return {
      base: String(c.baseUrl || "").replace(/\/+$/, ""),
      model: c.model || "",
      key: c.key || "",
      apiVersion: c.apiVersion || "2024-10-21",
      format: detect(String(c.baseUrl || ""), c.format)
    };
  };

  const ready = () => { const c = cfg(); return !!(c.base && c.model && c.key); };

  function endpoint(c) {
    if (c.format === "anthropic") return c.base + "/v1/messages";
    if (c.format === "gemini") return `${c.base}/v1beta/models/${encodeURIComponent(c.model)}:generateContent`;
    if (c.format === "azure") {
      const root = c.base.replace(/\/openai(\/v1)?$/i, "");
      return `${root}/openai/deployments/${encodeURIComponent(c.model)}/chat/completions?api-version=${encodeURIComponent(c.apiVersion)}`;
    }
    return c.base + "/chat/completions";
  }

  function headers(c) {
    if (c.format === "anthropic") return { "Content-Type": "application/json", "x-api-key": c.key, "anthropic-version": "2023-06-01" };
    if (c.format === "gemini") return { "Content-Type": "application/json", "x-goog-api-key": c.key };
    if (c.format === "azure") return { "Content-Type": "application/json", "api-key": c.key };
    return { "Content-Type": "application/json", Authorization: "Bearer " + c.key };
  }

  function body(c, messages, maxTokens, temperature, json) {
    if (c.format === "anthropic") return toAnthropic(messages, maxTokens, temperature, c.model);
    if (c.format === "gemini") {
      const g = toGemini(messages, maxTokens, temperature);
      if (json) g.generationConfig.responseMimeType = "application/json";
      return g;
    }
    const b = { model: c.model, messages, max_tokens: maxTokens, temperature };
    if (json && process.env.AI_JSON_MODE !== "off") b.response_format = { type: "json_object" };
    return b;
  }

  function textOf(c, data) {
    if (c.format === "anthropic") return (data.content || []).filter(p => p.type === "text").map(p => p.text).join("");
    if (c.format === "gemini") {
      const parts = ((data.candidates || [])[0] || {}).content || {};
      return (parts.parts || []).map(p => p.text || "").join("");
    }
    const t = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return Array.isArray(t) ? t.map(p => p.text || "").join("") : (t || "");
  }

  function errorOf(data, status) {
    const e = data.error || data;
    return (e && (e.message || e.code)) || ("HTTP " + status);
  }

  async function chat(messages, { maxTokens = 1400, temperature = 0.3, json = false } = {}) {
    const c = cfg();
    if (!c.base || !c.model || !c.key) throw new Error("The AI isn't set up yet. Add the provider address, model and key on the Settings page.");
    const hasImage = messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === "image_url"));
    let res;
    try {
      res = await fetch(endpoint(c), { method: "POST", headers: headers(c), body: JSON.stringify(body(c, messages, maxTokens, temperature, json)), signal: AbortSignal.timeout(120000) });
    } catch (e) {
      throw new Error("Couldn't reach the AI provider: " + e.message + ". Check the address on the Settings page.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = String(errorOf(data, res.status));
      if (json && res.status === 400 && /response_format|json/i.test(msg)) {
        process.env.AI_JSON_MODE = "off";
        return chat(messages, { maxTokens, temperature, json: false });
      }
      if (res.status === 400 && /max_tokens|max_completion_tokens/i.test(msg) && c.format === "openai") {
        const b2 = { model: c.model, messages, max_completion_tokens: maxTokens };
        const r2 = await fetch(endpoint(c), { method: "POST", headers: headers(c), body: JSON.stringify(b2) });
        const d2 = await r2.json().catch(() => ({}));
        if (r2.ok) return textOf(c, d2);
      }
      if (hasImage && (/image|vision|multimodal|not support/i.test(msg) || res.status === 400)) {
        throw new Error("This model can't read images, so it can't type up photographed pages. Pick a model that accepts images, or turn off handwriting features. (" + msg.slice(0, 160) + ")");
      }
      if (res.status === 401 || res.status === 403) throw new Error("The AI provider refused the key (" + res.status + "). Check it on the Settings page.");
      if (res.status === 404 && c.format === "azure") throw new Error("Azure returned 404: check the model is your deployment name, and the API version suits your resource.");
      if (res.status === 429) throw new Error("The AI provider is rate limiting or out of quota (429). Try again shortly.");
      throw new Error("AI provider error (" + res.status + "): " + msg.slice(0, 300));
    }
    return textOf(c, data);
  }

  return {
    chat,
    get ready() { return ready(); },
    get model() { return cfg().model; },
    get flavour() { return cfg().format; }
  };
}

module.exports = { client, detect };
