'use strict';

/**
 * Model catalog — curated list of models with size, VRAM requirements, and HuggingFace URLs.
 *
 * Fields per model:
 *   name        — Display name
 *   params      — Parameter count string (e.g. "8B")
 *   quant       — Quantization level
 *   fileSizeGB  — GGUF file size in GB (for download + tok/s estimate)
 *   vramGB      — VRAM needed to load model (approx)
 *   maxContext   — Max context length model supports
 *   contextVRAMperK — Additional VRAM per 1K context tokens (GB), approx
 *   hfRepo      — HuggingFace repo
 *   hfFile      — GGUF filename in repo
 *   useCase     — Short description of what it's good at
 */
const MODELS = [
  // ── Small (1-4B) — runs on anything ──────────────────────────────────────
  {
    name: 'Qwen3 1.7B',
    params: '1.7B',
    quant: 'Q4_K_M',
    fileSizeGB: 1.2,
    vramGB: 2,
    maxContext: 32768,
    contextVRAMperK: 0.05,
    hfRepo: 'unsloth/Qwen3-1.7B-GGUF',
    hfFile: 'Qwen3-1.7B-Q4_K_M.gguf',
    useCase: 'Fast assistant, lightweight tasks',
  },
  {
    name: 'Qwen3 4B',
    params: '4B',
    quant: 'Q4_K_M',
    fileSizeGB: 2.7,
    vramGB: 4,
    maxContext: 32768,
    contextVRAMperK: 0.08,
    hfRepo: 'unsloth/Qwen3-4B-GGUF',
    hfFile: 'Qwen3-4B-Q4_K_M.gguf',
    useCase: 'Good balance for 4-6 GB GPUs',
  },
  {
    name: 'Llama 3.2 3B',
    params: '3B',
    quant: 'Q4_K_M',
    fileSizeGB: 2.0,
    vramGB: 3,
    maxContext: 131072,
    contextVRAMperK: 0.06,
    hfRepo: 'bartowski/Llama-3.2-3B-Instruct-GGUF',
    hfFile: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    useCase: 'Meta Llama, good general chat',
  },

  // ── Medium (7-8B) — sweet spot for most GPUs ────────────────────────────
  {
    name: 'Qwen3 8B',
    params: '8B',
    quant: 'Q4_K_M',
    fileSizeGB: 5.0,
    vramGB: 7,
    maxContext: 32768,
    contextVRAMperK: 0.12,
    hfRepo: 'unsloth/Qwen3-8B-GGUF',
    hfFile: 'Qwen3-8B-Q4_K_M.gguf',
    useCase: 'Excellent all-rounder, strong reasoning',
  },
  {
    name: 'Llama 3.1 8B',
    params: '8B',
    quant: 'Q4_K_M',
    fileSizeGB: 4.9,
    vramGB: 7,
    maxContext: 131072,
    contextVRAMperK: 0.12,
    hfRepo: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',
    hfFile: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
    useCase: 'Meta flagship 8B, great at instruction following',
  },
  {
    name: 'Mistral 7B v0.3',
    params: '7B',
    quant: 'Q4_K_M',
    fileSizeGB: 4.4,
    vramGB: 6,
    maxContext: 32768,
    contextVRAMperK: 0.10,
    hfRepo: 'bartowski/Mistral-7B-Instruct-v0.3-GGUF',
    hfFile: 'Mistral-7B-Instruct-v0.3-Q4_K_M.gguf',
    useCase: 'Fast, efficient chat and code',
  },
  {
    name: 'Gemma 2 9B',
    params: '9B',
    quant: 'Q4_K_M',
    fileSizeGB: 5.8,
    vramGB: 8,
    maxContext: 8192,
    contextVRAMperK: 0.15,
    hfRepo: 'bartowski/gemma-2-9b-it-GGUF',
    hfFile: 'gemma-2-9b-it-Q4_K_M.gguf',
    useCase: 'Google model, strong at analysis',
  },
  {
    name: 'DeepSeek R1 Distill 8B',
    params: '8B',
    quant: 'Q4_K_M',
    fileSizeGB: 4.9,
    vramGB: 7,
    maxContext: 32768,
    contextVRAMperK: 0.12,
    hfRepo: 'bartowski/DeepSeek-R1-Distill-Llama-8B-GGUF',
    hfFile: 'DeepSeek-R1-Distill-Llama-8B-Q4_K_M.gguf',
    useCase: 'Chain-of-thought reasoning, math, logic',
  },

  // ── Large (13-14B) — needs 10+ GB VRAM ──────────────────────────────────
  {
    name: 'Qwen3 14B',
    params: '14B',
    quant: 'Q4_K_M',
    fileSizeGB: 8.7,
    vramGB: 11,
    maxContext: 32768,
    contextVRAMperK: 0.18,
    hfRepo: 'unsloth/Qwen3-14B-GGUF',
    hfFile: 'Qwen3-14B-Q4_K_M.gguf',
    useCase: 'Top quality for 12 GB GPUs',
  },
  {
    name: 'Llama 3.3 70B',
    params: '70B',
    quant: 'Q4_K_M',
    fileSizeGB: 42.5,
    vramGB: 48,
    maxContext: 131072,
    contextVRAMperK: 0.50,
    hfRepo: 'bartowski/Llama-3.3-70B-Instruct-GGUF',
    hfFile: 'Llama-3.3-70B-Instruct-Q4_K_M.gguf',
    useCase: 'Flagship quality — needs 48 GB+ (A6000, 2x 3090, Mac Ultra)',
  },
  {
    name: 'Qwen3 30B-A3B (MoE)',
    params: '30B',
    quant: 'Q4_K_M',
    fileSizeGB: 18.4,
    vramGB: 22,
    maxContext: 32768,
    contextVRAMperK: 0.25,
    hfRepo: 'unsloth/Qwen3-30B-A3B-GGUF',
    hfFile: 'Qwen3-30B-A3B-Q4_K_M.gguf',
    useCase: 'MoE — 30B params but only 3B active. Fast like 3B, smart like 30B.',
  },
  {
    name: 'Qwen3 32B',
    params: '32B',
    quant: 'Q4_K_M',
    fileSizeGB: 19.9,
    vramGB: 24,
    maxContext: 32768,
    contextVRAMperK: 0.30,
    hfRepo: 'unsloth/Qwen3-32B-GGUF',
    hfFile: 'Qwen3-32B-Q4_K_M.gguf',
    useCase: 'Excellent quality — 24 GB GPU (4090, A5000)',
  },

  // ── Code-specialized ────────────────────────────────────────────────────
  {
    name: 'Qwen 2.5 Coder 7B',
    params: '7B',
    quant: 'Q4_K_M',
    fileSizeGB: 4.7,
    vramGB: 7,
    maxContext: 32768,
    contextVRAMperK: 0.12,
    hfRepo: 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF',
    hfFile: 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf',
    useCase: 'Code generation and editing specialist',
  },
  {
    name: 'Qwen 2.5 Coder 32B',
    params: '32B',
    quant: 'Q4_K_M',
    fileSizeGB: 19.9,
    vramGB: 24,
    maxContext: 32768,
    contextVRAMperK: 0.30,
    hfRepo: 'bartowski/Qwen2.5-Coder-32B-Instruct-GGUF',
    hfFile: 'Qwen2.5-Coder-32B-Instruct-Q4_K_M.gguf',
    useCase: 'Best open-source code model. Needs 24 GB.',
  },
];

function getAll() {
  return MODELS;
}

function getByName(name) {
  return MODELS.find(m => m.name === name) || null;
}

module.exports = { getAll, getByName, MODELS };
