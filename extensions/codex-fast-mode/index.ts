import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FAST_MODE_SERVICE_TIER = "priority";
const STATE_ENTRY_TYPE = "codex-fast-mode-state";

/**
 * Status slot shared with the codex-usage extension. The codex-usage footer
 * inlines this status into the stats line, so it is not just a footer note.
 */
export const CODEX_FOOTER_STATUS_KEY = "codex-custom-footer";

export interface ModelDescriptor {
	provider?: unknown;
	api?: unknown;
	id?: unknown;
}

const FAST_MODE_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
]);

export function supportsCodexFastMode(model: ModelDescriptor | undefined): boolean {
	return (
		model?.provider === "openai-codex" &&
		model.api === "openai-codex-responses" &&
		typeof model.id === "string" &&
		FAST_MODE_MODEL_IDS.has(model.id)
	);
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

export function restoreFastModeState(entries: readonly unknown[]): boolean {
	let enabled = true;

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

export default function codexFastMode(pi: ExtensionAPI) {
	let enabled = true;

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

	pi.on("session_start", (_event, ctx) => {
		enabled = restoreFastModeState(ctx.sessionManager.getBranch());
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
			updateStatus(ctx.model, ctx);
			ctx.ui.notify(describeStatus(ctx.model), "info");
		},
	});
}
