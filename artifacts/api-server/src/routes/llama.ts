import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Router, type IRouter, type Response } from "express";
import { LlamaChatBody } from "@workspace/api-zod";
import { logger } from "../lib/logger";

const execFile = promisify(execFileCallback);
const router: IRouter = Router();
const OLLAMA_URL = "http://127.0.0.1:11434";
const MODEL = process.env.LLAMA_MODEL ?? "gemma4:e4b";
const STARTUP_TIMEOUT_MS = 30_000;
const MODEL_PULL_TIMEOUT_MS = 20 * 60 * 1000;

let ollamaReadyPromise: Promise<void> | null = null;
let modelReadyPromise: Promise<void> | null = null;

type OllamaTags = { models?: Array<{ name?: string }> };
type OllamaStreamChunk = { message?: { content?: string }; done?: boolean; error?: string };
type SearchSource = { title: string; url: string; snippet: string };

async function ollamaIsReachable() {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForOllama() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await ollamaIsReachable()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Ollama did not become ready within 30 seconds");
}

async function ensureOllama() {
  if (await ollamaIsReachable()) return;
  if (!ollamaReadyPromise) {
    ollamaReadyPromise = (async () => {
      const child = spawn("ollama", ["serve"], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, OLLAMA_HOST: "127.0.0.1:11434" },
      });
      child.unref();
      await waitForOllama();
    })().catch((error) => {
      ollamaReadyPromise = null;
      throw error;
    });
  }
  await ollamaReadyPromise;
}

async function modelIsInstalled() {
  const response = await fetch(`${OLLAMA_URL}/api/tags`);
  if (!response.ok) return false;
  const data = (await response.json()) as OllamaTags;
  return Boolean(data.models?.some((model) => model.name === MODEL || model.name?.startsWith(`${MODEL}:`)));
}

async function ensureModel() {
  await ensureOllama();
  if (await modelIsInstalled()) return;
  if (!modelReadyPromise) {
    modelReadyPromise = execFile("ollama", ["pull", MODEL], {
      timeout: MODEL_PULL_TIMEOUT_MS,
      maxBuffer: 2_000_000,
    }).then(() => undefined).catch((error) => {
      modelReadyPromise = null;
      throw error;
    });
  }
  await modelReadyPromise;
}

function startEventStream(res: Response) {
  res.status(200);
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders();
}

function writeStreamEvent(res: Response, event: { delta?: string; done?: boolean; model?: string; local?: boolean; sources?: SearchSource[]; error?: string }) {
  res.write("data: " + JSON.stringify(event) + "\n\n");
}

