import { describe, expect, it } from "vitest";

import { compareVersions } from "../src/update-notifier.js";

describe("update-notifier", () => {
  describe("compareVersions", () => {
    it("returns 0 for equal versions", () => {
      expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    });

    it("returns positive when first version is greater", () => {
      expect(compareVersions("1.0.1", "1.0.0")).toBeGreaterThan(0);
      expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
      expect(compareVersions("1.1.0", "1.0.9")).toBeGreaterThan(0);
    });

    it("returns negative when first version is smaller", () => {
      expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
      expect(compareVersions("1.9.9", "2.0.0")).toBeLessThan(0);
      expect(compareVersions("1.0.9", "1.1.0")).toBeLessThan(0);
    });

    it("handles versions with different segment counts", () => {
      expect(compareVersions("1.0", "1.0.0")).toBe(0);
      expect(compareVersions("1.0.0", "1.0")).toBe(0);
    });

    it("handles versions with v prefix", () => {
      expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
      expect(compareVersions("v1.0.1", "1.0.0")).toBeGreaterThan(0);
    });

    it("handles versions with caret/tilde prefix", () => {
      expect(compareVersions("^1.0.0", "1.0.0")).toBe(0);
      expect(compareVersions("~1.0.0", "1.0.0")).toBe(0);
    });
  });
});
