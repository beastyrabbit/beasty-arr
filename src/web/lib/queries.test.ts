import { beforeEach, describe, expect, it, vi } from "vitest";

const toastMocks = vi.hoisted(() => ({
  base: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(toastMocks.base, {
    error: toastMocks.error,
    success: toastMocks.success,
  }),
}));

import { toastMaybeDryRun } from "./queries.js";

describe("toastMaybeDryRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a blocked apply outcome as an error instead of a success", () => {
    toastMaybeDryRun({ ok: false, message: "Blocked language downgrade." }, "Import command sent");

    expect(toastMocks.error).toHaveBeenCalledWith("Blocked language downgrade.");
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it("keeps dry-run simulations distinct from live successes", () => {
    toastMaybeDryRun({ dryRun: true, wouldHave: "would import one file" }, "ignored");

    expect(toastMocks.base).toHaveBeenCalledWith("DRY RUN — would import one file", { icon: "◌" });
    expect(toastMocks.success).not.toHaveBeenCalled();
  });
});
