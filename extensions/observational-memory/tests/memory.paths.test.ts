import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderIndexFile, renderMemoryMap } from "../src/memory/index-render.js";
import { atomicWrite, listTopics, parseFrontMatter, readJourney, resolveWithinMemory } from "../src/memory/paths.js";

let cwd: string;
let root: string; // the per-session memory root: <cwd>/.memory/<sessionId>

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "om-mem-"));
	root = join(cwd, ".memory", "sess-1");
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function writeTopic(filename: string, content: string): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, filename), content, "utf-8");
}

describe("resolveWithinMemory", () => {
	it("resolves paths inside .memory/", () => {
		expect(resolveWithinMemory(root, "auth.md")).toBe(join(root, "auth.md"));
		expect(resolveWithinMemory(root, ".memory/auth.md")).toBe(join(root, ".memory", "auth.md"));
	});

	it("rejects paths that escape the sandbox", () => {
		expect(resolveWithinMemory(root, "../secret.txt")).toBeUndefined();
		expect(resolveWithinMemory(root, "../../etc/passwd")).toBeUndefined();
	});
});

describe("parseFrontMatter", () => {
	it("parses flat key: value front-matter and returns the body", () => {
		const { front, body } = parseFrontMatter(
			"---\nid: auth\ntitle: Authentication\nsummary: JWT + sessions\nupdated: 2026-06-25 14:00\n---\nBody text here.\n",
		);
		expect(front).toEqual({ id: "auth", title: "Authentication", summary: "JWT + sessions", updated: "2026-06-25 14:00" });
		expect(body).toBe("Body text here.\n");
	});

	it("strips surrounding quotes", () => {
		const { front } = parseFrontMatter('---\nsummary: "quoted, with comma"\n---\nx');
		expect(front.summary).toBe("quoted, with comma");
	});

	it("returns empty front-matter when absent", () => {
		const { front, body } = parseFrontMatter("no front matter");
		expect(front).toEqual({});
		expect(body).toBe("no front matter");
	});
});

describe("listTopics", () => {
	it("returns parsed topics excluding INDEX.md and JOURNEY.md, sorted by filename", () => {
		writeTopic("INDEX.md", "# Memory index");
		writeTopic("JOURNEY.md", "## 2026-05-01\nStarted the project.");
		writeTopic("zebra.md", "---\nid: zebra\ntitle: Zebra\nsummary: z\n---\nbody");
		writeTopic("auth.md", "---\nid: auth\ntitle: Auth\nsummary: a\n---\nbody");
		const topics = listTopics(root);
		expect(topics.map((t) => t.filename)).toEqual(["auth.md", "zebra.md"]);
		expect(topics[0]).toMatchObject({ id: "auth", title: "Auth", summary: "a", path: join(".memory", "sess-1", "auth.md") });
	});

	it("returns [] when the session memory root does not exist", () => {
		expect(listTopics(root)).toEqual([]);
	});
});

describe("readJourney", () => {
	it("returns undefined when JOURNEY.md is absent", () => {
		expect(readJourney(root)).toBeUndefined();
	});

	it("returns the trimmed body when present", () => {
		writeTopic("JOURNEY.md", "\n## 2026-05-01\nStarted the project.\n\n");
		expect(readJourney(root)).toBe("## 2026-05-01\nStarted the project.");
	});

	it("returns undefined when JOURNEY.md is effectively empty", () => {
		writeTopic("JOURNEY.md", "   \n\n");
		expect(readJourney(root)).toBeUndefined();
	});
});

describe("renderIndexFile / renderMemoryMap", () => {
	it("renders an empty index placeholder", () => {
		expect(renderIndexFile([])).toContain("_No topics yet._");
		expect(renderMemoryMap([])).toBeUndefined();
	});

	it("renders topics into the index file and the compaction map", () => {
		writeTopic("auth.md", "---\nid: auth\ntitle: Auth\nsummary: JWT and sessions\nupdated: 2026-06-25 14:00\n---\nbody");
		const topics = listTopics(root);
		const index = renderIndexFile(topics);
		expect(index).toContain("## Auth");
		expect(index).toContain("`.memory/sess-1/auth.md`");
		expect(index).toContain("JWT and sessions");
		const map = renderMemoryMap(topics);
		expect(map).toContain("## Memory map");
		expect(map).toContain("`.memory/sess-1/auth.md` — JWT and sessions (updated 2026-06-25 14:00)");
	});
});

describe("atomicWrite", () => {
	it("writes content, creating parent dirs", () => {
		const path = join(cwd, ".memory", "deep", "file.md");
		atomicWrite(path, "hello");
		expect(readFileSync(path, "utf-8")).toBe("hello");
	});
});
