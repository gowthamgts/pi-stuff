import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import typesafeBashGuard, {
	HARMFUL_ENTRY_TYPE,
	REVIEW_ENTRY_TYPE,
	STATE_ENTRY_TYPE,
	loadBellPreference,
	loadBashGuardSettings,
	ensureBashGuardSettings,
	BASH_JUDGE_SYSTEM_PROMPT,
	MAX_WORKSPACE_FILES,
	agentEditedPaths,
	agentStatedIntent,
	buildWorkspaceContext,
	judgeBashCommand,
	parsePorcelainStatus,
	parseJudgeVerdict,
	recentUserRequests,
	type BashGuardOptions,
	resolveTypeSafeApiKey,
	reviewBashCommand,
} from "../index.ts";

type Classification = "not_harmful" | "may_be_harmful" | "harmful";

function judged(classification: Classification, analysis = "Deletes generated output inside the project."): any {
	return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ classification, analysis }) }] };
}

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

function createHarness(client: TypeSafeClient, confirm = true, preferencePath?: string, options: BashGuardOptions = {}) {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const entries: Array<{ type: string; data: unknown }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses: Array<{ id: string; text: string | undefined }> = [];
	const git = {
		// Default: not a Git repository, so reviews omit workspace context.
		run: async (_args: string[], _cwd: string): Promise<{ stdout: string; stderr: string; code: number }> =>
			({ stdout: "", stderr: "fatal: not a git repository", code: 128 }),
	};

	typesafeBashGuard(
		{
			on(name: string, handler: (event: any, ctx: any) => Promise<any>) {
				handlers.set(name, handler);
			},
			registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
				commands.set(name, command);
			},
			registerEntryRenderer() {},
			appendEntry(type: string, data: unknown) {
				entries.push({ type, data });
			},
			async exec(command: string, args: string[], options: { cwd: string }) {
				assert.equal(command, "git");
				return { ...(await git.run(args, options.cwd)), killed: false };
			},
		} as any,
		{ client, preferencePath, ...options },
	);

	const ctx = {
		cwd: "/repo",
		mode: "tui",
		hasUI: true,
		signal: undefined as AbortSignal | undefined,
		modelRegistry: {
			find(provider: string, id: string) { return { provider, id }; },
			async complete(_model: any, _context: any, _options: any): Promise<any> {
				return judged("not_harmful");
			},
		},
		sessionManager: undefined as { getBranch(): unknown[] } | undefined,
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

	return { handlers, commands, entries, notifications, statuses, ctx, git };
}

test("session toggle bypasses both bash sources and on restores harmful-command blocking", async () => {
	const harness = createHarness(clientFor("harmful"), false, undefined, { fallbackModel: "test/judge" });
	let reviews = 0;
	let confirmations = 0;
	harness.ctx.ui.confirm = async () => { confirmations++; return false; };
	harness.ctx.modelRegistry.complete = async () => { throw new Error("must not judge"); };
	const command = harness.commands.get("typeguard")!;
	await command.handler(" OFF ", harness.ctx);
	assert.deepEqual(harness.entries, [{ type: STATE_ENTRY_TYPE, data: { enabled: false } }]);
	assert.match(harness.statuses.at(-1)!.text!, /OFF.*this session/);
	assert.equal(harness.notifications.at(-1)?.level, "warning");
	// Even a client that would fail must never be contacted while disabled.
	const bypass = createHarness({ systemOne: async () => { reviews++; throw new Error("must not review"); } } as unknown as TypeSafeClient);
	await bypass.commands.get("typeguard")!.handler("off", bypass.ctx);
	for (const h of [harness, bypass]) {
		assert.equal(await h.handlers.get("tool_call")!({ toolName: "bash", input: { command: "malicious-command" } }, h.ctx), undefined);
		assert.equal(await h.handlers.get("user_bash")!({ command: "malicious-command", cwd: "/repo" }, h.ctx), undefined);
		assert.equal(h.entries.length, 1);
	}
	assert.equal(reviews, 0);
	assert.equal(confirmations, 0);
	await command.handler("on", harness.ctx);
	assert.equal((await harness.handlers.get("tool_call")!({ toolName: "bash", input: { command: "malicious-command" } }, harness.ctx)).block, true);
	assert.equal((await harness.handlers.get("user_bash")!({ command: "malicious-command", cwd: "/repo" }, harness.ctx)).result.exitCode, 126);
});

