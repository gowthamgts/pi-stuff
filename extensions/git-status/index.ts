import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const REFRESH_INTERVAL_MS = 2_000;

export interface GitStatusSummary {
	branch: string;
	upstream?: string;
	ahead: number;
	behind: number;
	changed: number;
	staged: number;
	modified: number;
	untracked: number;
	conflicted: number;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseGitStatus(output: string): GitStatusSummary {
	let head = "unknown";
	let oid: string | undefined;
	let upstream: string | undefined;
	let ahead = 0;
	let behind = 0;
	let changed = 0;
	let staged = 0;
	let modified = 0;
	let untracked = 0;
	let conflicted = 0;

	for (const line of output.split("\n")) {
		if (line.startsWith("# branch.head ")) {
			head = line.slice("# branch.head ".length);
			continue;
		}
		if (line.startsWith("# branch.oid ")) {
			oid = line.slice("# branch.oid ".length);
			continue;
		}
		if (line.startsWith("# branch.upstream ")) {
			upstream = line.slice("# branch.upstream ".length);
			continue;
		}
		if (line.startsWith("# branch.ab ")) {
			const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
			if (match) {
				ahead = Number(match[1]);
				behind = Number(match[2]);
			}
			continue;
		}

		if (line.startsWith("? ")) {
			changed++;
			untracked++;
			continue;
		}
		if (line.startsWith("u ")) {
			changed++;
			conflicted++;
			continue;
		}
		if (line.startsWith("1 ") || line.startsWith("2 ")) {
			changed++;
			const indexStatus = line[2];
			const worktreeStatus = line[3];
			if (indexStatus && indexStatus !== ".") staged++;
			if (worktreeStatus && worktreeStatus !== ".") modified++;
		}
	}

	const branch = head === "(detached)" && oid && oid !== "(initial)" ? `@${oid.slice(0, 7)}` : head;
	return { branch, upstream, ahead, behind, changed, staged, modified, untracked, conflicted };
}

export function formatGitStatus(status: GitStatusSummary, compact = false): string {
	const sync = [status.ahead > 0 ? `↑${status.ahead}` : "", status.behind > 0 ? `↓${status.behind}` : ""]
		.filter(Boolean)
		.join(" ");
	const branch = `git ${status.branch}${sync ? ` ${sync}` : ""}`;

	if (status.changed === 0) return `${branch} • clean`;

	if (compact) {
		const counts = [
			`Δ${status.changed}`,
			status.staged > 0 ? `+${status.staged}` : "",
			status.modified > 0 ? `~${status.modified}` : "",
			status.untracked > 0 ? `?${status.untracked}` : "",
			status.conflicted > 0 ? `!${status.conflicted}` : "",
		].filter(Boolean);
		return `${branch} • ${counts.join(" ")}`;
	}

	const details = [
		`${status.changed} changed`,
		status.staged > 0 ? `${status.staged} staged` : "",
		status.modified > 0 ? `${status.modified} modified` : "",
		status.untracked > 0 ? `${status.untracked} untracked` : "",
		status.conflicted > 0 ? `${status.conflicted} conflict${status.conflicted === 1 ? "" : "s"}` : "",
	].filter(Boolean);
	return `${branch} • ${details.join(" • ")}`;
}

function addUsage(totals: UsageTotals, usage: unknown): void {
	if (!isRecord(usage)) return;
	if (typeof usage.input === "number") totals.input += usage.input;
	if (typeof usage.output === "number") totals.output += usage.output;
	if (typeof usage.cacheRead === "number") totals.cacheRead += usage.cacheRead;
	if (typeof usage.cacheWrite === "number") totals.cacheWrite += usage.cacheWrite;
	if (isRecord(usage.cost) && typeof usage.cost.total === "number") totals.cost += usage.cost.total;
}

export function collectUsageTotals(entries: readonly unknown[]): UsageTotals {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		if (entry.type === "message" && isRecord(entry.message)) {
			if (entry.message.role === "assistant" || (entry.message.role === "toolResult" && entry.message.usage)) {
				addUsage(totals, entry.message.usage);
			}
		} else if (entry.type === "branch_summary" || entry.type === "compaction") {
			addUsage(totals, entry.usage);
		}
	}

	return totals;
}

