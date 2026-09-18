import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

interface StructuredSearchArgs {
	query?: string;
	exactPhrases?: string[];
	excludeTerms?: string[];
	site?: string;
	count?: number;
}

interface BuiltSearchQuery {
	query: string;
	baseQuery?: string;
	exactPhrases: string[];
	excludeTerms: string[];
	site?: string;
}

const NIMBLE_SEARCH_URL = "https://sdk.nimbleway.com/v2/search";

async function nimbleSearch(
	query: string,
	count: number,
	apiKey: string,
	site: string | undefined,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const body: Record<string, unknown> = {
		query,
		max_results: Math.min(Math.max(count, 1), 20),
	};
	// Nimble has a native domain filter, which is more reliable than a
	// site: operator embedded in the query string.
	if (site) body.include_domains = [site];

	const resp = await fetch(NIMBLE_SEARCH_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!resp.ok) {
		const text = await resp.text();
		if (resp.status === 401 || resp.status === 403) {
			throw new Error(
				`Nimble auth failed (${resp.status}). Check nimble.api_key in ${SECRETS_PATH}.`,
			);
		}
		if (resp.status === 429) {
			throw new Error(
				"Nimble rate limit or monthly request quota exhausted (429).",
			);
		}
		throw new Error(`Nimble API ${resp.status}: ${text.slice(0, 200)}`);
	}

	const data = (await resp.json()) as {
		results?: Array<{
			title?: string;
			url?: string;
			description?: string;
		}>;
	};

	if (!data.results || data.results.length === 0) return [];

	return data.results
		.filter((item) => item.url)
		.map((item) => ({
			title: item.title ?? item.url ?? "",
			url: item.url as string,
			snippet: (item.description ?? "").replace(/\s+/g, " ").trim(),
		}));
}

const AGENT_DIR =
	process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const SECRETS_PATH = path.join(AGENT_DIR, "secrets.json");

const KEY_PLACEHOLDER = "WKLEJ_TU_SWOJ_KLUCZ";

function readJson(file: string): Record<string, any> | null {
	if (!fs.existsSync(file)) return null;
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

// The scaffold placeholder counts as "not configured", so a forgotten paste
// surfaces as a clear message instead of a 401 from Nimble.
function usableKey(value: unknown): string | null {
	return typeof value === "string" && value && value !== KEY_PLACEHOLDER
		? value
		: null;
}

function loadCredentials(): { apiKey: string } | null {
	const envKey = usableKey(process.env.NIMBLE_API_KEY);
	if (envKey) return { apiKey: envKey };

	// Shared secrets file for every extension: <agent dir>/secrets.json
	const shared = usableKey(readJson(SECRETS_PATH)?.nimble?.api_key);
	if (shared) return { apiKey: shared };

	return null;
}

function formatResults(results: SearchResult[]): string {
	if (results.length === 0) return "No results found.";
	return results
		.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
		.join("\n\n");
}

function stripWrappingQuotes(value: string): string {
	return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
		? value.slice(1, -1).trim()
		: value;
}

function cleanItems(values?: string[]): string[] {
	if (!values) return [];
	return values
		.map((value) => stripWrappingQuotes(value.trim().replace(/\s+/g, " ")))
		.filter(Boolean);
}

function cleanQuery(value?: string): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = value.trim().replace(/\s+/g, " ");
	return cleaned || undefined;
}

function normalizeSite(site?: string): string | undefined {
	if (typeof site !== "string") return undefined;

	let value = site.trim().replace(/^site:/i, "").trim();
	if (!value) return undefined;

	try {
		const candidate = /^[a-z]+:\/\//i.test(value)
			? value
			: `https://${value}`;
		const url = new URL(candidate);
		if (url.hostname) value = url.hostname;
	} catch {}

	return value.replace(/\/+$/, "") || undefined;
}

function quoteForSearch(value: string): string {
	return `"${value.replace(/"/g, '\\"')}"`;
}