test("status and invalid toggle arguments do not change or persist state", async () => {
	const harness = createHarness(clientFor("not_harmful"));
	const command = harness.commands.get("typeguard")!;
	for (const args of ["", "status", "toggle", "off now"]) await command.handler(args, harness.ctx);
	assert.equal(harness.entries.length, 0);
	assert.match(harness.notifications[0].message, /is on for this session/);
	assert.equal(harness.notifications.at(-1)?.level, "error");
	await command.handler("off", harness.ctx);
	await command.handler("status", harness.ctx);
	assert.equal(harness.entries.length, 1);
	assert.match(harness.notifications.at(-1)!.message, /OFF for this session/);
});

test("restores session toggle on reload, resume, and branch navigation without changing settings", async () => {
	const dir = await mkdtemp(join(tmpdir(), "typesafe-guard-"));
	const path = join(dir, "settings.json");
	try {
		const settings = '{ "bell": false }\n';
		await writeFile(path, settings);
		const original = createHarness(clientFor("harmful"), false, path);
		await original.commands.get("typeguard")!.handler("off", original.ctx);
		assert.equal(await readFile(path, "utf8"), settings);
		const restored = createHarness(clientFor("harmful"), false, path);
		let branch: unknown[] = original.entries.map((entry) => ({ type: "custom", customType: entry.type, data: entry.data }));
		restored.ctx.sessionManager = { getBranch: () => branch };
		await restored.handlers.get("session_start")!({}, restored.ctx);
		assert.match(restored.statuses.at(-1)!.text!, /OFF/);
		assert.equal(restored.entries.length, 0);
		assert.equal(await readFile(path, "utf8"), settings);
		for (const [entries, off] of [
			[[], false],
			[branch, true],
			[[...branch, { type: "custom", customType: STATE_ENTRY_TYPE, data: { enabled: "false" } }], true],
			[[...branch, { type: "custom", customType: STATE_ENTRY_TYPE, data: { enabled: true } }], false],
		] as const) {
			branch = [...entries];
			await restored.handlers.get("session_tree")!({}, restored.ctx);
			assert.equal(restored.statuses.at(-1)!.text!.includes("OFF"), off);
		}
		branch = [];
		await restored.handlers.get("session_start")!({}, restored.ctx);
		assert.equal(restored.statuses.at(-1)?.text, "TypeSafe: on");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("loads bell settings with on as the default", async () => {
	const dir = await mkdtemp(join(tmpdir(), "typesafe-guard-"));
	const path = join(dir, "settings.json");
	try {
		assert.equal(await loadBellPreference(path), true);
		for (const [settings, expected] of [[{}, true], [{ bell: true }, true], [{ bell: false }, false]] as const) {
			await writeFile(path, JSON.stringify(settings));
			assert.equal(await loadBellPreference(path), expected);
		}
		for (const contents of ["invalid json", '{"bell":"off"}', "null", "[]"]) {
			await writeFile(path, contents);
			await assert.rejects(loadBellPreference(path));
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("rings only for terminal approval prompts, honoring settings", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "typesafe-guard-"));
	const path = join(dir, "settings.json");
	const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	const writes: string[] = [];
	const writeMock = t.mock.method(process.stdout, "write", (text: string) => {
		writes.push(text);
		return true;
	});
	try {
		for (const scenario of [
			{ source: "agent", classification: "may_be_harmful", expected: 1 },
			{ source: "user", classification: "may_be_harmful", expected: 1 },
			{ source: "agent", classification: "may_be_harmful", bell: false, expected: 0 },
			{ source: "agent", classification: "may_be_harmful", mode: "rpc", expected: 0 },
			{ source: "agent", classification: "may_be_harmful", hasUI: false, expected: 0 },
			{ source: "agent", classification: "may_be_harmful", tty: false, expected: 0 },
			{ source: "agent", classification: "not_harmful", expected: 0 },
			{ source: "agent", classification: "harmful", expected: 0 },
			{ source: "agent", classification: "not_harmful", confidence: 0.4, expected: 1 },
			{ source: "agent", classification: "may_be_harmful", invalid: true, expected: 1 },
		] as const) {
			const config = scenario as typeof scenario & {
				bell?: boolean; mode?: string; hasUI?: boolean; tty?: boolean; confidence?: number; invalid?: boolean;
			};
			await writeFile(path, config.invalid ? "invalid" : JSON.stringify({ bell: config.bell }));
			Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: config.tty ?? true });
			const harness = createHarness(clientFor(config.classification, config.confidence), false, path);
			harness.ctx.mode = config.mode ?? "tui";
			harness.ctx.hasUI = config.hasUI ?? true;
			await harness.handlers.get("session_start")?.({}, harness.ctx);
			writes.length = 0;
			harness.ctx.ui.confirm = async () => {
				assert.equal(writes.filter((text) => text === "\u0007").length, config.expected);
				return false;
			};
			await harness.handlers.get(config.source === "agent" ? "tool_call" : "user_bash")?.(
				config.source === "agent"
					? { toolName: "bash", toolCallId: "1", input: { command: "rm generated.txt" } }
					: { command: "rm generated.txt", cwd: "/repo" },
				harness.ctx,
			);
			assert.equal(writes.filter((text) => text === "\u0007").length, config.expected);
			if (config.invalid) assert.match(harness.notifications[0]?.message ?? "", /bell defaults to on/);
		}
	} finally {
		writeMock.mock.restore();
		if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
		else delete process.stdout.isTTY;
		await rm(dir, { recursive: true, force: true });
	}
});

test("loads and validates optional fallback settings", async () => {
	const dir = await mkdtemp(join(tmpdir(), "typesafe-guard-"));
	const path = join(dir, "settings.json");
	try {
		assert.equal((await loadBashGuardSettings(path)).fallbackModel, undefined);
		await writeFile(path, JSON.stringify({ bell: false, fallbackModel: "codex/gpt-6-luna", fallbackTimeoutMs: 12000 }));
		assert.deepEqual(await loadBashGuardSettings(path), { bell: false, fallbackModel: "codex/gpt-6-luna", fallbackScope: "risky", fallbackTimeoutMs: 12000 });
		await writeFile(path, JSON.stringify({ fallbackScope: "uncertain" }));
		assert.equal((await loadBashGuardSettings(path)).fallbackScope, "uncertain");
		for (const fallbackModel of [null, "", " ", "no-provider", "codex/", "/model", "openai/model with spaces", 2, false, [], {}]) {
			await writeFile(path, JSON.stringify({ bell: false, fallbackModel }));
			const settings = await loadBashGuardSettings(path);
			assert.equal(settings.fallbackModel, undefined);
			assert.equal(settings.bell, false);
		}
		for (const settings of [{ fallbackTimeoutMs: 0 }, { fallbackTimeoutMs: -1 }, { fallbackTimeoutMs: 1.5 }, { fallbackScope: "always" }, { fallbackScope: null }]) {
			await writeFile(path, JSON.stringify(settings));
			await assert.rejects(loadBashGuardSettings(path));
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("first session creates starter settings without overwriting existing files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "typesafe-guard-"));
	const path = join(dir, "nested", "settings.json");
	try {
		const harness = createHarness(clientFor("not_harmful", 0.4), false, path);
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { bell: true, fallbackModel: null, fallbackScope: "risky", fallbackTimeoutMs: 30000 });
		assert.equal((await harness.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "pwd" } }, harness.ctx)).block, true);
		assert.equal((harness.entries[0].data as any).review.fallback, undefined);
		assert.equal(harness.notifications.length, 0);
		for (const contents of ['{ "bell": false, "fallbackModel": "openai/gpt-6-luna" }', "invalid JSON"]) {
			await writeFile(path, contents);
			await ensureBashGuardSettings(path);
			assert.equal(await readFile(path, "utf8"), contents);
		}
		const concurrentPath = join(dir, "concurrent.json");
		await Promise.all([ensureBashGuardSettings(concurrentPath), ensureBashGuardSettings(concurrentPath)]);
		assert.equal(JSON.parse(await readFile(concurrentPath, "utf8")).fallbackModel, null);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("invalid fallback model values never attempt LLM judging", async () => {
	const dir = await mkdtemp(join(tmpdir(), "typesafe-guard-"));
	const path = join(dir, "settings.json");
	try {
		for (const fallbackModel of [null, "", " ", "model-only", 123, false, {}, []]) {
			await writeFile(path, JSON.stringify({ bell: false, fallbackModel }));
			const harness = createHarness(clientFor("not_harmful", 0.4), false, path);
			let attempts = 0;
			harness.ctx.modelRegistry.find = () => { attempts++; throw new Error("should not resolve a model"); };
			await harness.handlers.get("session_start")?.({}, harness.ctx);
			const result = await harness.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "pwd" } }, harness.ctx);
			assert.equal(result.block, true);
			assert.equal(attempts, 0);
			assert.equal(harness.notifications.length, 0);
			assert.equal((harness.entries[0].data as any).review.fallback, undefined);
		}
		const optionsHarness = createHarness(clientFor("not_harmful", 0.4), false, undefined, { fallbackModel: "invalid" });
		await optionsHarness.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "pwd" } }, optionsHarness.ctx);
		assert.equal((optionsHarness.entries[0].data as any).review.fallback, undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("LLM fallback routes results needing approval for both bash sources, per scope", async () => {
	for (const scope of ["risky", "uncertain"] as const) {
		for (const source of ["agent", "user"] as const) {
			for (const [classification, confidence, risky, uncertain] of [
				["not_harmful", 0.4, 1, 1], ["may_be_harmful", 0.4, 1, 1], ["may_be_harmful", 0.95, 1, 0],
				["not_harmful", 0.65, 0, 0], ["harmful", 0.4, 0, 0], ["harmful", 0.95, 0, 0],
			] as const) {
				const expectedCalls = scope === "risky" ? risky : uncertain;
				const harness = createHarness(clientFor(classification, confidence), false, undefined, { fallbackModel: "codex/gpt-6-luna", fallbackScope: scope });
				let calls = 0;
				harness.ctx.modelRegistry.complete = async (model, context, options) => {
					calls++;
					assert.deepEqual(model, { provider: "codex", id: "gpt-6-luna" });
					assert.deepEqual(JSON.parse(context.messages[0].content), {
						command: "echo test", cwd: "/repo", source,
						typesafe: { classification, confidence },
						recentUserRequests: [],
					});
					assert.equal(context.tools, undefined);
					assert.equal(options.signal instanceof AbortSignal, true);
					return judged("not_harmful");
				};
				const result = await harness.handlers.get(source === "agent" ? "tool_call" : "user_bash")?.(
					source === "agent" ? { toolName: "bash", input: { command: "echo test" } } : { command: "echo test", cwd: "/repo" }, harness.ctx,
				);
				assert.equal(calls, expectedCalls, `${scope} ${source} ${classification} ${confidence}`);
				if (expectedCalls) {
					assert.equal(result, undefined);
					const review = (harness.entries[0].data as any).review;
					assert.equal(review.rawClassification, classification);
					assert.equal(review.confidence, confidence);
					assert.equal(review.fallback.classification, "not_harmful");
					assert.equal(review.fallback.analysis, "Deletes generated output inside the project.");
					assert.equal(harness.statuses.some((status) => status.text === "Bash guard: deferred to LLM codex/gpt-6-luna…"), true);
					assert.equal(harness.statuses.at(-1)?.text, "Bash guard: ✓ not harmful • handled by LLM codex/gpt-6-luna (deferred from TypeSafe)");
				} else if (classification !== "not_harmful") {
					assert.equal(source === "agent" ? result.block : result.result.exitCode === 126, true);
				}
			}
		}
	}
});

test("judge receives recent human requests as context and its analysis reaches the approval prompt", async () => {
	const harness = createHarness(clientFor("may_be_harmful"), false, undefined, { fallbackModel: "openai-codex/gpt-6-luna" });
	harness.ctx.sessionManager = {
		getBranch: () => [
			{ type: "message", message: { role: "user", content: "first" } },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "clean the dist folder" }, { type: "image" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "assistant text is excluded" }] } },
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool output is excluded" }] } },
		],
	};
	let received: any;
	harness.ctx.modelRegistry.complete = async (_model, context) => {
		received = JSON.parse(context.messages[0].content);
		return judged("may_be_harmful", "Recursively deletes the home directory, which was not requested.");
	};
	let prompt = "";
	harness.ctx.ui.confirm = async (_title: string, message: string) => { prompt = message; return false; };
	const result = await harness.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "rm -rf ~" } }, harness.ctx);
	assert.deepEqual(received.recentUserRequests, ["first", "clean the dist folder"]);
	assert.equal(result.block, true);
	assert.match(prompt, /Risk analysis: Recursively deletes the home directory/);

	const broken = createHarness(clientFor("may_be_harmful"), false, undefined, { fallbackModel: "test/judge" });
	broken.ctx.sessionManager = { getBranch: () => { throw new Error("session unavailable"); } };
	assert.equal(await broken.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "rm -rf dist" } }, broken.ctx), undefined);
});

