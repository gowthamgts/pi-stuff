import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
const AUTH_FILES = [
	join(HOME, '.pi', 'agent', 'auth.json'),
	join(HOME, '.codex', 'auth.json'),
]
const QUOTA_URL = 'https://chatgpt.com/backend-api/wham/usage'
/**
 * Status slot shared with the codex-fast-mode extension: its fast/standard
 * indicator is inlined into this footer's stats line instead of the statuses line.
 */
export const CODEX_FOOTER_STATUS_KEY = 'codex-custom-footer'
const MINUTE_MS = 60 * 1000
const QUOTA_REFRESH_MS = 5 * MINUTE_MS

export interface QuotaStatus {
	/** Remaining quota as a percentage of the weekly window (0–100). */
	remainingPercent: number
	/** Epoch seconds at which the quota window resets, when known. */
	resetsAt: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Format token counts for compact footer display (same thresholds as pi's default footer). */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString()
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`
	if (count < 1000000) return `${Math.round(count / 1000)}k`
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`
	return `${Math.round(count / 1000000)}M`
}

/** Replaces the home directory prefix with `~` (same behavior as pi's default footer). */
export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd
	const resolvedCwd = resolve(cwd)
	const resolvedHome = resolve(home)
	const relativeToHome = relative(resolvedHome, resolvedCwd)
	const isInsideHome =
		relativeToHome === '' ||
		(relativeToHome !== '..' && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome))
	if (!isInsideHome) return cwd
	return relativeToHome === '' ? '~' : `~${sep}${relativeToHome}`
}

/** Extracts the remaining quota percentage and window reset time from the `wham/usage` payload. */
export function parseQuotaStatus(data: unknown, nowSec: number): QuotaStatus | null {
	if (!isRecord(data)) return null
	const rateLimit = data.rate_limit
	if (!isRecord(rateLimit)) return null

	let remainingPercent = 100
	let resetsAt: number | null = null
	if (isRecord(rateLimit.primary_window)) {
		const window = rateLimit.primary_window
		if (typeof window.used_percent === 'number') {
			remainingPercent = Math.max(0, Math.min(100, 100 - window.used_percent))
		}
		if (typeof window.reset_at === 'number' && window.reset_at > nowSec) resetsAt = window.reset_at
	}
	if (rateLimit.limit_reached === true) remainingPercent = 0

	return { remainingPercent, resetsAt }
}

