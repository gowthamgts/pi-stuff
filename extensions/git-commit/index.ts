import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SYSTEM_PROMPT = `Write a git commit subject for the staged diff.

Rules:
- output exactly one line and nothing else
- use lowercase only
- use imperative mood
- describe the change, not the implementation process
- use at most 40 characters, including any prefix
- omit trailing punctuation, quotes, and markdown`;

export function normalizeSummary(output: string): string {
	const firstLine = output.split(/\r?\n/).find((line) => line.trim()) ?? "";
	return firstLine
		.trim()
		.replace(/^[-*]\s+/, "")
		.replace(/^`{1,3}|`{1,3}$/g, "")
		.replace(/^["']|["']$/g, "")
		.replace(/\s+/g, " ")
		.toLowerCase()
		.slice(0, 40)
		.trim()
		.replace(/[.!?;:]+$/, "");
}

export default function gitCommit(pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "Stage all changes and create a short AI-written commit",
		handler: async (_args, ctx) => {
			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}
			if (!ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
				ctx.ui.notify(`No authentication configured for ${ctx.model.provider}/${ctx.model.id}`, "error");
				return;
			}

			const staged = await pi.exec("git", ["add", "-A"], { cwd: ctx.cwd });
			if (staged.code !== 0) {
				ctx.ui.notify(staged.stderr.trim() || "Unable to stage changes", "error");
				return;
			}

			const diff = await pi.exec(
				"git",
				["diff", "--cached", "--no-ext-diff", "--no-textconv", "--unified=2"],
				{ cwd: ctx.cwd },
			);
			if (diff.code !== 0) {
				ctx.ui.notify(diff.stderr.trim() || "Unable to read staged changes", "error");
				return;
			}
			if (!diff.stdout.trim()) {
				ctx.ui.notify("Nothing to commit", "info");
				return;
			}

			ctx.ui.notify("Generating commit summary...", "info");
			// ponytail: first 20k characters cover normal commits; raise this if large commits need more context.
			const diffContext = diff.stdout.slice(0, 20_000);

			try {
				const response = await ctx.modelRegistry.complete(
					ctx.model,
					{
						systemPrompt: SYSTEM_PROMPT,
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: diffContext }],
								timestamp: Date.now(),
							},
						],
					},
					{ maxTokens: 64, cacheRetention: "none" },
				);
				const summary = normalizeSummary(
					response.content
						.filter((part): part is { type: "text"; text: string } => part.type === "text")
						.map((part) => part.text)
						.join("\n"),
				);
				if (!summary) {
					ctx.ui.notify("The model returned an empty commit summary", "error");
					return;
				}

				const committed = await pi.exec("git", ["commit", "-m", summary], { cwd: ctx.cwd });
				if (committed.code !== 0) {
					ctx.ui.notify(committed.stderr.trim() || "Unable to create commit", "error");
					return;
				}
				ctx.ui.notify(`Committed: ${summary}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
