import { describe, expect, it } from "vitest";

import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	earlierCoverageMarkerId,
	entryIndexById,
	isSourceEntry,
	lastSourceEntryId,
	latestCoverageIndex,
	latestCoverageMarkerId,
	rawTokensAfterIndex,
	rawTokensSinceDropCoverage,
	rawTokensSinceLastCompaction,
	rawTokensSinceObservationCoverage,
	selectSourceSlice,
} from "../src/ledger/index.js";
import {
	branchSummary,
	compactionEntry,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	assistantToolCallMessage,
	rawMessage,
	textCustomMessage,
	toolResultMessage,
} from "./fixtures/session.js";

describe("lastSourceEntryId", () => {
	it("returns the id of the last source entry on the branch (tombstone watermark anchor)", () => {
		const branch = [
			textCustomMessage("raw-1", "abcd"),
			textCustomMessage("raw-2", "efgh"),
			observationsRecordedEntry("om-1", { observations: [observation("2026-05-02T10:00:00")], coversUpToId: "raw-2" }),
		];
		expect(lastSourceEntryId(branch)).toBe("raw-2");
	});

	it("returns undefined when there are no source entries", () => {
		expect(lastSourceEntryId([])).toBeUndefined();
	});
});

describe("ledger progress helpers", () => {
	it("detects only source entries", () => {
		expect(isSourceEntry(textCustomMessage("raw-1", "abcd"))).toBe(true);
		expect(isSourceEntry(branchSummary("sum-1", "abcd"))).toBe(true);
		expect(
			isSourceEntry(observationsRecordedEntry("om-1", { observations: [observation("t1")], coversUpToId: "raw-1" })),
		).toBe(false);
		expect(isSourceEntry(compactionEntry("cmp-1"))).toBe(false);
	});

	it("builds an id→index map", () => {
		const entries = [textCustomMessage("raw-1", "abcd"), textCustomMessage("raw-2", "efgh")];
		expect(entryIndexById(entries).get("raw-1")).toBe(0);
		expect(entryIndexById(entries).get("raw-2")).toBe(1);
	});

	it("counts raw tokens after an index, ignoring memory/compaction entries", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", { observations: [observation("t1")], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-2" }),
			branchSummary("sum-1", "cccccccccccc"),
		];

		expect(rawTokensAfterIndex(entries, 0)).toBe(5); // raw-2: 2 + sum-1: 3
		expect(rawTokensAfterIndex(entries, 2)).toBe(3);
	});

	it("uses independent coverage clocks for observations and drops", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", { observations: [observation("t1")], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
			textCustomMessage("raw-3", "cccccccccccc"),
			observationsDroppedEntry("om-drop-1", { observationTimestamps: ["t1"], coversUpToId: "raw-2" }),
			textCustomMessage("raw-4", "dddddddddddddddd"),
		];

		expect(rawTokensSinceObservationCoverage(entries)).toBe(9); // raw-2 + raw-3 + raw-4
		expect(rawTokensSinceDropCoverage(entries)).toBe(7); // raw-3 + raw-4
	});

	it("chooses the max covered branch position, not ledger order", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			textCustomMessage("raw-2", "bbbbbbbb"),
			observationsRecordedEntry("om-1", { observations: [observation("t1")], coversUpToId: "raw-2" }),
			observationsRecordedEntry("om-2", { observations: [observation("t2")], coversUpToId: "raw-1" }),
			textCustomMessage("raw-3", "cccccccccccc"),
		];

		expect(latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED)).toBe(1);
		expect(latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED)).toBe("raw-2");
		expect(latestCoverageIndex(entries, OM_OBSERVATIONS_DROPPED)).toBe(-1);
		expect(rawTokensSinceObservationCoverage(entries)).toBe(3);
	});

	it("compares coverage markers by branch index", () => {
		const entries = [textCustomMessage("raw-1", "a"), textCustomMessage("raw-2", "b"), textCustomMessage("raw-3", "c")];
		expect(earlierCoverageMarkerId(entries, "raw-3", "raw-2")).toBe("raw-2");
		expect(earlierCoverageMarkerId(entries, "raw-1", undefined)).toBe("raw-1");
		expect(earlierCoverageMarkerId(entries, "missing", "raw-2")).toBe("raw-2");
		expect(earlierCoverageMarkerId(entries, "missing-a", "missing-b")).toBeUndefined();
	});

	it("counts raw tokens since the latest compaction", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			compactionEntry("cmp-1", { firstKeptEntryId: "raw-1" }),
			textCustomMessage("raw-2", "bbbbbbbb"),
		];
		expect(rawTokensSinceLastCompaction(entries)).toBe(3); // raw-1 + raw-2 from kept tail
	});
});

