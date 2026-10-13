import { describe, expect, it } from "vitest";
import {
  aiTaskSchema,
  aiUsageSourceSchema,
  estimateCostUsd,
  estimateTranscriptionCostUsd,
} from "./ai-usage.ts";

describe("estimateCostUsd", () => {
  it("bills cached text tokens at the cached rate and subtracts them from input", () => {
    // 1M input of which 400k cached, 100k output on gpt-5.6-terra:
    // 600k * 2.00 + 400k * 0.20 + 100k * 12.00 = 1.20 + 0.08 + 1.20
    const cost = estimateCostUsd("gpt-5.6-terra", {
      input_tokens: 1_000_000,
      cached_input_tokens: 400_000,
      output_tokens: 100_000,
    });
    expect(cost).toBeCloseTo(2.48, 10);
  });

  it("prices the default planning and evaluation models", () => {
    // gpt-6.1-sol: 600k * 2.00 + 400k * 0.10 + 100k * 10.00 = 1.20 + 0.04 + 1.00
    expect(
      estimateCostUsd("gpt-6.1-sol", { input_tokens: 1_000_000, cached_input_tokens: 400_000, output_tokens: 100_000 }),
    ).toBeCloseTo(2.24, 10);
    // gpt-6-luna: 600k * 0.10 + 400k * 0.01 + 100k * 0.50 = 0.06 + 0.004 + 0.05
    expect(
      estimateCostUsd("gpt-6-luna", { input_tokens: 1_000_000, cached_input_tokens: 400_000, output_tokens: 100_000 }),
    ).toBeCloseTo(0.114, 10);
  });

  it("prices text and audio buckets separately with cached subtraction in each", () => {
    // text: 10k * 0.60 + 0 cached + 2k * 2.40 = 0.006 + 0.0048
    // audio: (50k - 20k) * 10.00 + 20k * 0.30 + 10k * 20.00 = 0.30 + 0.006 + 0.20
    const cost = estimateCostUsd("gpt-realtime-2.1-mini", {
      input_tokens: 10_000,
      output_tokens: 2_000,
      audio_input_tokens: 50_000,
      audio_cached_input_tokens: 20_000,
      audio_output_tokens: 10_000,
    });
    expect(cost).toBeCloseTo(0.0108 + 0.506, 10);
  });

  it("falls back to the input rate when the model has no cached rate", () => {
    // gpt-4o-mini-transcribe audio: 1M input (500k cached) * 1.25 + 0 output
    const cost = estimateCostUsd("gpt-4o-mini-transcribe", {
      audio_input_tokens: 1_000_000,
      audio_cached_input_tokens: 500_000,
    });
    expect(cost).toBeCloseTo(1.25, 10);
  });

  it("never bills more cached tokens than input tokens", () => {
    const cost = estimateCostUsd("gpt-5.6-luna", { input_tokens: 100, cached_input_tokens: 1_000 });
    expect(cost).toBeCloseTo((100 * 0.02) / 1_000_000, 15);
  });

  it("returns zero for no tokens on a known model", () => {
    expect(estimateCostUsd("gpt-5.6-luna", {})).toBe(0);
  });

  it("returns null for an unknown model", () => {
    expect(estimateCostUsd("gpt-unknown", { input_tokens: 10, output_tokens: 10 })).toBeNull();
  });

  it("bills embeddings by input tokens only", () => {
    // 1M input tokens on text-embedding-3-small: 1M * 0.02
    expect(estimateCostUsd("text-embedding-3-small", { input_tokens: 1_000_000 })).toBeCloseTo(0.02, 10);
    expect(estimateCostUsd("text-embedding-3-small", { input_tokens: 500 })).toBeCloseTo((500 * 0.02) / 1_000_000, 15);
  });

  it("returns null when tokens are present for an unpriced modality", () => {
    expect(estimateCostUsd("gpt-5.6-terra", { audio_input_tokens: 10 })).toBeNull();
  });
});

describe("estimateTranscriptionCostUsd", () => {
  it("charges the per-minute rate pro rata", () => {
    expect(estimateTranscriptionCostUsd("gpt-4o-mini-transcribe", 600)).toBeCloseTo(0.03, 10);
    expect(estimateTranscriptionCostUsd("gpt-4o-mini-transcribe", 90)).toBeCloseTo(0.0045, 10);
    expect(estimateTranscriptionCostUsd("gpt-live-transcribe", 600)).toBeCloseTo(0.17, 10);
  });

  it("returns null for a model without a per-minute rate", () => {
    expect(estimateTranscriptionCostUsd("gpt-5.6-terra", 60)).toBeNull();
  });

  it("prices gpt-live-transcribe only by the minute, never from tokens", () => {
    expect(estimateCostUsd("gpt-live-transcribe", { audio_input_tokens: 1_000 })).toBeNull();
  });
});

describe("enums", () => {
  it("lists the architecture's tasks and sources", () => {
    expect(aiTaskSchema.options).toEqual([
      "voice",
      "auxiliary",
      "deep_analysis",
      "planning",
      "evaluation",
      "report",
      "vision",
      "embedding",
    ]);
    expect(aiUsageSourceSchema.options).toEqual(["provider", "client_reported", "duration_estimate"]);
  });
});