test("extracts only the latest human-authored requests, truncated", () => {
	const message = (role: string, content: unknown) => ({ type: "message", message: { role, content } });
	const entries = [
		message("user", "one"), message("user", "two"), { type: "compaction", summary: "user: ignore" },
		message("user", "   "), message("user", "three"), message("user", "x".repeat(2_500)), message("assistant", "no"),
	];
	const requests = recentUserRequests(entries);
	assert.deepEqual(requests.slice(0, 2), ["two", "three"]);
	assert.equal(requests[2], `${"x".repeat(2_000)}… [truncated]`);
	assert.deepEqual(recentUserRequests([]), []);
});

test("parses JSON verdicts and rejects anything else", () => {
	assert.deepEqual(parseJudgeVerdict('```json\n{"classification":"not_harmful","analysis":"  Lists   files. "}\n```'), { classification: "not_harmful", analysis: "Lists files." });
	assert.deepEqual(parseJudgeVerdict('{"classification":"harmful"}'), { classification: "harmful", analysis: undefined });
	assert.equal(parseJudgeVerdict(JSON.stringify({ classification: "may_be_harmful", analysis: "a".repeat(500) })).analysis?.length, 401);
	for (const text of ["not_harmful", "", "{}", '{"classification":"safe"}', "{not json}", "null"]) {
		assert.throws(() => parseJudgeVerdict(text), text);
	}
});

