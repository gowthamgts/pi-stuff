import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import { Box, Text } from "@earendil-works/pi-tui";

export type BashSafetyClassification = "not_harmful" | "may_be_harmful" | "harmful";
export type BashCommandSource = "agent" | "user";

export interface BashSafetyReview {
	classification: BashSafetyClassification;
	rawClassification: BashSafetyClassification;
	confidence: number;
	probabilities: Record<BashSafetyClassification, number>;
	model: string;
	durationMs: number;
}

export interface BashGuardOptions {
	client?: TypeSafeClient;
	timeoutMs?: number;
	minimumConfidence?: number;
	readOnePasswordSecret?: (reference: string, signal?: AbortSignal) => Promise<string>;
}

export const REVIEW_ENTRY_TYPE = "typesafe-bash-guard-review";
export const HARMFUL_ENTRY_TYPE = "typesafe-bash-guard-harmful";
export const API_STATUS_KEY = "typesafe-bash-guard-api";
export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_MINIMUM_CONFIDENCE = 0.65;

export function readOnePasswordSecret(reference: string, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"op",
			["read", "--no-newline", reference],
			{ encoding: "utf8", signal },
			(error, stdout, stderr) => {
				if (error) {
					const detail = stderr.trim() || error.message;
					reject(new Error(`1Password CLI failed: ${detail}`, { cause: error }));
					return;
				}
				if (!stdout) {
					reject(new Error("1Password returned an empty TypeSafe API key"));
					return;
				}
				resolve(stdout);
			},
		);
	});
}

export async function resolveTypeSafeApiKey(
	value: string | undefined,
	signal?: AbortSignal,
	readSecret: (reference: string, signal?: AbortSignal) => Promise<string> = readOnePasswordSecret,
): Promise<string | undefined> {
	if (!value?.startsWith("op://")) return value;
	return readSecret(value, signal);
}

export const BASH_SAFETY_QUESTION = choice(
	{
		question: "Classify the safety of executing `command` as a shell command in `cwd`.",
		focus: "Judge what the complete command can do, including pipes, substitutions, encoded payloads, downloads, and chained commands. Classify capability and apparent intent, not whether the command is syntactically valid.",
	},
	{
		not_harmful: {
			what: "Routine, non-destructive development or system inspection with no credible malicious effect.",
			examples: ["listing or reading files", "running tests or builds", "querying git status", "creating ordinary project files"],
		},
		may_be_harmful: {
			what: "Potentially destructive, privileged, privacy-sensitive, or externally consequential, but plausibly legitimate when the user explicitly approves it.",
			examples: ["deleting or overwriting files", "installing software", "changing permissions", "sending data over a network", "executing downloaded code", "accessing secrets"],
			not_for: "Clearly malicious behavior or catastrophic destruction belongs in harmful.",
		},
		harmful: {
			what: "Clearly malicious, unauthorized, or catastrophically destructive behavior that must not execute.",
			examples: ["credential theft or exfiltration", "malware, backdoors, or persistence", "destructive disk or system wipes", "fork bombs", "disabling security controls", "deliberate stealth or evasion supporting an attack"],
		},
	},
);

export async function reviewBashCommand(
	client: TypeSafeClient,
	command: string,
	cwd: string,
	source: BashCommandSource,
	options: { signal?: AbortSignal; timeoutMs?: number; minimumConfidence?: number } = {},
): Promise<BashSafetyReview> {
	const startedAt = performance.now();
	const response = await client.systemOne(
		{
			state: { command, cwd, source },
			questions: { safety: BASH_SAFETY_QUESTION },
		},
		{
			signal: options.signal,
			timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			retry: { maxRetries: 0 },
		},
	);
	const durationMs = performance.now() - startedAt;
	const answer = response.answers.safety;
	const rawClassification = answer.choice;
	if (
		(rawClassification !== "not_harmful" &&
			rawClassification !== "may_be_harmful" &&
			rawClassification !== "harmful") ||
		!Number.isFinite(answer.confidence)
	) {
		throw new Error("TypeSafe returned an invalid bash safety classification");
	}
	const minimumConfidence = options.minimumConfidence ?? DEFAULT_MINIMUM_CONFIDENCE;

	// An uncertain "safe" answer is not safe enough to execute without human review.
	const classification =
		rawClassification === "not_harmful" && answer.confidence < minimumConfidence
			? "may_be_harmful"
			: rawClassification;

	return {
		classification,
		rawClassification,
		confidence: answer.confidence,
		probabilities: answer.probabilities,
		model: response.model,
		durationMs,
	};
}