function decodeHtml(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchWeb(query: string): Promise<SearchSource[]> {
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(searchUrl, {
    headers: { "user-agent": "NOVA local assistant/1.0" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Web search returned ${response.status}`);
  const html = await response.text();
  const links = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>[\s\S]*?<\/a>/g)].map((match) => decodeHtml(match[0].replace(/^[\s\S]*?>/, "").replace(/<\/a>[\s\S]*$/, "")));

  return links.slice(0, 5).flatMap((match, index) => {
    try {
      const href = decodeHtml(match[1]);
      const parsed = new URL(href.startsWith("//") ? `https:${href}` : href);
      const destination = parsed.searchParams.get("uddg");
      const url = destination ? decodeURIComponent(destination) : parsed.toString();
      return [{ title: decodeHtml(match[2]), url, snippet: snippets[index] ?? "" }];
    } catch {
      return [];
    }
  });
}

function needsWebSearch(query: string) {
  return /\b(20\d{2}|19\d{2}|today|latest|current|news|price|weather|who|when|where|research|search|internet|güncel|bugün|haber|fiyat|hava|kim|ne zaman|nerede|araştır|ara|internet)\b/.test(query.toLocaleLowerCase("en-US"));
}

function exactAgeAnswer(query: string) {
  const yearMatch = query.match(/\b(?:19|20)\d{2}\b/);
  if (!yearMatch || !/(age|born|birth|yaş|doğ|doğum)/i.test(query)) return null;
  const birthYear = Number(yearMatch[0]);
  const currentYear = new Date().getFullYear();
  const age = currentYear - birthYear;
  if (age < 0 || age > 130) return null;
  const isTurkish = /[çğıöşüİ]|(yaş|doğ|doğum|yılında)/i.test(query);
  return isTurkish
    ? `${birthYear} yılında doğan bir çocuk ${currentYear} yılında doğum günü henüz gelmediyse **${age - 1}**, doğum günü geçtiyse **${age}** yaşındadır. Yalnızca doğum yılını bildiğimiz için kesin cevap bu aralıktır.`
    : `Someone born in ${birthYear} is **${age - 1} or ${age}** in ${currentYear}: ${age - 1} before their birthday and ${age} after it. The birth year alone is not enough to give one exact age.`;
}

function systemPrompt(mode: "Focus" | "Create" | "Code") {
  const modeInstructions = {
    Focus: "Help the user think clearly. Ask a focused follow-up only when necessary, otherwise answer directly and give practical next steps.",
    Create: "Help the user create. Turn rough ideas into strong drafts, options, or concrete plans. Preserve their intent and be specific.",
    Code: "Act as a careful senior programming partner. Explain the cause, show the fix, and call out assumptions. Prefer working examples over vague advice.",
  };
  return `You are NOVA, a helpful and honest private assistant running on a local Gemma 4 model. ${modeInstructions[mode]} Answer in the same language as the user. Never claim to have browsed the web or used a tool when you have not. If you are unsure, say so plainly. Do not repeat the user's prompt as filler.`;
}

router.post("/llama/chat", async (req, res): Promise<void> => {
  const parsed = LlamaChatBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid local model request");
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const latestUserMessage = [...parsed.data.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const shouldSearch = parsed.data.webEnabled !== false && needsWebSearch(latestUserMessage);
    const modelPromise = ensureModel();
    const sourcesPromise: Promise<SearchSource[]> = shouldSearch
      ? searchWeb(latestUserMessage).then((foundSources) => {
          req.log.info({ resultCount: foundSources.length }, "Completed local web research");
          return foundSources;
        }).catch((error) => {
          req.log.warn({ err: error }, "Web research unavailable; continuing without sources");
          return [];
        })
      : Promise.resolve([]);
    await modelPromise;
    const sources = await sourcesPromise;

    const exactAge = exactAgeAnswer(latestUserMessage);
    if (exactAge) {
      startEventStream(res);
      writeStreamEvent(res, { delta: exactAge });
      writeStreamEvent(res, { done: true, model: MODEL, local: true, sources });
      res.end();
      return;
    }

    const webContext = sources.length
      ? `\n\nWeb research context. Use it as evidence, distinguish facts from uncertainty, and do not invent details. Do not invent temperatures, percentages, dates, names, or other numbers that are not present in the snippets. If the sources do not contain the requested detail, say that it is unavailable and ask for the missing location or date instead of guessing:\n${sources.map((source, index) => `${index + 1}. ${source.title}\nURL: ${source.url}\nSummary: ${source.snippet}`).join("\n\n")}`
      : "";
    const response = await fetch(OLLAMA_URL + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        keep_alive: "30m",
        options: { temperature: 0.55, num_ctx: 2048, num_predict: 512, top_p: 0.9 },
        messages: [
          { role: "system", content: systemPrompt(parsed.data.mode) },
          ...(webContext ? [{ role: "system" as const, content: webContext }] : []),
          ...parsed.data.messages.slice(-12).map((message) => ({
            role: message.role,
            content: message.content,
          })),
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!response.ok) {
      const detail = await response.text();
      req.log.error({ status: response.status, detail }, "Local Llama request failed");
      res.status(503).json({ error: "The local Llama model could not answer right now." });
      return;
    }

    if (!response.body) throw new Error("The local model returned no response stream");

    startEventStream(res);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finished = false;

    const consumeLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const chunk = JSON.parse(trimmed) as OllamaStreamChunk;
      if (chunk.error) throw new Error(chunk.error);
      const delta = chunk.message?.content ?? "";
      if (delta) {
        content += delta;
        writeStreamEvent(res, { delta });
      }
      if (chunk.done) finished = true;
    };

    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const streamLines = buffer.split("\n");
      buffer = streamLines.pop() ?? "";
      for (const line of streamLines) consumeLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeLine(buffer);
    if (!content.trim()) throw new Error("The local model returned an empty response");

    writeStreamEvent(res, { done: true, model: MODEL, local: true, sources });
    res.end();
  } catch (error) {
    req.log.error({ err: error }, "Local model is unavailable");
    if (res.headersSent) {
      writeStreamEvent(res, { error: "The local model stopped before completing the answer." });
      res.end();
      return;
    }
    res.status(503).json({
      error: "Local model is not ready yet. Keep Ollama installed and try again in a moment.",
    });
  }
});

void ensureModel().catch((error) => {
  logger.warn({ err: error, model: MODEL }, "Local model warm-up did not complete");
});

export default router;