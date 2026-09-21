import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { UiPreviewBanner } from "@/components/apex/UiPreviewBanner";
import {
  PREVIEW_RUNTIME_STATUS,
  PREVIEW_STRATEGY_POLICY,
  previewRequestPath,
  resolvePreviewFetch,
} from "@/lib/ui-preview";

describe("UI preview fetch interceptor", () => {
  it("extracts pathnames from absolute and relative URLs", () => {
    expect(previewRequestPath("/api/status")).toBe("/api/status");
    expect(previewRequestPath("http://runtime.test:3001/api/status")).toBe("/api/status");
    expect(previewRequestPath("https://example.trycloudflare.com/api/strategies/policy?x=1")).toBe(
      "/api/strategies/policy",
    );
  });

  it("returns a stopped runtime status with no session", () => {
    const res = resolvePreviewFetch("http://runtime.test:3001/api/status");
    expect(res).toEqual({ status: 200, body: PREVIEW_RUNTIME_STATUS });
    expect(PREVIEW_RUNTIME_STATUS.engineRunning).toBe(false);
    expect(PREVIEW_RUNTIME_STATUS.sessionId).toBeNull();
    expect(PREVIEW_RUNTIME_STATUS.pnl).toBeNull();
  });

  it("mirrors guardrails disabled_strategies and leaves trend_follow runnable", () => {
    const res = resolvePreviewFetch("/api/strategies/policy");
    expect(res?.body).toEqual(PREVIEW_STRATEGY_POLICY);
    expect(PREVIEW_STRATEGY_POLICY.disabledStrategies).toEqual(["vwap_mr", "breakout", "momentum"]);
    const trend = PREVIEW_STRATEGY_POLICY.strategies.find((s) => s.id === "trend_follow");
    expect(trend?.disabledByGuardrails).toBe(false);
  });

  it("uses the same engine-not-running codes as the real API", () => {
    expect(resolvePreviewFetch("/api/analytics/session")?.status).toBe(400);
    expect(resolvePreviewFetch("/api/analytics/equity-curve")?.status).toBe(400);
    expect(resolvePreviewFetch("/api/pnl")?.status).toBe(503);
    expect(resolvePreviewFetch("/api/risk/status")?.status).toBe(400);
  });

  it("blocks mutating engine calls so a public preview cannot start trading", () => {
    const res = resolvePreviewFetch("http://runtime.test:3001/api/engine/start", "POST");
    expect(res?.status).toBe(403);
    expect(res?.body).toEqual({ error: "UI preview — engine is not connected" });
  });

  it("returns empty arrays for PostgREST so positions/orders never hit production", () => {
    const res = resolvePreviewFetch("https://preview.invalid/rest/v1/positions?select=*");
    expect(res).toEqual({ status: 200, body: [] });
  });

  it("does not intercept unrelated traffic (fonts, static assets)", () => {
    expect(resolvePreviewFetch("https://fonts.googleapis.com/css2?family=Geist")).toBeNull();
    expect(resolvePreviewFetch("/assets/index.js")).toBeNull();
  });
});

describe("UiPreviewBanner", () => {
  it("labels the shell as a static preview, not a paper session", () => {
    const { getByTestId } = render(<UiPreviewBanner />);
    expect(getByTestId("ui-preview-banner").textContent).toMatch(/UI preview/i);
    expect(getByTestId("ui-preview-banner").textContent).toMatch(/Not a paper session/);
  });
});
