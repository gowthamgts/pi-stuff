import assert from "node:assert/strict";
import test from "node:test";
import gitCommit from "../index.ts";

test("/commit stages changes and commits a normalized 40-character subject", async () => {
	let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
	const calls: Array<{ command: string; args: string[] }> = [];

	gitCommit({
		registerCommand(_name: string, command: { handler: typeof handler }) {
			handler = command.handler;
		},
		async exec(command: string, args: string[]) {
			calls.push({ command, args });
			if (args[0] === "diff") return { code: 0, stdout: "diff --git a/a.ts b/a.ts", stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		},
	} as any);

	assert.ok(handler);
	await handler("", {
		cwd: "/repo",
		model: { provider: "test", id: "model" },
		modelRegistry: {
			hasConfiguredAuth: () => true,
			complete: async () => ({
				content: [{ type: "text", text: "`ADD AUTHENTICATION AND IMPROVE LOGIN ERROR HANDLING.`" }],
			}),
		},
		ui: { notify() {} },
	});

	assert.deepEqual(calls.map(({ args }) => args[0]), ["add", "diff", "commit"]);
	const summary = calls.at(-1)?.args[2] ?? "";
	assert.ok(summary.length <= 40);
	assert.equal(summary, summary.toLowerCase());
	assert.doesNotMatch(summary, /[.!?;:]$/);
});
