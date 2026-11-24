import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
const AUTH_FILES = [
	join(HOME, '.pi', 'agent', 'auth.json'),
	join(HOME, '.codex', 'auth.json'),
]
const CODEX_QUOTA_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CODEX_APPS_URL = `${CODEX_QUOTA_URL}/chatpass/apps`
const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
/** Quota status consumed by pi's default footer and custom footers that render extension statuses. */
export const SUBSCRIPTION_USAGE_STATUS_KEY = 'subscription-usage'
const MINUTE_MS = 60 * 1000
const QUOTA_REFRESH_MS = 5 * MINUTE_MS
/** Columns left for other extension statuses, which share the footer line with this one. */
const STATUS_RESERVED_COLUMNS = 30
const RESIZE_DEBOUNCE_MS = 50

/** Width available to this status, or unlimited when the terminal size is unknown. */
function availableStatusWidth(columns: number | undefined = process.stdout.columns): number {
	return columns ? Math.max(0, columns - STATUS_RESERVED_COLUMNS) : Number.POSITIVE_INFINITY
}

export type OAuthProvider = 'openai' | 'openai-codex' | 'anthropic'

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

/** Extracts remaining quota and reset times from the Codex `wham/usage` payload. */
export function parseCodexQuotaStatus(data: unknown, nowSec: number): QuotaStatus | null {
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

/** Extracts remaining quota and reset times from Anthropic's `oauth/usage` payload. */
export function parseAnthropicQuotaStatus(data: unknown, nowSec: number): QuotaStatus | null {
	if (!isRecord(data)) return null

	const parseWindow = (value: unknown): { remainingPercent: number; resetsAt: number | null } | null => {
		if (!isRecord(value) || typeof value.utilization !== 'number') return null
		const remainingPercent = Math.round(Math.max(0, Math.min(100, 100 - value.utilization)))
		const reset = typeof value.resets_at === 'string' ? Date.parse(value.resets_at) / 1000 : NaN
		return { remainingPercent, resetsAt: Number.isFinite(reset) && reset > nowSec ? reset : null }
	}

	const primary = parseWindow(data.five_hour)
	const weekly = parseWindow(data.seven_day)
	if (!primary && !weekly) return null
	return {
		remainingPercent: primary?.remainingPercent ?? 100,
		resetsAt: primary?.resetsAt ?? null,
		weeklyRemainingPercent: weekly?.remainingPercent ?? null,
		weeklyResetsAt: weekly?.resetsAt ?? null,
	}
}

/** Formats a duration in seconds as a compact countdown (e.g. "48m", "1h2m", "3d5h"). */
export function formatDuration(seconds: number): string {
	if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`
	const totalMinutes = Math.round(seconds / 60)
	const days = Math.floor(totalMinutes / 1440)
	const hours = Math.floor((totalMinutes % 1440) / 60)
	const minutes = totalMinutes % 60
	if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`
	if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`
	return `${minutes}m`
}

/**
 * Formats quota like `5h - 69% (r in 1h2m), 7d - 30% (r in 3d5h)`. Reset times are shown
 * when known and when they fit in `maxWidth`, dropping the weekly reset first, then the 5h one.
 */
export function formatQuotaStatus(
	status: QuotaStatus | null,
	nowSec = Date.now() / 1000,
	maxWidth = Number.POSITIVE_INFINITY,
): string {
	if (!status) return '5h - –, 7d - –'
	const reset = (resetsAt: number | null, show: boolean) =>
		show && resetsAt !== null ? ` (r in ${formatDuration(Math.max(0, resetsAt - nowSec))})` : ''
	const build = (showPrimary: boolean, showWeekly: boolean) => {
		let text = `5h - ${status.remainingPercent}%${reset(status.resetsAt, showPrimary)}`
		if (status.weeklyRemainingPercent !== null) {
			text += `, 7d - ${status.weeklyRemainingPercent}%${reset(status.weeklyResetsAt, showWeekly)}`
		}
		return text
	}
	for (const [primary, weekly] of [[true, true], [true, false]] as const) {
		const text = build(primary, weekly)
		if (text.length <= maxWidth) return text
	}
	return build(false, false)
}

/** Which subscription a model's provider maps to, if any. */
export function subscriptionFor(provider: unknown): 'codex' | 'anthropic' | undefined {
	if (provider === 'openai' || provider === 'openai-codex') return 'codex'
	if (provider === 'anthropic') return 'anthropic'
	return undefined
}

/** Pulls ChatGPT OAuth access tokens from pi's or the Codex CLI's auth file. */
export function extractAccessTokens(auth: unknown): string[] {
	const tokens: string[] = []
	if (!isRecord(auth)) return tokens
	if (isRecord(auth.tokens) && typeof auth.tokens.access_token === 'string') {
		tokens.push(auth.tokens.access_token)
	}
	for (const provider of ['openai-codex', 'openai', 'anthropic']) {
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
		const response = await fetch(CODEX_APPS_URL, {
			headers: { Authorization: `Bearer ${codexToken}`, 'User-Agent': 'codex-cli' },
			signal: AbortSignal.timeout(10_000),
		})
		if (!response.ok) return null
		const data: unknown = await response.json()
		if (!isRecord(data) || !Array.isArray(data.items) ||
			data.items.filter((item: unknown) => isRecord(item) && item.id === appId).length !== 1) return null
		return fetchCodexQuotaStatus([codexToken])
	} catch {
		return null
	}
}

export function readAccessTokens(provider: unknown, authFiles: readonly string[] = AUTH_FILES, allowCodexCli = true): string[] {
	if (provider !== 'openai' && provider !== 'openai-codex' && provider !== 'anthropic') return []
	const tokens: string[] = []
	try {
		const auth: unknown = JSON.parse(readFileSync(authFiles[0], 'utf8'))
		if (isRecord(auth)) {
			const credential = auth[provider]
			// openai and anthropic also support API keys; only OAuth has a subscription quota.
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
	provider: OAuthProvider,
	ctx: Pick<ExtensionContext, 'model' | 'modelRegistry'>,
	authFiles: readonly string[] = AUTH_FILES,
): Promise<string[]> {
	const stored = readAccessTokens(provider, authFiles, false)
	const model = ctx.model?.provider === provider ? ctx.model
		: ctx.modelRegistry.getAll().find((candidate) => candidate.provider === provider)
	if (!stored.length || !model || !ctx.modelRegistry.isUsingOAuth(model)) return []
	try {
		const result = await ctx.modelRegistry.getProviderAuth(provider)
		if (result?.auth.baseUrl) return [] // never send a proxy credential to the vendor
		const authorization = result?.auth.headers?.Authorization ?? result?.auth.headers?.authorization
		const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
			? authorization.slice(7) : result?.auth.apiKey
		return token ? [token] : []
	} catch {
		return []
	}
}

/** Fetches the remaining Codex quota from OpenAI, trying each access token in order. */
export async function fetchCodexQuotaStatus(tokens: readonly string[]): Promise<QuotaStatus | null> {
	for (const token of tokens) {
		try {
			const response = await fetch(CODEX_QUOTA_URL, {
				headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'codex-cli' },
				signal: AbortSignal.timeout(10_000),
			})
			if (!response.ok) continue
			const status = parseCodexQuotaStatus((await response.json()) as unknown, Date.now() / 1000)
			if (status) return status
		} catch {
			// network error — try the next token source
		}
	}
	return null
}

/** Fetches the remaining Claude subscription quota from Anthropic. */
export async function fetchAnthropicQuotaStatus(tokens: readonly string[]): Promise<QuotaStatus | null> {
	for (const token of tokens) {
		try {
			const response = await fetch(ANTHROPIC_USAGE_URL, {
				headers: {
					Authorization: `Bearer ${token}`,
					'anthropic-beta': 'oauth-2025-04-20',
					'User-Agent': 'claude-code',
				},
				signal: AbortSignal.timeout(10_000),
			})
			if (!response.ok) continue
			const status = parseAnthropicQuotaStatus((await response.json()) as unknown, Date.now() / 1000)
			if (status) return status
		} catch {
			// network error — try the next token source
		}
	}
	return null
}

export default function subscriptionUsage(pi: ExtensionAPI, options: { authFiles?: readonly string[] } = {}) {
	const authFiles = options.authFiles ?? AUTH_FILES
	const defaultResolve = async (provider: OAuthProvider) =>
		readAccessTokens(provider, authFiles, provider !== 'openai-codex')
	let resolveTokens: (provider: OAuthProvider) => Promise<string[]> = defaultResolve
	let quota: QuotaStatus | null = null
	let currentModel: { provider?: unknown } | undefined
	let countdownTimer: ReturnType<typeof setInterval> | undefined
	let quotaTimer: ReturnType<typeof setInterval> | undefined
	let settledTimer: ReturnType<typeof setTimeout> | undefined
	let updateStatus = () => {}
	let generation = 0
	let resizeTimer: ReturnType<typeof setTimeout> | undefined
	// Redraw from cached quota only (never refetch), coalescing the burst of events while dragging.
	const onResize = () => {
		if (resizeTimer) clearTimeout(resizeTimer)
		resizeTimer = setTimeout(() => updateStatus(), RESIZE_DEBOUNCE_MS)
		resizeTimer.unref?.()
	}
	let quotaInFlight = false

	const stopTimers = () => {
		if (countdownTimer) clearInterval(countdownTimer)
		if (quotaTimer) clearInterval(quotaTimer)
		if (settledTimer) clearTimeout(settledTimer)
		if (resizeTimer) clearTimeout(resizeTimer)
		countdownTimer = quotaTimer = settledTimer = resizeTimer = undefined
	}

	const fetchForCurrentModel = async (): Promise<QuotaStatus | null> => {
		const provider = currentModel?.provider
		switch (subscriptionFor(provider)) {
			case 'anthropic': {
				const tokens = await resolveTokens('anthropic')
				return tokens.length ? fetchAnthropicQuotaStatus(tokens) : null
			}
			case 'codex': {
				const tokens = await resolveTokens(provider as OAuthProvider)
				// Sign in with ChatGPT's openai token is for api.openai.com, not wham/usage.
				// The companion Codex token can read plan usage only after its account's
				// app registration is matched to the active openai OAuth client ID.
				if (provider === 'openai') {
					const codexToken = (await resolveTokens('openai-codex'))[0]
					return tokens[0] && codexToken ? fetchOpenAIQuotaStatus(tokens[0], codexToken) : null
				}
				return tokens.length ? fetchCodexQuotaStatus(tokens) : null
			}
			default:
				return null
		}
	}

	const refreshQuota = async (): Promise<void> => {
		if (quotaInFlight) return
		quotaInFlight = true
		const requestGeneration = generation
		try {
			const nextQuota = await fetchForCurrentModel()
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
			// to refresh an idle credential before it expires.
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
			const subscription = subscriptionFor(currentModel?.provider)
			// Hidden for other providers and for API-key-only openai/anthropic sessions.
			if (!subscription || (currentModel?.provider !== 'openai-codex' &&
				readAccessTokens(currentModel?.provider, authFiles).length === 0)) {
				ctx.ui.setStatus(SUBSCRIPTION_USAGE_STATUS_KEY, undefined)
				return
			}
			const text = formatQuotaStatus(quota, Date.now() / 1000, availableStatusWidth())
			const lowestRemaining = quota
				? Math.min(quota.remainingPercent, quota.weeklyRemainingPercent ?? 100)
				: undefined
			ctx.ui.setStatus(
				SUBSCRIPTION_USAGE_STATUS_KEY,
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
		process.stdout.off('resize', onResize)
		process.stdout.on('resize', onResize)
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
			if (ctx.mode === 'tui' && subscriptionFor(currentModel?.provider)) void refreshQuota()
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
		process.stdout.off('resize', onResize)
		updateStatus = () => {}
		resolveTokens = defaultResolve
		currentModel = undefined
		if (ctx.mode === 'tui') ctx.ui.setStatus(SUBSCRIPTION_USAGE_STATUS_KEY, undefined)
	})
}
