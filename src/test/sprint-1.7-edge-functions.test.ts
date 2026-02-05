import { describe, expect, it, vi, beforeEach } from "vitest";
import { invokeFunction } from "@/services/supabaseFunctions";
import { supabase } from "@/integrations/supabase/client";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: vi.fn(),
    },
  },
}));

const invokeMock = vi.mocked(supabase.functions.invoke);

describe("supabaseFunctions.invokeFunction", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("returns data when function succeeds", async () => {
    invokeMock.mockResolvedValue({
      data: { ok: true, id: "abc" },
      error: null,
    });

    const result = await invokeFunction("journal-entry", {
      action: "create",
      user_id: "user",
      title: "Test",
    });

    expect(result).toEqual({ ok: true, id: "abc" });
  });

  it("throws when function returns an error", async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: { message: "boom" },
    });

    await expect(
      invokeFunction("alerts-ack", { id: "id" })
    ).rejects.toThrow("boom");
  });
});