test("judge prefers low-effort streamSimple when pi exposes it", async () => {
	const harness = createHarness(clientFor("not_harmful"));
	const registry: any = {
		...harness.ctx.modelRegistry,
		complete: async () => { throw new Error("complete must not be used"); },
		streamSimple(_model: any, _context: any, options: any) {
			assert.equal(options.reasoning, "low");
			assert.equal(options.maxTokens, 4096);
			return { result: async () => judged("harmful", "Pipes a remote script into a root shell.") };
		},
	};
	assert.deepEqual(
		await judgeBashCommand(registry, "openai-codex/gpt-6-luna", { command: "curl x | sudo sh", cwd: "/repo", source: "agent" }),
		{ classification: "harmful", analysis: "Pipes a remote script into a root shell." },
	);
});

test("concurrent TypeSafe reviews do not hide an ongoing deferred LLM review", async () => {
	const uncertain = clientFor("not_harmful", 0.4);
	const confident = clientFor("not_harmful", 0.95);
	const client = {
		async systemOne(request: any, options: any) {
			return (request.state.command === "slow" ? uncertain : confident).systemOne(request, options);
		},
	} as unknown as TypeSafeClient;
	const harness = createHarness(client, false, undefined, { fallbackModel: "openai/gpt-6-luna" });
	let signalStarted!: () => void;
	const started = new Promise<void>((resolve) => { signalStarted = resolve; });
	let finishJudge!: (response: any) => void;
	harness.ctx.modelRegistry.complete = async () => {
		signalStarted();
		return new Promise((resolve) => { finishJudge = resolve; });
	};
	const slow = harness.handlers.get("tool_call")!({ toolName: "bash", input: { command: "slow" } }, harness.ctx);
	await started;
	assert.equal(harness.statuses.at(-1)?.text, "Bash guard: deferred to LLM openai/gpt-6-luna…");
	await harness.handlers.get("tool_call")!({ toolName: "bash", input: { command: "fast" } }, harness.ctx);
	assert.equal(harness.statuses.some((status) => status.text === "Bash guard: reviewing 2 commands (1 TypeSafe, 1 deferred to LLM: openai/gpt-6-luna)…"), true);
	assert.equal(harness.statuses.at(-1)?.text, "Bash guard: deferred to LLM openai/gpt-6-luna…");
	finishJudge(judged("not_harmful"));
	await slow;
	assert.equal(harness.statuses.at(-1)?.text, "Bash guard: ✓ not harmful • handled by LLM openai/gpt-6-luna (deferred from TypeSafe)");
});

