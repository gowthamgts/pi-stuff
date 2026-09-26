import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FAST_MODE_SERVICE_TIER = "priority";
const STATE_ENTRY_TYPE = "codex-fast-mode-state";
const PREFERENCE_FILE_NAME = "codex-fast-mode.json";

/** Status slot shown alongside the separate codex-usage quota status. */
export const CODEX_FOOTER_STATUS_KEY = "codex-custom-footer";

export interface ModelDescriptor {
	provider?: unknown;
	api?: unknown;
	id?: unknown;
}

export function supportsCodexFastMode(model: ModelDescriptor | undefined): boolean {
	return model?.provider === "openai-codex" && model.api === "openai-codex-responses";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function setFastMode(payload: unknown, enabled: boolean): unknown {
	if (!isRecord(payload)) return payload;

	if (enabled) {
		return {
			...payload,
			service_tier: FAST_MODE_SERVICE_TIER,
		};
	}

	const { service_tier: _serviceTier, ...standardPayload } = payload;
	return standardPayload;
}

export function enableFastMode(payload: unknown): unknown {
	return setFastMode(payload, true);
}

function findFastModeState(entries: readonly unknown[]): boolean | undefined {
	let enabled: boolean | undefined;

	for (const entry of entries) {
		if (
			isRecord(entry) &&
			entry.type === "custom" &&
			entry.customType === STATE_ENTRY_TYPE &&
			isRecord(entry.data) &&
			typeof entry.data.enabled === "boolean"
		) {
			enabled = entry.data.enabled;
		}
	}

	return enabled;
}

export function restoreFastModeState(entries: readonly unknown[]): boolean {
	return findFastModeState(entries) ?? true;
}

export function getFastModePreferencePath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(agentDir, PREFERENCE_FILE_NAME);
}

export async function loadFastModePreference(path: string): Promise<boolean | undefined> {
	try {
		const preference = JSON.parse(await readFile(path, "utf8"));
		return isRecord(preference) && typeof preference.enabled === "boolean"
			? preference.enabled
			: undefined;
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
}

export async function saveFastModePreference(path: string, enabled: boolean): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;

	try {
		await writeFile(temporaryPath, `${JSON.stringify({ enabled })}\n`, { mode: 0o600 });
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

export default function codexFastMode(
	pi: ExtensionAPI,
	options: { preferencePath?: string } = {},
) {
	let enabled = true;
	const preferencePath = options.preferencePath ?? getFastModePreferencePath();

	const updateStatus = (
		model: ModelDescriptor | undefined,
		ctx: { ui: { setStatus(id: string, text: string | undefined): void } },
	) => {
		const status = supportsCodexFastMode(model)
			? enabled
				? "⚡ Codex fast"
				: "○ Codex standard"
			: undefined;
		ctx.ui.setStatus(CODEX_FOOTER_STATUS_KEY, status);
	};

	const describeStatus = (model: ModelDescriptor | undefined) => {
		if (!enabled) return "Codex fast mode is off.";
		if (supportsCodexFastMode(model)) return "Codex fast mode is on and active.";
		return "Codex fast mode is on, but the current model does not support it.";
	};

	pi.on("session_start", async (_event, ctx) => {
		const sessionPreference = findFastModeState(ctx.sessionManager.getBranch());

		try {
			const savedPreference = await loadFastModePreference(preferencePath);
			enabled = savedPreference ?? sessionPreference ?? true;

			// Migrate the old session-only setting the first time this version loads it.
			if (savedPreference === undefined && sessionPreference !== undefined) {
				await saveFastModePreference(preferencePath, sessionPreference);
			}
		} catch (error) {
			enabled = sessionPreference ?? true;
			console.error(`Failed to load Codex fast mode preference from ${preferencePath}: ${error}`);
		}

		updateStatus(ctx.model, ctx);
	});

	pi.on("model_select", (event, ctx) => {
		updateStatus(event.model, ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!supportsCodexFastMode(ctx.model) || !isRecord(event.payload)) return;
		return setFastMode(event.payload, enabled);
	});

	pi.registerCommand("fast", {
		description: "Control Codex fast mode: /fast on|off|status",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";

			if (action === "status") {
				ctx.ui.notify(describeStatus(ctx.model), "info");
				return;
			}

			if (action !== "on" && action !== "off") {
				ctx.ui.notify("Usage: /fast on|off|status", "error");
				return;
			}

			enabled = action === "on";
			pi.appendEntry(STATE_ENTRY_TYPE, { enabled });

			try {
				await saveFastModePreference(preferencePath, enabled);
			} catch (error) {
				ctx.ui.notify(`Could not persist Codex fast mode preference: ${error}`, "warning");
			}

			updateStatus(ctx.model, ctx);
			ctx.ui.notify(describeStatus(ctx.model), "info");
		},
	});
}
