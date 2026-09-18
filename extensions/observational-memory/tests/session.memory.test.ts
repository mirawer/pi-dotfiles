import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessionMemoryRoot } from "../src/memory/paths.js";
import { ensureSessionMemory } from "../src/memory/session.js";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "om-session-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

/** Minimal session-file header line, as written by pi's SessionManager. */
function writeSessionFile(id: string): string {
	const file = join(cwd, `${id}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", id, cwd })}\n`, "utf-8");
	return file;
}

function fakeCtx(sessionId: string, header?: { parentSession?: string }) {
	return {
		cwd,
		sessionManager: {
			getSessionId: () => sessionId,
			getHeader: () => ({ id: sessionId, cwd, ...header }),
		},
	};
}

describe("ensureSessionMemory", () => {
	it("returns the per-session root and does not create it without a parent", () => {
		const root = ensureSessionMemory(fakeCtx("child"));
		expect(root).toBe(sessionMemoryRoot(cwd, "child"));
		// Lazy: nothing to seed, so the dir is left for the first durable write to create.
		expect(existsSync(root)).toBe(false);
	});

	it("seeds from the parent session on first touch, excluding .runs/", () => {
		const parentRoot = sessionMemoryRoot(cwd, "parent");
		mkdirSync(join(parentRoot, ".runs"), { recursive: true });
		writeFileSync(join(parentRoot, "auth.md"), "---\nid: auth\n---\nbody", "utf-8");
		writeFileSync(join(parentRoot, "JOURNEY.md"), "## history", "utf-8");
		writeFileSync(join(parentRoot, ".runs", "obs-1.cost.json"), "{}", "utf-8");

		const parentFile = writeSessionFile("parent");
		const root = ensureSessionMemory(fakeCtx("child", { parentSession: parentFile }));

		expect(root).toBe(sessionMemoryRoot(cwd, "child"));
		expect(readFileSync(join(root, "auth.md"), "utf-8")).toContain("body");
		expect(readFileSync(join(root, "JOURNEY.md"), "utf-8")).toBe("## history");
		// Transient IPC is never carried across the fork.
		expect(existsSync(join(root, ".runs"))).toBe(false);
	});

	it("is idempotent: an existing root is never re-seeded from the parent", () => {
		const parentRoot = sessionMemoryRoot(cwd, "parent");
		mkdirSync(parentRoot, { recursive: true });
		writeFileSync(join(parentRoot, "auth.md"), "parent copy", "utf-8");
		const parentFile = writeSessionFile("parent");

		// Child already has its own divergent memory — seeding must not clobber it.
		const childRoot = sessionMemoryRoot(cwd, "child");
		mkdirSync(childRoot, { recursive: true });
		writeFileSync(join(childRoot, "auth.md"), "child copy", "utf-8");

		const root = ensureSessionMemory(fakeCtx("child", { parentSession: parentFile }));
		expect(readFileSync(join(root, "auth.md"), "utf-8")).toBe("child copy");
	});

	it("skips seeding when the parent kept no memory under this project", () => {
		const parentFile = writeSessionFile("parent"); // no parent memory root on disk
		const root = ensureSessionMemory(fakeCtx("child", { parentSession: parentFile }));
		expect(existsSync(root)).toBe(false);
	});
});
