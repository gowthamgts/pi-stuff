import assert from "node:assert/strict";
import test from "node:test";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import typesafeBashGuard, {
	HARMFUL_ENTRY_TYPE,
	REVIEW_ENTRY_TYPE,
	resolveTypeSafeApiKey,
	reviewBashCommand,
} from "../index.ts";

type Classification = "not_harmful" | "may_be_harmful" | "harmful";

function clientFor(classification: Classification, confidence = 0.95): TypeSafeClient {
	return {
		async systemOne(request: any) {
			assert.equal(request.state.command.length > 0, true);
			return {
				model: "jev-test",
				answers: {
					safety: {
						type: "choice",
						choice: classification,
						confidence,
						probabilities: {
							not_harmful: classification === "not_harmful" ? 0.9 : 0.05,
							may_be_harmful: classification === "may_be_harmful" ? 0.9 : 0.05,
							harmful: classification === "harmful" ? 0.9 : 0.05,
						},
					},
				},
				usage: { input_tokens: 1, output_tokens: 1 },
			};
		},
	} as unknown as TypeSafeClient;
}

function createHarness(client: TypeSafeClient, confirm = true) {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
	const entries: Array<{ type: string; data: unknown }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses: Array<{ id: string; text: string | undefined }> = [];

	typesafeBashGuard(
		{
			on(name: string, handler: (event: any, ctx: any) => Promise<any>) {
				handlers.set(name, handler);
			},
			registerEntryRenderer() {},
			appendEntry(type: string, data: unknown) {
				entries.push({ type, data });
			},
		} as any,
		{ client },
	);

	const ctx = {
		cwd: "/repo",
		hasUI: true,
		signal: undefined,
		ui: {
			async confirm() {
				return confirm;
			},
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			setStatus(id: string, text: string | undefined) {
				statuses.push({ id, text });
			},
		},
	};

	return { handlers, entries, notifications, statuses, ctx };
}

test("keeps a plaintext TypeSafe API key unchanged", async () => {
	assert.equal(await resolveTypeSafeApiKey("ts-plain-key"), "ts-plain-key");
});

test("resolves an op:// TypeSafe API key reference through 1Password", async () => {
	let receivedReference: string | undefined;
	const key = await resolveTypeSafeApiKey("op://Engineering/TypeSafe/credential", undefined, async (reference) => {
		receivedReference = reference;
		return "ts-from-1password";
	});
	assert.equal(receivedReference, "op://Engineering/TypeSafe/credential");
	assert.equal(key, "ts-from-1password");
});

test("allows a confident not-harmful agent bash command", async () => {
	const harness = createHarness(clientFor("not_harmful"));
	const result = await harness.handlers.get("tool_call")?.(
		{ toolName: "bash", toolCallId: "1", input: { command: "pnpm test" } },
		harness.ctx,
	);
	assert.equal(result, undefined);
	assert.equal(harness.entries.length, 1);
	assert.equal(harness.entries[0]?.type, REVIEW_ENTRY_TYPE);
	assert.equal(typeof (harness.entries[0]?.data as any).review.durationMs, "number");
	assert.equal(harness.statuses[0]?.text, "TypeSafe: reviewing…");
	assert.equal(harness.statuses.at(-1)?.text, "TypeSafe: ✓ not harmful");
});

test("blocks harmful agent commands and emits a banner entry and alert", async () => {
	const harness = createHarness(clientFor("harmful"));
	const result = await harness.handlers.get("tool_call")?.(
		{ toolName: "bash", toolCallId: "1", input: { command: "malicious-command" } },
		harness.ctx,
	);
	assert.equal(result.block, true);
	assert.equal(result.terminate, true);
	assert.match(result.reason, /HARMFUL COMMAND BLOCKED/);
	assert.deepEqual(
		harness.entries.map((entry) => entry.type),
		[REVIEW_ENTRY_TYPE, HARMFUL_ENTRY_TYPE],
	);
	assert.match(harness.notifications[0]?.message ?? "", /BLOCKED/);
	assert.equal(harness.notifications[0]?.level, "error");
});

test("asks before a potentially harmful command and blocks a rejection", async () => {
	const harness = createHarness(clientFor("may_be_harmful"), false);
	const result = await harness.handlers.get("tool_call")?.(
		{ toolName: "bash", toolCallId: "1", input: { command: "rm generated.txt" } },
		harness.ctx,
	);
	assert.equal(result.block, true);
	assert.match(result.reason, /user did not approve/);
});

test("blocks harmful user ! commands without executing them", async () => {
	const harness = createHarness(clientFor("harmful"));
	const result = await harness.handlers.get("user_bash")?.(
		{ command: "malicious-command", cwd: "/repo", excludeFromContext: false },
		harness.ctx,
	);
	assert.equal(result.result.exitCode, 126);
	assert.match(result.result.output, /HARMFUL COMMAND BLOCKED/);
});

test("low-confidence not-harmful classifications require confirmation", async () => {
	const review = await reviewBashCommand(clientFor("not_harmful", 0.4), "echo $TOKEN", "/repo", "agent");
	assert.equal(review.rawClassification, "not_harmful");
	assert.equal(review.classification, "may_be_harmful");
});

test("fails open and warns when TypeSafe review fails", async () => {
	const failingClient = {
		async systemOne() {
			throw new Error("unavailable");
		},
	} as unknown as TypeSafeClient;
	const harness = createHarness(failingClient);
	const originalError = console.error;
	console.error = () => {};
	try {
		const result = await harness.handlers.get("tool_call")?.(
			{ toolName: "bash", toolCallId: "1", input: { command: "anything" } },
			harness.ctx,
		);
		assert.equal(result, undefined);
		assert.match(harness.notifications[0]?.message ?? "", /fail-open/);
		assert.equal(harness.notifications[0]?.level, "warning");
		assert.equal(harness.statuses.at(-1)?.text, "TypeSafe: API error (fail-open)");
		assert.equal(harness.entries[0]?.type, REVIEW_ENTRY_TYPE);
		assert.equal((harness.entries[0]?.data as any).error, true);
	} finally {
		console.error = originalError;
	}
});
