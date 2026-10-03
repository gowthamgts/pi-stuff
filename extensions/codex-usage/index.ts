import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
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
const APPS_URL = `${QUOTA_URL}/chatpass/apps`
/** Status slot published by codex-fast-mode. Retained for package compatibility. */
export const CODEX_FOOTER_STATUS_KEY = 'codex-custom-footer'
/** Quota status consumed by pi's default footer and custom footers such as git-status. */
export const CODEX_USAGE_STATUS_KEY = 'codex-usage'
const MINUTE_MS = 60 * 1000
const QUOTA_REFRESH_MS = 5 * MINUTE_MS

export interface QuotaStatus {
	/** Remaining quota in the primary five-hour window (0–100). */
	remainingPercent: number
	/** Epoch seconds at which the primary window resets, when known. */
	resetsAt: number | null
	/** Remaining quota in the secondary weekly window, when reported (0–100). */
	weeklyRemainingPercent: number | null
	/** Epoch seconds at which the weekly window resets, when known. */
	weeklyResetsAt: number | null
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

	const parseWindow = (value: unknown): { remainingPercent: number; resetsAt: number | null } | null => {
		if (!isRecord(value)) return null
		const remainingPercent =
			typeof value.used_percent === 'number'
				? Math.max(0, Math.min(100, 100 - value.used_percent))
				: 100
		const resetsAt =
			typeof value.reset_at === 'number' && value.reset_at > nowSec ? value.reset_at : null
		return { remainingPercent, resetsAt }
	}

	const primary = parseWindow(rateLimit.primary_window) ?? { remainingPercent: 100, resetsAt: null }
	const weekly = parseWindow(rateLimit.secondary_window)
	if (rateLimit.limit_reached === true) primary.remainingPercent = 0