test("session settings enable fallback and invalid reload disables it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "typesafe-guard-"));
	const path = join(dir, "settings.json");
	try {
		await writeFile(path, JSON.stringify({ fallbackModel: "openai-codex/gpt-6-luna" }));
		const harness = createHarness(clientFor("not_harmful", 0.4), false, path);
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		const event = { toolName: "bash", input: { command: "echo test" } };
		assert.equal(await harness.handlers.get("tool_call")?.(event, harness.ctx), undefined);
		assert.equal((harness.entries[0].data as any).review.fallback.model, "openai-codex/gpt-6-luna");
		await writeFile(path, "invalid");
		await harness.handlers.get("session_start")?.({}, harness.ctx);
		assert.equal((await harness.handlers.get("tool_call")?.(event, harness.ctx)).block, true);
		assert.equal((harness.entries[1].data as any).review.fallback, undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("LLM verdicts retain approval or block harmful commands", async () => {
	for (const verdict of ["may_be_harmful", "harmful"] as const) {
		for (const source of ["agent", "user"] as const) {
			const harness = createHarness(clientFor("not_harmful", 0.4), false, undefined, { fallbackModel: "test/judge" });
			harness.ctx.modelRegistry.complete = async () => judged(verdict);
			const result = await harness.handlers.get(source === "agent" ? "tool_call" : "user_bash")?.(
				source === "agent" ? { toolName: "bash", input: { command: "echo test" } } : { command: "echo test", cwd: "/repo" }, harness.ctx,
			);
			assert.equal(source === "agent" ? result.block : result.result.exitCode === 126, true);
			assert.equal(harness.entries.some((entry) => entry.type === HARMFUL_ENTRY_TYPE), verdict === "harmful");
		}
	}
});

test("LLM failures retain human confirmation rather than failing open", async () => {
	for (const failure of ["invalid", "error", "truncated", "timeout", "missing", "old-pi"]) {
		const harness = createHarness(clientFor("not_harmful", 0.4), false, undefined, { fallbackModel: "test/judge", fallbackTimeoutMs: 5 });
		const controller = new AbortController();
		harness.ctx.signal = controller.signal;
		harness.ctx.modelRegistry.complete = async (_model, _context, options) => {
			if (failure === "error") throw new Error("auth unavailable");
			if (failure === "timeout") {
				return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted"))));
			}
			return { ...judged("not_harmful"), stopReason: failure === "truncated" ? "length" : "stop", ...(failure === "invalid" ? { content: [{ type: "text", text: "safe probably" }] } : {}) };
		};
		if (failure === "missing") harness.ctx.modelRegistry.find = () => undefined as any;
		if (failure === "old-pi") harness.ctx.modelRegistry.complete = undefined as any;
		const result = await harness.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "echo test" } }, harness.ctx);
		assert.equal(result.block, true, failure);
		assert.equal((harness.entries[0].data as any).review.fallback.error, true, failure);
		assert.match(harness.notifications[0].message, /original approval requirement/);
		assert.equal(harness.statuses.at(-1)?.text, "TypeSafe: ⚠ may be harmful (LLM test/judge failed; approval required)");
	}
});

