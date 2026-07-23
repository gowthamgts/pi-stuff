import assert from "node:assert/strict";
import test from "node:test";
import codexFastMode, {
	enableFastMode,
	FAST_MODE_SERVICE_TIER,
	restoreFastModeState,
	setFastMode,
	supportsCodexFastMode,
} from "../index.ts";

const supportedModel = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	id: "gpt-5.5",
};

test("recognizes fast-mode Codex models", () => {
	for (const id of [
		"gpt-5.4",
		"gpt-5.5",
		"gpt-5.6-luna",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
	]) {
		assert.equal(
			supportsCodexFastMode({ ...supportedModel, id }),
			true,
			`${id} should support fast mode`,
		);
	}
});

test("rejects unsupported models and providers", () => {
	assert.equal(supportsCodexFastMode({ ...supportedModel, id: "gpt-5.4-mini" }), false);
	assert.equal(supportsCodexFastMode({ ...supportedModel, id: "gpt-5.3-codex-spark" }), false);
	assert.equal(supportsCodexFastMode({ ...supportedModel, provider: "openai" }), false);
	assert.equal(supportsCodexFastMode({ ...supportedModel, api: "openai-responses" }), false);
	assert.equal(supportsCodexFastMode(undefined), false);
});

test("sets priority service tier without mutating the original payload", () => {
	const payload = { model: "gpt-5.5", service_tier: "default" };
	const result = enableFastMode(payload);

	assert.deepEqual(result, {
		model: "gpt-5.5",
		service_tier: FAST_MODE_SERVICE_TIER,
	});
	assert.equal(payload.service_tier, "default");
});

test("removes the service tier in standard mode", () => {
	const payload = { model: "gpt-5.5", service_tier: "priority", stream: true };
	assert.deepEqual(setFastMode(payload, false), {
		model: "gpt-5.5",
		stream: true,
	});
	assert.equal(payload.service_tier, "priority");
});

test("leaves non-object payloads unchanged", () => {
	assert.equal(setFastMode(null, true), null);
	assert.equal(setFastMode("payload", false), "payload");
	const payload: unknown[] = [];
	assert.equal(setFastMode(payload, true), payload);
});

test("restores the latest mode stored in a session", () => {
	assert.equal(restoreFastModeState([]), true);
	assert.equal(
		restoreFastModeState([
			{ type: "custom", customType: "codex-fast-mode-state", data: { enabled: false } },
		]),
		false,
	);
	assert.equal(
		restoreFastModeState([
			{ type: "custom", customType: "codex-fast-mode-state", data: { enabled: false } },
			{ type: "message", message: {} },
			{ type: "custom", customType: "codex-fast-mode-state", data: { enabled: true } },
		]),
		true,
	);
});

test("/fast toggles requests, status, and persisted session state", () => {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => unknown }>();
	const appended: Array<{ customType: string; data: unknown }> = [];

	codexFastMode({
		on(event: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: any) => unknown }) {
			commands.set(name, command);
		},
		appendEntry(customType: string, data: unknown) {
			appended.push({ customType, data });
		},
	} as any);

	const statuses: Array<string | undefined> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const ctx = {
		model: supportedModel,
		sessionManager: { getBranch: () => [] },
		ui: {
			setStatus(_id: string, text: string | undefined) {
				statuses.push(text);
			},
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
		},
	};

	const sessionHandler = handlers.get("session_start");
	const requestHandler = handlers.get("before_provider_request");
	const fastCommand = commands.get("fast");
	assert.ok(sessionHandler);
	assert.ok(requestHandler);
	assert.ok(fastCommand);

	sessionHandler({}, ctx);
	assert.equal(statuses.at(-1), "⚡ Codex fast");
	assert.deepEqual(requestHandler({ payload: { model: "gpt-5.5" } }, ctx), {
		model: "gpt-5.5",
		service_tier: "priority",
	});

	fastCommand.handler("off", ctx);
	assert.equal(statuses.at(-1), "○ Codex standard");
	assert.deepEqual(appended.at(-1), {
		customType: "codex-fast-mode-state",
		data: { enabled: false },
	});
	assert.deepEqual(
		requestHandler({ payload: { model: "gpt-5.5", service_tier: "priority" } }, ctx),
		{ model: "gpt-5.5" },
	);

	fastCommand.handler("status", ctx);
	assert.deepEqual(notifications.at(-1), {
		message: "Codex fast mode is off.",
		level: "info",
	});

	fastCommand.handler("on", ctx);
	assert.equal(statuses.at(-1), "⚡ Codex fast");
	assert.deepEqual(appended.at(-1), {
		customType: "codex-fast-mode-state",
		data: { enabled: true },
	});

	fastCommand.handler("invalid", ctx);
	assert.deepEqual(notifications.at(-1), {
		message: "Usage: /fast on|off|status",
		level: "error",
	});
});

test("restored standard mode applies before the first request", () => {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	codexFastMode({
		on(event: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(event, handler);
		},
		registerCommand() {},
		appendEntry() {},
	} as any);

	const ctx = {
		model: supportedModel,
		sessionManager: {
			getBranch: () => [
				{ type: "custom", customType: "codex-fast-mode-state", data: { enabled: false } },
			],
		},
		ui: { setStatus() {}, notify() {} },
	};

	handlers.get("session_start")?.({}, ctx);
	assert.deepEqual(
		handlers.get("before_provider_request")?.(
			{ payload: { model: "gpt-5.5", service_tier: "priority" } },
			ctx,
		),
		{ model: "gpt-5.5" },
	);
});
