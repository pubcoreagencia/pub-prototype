// src/routing/catalog-models.ts

/**
 * 10 Live-Verified FREE models for Gateway A (OpenRouter).
 * Curated with pricing.prompt === "0" && pricing.completion === "0"
 * and verified live via streaming chat completions on OpenRouter API.
 */
export const OPENROUTER_VERIFIED_FREE_MODELS: string[] = [
  'cohere/north-mini-code:free',
  'nex-agi/nex-n2.5-pro:free',
  'qwen/qwen3.8-27b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'nex-agi/nex-n2.5-mini:free',
  'z-ai/glm-5.2:free',
  'liquid/lfm-2.5-2.6b:free',
  'openrouter/free',
];

/**
 * Known Architectural Models for Gateway B (9router).
 * NOTE: These models are known from 9router documentation / architecture,
 * but CANNOT be marked as VERIFIED until tested live against an active 9router endpoint.
 */
export const ROUTER_KNOWN_MODELS: string[] = [
  'gemini/gemini-2.5-flash-lite:free',
  'qwen/qwen3.8-coder:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-chat:free',
  'mistralai/mistral-small-3:free',
  'cohere/command-r-08-2024:free',
  'google/gemma-2-27b-it:free',
  'microsoft/phi-4:free',
  'huggingface/zephyr-orpo-141b:free',
  'router/free-pool',
];

/**
 * Live-verified FREE models for Gateway B (9router).
 * Verified live against https://pub-9router-cloud.onrender.com
 * with streaming SSE enabled, TTFT < 1.5s, valid output chunks, and zero-cost free provider connection.
 */
export const ROUTER_VERIFIED_FREE_MODELS: string[] = [
  'kc/cohere/north-mini-code:free',
  'kc/nvidia/nemotron-3-super-120b-a12b:free',
  'kc/kilo-auto/free',
  'kc/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'kc/dots-studio/dots-3-note-preview:free',
  'kc/inclusionai/ling-3.0-flash-fin:free',
  'kc/nvidia/nemotron-3-ultra-550b-a55b:free',
  'kc/nvidia/nemotron-3.5-lightning:free',
  'kc/nex-agi/nex-n2.5-pro:free',
  'kc/nex-agi/nex-n2.5-mini:free',
];