function buildSearchQuery(args: StructuredSearchArgs): BuiltSearchQuery {
	const baseQuery = cleanQuery(args.query);
	const exactPhrases = cleanItems(args.exactPhrases);
	const excludeTerms = cleanItems(args.excludeTerms);
	const site = normalizeSite(args.site);

	if (!baseQuery && exactPhrases.length === 0) {
		throw new Error(
			"At least one of 'query' or 'exactPhrases' is required.",
		);
	}

	const parts: string[] = [];
	if (baseQuery) parts.push(baseQuery);
	for (const phrase of exactPhrases) {
		parts.push(quoteForSearch(phrase));
	}
	for (const term of excludeTerms) {
		parts.push(`-${term.includes(" ") ? quoteForSearch(term) : term}`);
	}
	// `site` is not folded into the query string — it is passed to Nimble as
	// the native include_domains parameter instead.

	return {
		query: parts.join(" "),
		baseQuery,
		exactPhrases,
		excludeTerms,
		site,
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via Nimble Search API. Build one search per call from a base query string, exact phrases, exclusions, and an optional site. Returns title, URL, and snippet.",
		promptSnippet:
			"Search the web via a query string plus optional exactPhrases, excludeTerms, and site. Use one tool call per search angle.",
		promptGuidelines: [
			"Use exactPhrases for exact phrase matching instead of embedding quote marks inside the main query string.",
			"Use one web_search tool call per search angle instead of batching multiple searches into one call.",
		],

		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description:
						"Base search query as a normal string. Prefer this for the main search wording.",
				}),
			),
			exactPhrases: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Exact phrases to match. Each item becomes a quoted phrase in the final search query.",
				}),
			),
			excludeTerms: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Terms or phrases to exclude. Multi-word items are excluded as exact phrases.",
				}),
			),
			site: Type.Optional(
				Type.String({
					description:
						"Optional site/domain restriction, such as example.com or a full URL.",
				}),
			),
			count: Type.Optional(
				Type.Number({
					description: "Number of results to return (default: 5, max: 20)",
					minimum: 1,
					maximum: 20,
				}),
			),
		}),

		async execute(_toolCallId, params: StructuredSearchArgs, signal) {
			const creds = loadCredentials();
			if (!creds) {
				throw new Error(
					`Missing Nimble API key. Add {"nimble": {"api_key": "..."}} to ${SECRETS_PATH}, or set NIMBLE_API_KEY. Get a key at https://nimbleway.com -> Settings -> API Keys`,
				);
			}

			const count = params.count ?? 5;
			const built = buildSearchQuery(params);
			const results = await nimbleSearch(
				built.query,
				count,
				creds.apiKey,
				built.site,
				signal,
			);

			return {
				content: [
					{
						type: "text" as const,
						text: formatResults(results),
					},
				],
				details: {
					composedQuery: built.query,
					query: built.baseQuery,
					exactPhrases: built.exactPhrases,
					excludeTerms: built.excludeTerms,
					site: built.site,
					resultCount: results.length,
				},
			};
		},

		renderCall(args, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ??
				new Text("", 0, 0);
			const { count, ...searchArgs } = args as StructuredSearchArgs;

			try {
				const built = buildSearchQuery(searchArgs);
				const display =
					built.query.length > 70
						? built.query.slice(0, 67) + "..."
						: built.query;
				const lines = [
					theme.fg("toolTitle", theme.bold("search ")) +
						theme.fg("accent", `"${display}"`),
				];
				if (count && count !== 5) {
					lines.push(theme.fg("dim", `  count: ${count}`));
				}
				text.setText(lines.join("\n"));
				return text;
			} catch {
				text.setText(
					theme.fg("toolTitle", theme.bold("search ")) +
						theme.fg("error", "(invalid query)"),
				);
				return text;
			}
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ??
				new Text("", 0, 0);

			if (isPartial) {
				text.setText(theme.fg("warning", "Searching…"));
				return text;
			}

			if (context.isError) {
				const msg =
					result.content.find((c) => c.type === "text")?.text ||
					"Error";
				text.setText(theme.fg("error", msg));
				return text;
			}

			const details = result.details as {
				composedQuery?: string;
				resultCount?: number;
			};
			const status = theme.fg(
				"success",
				`${details?.resultCount ?? 0} results`,
			);
			if (!expanded) {
				text.setText(status);
				return text;
			}

			const content =
				result.content.find((c) => c.type === "text")?.text || "";
			const preview =
				content.length > 500 ? content.slice(0, 500) + "..." : content;
			const queryLine = details?.composedQuery
				? theme.fg("dim", `query: ${details.composedQuery}`)
				: "";
			text.setText(
				[status, queryLine, theme.fg("dim", preview)]
					.filter(Boolean)
					.join("\n"),
			);
			return text;
		},
	});
}
