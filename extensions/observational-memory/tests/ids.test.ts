import { describe, expect, it } from "vitest";

import { assignObservationTimestamps } from "../src/ids.js";

describe("assignObservationTimestamps (L5)", () => {
	it("derives a second-resolution id base from the model's minute timestamp", () => {
		const result = assignObservationTimestamps([{ timestamp: "2026-06-25 14:30", content: "hi there" }]);
		expect(result).toEqual([{ timestamp: "2026-06-25T14:30:00", content: "hi there", tokenCount: 2 }]);
	});

	it("disambiguates same-minute observations with .NN suffixes in emission order", () => {
		const result = assignObservationTimestamps([
			{ timestamp: "2026-06-25 14:30", content: "first" },
			{ timestamp: "2026-06-25 14:30", content: "second" },
			{ timestamp: "2026-06-25 14:30", content: "third" },
		]);
		expect(result.map((o) => o.timestamp)).toEqual([
			"2026-06-25T14:30:00",
			"2026-06-25T14:30:00.01",
			"2026-06-25T14:30:00.02",
		]);
	});

	it("avoids collisions against already-used timestamps from the existing buffer", () => {
		const result = assignObservationTimestamps([{ timestamp: "2026-06-25 14:30", content: "new" }], {
			used: ["2026-06-25T14:30:00", "2026-06-25T14:30:00.01"],
		});
		expect(result[0].timestamp).toBe("2026-06-25T14:30:00.02");
	});

	it("falls back to the anchor time when the model timestamp is malformed", () => {
		const anchor = new Date("2026-06-25T09:15:42").getTime();
		const result = assignObservationTimestamps([{ timestamp: "not a time", content: "x" }], { fallbackAnchor: anchor });
		expect(result[0].timestamp).toBe("2026-06-25T09:15:42");
	});

	it("computes tokenCount in code, never from the model", () => {
		const content = "a".repeat(40);
		const [obs] = assignObservationTimestamps([{ timestamp: "2026-06-25 14:30", content }]);
		expect(obs.tokenCount).toBe(10);
	});
});
