import assert from 'node:assert/strict'
import test from 'node:test'
import codexUsage, {
	extractAccessTokens,
	fetchQuotaStatus,
	formatCwdForFooter,
	formatDuration,
	formatTokens,
	layoutStatsLine,
	parseQuotaStatus,
} from '../index.ts'

test('formats token counts like pi\'s default footer', () => {
	assert.equal(formatTokens(0), '0')
	assert.equal(formatTokens(900), '900')
	assert.equal(formatTokens(1_234), '1.2k')
	assert.equal(formatTokens(12_345), '12k')
	assert.equal(formatTokens(123_456), '123k')
	assert.equal(formatTokens(1_234_567), '1.2M')
	assert.equal(formatTokens(45_243_010), '45M')
	assert.equal(formatTokens(1_234_567_890), '1235M')
})

test('replaces the home directory with a tilde', () => {
	const home = '/Users/me'
	assert.equal(formatCwdForFooter('/Users/me', home), '~')
	assert.equal(formatCwdForFooter('/Users/me/projects/foo', home), '~/projects/foo')
	assert.equal(formatCwdForFooter('/Users/me2/other', home), '/Users/me2/other')
	assert.equal(formatCwdForFooter('/opt/elsewhere', home), '/opt/elsewhere')
	assert.equal(formatCwdForFooter('/opt/x', undefined), '/opt/x')
})

test('parses remaining quota from the usage payload', () => {
	const nowSec = 1_786_000_000
	const payload = {
		plan_type: 'plus',
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: {
				used_percent: 37,
				limit_window_seconds: 604_800,
				reset_after_seconds: 43_200,
				reset_at: nowSec + 43_200,
			},
			secondary_window: null,
		},
	}

	assert.deepEqual(parseQuotaStatus(payload, nowSec), {
		remainingPercent: 63,
		resetsAt: nowSec + 43_200,
	})
})

test('reports zero remaining when the limit is reached', () => {
	const nowSec = 1_786_000_000
	const payload = {
		rate_limit: {
			allowed: false,
			limit_reached: true,
			primary_window: { used_percent: 100, reset_at: nowSec + 2_874 },
		},
	}

	assert.deepEqual(parseQuotaStatus(payload, nowSec), {
		remainingPercent: 0,
		resetsAt: nowSec + 2_874,
	})
})

test('clamps percentages and ignores past resets', () => {
	const nowSec = 1_786_000_000
	assert.equal(parseQuotaStatus({ rate_limit: { primary_window: { used_percent: -10 } } }, nowSec)?.remainingPercent, 100)
	assert.equal(parseQuotaStatus({ rate_limit: { primary_window: { used_percent: 150 } } }, nowSec)?.remainingPercent, 0)
	assert.equal(
		parseQuotaStatus({ rate_limit: { primary_window: { used_percent: 10, reset_at: nowSec - 60 } } }, nowSec)?.resetsAt,
		null,
	)
})

test('returns null when quota data is missing', () => {
	const nowSec = 1_786_000_000
	assert.equal(parseQuotaStatus(null, nowSec), null)
	assert.equal(parseQuotaStatus({}, nowSec), null)
	assert.equal(parseQuotaStatus({ rate_limit: null }, nowSec), null)
	assert.equal(parseQuotaStatus('junk', nowSec), null)
})

test('formats countdown durations', () => {
	assert.equal(formatDuration(45), '45s')
	assert.equal(formatDuration(2_874), '48m')
	assert.equal(formatDuration(3_600), '1h')
	assert.equal(formatDuration(11_520), '3h 12m')
	assert.equal(formatDuration(200_000), '2d')
})

test('extracts access tokens from pi and Codex CLI auth shapes', () => {
	assert.deepEqual(extractAccessTokens({ tokens: { access_token: 'codex-token' } }), ['codex-token'])
	assert.deepEqual(extractAccessTokens({ 'openai-codex': { access: 'pi-token' } }), ['pi-token'])
	assert.deepEqual(
		extractAccessTokens({ tokens: { access_token: 'codex-token' }, 'openai-codex': { access: 'pi-token' } }),
		['codex-token', 'pi-token'],
	)
	assert.deepEqual(extractAccessTokens({ OPENAI_API_KEY: 'sk-123' }), [])
	assert.deepEqual(extractAccessTokens(null), [])
	assert.deepEqual(extractAccessTokens('junk'), [])
})

test('fetches quota status from the usage endpoint', async () => {
	const realFetch = globalThis.fetch
	const nowSec = Math.floor(Date.now() / 1000)
	globalThis.fetch = (async () => ({
		ok: true,
		json: async () => ({
			rate_limit: {
				limit_reached: true,
				primary_window: { used_percent: 100, reset_at: nowSec + 2_874 },
			},
		}),
	})) as unknown as typeof fetch

	try {
		const status = await fetchQuotaStatus(['test-token'])
		assert.ok(status)
		assert.equal(status.remainingPercent, 0)
		assert.equal(status.resetsAt, nowSec + 2_874)
	} finally {
		globalThis.fetch = realFetch
	}
})

