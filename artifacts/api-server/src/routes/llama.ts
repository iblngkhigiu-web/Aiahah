import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Router, type IRouter } from "express";
import { LlamaChatBody, LlamaChatResponse } from "@workspace/api-zod";
import { logger } from "../lib/logger";

const execFile = promisify(execFileCallback);
const router: IRouter = Router();
const OLLAMA_URL = "http://127.0.0.1:11434";
const MODEL = process.env.LLAMA_MODEL ?? "llama3.2:3b";
const STARTUP_TIMEOUT_MS = 30_000;
const MODEL_PULL_TIMEOUT_MS = 20 * 60 * 1000;

let ollamaReadyPromise: Promise<void> | null = null;
let modelReadyPromise: Promise<void> | null = null;

type OllamaTags = { models?: Array<{ name?: string }> };
type OllamaChatResponse = { message?: { content?: string } };

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

function systemPrompt(mode: "Focus" | "Create" | "Code") {
  const modeInstructions = {
    Focus: "Help the user think clearly. Ask a focused follow-up only when necessary, otherwise answer directly and give practical next steps.",
    Create: "Help the user create. Turn rough ideas into strong drafts, options, or concrete plans. Preserve their intent and be specific.",
    Code: "Act as a careful senior programming partner. Explain the cause, show the fix, and call out assumptions. Prefer working examples over vague advice.",
  };
  return `You are NOVA, a helpful and honest private assistant running on a local Llama model. ${modeInstructions[mode]} Answer in the same language as the user. Never claim to have browsed the web or used a tool when you have not. If you are unsure, say so plainly. Do not repeat the user's prompt as filler.`;
}

router.post("/llama/chat", async (req, res): Promise<void> => {
  const parsed = LlamaChatBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid local Llama request");
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    await ensureModel();
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        options: { temperature: 0.65, num_ctx: 4096 },
        messages: [
          { role: "system", content: systemPrompt(parsed.data.mode) },
          ...parsed.data.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      req.log.error({ status: response.status, detail }, "Local Llama request failed");
      res.status(503).json({ error: "The local Llama model could not answer right now." });
      return;
    }

    const data = (await response.json()) as OllamaChatResponse;
    const content = data.message?.content?.trim();
    if (!content) {
      req.log.error("Local Llama returned an empty response");
      res.status(503).json({ error: "The local Llama model returned an empty response." });
      return;
    }

    res.json(LlamaChatResponse.parse({ content, model: MODEL, local: true }));
  } catch (error) {
    req.log.error({ err: error }, "Local Llama is unavailable");
    res.status(503).json({
      error: "Local Llama is not ready yet. Keep Ollama installed and try again in a moment.",
    });
  }
});

void ensureModel().catch((error) => {
  logger.warn({ err: error, model: MODEL }, "Local Llama warm-up did not complete");
});

export default router;