describe("selectSourceSlice", () => {
	it("selects source entries after the watermark, bounded by chunkTokens", () => {
		const entries = [
			textCustomMessage("raw-1", "a".repeat(40)), // 10 tokens
			observationsRecordedEntry("om-1", { observations: [observation("t1")], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "b".repeat(40)), // 10 tokens
			textCustomMessage("raw-3", "c".repeat(40)), // 10 tokens
			textCustomMessage("raw-4", "d".repeat(40)), // 10 tokens
		];

		const slice = selectSourceSlice(entries, "raw-1", 25);
		expect(slice.entries.map((e) => e.id)).toEqual(["raw-2", "raw-3"]);
		expect(slice.coversUpToId).toBe("raw-3");
		expect(slice.tokens).toBe(20);
	});

	it("always includes at least one source entry even if oversized", () => {
		const entries = [textCustomMessage("raw-1", "x".repeat(400))]; // 100 tokens
		const slice = selectSourceSlice(entries, undefined, 10);
		expect(slice.entries.map((e) => e.id)).toEqual(["raw-1"]);
		expect(slice.coversUpToId).toBe("raw-1");
	});

	it("never ends a chunk between a tool call and its result, even past the token budget", () => {
		const entries = [
			rawMessage("raw-1", "a".repeat(40)), // 10 tokens (the watermark)
			assistantToolCallMessage("asst-1", { arguments: { cmd: "x".repeat(40) } }), // ~10+ tokens, tool call
			toolResultMessage("tr-1", "b".repeat(40)), // 10 tokens, must stay with asst-1
			rawMessage("raw-2", "c".repeat(40)), // 10 tokens — the valid next-chunk start
		];

		// Budget is exceeded right at the tool result, but it is not a valid cut point, so the
		// slice extends to include it and only breaks at the following user message.
		const slice = selectSourceSlice(entries, "raw-1", 15);
		expect(slice.entries.map((e) => e.id)).toEqual(["asst-1", "tr-1"]);
		expect(slice.coversUpToId).toBe("tr-1");
	});

	it("breaks before an assistant tool call so the call and result move to the next chunk together", () => {
		const entries = [
			rawMessage("raw-1", "a".repeat(40)), // 10 tokens
			assistantToolCallMessage("asst-1", { arguments: { cmd: "x".repeat(40) } }), // tool call
			toolResultMessage("tr-1", "b".repeat(40)), // result
		];

		// raw-1 fills the budget; the next entry is the assistant tool call (a valid cut point),
		// so the chunk ends at raw-1 and the call+result start the following chunk.
		const slice = selectSourceSlice(entries, undefined, 10);
		expect(slice.entries.map((e) => e.id)).toEqual(["raw-1"]);
		expect(slice.coversUpToId).toBe("raw-1");
	});

	it("returns an empty slice when nothing new follows the watermark", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-1", { observations: [observation("t1")], coversUpToId: "raw-1" }),
		];
		const slice = selectSourceSlice(entries, "raw-1", 5000);
		expect(slice.entries).toEqual([]);
		expect(slice.coversUpToId).toBeUndefined();
	});
});
