import "server-only";

import { createGoogle } from "@ai-sdk/google";

export function getGeminiModel() {
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    throw new Error("The Gemini API key is not configured on the server.");
  }

  const modelId = process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash-lite";
  return createGoogle()(modelId);
}

export function geminiModelRejectionMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : "";
  if (/model.{0,80}(not found|not supported|unsupported|invalid|does not exist|not available)/i.test(message)) {
    return "Gemini rejected the configured model. Check GEMINI_MODEL and choose a model supported by your API key.";
  }
  return null;
}
