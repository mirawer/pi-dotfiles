import { describe, expect, it } from "vitest";
import { poolTokens, selectPromotionOverflow } from "../src/ledger/pool.js";
import type { Observation } from "../src/ledger/types.js";

function obs(timestamp: string, tokenCount: number): Observation {
	return { timestamp, content: `c ${timestamp}`, tokenCount };
}

describe("poolTokens", () => {
	it("sums tokenCount", () => {
		expect(poolTokens([obs("2026-01-01T00:00:00", 10), obs("2026-01-01T00:01:00", 5)])).toBe(15);
	});
});

describe("selectPromotionOverflow (oldest-first)", () => {
	it("promotes the oldest observations above the target, keeping the newest", () => {
		const active = [
			obs("2026-01-01T00:01:00", 40), // oldest
			obs("2026-01-01T00:02:00", 40),
			obs("2026-01-01T00:03:00", 40),
			obs("2026-01-01T00:04:00", 40), // newest
		];
		const { promote, keptTokens, totalTokens } = selectPromotionOverflow(active, 100);
		// keep newest two (80 tok); next would push to 120 > 100.
		expect(promote.map((o) => o.timestamp)).toEqual(["2026-01-01T00:01:00", "2026-01-01T00:02:00"]);
		expect(keptTokens).toBe(80);
		expect(totalTokens).toBe(160);
	});

	it("sorts unordered input chronologically before selecting", () => {
		const active = [
			obs("2026-01-01T00:03:00", 40),
			obs("2026-01-01T00:01:00", 40),
			obs("2026-01-01T00:04:00", 40),
			obs("2026-01-01T00:02:00", 40),
		];
		const { promote } = selectPromotionOverflow(active, 100);
		expect(promote.map((o) => o.timestamp)).toEqual(["2026-01-01T00:01:00", "2026-01-01T00:02:00"]);
	});

	it("promotes nothing when the pool is within target", () => {
		const active = [obs("2026-01-01T00:01:00", 30), obs("2026-01-01T00:02:00", 30)];
		expect(selectPromotionOverflow(active, 100).promote).toEqual([]);
	});

	it("always keeps at least the newest observation, even if it alone exceeds target", () => {
		const active = [obs("2026-01-01T00:01:00", 40), obs("2026-01-01T00:02:00", 500)];
		const { promote } = selectPromotionOverflow(active, 100);
		expect(promote.map((o) => o.timestamp)).toEqual(["2026-01-01T00:01:00"]);
	});

	it("handles an empty pool", () => {
		expect(selectPromotionOverflow([], 100)).toEqual({ promote: [], keptTokens: 0, totalTokens: 0 });
	});
});