test('returns null when every token source fails', async () => {
	const realFetch = globalThis.fetch
	globalThis.fetch = (async () => ({ ok: false })) as unknown as typeof fetch

	try {
		assert.equal(await fetchQuotaStatus([]), null)
		assert.equal(await fetchQuotaStatus(['expired-token']), null)
	} finally {
		globalThis.fetch = realFetch
	}
})

test('right-aligns the model name next to the stats', () => {
	assert.equal(layoutStatsLine('a', 'b', 5), 'a   b')
	assert.equal(layoutStatsLine('a', 'bbbb', 4).replace(/\x1b\[0m/g, ''), 'a  b')
	assert.equal(layoutStatsLine('aaa', 'b', 3), 'aaa')
})

test('renders the full footer with remaining quota', async () => {
	const handlers = new Map<string, (event: unknown, ctx: any) => unknown>()
	let component: { render(width: number): string[] } | undefined
	let restoredBuiltInFooter = false

	const realFetch = globalThis.fetch
	const nowSec = Math.floor(Date.now() / 1000)
	globalThis.fetch = (async () => ({
		ok: true,
		json: async () => ({
			rate_limit: {
				limit_reached: true,
				primary_window: { used_percent: 100, reset_at: nowSec + 2_874 },
			},
		}),
	})) as unknown as typeof fetch

	codexUsage({
		on(event: string, handler: (event: unknown, ctx: any) => unknown) {
			handlers.set(event, handler)
		},
	} as any)

	const ctx = {
		mode: 'tui',
		cwd: '/repo',
		model: { id: 'gpt-test', provider: 'openai-codex', reasoning: false, contextWindow: 128_000 },
		thinkingLevel: 'high',
		modelRegistry: {
			getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
			isUsingOAuth: () => true,
		},
		getContextUsage: () => ({ tokens: 16_000, contextWindow: 128_000, percent: 12.5 }),
		sessionManager: {
			getCwd: () => '/repo',
			getSessionName: () => undefined,
			getEntries: () => [
				{
					type: 'message',
					message: {
						role: 'assistant',
						usage: { input: 1_200, output: 34, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
			],
		},
		ui: {
			setFooter(factory: any) {
				if (factory === undefined) {
					restoredBuiltInFooter = true
					return
				}
				component = factory(
					{ requestRender() {} },
					{ fg(_color: string, text: string) { return text; } },
					{
						getGitBranch: () => null,
						getExtensionStatuses: () => new Map([['codex-custom-footer', '⚡ Codex fast']]),
						getAvailableProviderCount: () => 1,
						onBranchChange: () => () => {},
					},
				)
			},
		},
	}

	handlers.get('session_start')?.({}, ctx)
	await new Promise((resolve) => setTimeout(resolve, 20))

	const lines = component?.render(140)
	assert.equal(lines?.length, 2)
	// pwd line, exactly like the default footer
	assert.equal(lines?.[0], '/repo')
	// stats line: default content preserved...
	assert.ok(lines?.[1].startsWith('↑1.2k ↓34 $0.010 (sub) 12.5%/128k'))
	// ...with fast mode and the quota on the same line, model right-aligned
	assert.ok(lines?.[1].includes('⚡ Codex fast · codex 0% left · resets in 48m'))
	assert.ok(lines?.[1].endsWith('gpt-test'))

	globalThis.fetch = realFetch
	handlers.get('session_shutdown')?.({}, ctx)
	assert.equal(restoredBuiltInFooter, true)
})

test('hides quota and fast mode when the model is not openai-codex', async () => {
	const handlers = new Map<string, (event: unknown, ctx: any) => unknown>()
	let component: { render(width: number): string[] } | undefined

	codexUsage({
		on(event: string, handler: (event: unknown, ctx: any) => unknown) {
			handlers.set(event, handler)
		},
	} as any)

	const ctx = {
		mode: 'tui',
		cwd: '/repo',
		model: { id: 'deepseek-v4-flash', provider: 'deepseek', reasoning: false, contextWindow: 128_000 },
		thinkingLevel: 'high',
		modelRegistry: {
			getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
			isUsingOAuth: () => true,
		},
		getContextUsage: () => ({ tokens: 16_000, contextWindow: 128_000, percent: 12.5 }),
		sessionManager: {
			getCwd: () => '/repo',
			getSessionName: () => undefined,
			getEntries: () => [],
		},
		ui: {
			setFooter(factory: any) {
				if (factory === undefined) return
				component = factory(
					{ requestRender() {} },
					{ fg(_color: string, text: string) { return text; } },
					{
						getGitBranch: () => null,
						getExtensionStatuses: () =>
							new Map([
								['codex-custom-footer', '⚡ Codex fast'],
								['my-other-ext', 'some status'],
							]),
						getAvailableProviderCount: () => 1,
						onBranchChange: () => () => {},
					},
				)
			},
		},
	}

	handlers.get('session_start')?.({}, ctx)
	const lines = component?.render(140)
	assert.equal(lines?.length, 3)
	assert.ok(!lines?.[1].includes('codex'))
	assert.ok(!lines?.[1].includes('⚡'))
	// fast mode stays on the statuses line, other statuses too
	assert.equal(lines?.[2], '⚡ Codex fast some status')

	handlers.get('session_shutdown')?.({}, ctx)
})
