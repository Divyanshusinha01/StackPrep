import { describe, expect, it } from "vitest";
import { formatCount, formatMs, formatPercent, formatUsd, parseAdminWindow } from "./admin-format";

describe("parseAdminWindow", () => {
  it("accepts the offered windows", () => {
    expect(parseAdminWindow("1")).toBe(1);
    expect(parseAdminWindow("30")).toBe(30);
    expect(parseAdminWindow("90")).toBe(90);
  });

  it("falls back to 7 days for anything else", () => {
    for (const value of [undefined, "", "2", "365", "-7", "abc", ["30", "90"]]) {
      expect(parseAdminWindow(value)).toBe(7);
    }
  });
});

describe("formatting", () => {
  it("formats dollars with at least cents and at most four decimals", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1.5)).toBe("$1.50");
    expect(formatUsd(0.00123)).toBe("$0.0012");
  });

  it("formats counts with separators", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
  });

  it("formats ratios, with a dash for no data", () => {
    expect(formatPercent(0.4567)).toBe("45.7%");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(null)).toBe("—");
  });

  it("formats durations in ms below a second and seconds above", () => {
    expect(formatMs(12.4)).toBe("12 ms");
    expect(formatMs(2500)).toBe("2.50 s");
    expect(formatMs(null)).toBe("—");
  });
});
