import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { isCostEntry, sumSessionCost, type Entry } from "../src/ledger/index.js";
import { readWorkerCost, runCostPath, writeWorkerCost } from "../src/spawn/runs.js";
import { costEntry, observationsRecordedEntry, textCustomMessage, unknownCustomEntry } from "./fixtures/session.js";

describe("sumSessionCost (whole-session, never rolls back)", () => {
	it("sums every om.cost entry across all branches", () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			costEntry("obs-1", 0.0021, "observer"),
			observationsRecordedEntry("om-1", { observations: [], coversUpToId: "raw-1" } as never),
			costEntry("obs-2", 0.0009, "observer"),
			costEntry("cons-1", 0.0125, "consolidator"),
		] as unknown as Entry[];

		const { costUsd, runs } = sumSessionCost(entries);
		expect(costUsd).toBeCloseTo(0.0155, 10);
		expect(runs).toBe(3);
	});

	it("counts entries from every branch (no rollback under /tree)", () => {
		// Entries from an abandoned branch remain in getEntries() and must still count.
		const abandonedBranch = [costEntry("obs-a", 0.01), costEntry("obs-b", 0.02)];
		const currentBranch = [costEntry("obs-c", 0.03)];
		const all = [...abandonedBranch, ...currentBranch] as unknown as Entry[];

		expect(sumSessionCost(all).costUsd).toBeCloseTo(0.06, 10);
		// Removing the abandoned branch would understate spend — proving why we use all entries.
		expect(sumSessionCost(currentBranch as unknown as Entry[]).costUsd).toBeCloseTo(0.03, 10);
	});

	it("ignores unrelated and malformed entries", () => {
		const entries = [
			unknownCustomEntry("x-1", "om.enabled", { enabled: true }),
			unknownCustomEntry("x-2", "om.cost", { costUsd: "free" }),
			unknownCustomEntry("x-3", "om.cost", { costUsd: -1 }),
			costEntry("ok-1", 0.005),
		] as unknown as Entry[];

		const { costUsd, runs } = sumSessionCost(entries);
		expect(costUsd).toBeCloseTo(0.005, 10);
		expect(runs).toBe(1);
	});

	it("isCostEntry guards on a finite non-negative costUsd", () => {
		expect(isCostEntry(costEntry("ok", 0) as unknown as Entry)).toBe(true);
		expect(isCostEntry(unknownCustomEntry("bad", "om.cost", { costUsd: Number.NaN }) as unknown as Entry)).toBe(false);
		expect(isCostEntry(unknownCustomEntry("other", "om.enabled", {}) as unknown as Entry)).toBe(false);
	});
});

describe("worker cost file IPC", () => {
	it("round-trips a written cost file", () => {
		const dir = mkdtempSync(join(tmpdir(), "om-cost-"));
		try {
			const path = runCostPath(dir, "obs-123");
			writeWorkerCost(path, { costUsd: 0.0042 });
			expect(readWorkerCost(path)).toEqual({ costUsd: 0.0042 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns undefined for a missing or malformed file", () => {
		const dir = mkdtempSync(join(tmpdir(), "om-cost-"));
		try {
			expect(readWorkerCost(runCostPath(dir, "nope"))).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
