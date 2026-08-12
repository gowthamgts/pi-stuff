import assert from "node:assert/strict";
import test from "node:test";
import gitStatus, {
	collectUsageTotals,
	formatGitStatus,
	formatUsageStats,
	parseGitStatus,
	parseGitWorktree,
} from "../index.ts";

test("parses a clean tracked branch", () => {
	const status = parseGitStatus([
		"# branch.oid 0123456789abcdef",
		"# branch.head main",
		"# branch.upstream origin/main",
		"# branch.ab +0 -0",
		"",
	].join("\n"));

	assert.deepEqual(status, {
		branch: "main",
		upstream: "origin/main",
		ahead: 0,
		behind: 0,
		changed: 0,
		staged: 0,
		modified: 0,
		untracked: 0,
		conflicted: 0,
	});
	assert.equal(formatGitStatus(status), "git main • clean");
});

test("counts staged, modified, renamed, untracked, and conflicted files", () => {
	const status = parseGitStatus([
		"# branch.oid 0123456789abcdef",
		"# branch.head feature/status",
		"# branch.upstream origin/feature/status",
		"# branch.ab +2 -1",
		"1 M. N... 100644 100644 100644 abc abc staged.ts",
		"1 .M N... 100644 100644 100644 abc abc modified.ts",
		"1 MM N... 100644 100644 100644 abc abc both.ts",
		"2 R. N... 100644 100644 100644 abc abc R100 renamed.ts\toriginal.ts",
		"? untracked.ts",
		"u UU N... 100644 100644 100644 100644 abc abc abc conflict.ts",
	].join("\n"));

	assert.deepEqual(status, {
		branch: "feature/status",
		upstream: "origin/feature/status",
		ahead: 2,
		behind: 1,
		changed: 6,
		staged: 3,
		modified: 2,
		untracked: 1,
		conflicted: 1,
	});
	assert.equal(
		formatGitStatus(status),
		"git feature/status ↑2 ↓1 • 6 changed • 3 staged • 2 modified • 1 untracked • 1 conflict",
	);
	assert.equal(formatGitStatus(status, true), "git feature/status ↑2 ↓1 • Δ6 +3 ~2 ?1 !1");
});

test("uses the abbreviated commit for detached HEAD", () => {
	const status = parseGitStatus([
		"# branch.oid fedcba9876543210",
		"# branch.head (detached)",
	].join("\n"));

	assert.equal(status.branch, "@fedcba9");
});

test("preserves the branch name for a repository without commits", () => {
	const status = parseGitStatus([
		"# branch.oid (initial)",
		"# branch.head trunk",
		"? README.md",
	].join("\n"));

	assert.equal(status.branch, "trunk");
	assert.equal(status.changed, 1);
});

test("identifies linked worktrees without labeling the main worktree", () => {
	assert.equal(parseGitWorktree([
		"/repo",
		"/repo/.git",
		"/repo/.git",
	].join("\n")), undefined);

	assert.equal(parseGitWorktree([
		"/worktrees/pi-stuff-auth",
		"/repo/.git/worktrees/pi-stuff-auth",
		"/repo/.git",
	].join("\n")), "pi-stuff-auth");
});

test("includes the linked worktree in formatted status", () => {
	const status = {
		...parseGitStatus([
			"# branch.oid 0123456789abcdef",
			"# branch.head feature/auth",
		].join("\n")),
		worktree: "pi-stuff-auth",
	};

	assert.equal(formatGitStatus(status), "git feature/auth @ pi-stuff-auth • clean");
});

test("collects and formats usage totals", () => {
	const totals = collectUsageTotals([
		{
			type: "message",
			message: {
				role: "assistant",
				usage: { input: 1_200, output: 34, cacheRead: 100, cacheWrite: 0, cost: { total: 0.01 } },
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				usage: { input: 5, output: 6, cacheRead: 0, cacheWrite: 2, cost: { total: 0.002 } },
			},
		},
	]);

	assert.deepEqual(totals, {
		input: 1_205,
		output: 40,
		cacheRead: 100,
		cacheWrite: 2,
		cost: 0.012,
	});
	assert.equal(formatUsageStats(totals, { percent: 12.5, contextWindow: 128_000 }),
		"↑1.2k ↓40 R100 W2 $0.012 12.5%/128k");
});

test("renders Git status on the token-usage footer line", async () => {
	const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
	let component: { render(width: number): string[] } | undefined;
	let restoredBuiltInFooter = false;

	gitStatus({
		on(event: string, handler: (event: unknown, ctx: any) => unknown) {
			handlers.set(event, handler);
		},
		exec: async (_command: string, args: string[]) => ({
			stdout: args[0] === "status"
				? [
					"# branch.oid 0123456789abcdef",
					"# branch.head main",
					"# branch.ab +2 -0",
					"1 M. N... 100644 100644 100644 abc abc staged.ts",
					"? untracked.ts",
				].join("\n")
				: [
					"/worktrees/pi-stuff-main",
					"/repo/.git/worktrees/pi-stuff-main",
					"/repo/.git",
				].join("\n"),
			stderr: "",
			code: 0,
			killed: false,
		}),
		getThinkingLevel: () => "high",
	} as any);

	const entries = [{
		type: "message",
		message: {
			role: "assistant",
			usage: { input: 1_200, output: 34, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		},
	}];
	const ctx = {
		mode: "tui",
		cwd: "/repo",
		model: { id: "gpt-test", reasoning: true },
		getContextUsage: () => ({ tokens: 16_000, contextWindow: 128_000, percent: 12.5 }),
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => undefined,
		},
		ui: {
			setFooter(factory: any) {
				if (!factory) {
					restoredBuiltInFooter = true;
					return;
				}
				component = factory(
					{ requestRender() {} },
					{ fg(_color: string, text: string) { return text; } },
					{ getExtensionStatuses: () => new Map() },
				);
			},
		},
	};

	handlers.get("session_start")?.({}, ctx);
	await new Promise((resolve) => setTimeout(resolve, 0));

	const lines = component?.render(140);
	assert.equal(lines?.length, 2);
	assert.equal(lines?.[0], "/repo");
	assert.ok(lines?.[1].startsWith("↑1.2k ↓34 12.5%/128k"));
	assert.ok(lines?.[1].endsWith("gpt-test • high • git main ↑2 @ pi-stuff-main • 2 changed • 1 staged • 1 untracked"));

	handlers.get("session_shutdown")?.({}, ctx);
	assert.equal(restoredBuiltInFooter, true);
});