/** Formats a duration in seconds as a compact countdown (e.g. "48m", "3h 12m", "2d"). */
export function formatDuration(seconds: number): string {
	if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`
	if (seconds < 86_400) {
		const hours = Math.floor(seconds / 3600)
		const minutes = Math.round((seconds % 3600) / 60)
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
	}
	return `${Math.floor(seconds / 86_400)}d`
}

/** Pulls ChatGPT OAuth access tokens from pi's or the Codex CLI's auth file. */
export function extractAccessTokens(auth: unknown): string[] {
	const tokens: string[] = []
	if (!isRecord(auth)) return tokens
	if (isRecord(auth.tokens) && typeof auth.tokens.access_token === 'string') {
		tokens.push(auth.tokens.access_token)
	}
	for (const provider of ['openai-codex', 'openai']) {
		const entry = auth[provider]
		if (isRecord(entry) && typeof entry.access === 'string') tokens.push(entry.access)
	}
	return tokens
}

function readAccessTokens(): string[] {
	const tokens: string[] = []
	for (const file of AUTH_FILES) {
		try {
			tokens.push(...extractAccessTokens(JSON.parse(readFileSync(file, 'utf8'))))
		} catch {
			// unreadable or unparseable auth file
		}
	}
	return tokens
}

/** Fetches the remaining quota from OpenAI, trying each access token in order. */
export async function fetchQuotaStatus(tokens: readonly string[]): Promise<QuotaStatus | null> {
	for (const token of tokens) {
		try {
			const response = await fetch(QUOTA_URL, {
				headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'codex-cli' },
				signal: AbortSignal.timeout(10_000),
			})
			if (!response.ok) continue
			const data = (await response.json()) as unknown
			const status = parseQuotaStatus(data, Date.now() / 1000)
			if (status) return status
		} catch {
			// network error — try the next token source
		}
	}
	return null
}

/** Right-aligns the model name next to the stats, truncating the right side when narrow. */
export function layoutStatsLine(statsLeft: string, rightSide: string, width: number): string {
	const statsLeftWidth = visibleWidth(statsLeft)
	const minPadding = 2
	const rightSideWidth = visibleWidth(rightSide)

	if (statsLeftWidth + minPadding + rightSideWidth <= width) {
		const padding = ' '.repeat(width - statsLeftWidth - rightSideWidth)
		return statsLeft + padding + rightSide
	}
	const availableForRight = width - statsLeftWidth - minPadding
	if (availableForRight > 0) {
		const truncatedRight = truncateToWidth(rightSide, availableForRight, '')
		const padding = ' '.repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)))
		return statsLeft + padding + truncatedRight
	}
	return statsLeft
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, ' ').replace(/ +/g, ' ').trim()
}

export default function codexUsage(pi: ExtensionAPI) {
	let quota: QuotaStatus | null = null
	let renderTimer: ReturnType<typeof setInterval> | undefined
	let quotaTimer: ReturnType<typeof setInterval> | undefined
	let requestRender = () => {}
	let generation = 0
	let quotaInFlight = false

	const stopTimers = () => {
		if (renderTimer) clearInterval(renderTimer)
		if (quotaTimer) clearInterval(quotaTimer)
		renderTimer = undefined
		quotaTimer = undefined
	}

	const refreshQuota = async (): Promise<void> => {
		if (quotaInFlight) return
		quotaInFlight = true
		try {
			quota = await fetchQuotaStatus(readAccessTokens())
			requestRender()
		} catch {
			// keep the last known value
		} finally {
			quotaInFlight = false
		}
	}

	pi.on('session_start', (_event, ctx) => {
		stopTimers()
		const sessionGeneration = ++generation

		if (ctx.mode !== 'tui') return

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender())
			requestRender = () => tui.requestRender()

			// Minute tick keeps the reset countdown current without refetching.
			renderTimer = setInterval(() => {
				if (generation !== sessionGeneration) return
				tui.requestRender()
			}, MINUTE_MS)
			renderTimer.unref?.()
			quotaTimer = setInterval(() => void refreshQuota(), QUOTA_REFRESH_MS)
			quotaTimer.unref?.()
			void refreshQuota()

			return {
				dispose() {
					requestRender = () => {}
					stopTimers()
					unsubscribeBranch()
				},
				invalidate() {},
				render(width: number): string[] {
					// --- usage totals (same as the default footer) ---
					let input = 0
					let output = 0
					let cacheRead = 0
					let cacheWrite = 0
					let cost = 0
					let latestCacheHitRate: number | undefined
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === 'message' && entry.message.role === 'assistant') {
							const usage = entry.message.usage
							input += usage.input
							output += usage.output
							cacheRead += usage.cacheRead
							cacheWrite += usage.cacheWrite
							cost += usage.cost.total
							const latestPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite
							latestCacheHitRate =
								latestPromptTokens > 0 ? (usage.cacheRead / latestPromptTokens) * 100 : undefined
						} else if (entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.usage) {
							const usage = entry.message.usage
							input += usage.input
							output += usage.output
							cacheRead += usage.cacheRead
							cacheWrite += usage.cacheWrite
							cost += usage.cost.total
						} else if ((entry.type === 'branch_summary' || entry.type === 'compaction') && entry.usage) {
							const usage = entry.usage
							input += usage.input
							output += usage.output
							cacheRead += usage.cacheRead
							cacheWrite += usage.cacheWrite
							cost += usage.cost.total
						}
					}

					// --- context usage ---
					const contextUsage = ctx.getContextUsage()
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0
					const contextPercentValue = contextUsage?.percent ?? 0
					const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : '?'
					const contextPercentDisplay = `${contextPercent}%/${formatTokens(contextWindow)}`
					const contextPercentStr =
						contextPercentValue > 90
							? theme.fg('error', contextPercentDisplay)
							: contextPercentValue > 70
								? theme.fg('warning', contextPercentDisplay)
								: contextPercentDisplay

					// --- stats line (mirrors the default footer, plus the quota segment) ---
					const statsParts: string[] = []
					if (input) statsParts.push(`↑${formatTokens(input)}`)
					if (output) statsParts.push(`↓${formatTokens(output)}`)
					if (cacheRead) statsParts.push(`R${formatTokens(cacheRead)}`)
					if (cacheWrite) statsParts.push(`W${formatTokens(cacheWrite)}`)
					if ((cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== undefined) {
						statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`)
					}
					const provider = ctx.model ? ctx.modelRegistry.getProvider(ctx.model.provider) : undefined
					const oauth = (provider?.auth as { oauth?: { isSubscription?: boolean } } | undefined)?.oauth
					const usingSubscription =
						ctx.model !== undefined && ctx.modelRegistry.isUsingOAuth(ctx.model) && oauth?.isSubscription === true
					if (cost || usingSubscription) {
						statsParts.push(`$${cost.toFixed(3)}${usingSubscription ? ' (sub)' : ''}`)
					}
					statsParts.push(contextPercentStr)

					// Quota and fast-mode indicator only for Codex subscription models.
					const isCodexModel = ctx.model?.provider === 'openai-codex'
					const extensionStatuses = footerData.getExtensionStatuses()
					if (isCodexModel) {
						const fastStatus = extensionStatuses.get(CODEX_FOOTER_STATUS_KEY)
						if (fastStatus) {
							statsParts.push(theme.fg('dim', sanitizeStatusText(fastStatus)))
							if (quota) statsParts.push(theme.fg('dim', '·'))
						}
						if (quota) {
							let quotaText = `codex ${quota.remainingPercent}% left`
							if (quota.remainingPercent <= 25 && quota.resetsAt !== null) {
								const remainingSec = Math.max(0, quota.resetsAt - Date.now() / 1000)
								quotaText += ` · resets in ${formatDuration(remainingSec)}`
							}
							statsParts.push(
								quota.remainingPercent <= 0
									? theme.fg('error', quotaText)
									: quota.remainingPercent <= 25
										? theme.fg('warning', quotaText)
										: theme.fg('accent', quotaText),
							)
						} else {
							statsParts.push(theme.fg('dim', 'codex –'))
						}
					}

					let statsLeft = statsParts.join(' ')
					let statsLeftWidth = visibleWidth(statsLeft)
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, '...')
						statsLeftWidth = visibleWidth(statsLeft)
					}

					const modelName = ctx.model?.id ?? 'no-model'
					let rightSideWithoutProvider = modelName
					if (ctx.model?.reasoning) {
						const thinkingLevel = ctx.thinkingLevel || 'off'
						rightSideWithoutProvider =
							thinkingLevel === 'off' ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`
					}
					let rightSide = rightSideWithoutProvider
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`
						if (statsLeftWidth + 2 + visibleWidth(rightSide) > width) rightSide = rightSideWithoutProvider
					}

					const statsLine = layoutStatsLine(statsLeft, rightSide, width)
					// Dim the stats and the right side separately so inner colors (context %,
					// quota) survive, exactly like the default footer.
					const dimStatsLeft = theme.fg('dim', statsLeft)
					const remainder = statsLine.slice(statsLeft.length)
					const dimRemainder = theme.fg('dim', remainder)

					// --- pwd line ---
					let pwd = formatCwdForFooter(ctx.sessionManager.getCwd(), process.env.HOME)
					const branch = footerData.getGitBranch()
					if (branch) pwd = `${pwd} (${branch})`
					const sessionName = ctx.sessionManager.getSessionName()
					if (sessionName) pwd = `${pwd} • ${sessionName}`
					const pwdLine = truncateToWidth(theme.fg('dim', pwd), width, theme.fg('dim', '...'))

					const lines = [pwdLine, dimStatsLeft + dimRemainder]

					// --- extension statuses line (fast mode is inlined into the stats line for Codex models) ---
					const otherStatuses = Array.from(extensionStatuses.entries())
						.filter(([key]) => key !== CODEX_FOOTER_STATUS_KEY || !isCodexModel)
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => sanitizeStatusText(text))
					if (otherStatuses.length > 0) {
						lines.push(truncateToWidth(otherStatuses.join(' '), width, theme.fg('dim', '...')))
					}

					return lines
				},
			}
		})
	})

	// Refresh the quota shortly after an agent run settles.
	pi.on('agent_settled', () => {
		setTimeout(() => void refreshQuota(), 30_000).unref?.()
	})

	pi.on('session_shutdown', (_event, ctx) => {
		generation++
		requestRender = () => {}
		stopTimers()
		if (ctx.mode === 'tui') ctx.ui.setFooter(undefined)
	})
}