test("cancelling during LLM review blocks without an approval dialog or failure warning", async () => {
	for (const source of ["agent", "user"] as const) {
		const harness = createHarness(clientFor("may_be_harmful"), true, undefined, { fallbackModel: "test/judge" });
		const controller = new AbortController();
		harness.ctx.signal = controller.signal;
		harness.ctx.modelRegistry.complete = async (_model, _context, options) => {
			controller.abort();
			assert.equal(options.signal.aborted, true);
			return judged("not_harmful");
		};
		let confirms = 0;
		harness.ctx.ui.confirm = async () => { confirms++; return true; };
		const result = await harness.handlers.get(source === "agent" ? "tool_call" : "user_bash")?.(
			source === "agent" ? { toolName: "bash", input: { command: "rm -rf dist" } } : { command: "rm -rf dist", cwd: "/repo" }, harness.ctx,
		);
		assert.equal(confirms, 0);
		assert.equal(harness.notifications.length, 0);
		assert.match(source === "agent" ? result.reason : result.result.output, /cancelled during safety review/);
		if (source === "agent") assert.equal(result.block, true);
		else assert.equal(result.result.exitCode, 126);
	}
});

test("cancelling during TypeSafe review blocks instead of failing open", async () => {
	const controller = new AbortController();
	const client = {
		async systemOne() {
			controller.abort();
			throw new Error("aborted");
		},
	} as unknown as TypeSafeClient;
	const harness = createHarness(client);
	harness.ctx.signal = controller.signal;
	const originalError = console.error;
	let logged = 0;
	console.error = () => { logged++; };
	try {
		const result = await harness.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "rm -rf dist" } }, harness.ctx);
		assert.equal(result.block, true);
		assert.match(result.reason, /cancelled during safety review/);
		assert.equal(harness.notifications.length, 0);
		assert.equal(harness.entries.length, 0);
		assert.equal(logged, 0);
		assert.equal(harness.statuses.at(-1)?.text, "Bash guard: review cancelled");
	} finally {
		console.error = originalError;
	}
});

test("approval dialog receives the operation signal and cancellation while open blocks", async () => {
	for (const source of ["agent", "user"] as const) {
		const harness = createHarness(clientFor("may_be_harmful"));
		const controller = new AbortController();
		harness.ctx.signal = controller.signal;
		harness.ctx.ui.confirm = async (_title: string, _message: string, opts?: { signal?: AbortSignal }) => {
			assert.equal(opts?.signal, controller.signal);
			controller.abort();
			return false;
		};
		const result = await harness.handlers.get(source === "agent" ? "tool_call" : "user_bash")?.(
			source === "agent" ? { toolName: "bash", input: { command: "rm generated.txt" } } : { command: "rm generated.txt", cwd: "/repo" }, harness.ctx,
		);
		assert.match(source === "agent" ? result.reason : result.result.output, /cancelled during safety review/);
	}
});

