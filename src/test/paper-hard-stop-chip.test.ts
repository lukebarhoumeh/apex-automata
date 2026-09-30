/**
 * Paper hard-stop chip (handoff P5 follow-up) — pure derivation from
 * `/api/status → paperHardStop` plus a caller-supplied clock. The chip must
 * render nothing for live / stopped / old backends (field null or absent).
 */

import { describe, it, expect } from "vitest";
import { deriveHardStopChip, HARD_STOP_WARN_MS } from "@/runtime/state/deriveEnginePill";
import { normalizeRuntimeEvent } from "@/runtime/ws/normalizeEvent";
import type { StatusPayload } from "@/runtime/ws/types";

const FIRE_ISO = "2026-09-30T03:30:00.000Z";
const FIRE_MS = Date.parse(FIRE_ISO);

function armed(overrides: Partial<NonNullable<StatusPayload["paperHardStop"]>> = {}) {
  return {
    engineRunning: true,
    mode: "paper" as const,
    paperHardStop: {
      enabled: true,
      nextFireAtIso: FIRE_ISO,
      nextFireAtMs: FIRE_MS,
      timezone: "America/Chicago",
      localTime: "22:30",
      reason: "paper_hard_stop",
      ...overrides,
    },
  };
}

describe("deriveHardStopChip — null cases", () => {
  it("returns null when status is null/undefined (no /api/status yet)", () => {
    expect(deriveHardStopChip(null, 0)).toBeNull();
    expect(deriveHardStopChip(undefined, 0)).toBeNull();
  });

  it("returns null when the backend reports paperHardStop: null (live or stopped)", () => {
    expect(deriveHardStopChip({ engineRunning: true, mode: "live", paperHardStop: null }, 0)).toBeNull();
    expect(deriveHardStopChip({ engineRunning: false, mode: null, paperHardStop: null }, 0)).toBeNull();
  });

  it("returns null when the field is absent (old backend without the hard stop)", () => {
    expect(deriveHardStopChip({ engineRunning: true, mode: "paper" }, 0)).toBeNull();
  });

  it("returns null when the scheduler is present but not armed or has no fire time", () => {
    expect(deriveHardStopChip(armed({ enabled: false }), 0)).toBeNull();
    expect(deriveHardStopChip(armed({ nextFireAtIso: null, nextFireAtMs: null }), 0)).toBeNull();
    expect(deriveHardStopChip(armed({ nextFireAtIso: "not-a-date" }), 0)).toBeNull();
  });
});

describe("deriveHardStopChip — label, detail and tone", () => {
  it("formats hours + minutes and uses the info tone when far away", () => {
    const now = FIRE_MS - (3 * 60 + 12) * 60_000 - 30_000; // 3h 12m 30s before
    const chip = deriveHardStopChip(armed(), now);
    expect(chip).not.toBeNull();
    expect(chip!.label).toBe("Hard stop 22:30 CT");
    expect(chip!.remaining).toBe("3h 12m");
    expect(chip!.detail).toBe(`fires in 3h 12m (${FIRE_ISO})`);
    expect(chip!.tone).toBe("info");
    expect(chip!.title).toContain("America/Chicago");
    expect(chip!.title).toContain("22:30");
  });

  it("drops the hours part under one hour and flips to warn below the 30-minute threshold", () => {
    expect(deriveHardStopChip(armed(), FIRE_MS - 45 * 60_000)!.tone).toBe("info");
    expect(deriveHardStopChip(armed(), FIRE_MS - 45 * 60_000)!.remaining).toBe("45m");
    expect(deriveHardStopChip(armed(), FIRE_MS - HARD_STOP_WARN_MS)!.tone).toBe("info");
    const under = deriveHardStopChip(armed(), FIRE_MS - HARD_STOP_WARN_MS + 1)!;
    expect(under.tone).toBe("warn");
    expect(under.remaining).toBe("29m");
  });

  it("reports '<1m' just before the fire time and 'now' once it is due", () => {
    expect(deriveHardStopChip(armed(), FIRE_MS - 20_000)!.detail).toBe(`fires in <1m (${FIRE_ISO})`);
    const due = deriveHardStopChip(armed(), FIRE_MS + 5_000)!;
    expect(due.detail).toBe(`firing now (${FIRE_ISO})`);
    expect(due.tone).toBe("warn");
  });

  it("falls back to the IANA zone name when it has no desk abbreviation", () => {
    const chip = deriveHardStopChip(armed({ timezone: "Europe/London", localTime: "21:00" }), FIRE_MS - 60_000)!;
    expect(chip.label).toBe("Hard stop 21:00 Europe/London");
  });
});

describe("WS StatusUpdate carries paperHardStop through the normaliser", () => {
  it("passes a non-null paperHardStop verbatim and keeps an explicit null (so a stop clears the chip)", () => {
    const withStop = normalizeRuntimeEvent({
      type: "StatusUpdate",
      timestamp: 1,
      payload: { engineRunning: true, mode: "paper", paperHardStop: armed().paperHardStop },
    });
    expect((withStop!.payload as StatusPayload).paperHardStop).toEqual(armed().paperHardStop);

    const cleared = normalizeRuntimeEvent({
      type: "StatusUpdate",
      timestamp: 2,
      payload: { engineRunning: false, mode: null, paperHardStop: null },
    });
    expect((cleared!.payload as StatusPayload).paperHardStop).toBeNull();

    const legacy = normalizeRuntimeEvent({
      type: "StatusUpdate",
      timestamp: 3,
      payload: { engineRunning: true, mode: "paper" },
    });
    expect("paperHardStop" in (legacy!.payload as object)).toBe(false);
  });
});
