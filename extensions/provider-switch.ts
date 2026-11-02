import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ProviderMode = "codex" | "openrouter";
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type SwitchState = { mode: ProviderMode; thinking: Partial<Record<ProviderMode, ThinkingLevel>> };

export const MODE_ENV = "PI_PROVIDER_SWITCH_MODE";
export const SWITCH_EVENT = "provider-switch:changed";
export const CODEX_MODEL = "openai-codex/gpt-6.1-sol";
const LEGACY_MAIN_MODEL = "openrouter/deepseek/deepseek-v4-flash-0731";
const STATE_TYPE = "provider-switch";
const MODE_KEY = Symbol.for("pi/provider-switch/mode");
const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function getProviderMode(): ProviderMode {
	const mode = (globalThis as any)[MODE_KEY] ?? process.env[MODE_ENV];
	return mode === "openrouter" ? "openrouter" : "codex";
}

function setProviderMode(mode: ProviderMode): void {
	(globalThis as any)[MODE_KEY] = mode;
	process.env[MODE_ENV] = mode;
}

/** Agent profiles stay unchanged: they remain the legacy model catalogue. */
export function selectSubagentModel(legacyModel?: string | null): string {
	return getProviderMode() === "codex"
		? CODEX_MODEL
		: legacyModel || "openrouter/z-ai/glm-5.3";
}

export function selectMemoryModel<T extends { provider: string; id: string }>(legacyModel: T): T {
	return getProviderMode() === "codex"
		? { ...legacyModel, provider: "openai-codex", id: "gpt-6.1-sol" }
		: { ...legacyModel };
}

export function restoreSwitchState(entries: readonly unknown[]): SwitchState {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as any;
		if (entry?.type !== "custom" || entry.customType !== STATE_TYPE) continue;
		const data = entry.data;
		if (data?.mode !== "codex" && data?.mode !== "openrouter") continue;
		const thinking: SwitchState["thinking"] = {};
		for (const mode of ["codex", "openrouter"] as const) {
			if (LEVELS.has(data.thinking?.[mode])) thinking[mode] = data.thinking[mode];
		}
		return { mode: data.mode, thinking };
	}
	return { mode: "codex", thinking: {} };
}

function mainModel(mode: ProviderMode): { provider: string; id: string } {
	const fullId = mode === "codex" ? CODEX_MODEL : LEGACY_MAIN_MODEL;
	const slash = fullId.indexOf("/");
	return { provider: fullId.slice(0, slash), id: fullId.slice(slash + 1) };
}

export default function providerSwitch(pi: ExtensionAPI): void {
	let state: SwitchState = { mode: "codex", thinking: {} };
	let switching = false;

	function publish(ctx: any): void {
		setProviderMode(state.mode);
		pi.events.emit(SWITCH_EVENT, { mode: state.mode });
		if (ctx.hasUI) ctx.ui.setStatus(STATE_TYPE, `Providers: ${state.mode}`);
	}

	pi.on("session_start", async (_event, ctx) => {
		// Workers inherit the caller's mode; do not replace their role-specific model.
		if (process.env.PI_SUBAGENT_AGENT || process.env.OM_WORKER) {
			state = { mode: getProviderMode(), thinking: {} };
			publish(ctx);
			return;
		}
		state = restoreSwitchState(ctx.sessionManager.getBranch());
		const target = mainModel(state.mode);
		const model = ctx.modelRegistry.find(target.provider, target.id);
		if (!model) throw new Error(`Provider switch: model unavailable: ${target.provider}/${target.id}`);
		if (ctx.model?.provider !== target.provider || ctx.model?.id !== target.id) {
			if (!(await pi.setModel(model))) throw new Error(`Provider switch: missing authentication for ${target.provider}`);
		}
		const thinking = state.thinking[state.mode];
		if (thinking) pi.setThinkingLevel(thinking);
		publish(ctx);
	});

	const handler = async (args: string, ctx: any): Promise<void> => {
		if (args.trim()) {
			ctx.ui.notify("Usage: /switch (or /swich)", "warning");
			return;
		}
		// Do not wait behind an auto-compaction/retry loop indefinitely.
		if (switching || !ctx.isIdle()) {
			ctx.ui.notify("Stop the current run with Esc, then enter /switch again.", "warning");
			return;
		}
		switching = true;
		try {
			const next: ProviderMode = state.mode === "codex" ? "openrouter" : "codex";
			const target = mainModel(next);
			const model = ctx.modelRegistry.find(target.provider, target.id);
			if (!model) throw new Error(`Model unavailable: ${target.provider}/${target.id}`);
			const thinking = { ...state.thinking, [state.mode]: pi.getThinkingLevel() };
			if (!(await pi.setModel(model))) throw new Error(`Missing authentication for ${target.provider}`);
			if (thinking[next]) pi.setThinkingLevel(thinking[next]);
			state = { mode: next, thinking };
			pi.appendEntry(STATE_TYPE, state);
			publish(ctx);
			ctx.ui.notify(`Providers: ${next}. Running workers keep their current model; new and resumed workers use the selected mode.`, "info");
		} catch (error) {
			ctx.ui.notify(`Switch failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			switching = false;
		}
	};

	pi.registerCommand("switch", { description: "Toggle this session, subagents and memory between Codex and legacy OpenRouter", handler });
	pi.registerCommand("swich", { description: "Alias for /switch", handler });
}