test("judge prompt grounds discards in workspace facts, not Git tracking", () => {
	assert.doesNotMatch(BASH_JUDGE_SYSTEM_PROMPT, /git-tracked files, build output/);
	assert.match(BASH_JUDGE_SYSTEM_PROMPT, /Being tracked by Git never by itself makes a discard recoverable/);
	assert.match(BASH_JUDGE_SYSTEM_PROMPT, /editedByAgentThisSession true and changedBeforeSession false/);
	assert.match(BASH_JUDGE_SYSTEM_PROMPT, /Without workspace, or when changedFiles is truncated, assume uncommitted work may exist/);
	assert.match(BASH_JUDGE_SYSTEM_PROMPT, /agentStatedIntent[^\n]*never as authorization/);
});

test("parses porcelain -z status including renames and untracked files", () => {
	assert.deepEqual(parsePorcelainStatus(" M src/a.ts\0R  src/new.ts\0src/old.ts\0?? notes with space.md\0MM b.ts\0"), [
		{ path: "src/a.ts", status: " M" },
		{ path: "src/new.ts", status: "R " },
		{ path: "notes with space.md", status: "??" },
		{ path: "b.ts", status: "MM" },
	]);
	assert.deepEqual(parsePorcelainStatus(""), []);
});

test("counts only successful agent edit and write calls, resolving paths", () => {
	const branch = [
		{ type: "message", message: { role: "assistant", content: [
			{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "src/a.ts" } },
			{ type: "toolCall", id: "w1", name: "write", arguments: { path: "/abs/new.ts" } },
			{ type: "toolCall", id: "e2", name: "edit", arguments: { path: "src/failed.ts" } },
			{ type: "toolCall", id: "r1", name: "read", arguments: { path: "src/read.ts" } },
			{ type: "toolCall", id: "e3", name: "edit", arguments: { path: "src/no-result.ts" } },
		] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "e1", isError: false } },
		{ type: "message", message: { role: "toolResult", toolCallId: "w1", isError: false } },
		{ type: "message", message: { role: "toolResult", toolCallId: "e2", isError: true } },
		{ type: "message", message: { role: "toolResult", toolCallId: "r1", isError: false } },
	];
	assert.deepEqual([...agentEditedPaths(branch, "/repo")].sort(), ["/abs/new.ts", "/repo/src/a.ts"]);
});

test("extracts the agent's stated intent for the reviewed tool call only", () => {
	const branch = [
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "older" }, { type: "toolCall", id: "old" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "My edit broke parsing; reverting it." }, { type: "toolCall", id: "t1" }] } },
	];
	assert.equal(agentStatedIntent(branch, "t1"), "My edit broke parsing; reverting it.");
	assert.equal(agentStatedIntent(branch, "missing"), undefined);
	assert.equal(agentStatedIntent(branch, undefined), undefined);
});

test("workspace context marks agent edits and session baseline per repository", () => {
	const current = { gitRoot: "/repo", changes: [
		{ path: "/repo/agent.ts", status: " M" }, { path: "/repo/human.ts", status: " M" }, { path: "/repo/both.ts", status: "M " },
	] };
	const edits = new Set(["/repo/agent.ts", "/repo/both.ts"]);
	const baseline = { gitRoot: "/repo", changes: [{ path: "/repo/human.ts", status: " M" }, { path: "/repo/both.ts", status: " M" }] };
	assert.deepEqual(buildWorkspaceContext(current, edits, baseline), { gitRoot: "/repo", truncated: false, changedFiles: [
		{ path: "/repo/agent.ts", status: " M", editedByAgentThisSession: true, changedBeforeSession: false },
		{ path: "/repo/human.ts", status: " M", editedByAgentThisSession: false, changedBeforeSession: true },
		{ path: "/repo/both.ts", status: "M ", editedByAgentThisSession: true, changedBeforeSession: true },
	] });
	const otherRepo = buildWorkspaceContext(current, edits, { gitRoot: "/elsewhere", changes: [] });
	assert.equal("changedBeforeSession" in otherRepo.changedFiles[0], false);
	const many = { gitRoot: "/repo", changes: Array.from({ length: MAX_WORKSPACE_FILES + 1 }, (_, i) => ({ path: `/repo/f${i}`, status: "??" })) };
	const truncated = buildWorkspaceContext(many, new Set());
	assert.equal(truncated.truncated, true);
	assert.equal(truncated.changedFiles.length, MAX_WORKSPACE_FILES);
});