export function formatTokens(count: number): string {
	if (count < 1_000) return `${count}`;
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

export function formatUsageStats(
	totals: UsageTotals,
	contextUsage: { percent: number | null; contextWindow: number } | undefined,
): string {
	const parts: string[] = [];
	if (totals.input > 0) parts.push(`↑${formatTokens(totals.input)}`);
	if (totals.output > 0) parts.push(`↓${formatTokens(totals.output)}`);
	if (totals.cacheRead > 0) parts.push(`R${formatTokens(totals.cacheRead)}`);
	if (totals.cacheWrite > 0) parts.push(`W${formatTokens(totals.cacheWrite)}`);
	if (totals.cost > 0) parts.push(`$${totals.cost.toFixed(3)}`);

	if (contextUsage) {
		const percent = contextUsage.percent === null ? "?" : `${contextUsage.percent.toFixed(1)}%`;
		parts.push(`${percent}/${formatTokens(contextUsage.contextWindow)}`);
	}

	return parts.join(" ");
}

export function alignFooterLine(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	if (!right) return truncateToWidth(left, width, "…");

	let leftText = left;
	let leftWidth = visibleWidth(leftText);
	if (leftWidth >= width - 2) {
		leftText = truncateToWidth(leftText, Math.max(0, width - 2), "…");
		leftWidth = visibleWidth(leftText);
	}

	const availableForRight = Math.max(0, width - leftWidth - 2);
	if (availableForRight === 0) return truncateToWidth(leftText, width, "…");

	const rightText = truncateToWidth(right, availableForRight, "…");
	const padding = " ".repeat(Math.max(2, width - leftWidth - visibleWidth(rightText)));
	return truncateToWidth(leftText + padding + rightText, width, "");
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

export default function gitStatus(pi: ExtensionAPI) {
	let summary: GitStatusSummary | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let refreshActive: (() => Promise<void>) | undefined;
	let requestRender = () => {};
	let generation = 0;

	const stopPolling = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		refreshActive = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		stopPolling();
		summary = undefined;
		const sessionGeneration = ++generation;

		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();

			return {
				invalidate() {},
				render(width: number): string[] {
					const sessionName = ctx.sessionManager.getSessionName();
					const location = sessionName ? `${ctx.cwd} • ${sessionName}` : ctx.cwd;
					const extensionStatuses = Array.from(footerData.getExtensionStatuses().entries())
						.filter(([key]) => key !== "git-status")
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => sanitizeStatusText(text))
						.join(" ");
					const locationLine = alignFooterLine(
						theme.fg("dim", location),
						extensionStatuses,
						width,
					);

					const totals = collectUsageTotals(ctx.sessionManager.getEntries());
					const usageText = formatUsageStats(totals, ctx.getContextUsage());
					const modelName = ctx.model?.id ?? "no-model";
					const thinking = ctx.model?.reasoning ? ` • ${pi.getThinkingLevel()}` : "";
					const modelText = `${modelName}${thinking}`;

					let rightText = modelText;
					if (summary) {
						const fullGit = formatGitStatus(summary);
						const compactGit = formatGitStatus(summary, true);
						const available = Math.max(0, width - visibleWidth(usageText) - 2);
						const candidates = [
							`${modelText} • ${fullGit}`,
							`${modelText} • ${compactGit}`,
							fullGit,
							compactGit,
						];
						rightText = candidates.find((candidate) => visibleWidth(candidate) <= available) ?? compactGit;
					}

					const gitColor = summary?.conflicted
						? "error"
						: summary?.changed
							? "warning"
							: "dim";
					const statsLine = alignFooterLine(
						theme.fg("dim", usageText),
						theme.fg(gitColor, rightText),
						width,
					);

					return [locationLine, statsLine];
				},
			};
		});

		let inFlight: Promise<void> | undefined;
		const refresh = (): Promise<void> => {
			if (inFlight) return inFlight;
			inFlight = (async () => {
				const result = await pi.exec(
					"git",
					["status", "--porcelain=v2", "--branch", "--untracked-files=all"],
					{ cwd: ctx.cwd, timeout: 3_000 },
				);
				if (generation !== sessionGeneration) return;
				summary = result.code === 0 ? parseGitStatus(result.stdout) : undefined;
				requestRender();
			})()
				.catch(() => {
					if (generation === sessionGeneration) {
						summary = undefined;
						requestRender();
					}
				})
				.finally(() => {
					inFlight = undefined;
				});
			return inFlight;
		};

		refreshActive = refresh;
		void refresh();
		timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
		timer.unref?.();
	});

	pi.on("tool_execution_end", async () => {
		await refreshActive?.();
	});

	pi.on("turn_end", async () => {
		await refreshActive?.();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		generation++;
		stopPolling();
		summary = undefined;
		requestRender = () => {};
		if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
	});
}
