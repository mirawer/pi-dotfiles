import { describe, expect, it } from "vitest";

import { DEFAULTS } from "../src/config.js";
import type { Entry } from "../src/ledger/index.js";
import { renderTimeline } from "../src/ui/timeline.js";
import {
	compactionEntry,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	rawMessage,
} from "./fixtures/session.js";

const cfg = { ...DEFAULTS, chunkTokens: 3000, consolidateAtPoolTokens: 10_000, poolTargetTokens: 5_000 };

/** A big source message worth ~`tokens` (4 chars ≈ 1 token in the estimator). */
function bigMessage(id: string, tokens: number): Entry {
	return rawMessage(id, "x".repeat(tokens * 4)) as unknown as Entry;
}

describe("renderTimeline", () => {
	it("renders an empty timeline when nothing has happened", () => {
		const out = renderTimeline([], cfg);
		expect(out).toContain("(timeline empty)");
		expect(out).toContain("0 compactions");
	});

	it("renders one cell per chunk and classifies pool vs consolidated vs raw", () => {
		const branch = [
			bigMessage("m1", 3000),
			observationsRecordedEntry("r1", { observations: [observation("t1")], coversUpToId: "m1" }) as unknown as Entry,
			bigMessage("m2", 3000),
			observationsRecordedEntry("r2", { observations: [observation("t2")], coversUpToId: "m2" }) as unknown as Entry,
			// t1 promoted to .memory, t2 still in pool
			observationsDroppedEntry("d1", { observationTimestamps: ["t1"], coversUpToId: "m2" }) as unknown as Entry,
			bigMessage("m3", 6000), // ~2 raw (unobserved) cells
		] as Entry[];

		const out = renderTimeline(branch, cfg);
		const strip = out.split("\n")[1];
		expect(strip).toBe("▓▒░░▶"); // consolidated, pool, 2 raw, tip
		expect(out).toContain("▓ .memory (1)");
		expect(out).toContain("▒ pool (1)");
	});

	it("marks a partially-promoted chunk", () => {
		const branch = [
			bigMessage("m1", 3000),
			observationsRecordedEntry("r1", {
				observations: [observation("t1"), observation("t2")],
				coversUpToId: "m1",
			}) as unknown as Entry,
			observationsDroppedEntry("d1", { observationTimestamps: ["t1"], coversUpToId: "m1" }) as unknown as Entry,
		] as Entry[];
		const strip = renderTimeline(branch, cfg).split("\n")[1];
		expect(strip).toBe("▚▶");
	});

	it("overlays a compaction cut at the chunk boundary", () => {
		const branch = [
			bigMessage("m1", 3000),
			observationsRecordedEntry("r1", { observations: [observation("t1")], coversUpToId: "m1" }) as unknown as Entry,
			bigMessage("m2", 3000),
			observationsRecordedEntry("r2", { observations: [observation("t2")], coversUpToId: "m2" }) as unknown as Entry,
			compactionEntry("c1", { firstKeptEntryId: "m2" }) as unknown as Entry,
		] as Entry[];
		const strip = renderTimeline(branch, cfg).split("\n")[1];
		// cut sits before the chunk covering m2 (one chunk boundary precedes m2's index)
		expect(strip).toBe("▒┊▒▶");
		expect(renderTimeline(branch, cfg)).toContain("1 compaction");
	});

	it("wraps the strip across rows at the given width", () => {
		const branch: Entry[] = [];
		for (let i = 1; i <= 5; i++) {
			branch.push(bigMessage(`m${i}`, 3000));
			branch.push(
				observationsRecordedEntry(`r${i}`, {
					observations: [observation(`t${i}`)],
					coversUpToId: `m${i}`,
				}) as unknown as Entry,
			);
		}
		const out = renderTimeline(branch, cfg, 2);
		const lines = out.split("\n");
		// 5 pool cells at width 2 → rows "▒▒", "▒▒", "▒▶"
		expect(lines[1]).toBe("▒▒");
		expect(lines[2]).toBe("▒▒");
		expect(lines[3]).toBe("▒▶");
	});


});