test("judge receives live Git state, session baseline, agent edits, and stated intent", async () => {
	const harness = createHarness(clientFor("may_be_harmful"), false, undefined, { fallbackModel: "openai-codex/gpt-6-luna" });
	let dirty = " M human.ts\0";
	const calls: string[] = [];
	harness.git.run = async (args, cwd) => {
		calls.push(`${cwd} ${args.join(" ")}`);
		if (args[0] === "rev-parse") return { stdout: "/repo\n", stderr: "", code: 0 };
		return { stdout: dirty, stderr: "", code: 0 };
	};
	await harness.handlers.get("session_start")?.({}, harness.ctx);
	// After the session starts, the agent edits parser.ts and creates scratch.ts.
	dirty = " M human.ts\0 M src/parser.ts\0?? scratch.ts\0";
	harness.ctx.sessionManager = { getBranch: () => [
		{ type: "message", message: { role: "user", content: "fix the failing parser test" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "src/parser.ts" } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "e1", isError: false } },
		{ type: "message", message: { role: "assistant", content: [
			{ type: "text", text: "My parser edit broke more tests; reverting it." },
			{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "git checkout -- src/parser.ts" } },
		] } },
	] };
	let received: any;
	harness.ctx.modelRegistry.complete = async (_model, context) => {
		received = JSON.parse(context.messages[0].content);
		return judged("not_harmful", "Reverts only the agent's own edit to parser.ts.");
	};
	const result = await harness.handlers.get("tool_call")?.(
		{ toolName: "bash", toolCallId: "b1", input: { command: "git checkout -- src/parser.ts" } }, harness.ctx,
	);
	assert.equal(result, undefined);
	assert.equal(received.agentStatedIntent, "My parser edit broke more tests; reverting it.");
	assert.deepEqual(received.workspace, { gitRoot: "/repo", truncated: false, changedFiles: [
		{ path: "/repo/human.ts", status: " M", editedByAgentThisSession: false, changedBeforeSession: true },
		{ path: "/repo/src/parser.ts", status: " M", editedByAgentThisSession: true, changedBeforeSession: false },
		{ path: "/repo/scratch.ts", status: "??", editedByAgentThisSession: false, changedBeforeSession: false },
	] });
	assert.deepEqual(calls.filter((call) => call.includes("status")), [
		"/repo status --porcelain=v1 -z --untracked-files=normal",
		"/repo status --porcelain=v1 -z --untracked-files=normal",
	]);
});

test("judge omits workspace outside Git and still reviews", async () => {
	const harness = createHarness(clientFor("may_be_harmful"), false, undefined, { fallbackModel: "test/judge" });
	let received: any;
	harness.ctx.modelRegistry.complete = async (_model, context) => {
		received = JSON.parse(context.messages[0].content);
		return judged("may_be_harmful");
	};
	const result = await harness.handlers.get("tool_call")?.({ toolName: "bash", toolCallId: "x", input: { command: "rm notes.txt" } }, harness.ctx);
	assert.equal(result.block, true);
	assert.equal("workspace" in received, false);
	assert.equal((harness.entries[0].data as any).review.fallback.classification, "may_be_harmful");
});

test("fallback disabled by default and uncertain scope honors configurable confidence threshold", async () => {
	const harness = createHarness(clientFor("not_harmful", 0.4), false);
	harness.ctx.modelRegistry.complete = async () => { throw new Error("must not call"); };
	await harness.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "echo test" } }, harness.ctx);
	assert.equal((harness.entries[0].data as any).review.fallback, undefined);
	const configured = createHarness(clientFor("not_harmful", 0.7), false, undefined, { minimumConfidence: 0.8, fallbackModel: "test/judge", fallbackScope: "uncertain" });
	assert.equal(await configured.handlers.get("tool_call")?.({ toolName: "bash", input: { command: "echo test" } }, configured.ctx), undefined);
	assert.equal((configured.entries[0].data as any).review.fallback.classification, "not_harmful");
});

test("judge preserves model IDs containing slashes and rejects tool responses", async () => {
	const harness = createHarness(clientFor("not_harmful"));
	harness.ctx.modelRegistry.complete = async (model) => {
		assert.deepEqual(model, { provider: "openrouter", id: "vendor/model" });
		return { ...judged("not_harmful"), stopReason: "toolUse" };
	};
	await assert.rejects(judgeBashCommand(harness.ctx.modelRegistry as any, "openrouter/vendor/model", { command: "echo test", cwd: "/repo", source: "agent" }));
});

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