function blockedUserBashResult(reason: string) {
	return {
		result: {
			output: reason,
			exitCode: 126,
			cancelled: false,
			truncated: false,
		},
	};
}

function formatDuration(durationMs: number): string {
	return durationMs < 1_000 ? `${Math.round(durationMs)} ms` : `${(durationMs / 1_000).toFixed(2)} s`;
}

function formatReview(review: BashSafetyReview): string {
	return `TypeSafe classification: ${review.classification.replaceAll("_", " ")} (${Math.round(review.confidence * 100)}% confidence, ${formatDuration(review.durationMs)})`;
}

export default function typesafeBashGuard(pi: ExtensionAPI, options: BashGuardOptions = {}) {
	let client = options.client;
	let clientPromise: Promise<TypeSafeClient> | undefined;
	let activeReviews = 0;
	let latestApiStatus: string | undefined;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const minimumConfidence = options.minimumConfidence ?? DEFAULT_MINIMUM_CONFIDENCE;

	const getClient = async (signal?: AbortSignal) => {
		if (client) return client;

		clientPromise ??= resolveTypeSafeApiKey(
			process.env.TYPESAFE_API_KEY,
			signal,
			options.readOnePasswordSecret,
		).then(
			(apiKey) =>
				new TypeSafeClient({
					apiKey,
					timeout: timeoutMs,
					retry: { maxRetries: 0 },
				}),
		);

		try {
			client = await clientPromise;
			return client;
		} finally {
			// Allow a later command to retry if 1Password resolution failed or was cancelled.
			if (!client) clientPromise = undefined;
		}
	};

	const classify = async (
		command: string,
		cwd: string,
		source: BashCommandSource,
		ctx: {
			signal?: AbortSignal;
			ui: { setStatus(id: string, text: string | undefined): void };
		},
	): Promise<BashSafetyReview | undefined> => {
		activeReviews += 1;
		ctx.ui.setStatus(
			API_STATUS_KEY,
			activeReviews === 1 ? "TypeSafe: reviewing…" : `TypeSafe: reviewing ${activeReviews} commands…`,
		);

		let apiStartedAt: number | undefined;
		try {
			const apiClient = await getClient(ctx.signal);
			apiStartedAt = performance.now();
			const review = await reviewBashCommand(apiClient, command, cwd, source, {
				signal: ctx.signal,
				timeoutMs,
				minimumConfidence,
			});
			pi.appendEntry(REVIEW_ENTRY_TYPE, { source, review });
			const icon =
				review.classification === "not_harmful"
					? "✓"
					: review.classification === "may_be_harmful"
						? "⚠"
						: "⛔";
			latestApiStatus = `TypeSafe: ${icon} ${review.classification.replaceAll("_", " ")}`;
			return review;
		} catch (error) {
			latestApiStatus = "TypeSafe: API error (fail-open)";
			pi.appendEntry(REVIEW_ENTRY_TYPE, {
				source,
				error: true,
				durationMs: apiStartedAt === undefined ? undefined : performance.now() - apiStartedAt,
			});
			// The selected availability policy is fail-open. Make the bypass visible.
			console.error("TypeSafe bash review failed; allowing command because fail-open is enabled:", error);
			return undefined;
		} finally {
			activeReviews -= 1;
			ctx.ui.setStatus(
				API_STATUS_KEY,
				activeReviews > 0
					? activeReviews === 1
						? "TypeSafe: reviewing…"
						: `TypeSafe: reviewing ${activeReviews} commands…`
					: latestApiStatus,
			);
		}
	};

	const showReviewFailure = (ctx: { hasUI: boolean; ui: { notify(message: string, level: "warning"): void } }) => {
		if (ctx.hasUI) {
			ctx.ui.notify("TypeSafe bash review failed. Command allowed by the configured fail-open policy.", "warning");
		}
	};

	const showHarmfulAlert = (
		command: string,
		source: BashCommandSource,
		review: BashSafetyReview,
		ctx: { hasUI: boolean; ui: { notify(message: string, level: "error"): void } },
	) => {
		pi.appendEntry(HARMFUL_ENTRY_TYPE, { command, source, review });
		if (ctx.hasUI) {
			ctx.ui.notify("HARMFUL COMMAND BLOCKED — TypeSafe classified this bash command as harmful.", "error");
		}
	};

	const confirmPotentialHarm = async (
		command: string,
		review: BashSafetyReview,
		ctx: {
			hasUI: boolean;
			ui: { confirm(title: string, message: string): Promise<boolean> };
		},
	): Promise<boolean> => {
		if (!ctx.hasUI) return false;
		return ctx.ui.confirm(
			"⚠️ Bash command may be harmful",
			`${formatReview(review)}\n\n${command}\n\nProceed with execution?`,
		);
	};

	pi.registerEntryRenderer(REVIEW_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data as {
			source?: BashCommandSource;
			review?: BashSafetyReview;
			error?: boolean;
			durationMs?: number;
		};
		if (data.error || !data.review) {
			const timing = data.durationMs === undefined ? "API not called" : formatDuration(data.durationMs);
			return new Text(
				theme.fg("warning", "TypeSafe  ⚠ API error") +
					theme.fg("dim", `  •  ${timing}  •  fail-open`),
				0,
				0,
			);
		}

		const review = data.review;
		const icon =
			review.classification === "not_harmful"
				? "✓"
				: review.classification === "may_be_harmful"
					? "⚠"
					: "⛔";
		const color =
			review.classification === "not_harmful"
				? "success"
				: review.classification === "may_be_harmful"
					? "warning"
					: "error";
		let text = theme.fg(color, `TypeSafe  ${icon} ${review.classification.replaceAll("_", " ")}`);
		text += theme.fg(
			"dim",
			`  •  ${formatDuration(review.durationMs)}  •  confidence ${Math.round(review.confidence * 100)}%`,
		);
		if (expanded) {
			text += theme.fg(
				"dim",
				`\nmodel ${review.model}  •  raw ${review.rawClassification.replaceAll("_", " ")}  •  probabilities ${JSON.stringify(review.probabilities)}`,
			);
		}
		return new Text(text, 0, 0);
	});

	pi.registerEntryRenderer(HARMFUL_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data as { command?: string; source?: BashCommandSource };
		const box = new Box(1, 1, (text) => theme.bg("toolErrorBg", text));
		box.addChild(
			new Text(
				theme.fg("error", theme.bold("⛔ HARMFUL COMMAND BLOCKED")) +
					`\n${theme.fg("muted", `Source: ${data.source ?? "unknown"}`)}` +
					`\n${data.command ?? ""}`,
				0,
				0,
			),
		);
		return box;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const command = event.input.command;
		const review = await classify(command, ctx.cwd, "agent", ctx);
		if (!review) {
			showReviewFailure(ctx);
			return;
		}

		if (review.classification === "harmful") {
			showHarmfulAlert(command, "agent", review, ctx);
			return { block: true, reason: `HARMFUL COMMAND BLOCKED. ${formatReview(review)}`, terminate: true };
		}

		if (review.classification === "may_be_harmful") {
			const approved = await confirmPotentialHarm(command, review, ctx);
			if (!approved) {
				return {
					block: true,
					reason: ctx.hasUI
						? "Potentially harmful command blocked because the user did not approve it."
						: "Potentially harmful command blocked because no confirmation UI is available.",
				};
			}
		}
	});

	pi.on("user_bash", async (event, ctx) => {
		const review = await classify(event.command, event.cwd, "user", ctx);
		if (!review) {
			showReviewFailure(ctx);
			return;
		}

		if (review.classification === "harmful") {
			showHarmfulAlert(event.command, "user", review, ctx);
			return blockedUserBashResult(`HARMFUL COMMAND BLOCKED. ${formatReview(review)}`);
		}

		if (review.classification === "may_be_harmful") {
			const approved = await confirmPotentialHarm(event.command, review, ctx);
			if (!approved) {
				return blockedUserBashResult(
					ctx.hasUI
						? "Potentially harmful command blocked because the user did not approve it."
						: "Potentially harmful command blocked because no confirmation UI is available.",
				);
			}
		}
	});
}