	return {
		remainingPercent: primary.remainingPercent,
		resetsAt: primary.resetsAt,
		weeklyRemainingPercent: weekly?.remainingPercent ?? null,
		weeklyResetsAt: weekly?.resetsAt ?? null,
	}
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

export function formatQuotaStatus(status: QuotaStatus | null, nowSec = Date.now() / 1000): string {
	if (!status) return '5h - –, 7d - –'
	let text = `5h - ${status.remainingPercent}%`
	if (status.weeklyRemainingPercent !== null) text += `, 7d - ${status.weeklyRemainingPercent}%`
	if (status.remainingPercent <= 25 && status.resetsAt !== null) {
		text += ` · resets in ${formatDuration(Math.max(0, status.resetsAt - nowSec))}`
	}
	return text
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

function openaiAppId(token: string): string | undefined {
	try {
		const claims: unknown = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
		if (!isRecord(claims) || claims.iss !== 'https://auth.openai.com' ||
			claims.aud !== 'https://api.openai.com/v1' ||
			typeof claims.scope !== 'string' || !claims.scope.split(/\s+/).includes('chatgpt.tokens.use.direct') ||
			typeof claims.client_id !== 'string' || !/^oaiapp_[\w-]+$/.test(claims.client_id)) return undefined
		return claims.client_id
	} catch {
		return undefined
	}
}

/** Check the active app's registration in the Codex account before showing its plan quota. */
export async function fetchOpenAIQuotaStatus(openaiToken: string, codexToken: string): Promise<QuotaStatus | null> {
	const appId = openaiAppId(openaiToken)
	if (!appId) return null
	try {
		const response = await fetch(APPS_URL, {
			headers: { Authorization: `Bearer ${codexToken}`, 'User-Agent': 'codex-cli' },
			signal: AbortSignal.timeout(10_000),
		})
		if (!response.ok) return null
		const data: unknown = await response.json()
		if (!isRecord(data) || !Array.isArray(data.items) ||
			data.items.filter((item: unknown) => isRecord(item) && item.id === appId).length !== 1) return null
		return fetchQuotaStatus([codexToken])
	} catch {
		return null
	}
}

export function readAccessTokens(provider: unknown, authFiles: readonly string[] = AUTH_FILES, allowCodexCli = true): string[] {
	if (provider !== 'openai' && provider !== 'openai-codex') return []
	const tokens: string[] = []
	try {
		const auth: unknown = JSON.parse(readFileSync(authFiles[0], 'utf8'))
		if (isRecord(auth)) {
			const credential = auth[provider]
			// The openai provider also supports API keys; only ChatGPT OAuth has a subscription quota.
			if (isRecord(credential) && (provider === 'openai-codex' || credential.type === 'oauth')) {
				tokens.push(...extractAccessTokens({ [provider]: credential }))
			}
		}
	} catch {
		// unreadable or unparseable pi auth file
	}
	if (provider === 'openai-codex' && allowCodexCli) {
		try {
			tokens.push(...extractAccessTokens(JSON.parse(readFileSync(authFiles[1], 'utf8'))))
		} catch {
			// unreadable or unparseable Codex CLI auth file
		}
	}
	return tokens
}

/** Resolve a fresh Pi OAuth token; never substitute an API key or proxy credential. */
export async function resolveOAuthTokens(
	provider: 'openai' | 'openai-codex',
	ctx: Pick<ExtensionContext, 'model' | 'modelRegistry'>,
	authFiles: readonly string[] = AUTH_FILES,
): Promise<string[]> {
	const stored = readAccessTokens(provider, authFiles, false)
	const model = ctx.model?.provider === provider ? ctx.model
		: ctx.modelRegistry.getAll().find((candidate) => candidate.provider === provider)
	if (!stored.length || !model || !ctx.modelRegistry.isUsingOAuth(model)) return []
	try {
		const result = await ctx.modelRegistry.getProviderAuth(provider)
		if (result?.auth.baseUrl) return [] // never send a proxy credential to ChatGPT
		const authorization = result?.auth.headers?.Authorization ?? result?.auth.headers?.authorization
		const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
			? authorization.slice(7) : result?.auth.apiKey
		return token ? [token] : []
	} catch {
		return []
	}
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

/** Right-aligns text next to stats. Retained for compatibility with existing consumers. */
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

export default function codexUsage(pi: ExtensionAPI, options: { authFiles?: readonly string[] } = {}) {
	const authFiles = options.authFiles ?? AUTH_FILES
	let resolveTokens: (provider: 'openai' | 'openai-codex') => Promise<string[]> =
		async (provider) => readAccessTokens(provider, authFiles, provider !== 'openai-codex')
	let quota: QuotaStatus | null = null
	let currentModel: { provider?: unknown } | undefined
	let countdownTimer: ReturnType<typeof setInterval> | undefined
	let quotaTimer: ReturnType<typeof setInterval> | undefined
	let settledTimer: ReturnType<typeof setTimeout> | undefined
	let updateStatus = () => {}
	let generation = 0
	let quotaInFlight = false

	const stopTimers = () => {
		if (countdownTimer) clearInterval(countdownTimer)
		if (quotaTimer) clearInterval(quotaTimer)
		if (settledTimer) clearTimeout(settledTimer)
		countdownTimer = undefined
		quotaTimer = undefined
		settledTimer = undefined
	}

	const refreshQuota = async (): Promise<void> => {
		if (quotaInFlight) return
		quotaInFlight = true
		const requestGeneration = generation
		try {
			const provider = currentModel?.provider
			const tokens = provider === 'openai' || provider === 'openai-codex'
				? await resolveTokens(provider) : []
			// Sign in with ChatGPT's openai token is for api.openai.com, not wham/usage.
			// The companion Codex token can read plan usage only after its account's
			// app registration is matched to the active openai OAuth client ID.
			const codexToken = provider === 'openai' ? (await resolveTokens('openai-codex'))[0] : undefined
			const nextQuota = provider === 'openai'
				? tokens[0] && codexToken ? await fetchOpenAIQuotaStatus(tokens[0], codexToken) : null
				: tokens.length ? await fetchQuotaStatus(tokens) : null
			if (requestGeneration !== generation) return
			quota = nextQuota
			updateStatus()
		} finally {
			quotaInFlight = false
			if (requestGeneration !== generation && currentModel?.provider !== undefined) void refreshQuota()
		}
	}

	pi.on('session_start', (_event, ctx) => {
		stopTimers()
		generation++
		quota = null
		currentModel = ctx.model
		resolveTokens = async (provider) => {
			// Test fixtures supply their own auth files; production uses pi's resolver
			// to refresh an idle companion Codex credential before it expires.
			if (options.authFiles) return readAccessTokens(provider, authFiles, currentModel?.provider === 'openai-codex')
			const piTokens = await resolveOAuthTokens(provider, ctx, authFiles)
			if (provider !== 'openai-codex' || currentModel?.provider !== 'openai-codex') return piTokens
			// Preserve the Codex CLI fallback for legacy sessions only. Never use
			// an unrelated CLI account as the companion for an openai session.
			const storedPiTokens = readAccessTokens('openai-codex', authFiles, false)
			const cliTokens = readAccessTokens('openai-codex', authFiles).slice(storedPiTokens.length)
			return [...piTokens, ...cliTokens]
		}

		if (ctx.mode !== 'tui') return

		updateStatus = () => {
			if (currentModel?.provider !== 'openai-codex' &&
				(currentModel?.provider !== 'openai' || readAccessTokens('openai', authFiles).length === 0)) {
				ctx.ui.setStatus(CODEX_USAGE_STATUS_KEY, undefined)
				return
			}
			const text = formatQuotaStatus(quota)
			const lowestRemaining = quota
				? Math.min(quota.remainingPercent, quota.weeklyRemainingPercent ?? 100)
				: undefined
			ctx.ui.setStatus(
				CODEX_USAGE_STATUS_KEY,
				lowestRemaining === 0
					? ctx.ui.theme.fg('error', text)
					: lowestRemaining !== undefined && lowestRemaining <= 25
						? ctx.ui.theme.fg('warning', text)
						: quota
							? ctx.ui.theme.fg('accent', text)
							: ctx.ui.theme.fg('dim', text),
			)
		}

		updateStatus()
		countdownTimer = setInterval(updateStatus, MINUTE_MS)
		countdownTimer.unref?.()
		quotaTimer = setInterval(() => void refreshQuota(), QUOTA_REFRESH_MS)
		quotaTimer.unref?.()
		void refreshQuota()
	})

	pi.on('model_select', (event, ctx) => {
		const previousProvider = currentModel?.provider
		currentModel = event.model
		if (previousProvider !== currentModel?.provider) {
			generation++
			quota = null
			if (ctx.mode === 'tui' &&
				(currentModel?.provider === 'openai-codex' || currentModel?.provider === 'openai')) void refreshQuota()
		}
		updateStatus()
	})

	pi.on('agent_settled', () => {
		if (settledTimer) clearTimeout(settledTimer)
		settledTimer = setTimeout(() => void refreshQuota(), 30_000)
		settledTimer.unref?.()
	})

	pi.on('session_shutdown', (_event, ctx) => {
		generation++
		stopTimers()
		updateStatus = () => {}
		resolveTokens = async (provider) => readAccessTokens(provider, authFiles, provider !== 'openai-codex')
		currentModel = undefined
		if (ctx.mode === 'tui') ctx.ui.setStatus(CODEX_USAGE_STATUS_KEY, undefined)
	})
}
