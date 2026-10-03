import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import codexUsage, {
	extractAccessTokens,
	fetchOpenAIQuotaStatus,
	fetchQuotaStatus,
	formatCwdForFooter,
	formatDuration,
	formatQuotaStatus,
	formatTokens,
	layoutStatsLine,
	parseQuotaStatus,
	readAccessTokens,
	resolveOAuthTokens,
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
			secondary_window: {
				used_percent: 25,
				reset_at: nowSec + 500_000,
			},
		},
	}

	assert.deepEqual(parseQuotaStatus(payload, nowSec), {
		remainingPercent: 63,
		resetsAt: nowSec + 43_200,
		weeklyRemainingPercent: 75,
		weeklyResetsAt: nowSec + 500_000,
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
		weeklyRemainingPercent: null,
		weeklyResetsAt: null,
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

test('formats five-hour and weekly quota for shared footer status', () => {
	assert.equal(formatQuotaStatus(null), '5h - –, 7d - –')
	assert.equal(
		formatQuotaStatus({
			remainingPercent: 15,
			resetsAt: null,
			weeklyRemainingPercent: 75,
			weeklyResetsAt: null,
		}),
		'5h - 15%, 7d - 75%',
	)
	assert.equal(
		formatQuotaStatus({
			remainingPercent: 25,
			resetsAt: 1_000 + 2_874,
			weeklyRemainingPercent: 75,
			weeklyResetsAt: null,
		}, 1_000),
		'5h - 25%, 7d - 75% · resets in 48m',
	)
})

test('extracts access tokens from pi and Codex CLI auth shapes', () => {
	assert.deepEqual(extractAccessTokens({ tokens: { access_token: 'codex-token' } }), ['codex-token'])
	assert.deepEqual(extractAccessTokens({ 'openai-codex': { access: 'pi-token' } }), ['pi-token'])
	assert.deepEqual(extractAccessTokens({ openai: { type: 'oauth', access: 'new-token' } }), ['new-token'])
	assert.deepEqual(
		extractAccessTokens({ tokens: { access_token: 'codex-token' }, 'openai-codex': { access: 'pi-token' } }),
		['codex-token', 'pi-token'],
	)
	assert.deepEqual(extractAccessTokens({ OPENAI_API_KEY: 'sk-123' }), [])
	assert.deepEqual(extractAccessTokens(null), [])
	assert.deepEqual(extractAccessTokens('junk'), [])
})

test('reads OAuth for the selected provider, without using API keys or another provider\'s token', async (t) => {
	const dir = await mkdtemp(join(tmpdir(), 'codex-usage-'))
	t.after(() => rm(dir, { recursive: true, force: true }))
	const files = [join(dir, 'pi.json'), join(dir, 'cli.json')]
	await writeFile(files[0], JSON.stringify({
		openai: { type: 'oauth', access: 'new-token' },
		'openai-codex': { type: 'oauth', access: 'old-token' },
	}))
	await writeFile(files[1], JSON.stringify({ tokens: { access_token: 'cli-token' } }))
	assert.deepEqual(readAccessTokens('openai', files), ['new-token'])
	assert.deepEqual(readAccessTokens('openai-codex', files), ['old-token', 'cli-token'])
	assert.deepEqual(readAccessTokens('deepseek', files), [])
	await writeFile(files[0], JSON.stringify({ openai: { type: 'api_key', key: 'sk-secret' } }))
	assert.deepEqual(readAccessTokens('openai', files), [])
	assert.deepEqual(readAccessTokens('openai-codex', files), ['cli-token'])
})

test('resolves a fresh companion Pi OAuth credential, never a CLI or proxy token', async (t) => {
	const dir = await mkdtemp(join(tmpdir(), 'codex-usage-'))
	t.after(() => rm(dir, { recursive: true, force: true }))
	const files = [join(dir, 'pi.json'), join(dir, 'cli.json')]
	await writeFile(files[0], JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'stale-token' } }))
	await writeFile(files[1], JSON.stringify({ tokens: { access_token: 'cli-token' } }))
	let auth: any = { auth: { apiKey: 'fresh-token' } }
	const ctx: any = {
		model: { provider: 'openai' },
		modelRegistry: {
			getAll: () => [{ provider: 'openai-codex' }],
			isUsingOAuth: () => true,
			getProviderAuth: async () => auth,
		},
	}
	assert.deepEqual(await resolveOAuthTokens('openai-codex', ctx, files), ['fresh-token'])
	auth = { auth: { apiKey: 'fresh-token', baseUrl: 'https://proxy.example' } }
	assert.deepEqual(await resolveOAuthTokens('openai-codex', ctx, files), [])
	ctx.modelRegistry.isUsingOAuth = () => false
	auth = { auth: { apiKey: 'api-key' } }
	assert.deepEqual(await resolveOAuthTokens('openai-codex', ctx, files), [])
	await writeFile(files[0], '{}')
	ctx.modelRegistry.isUsingOAuth = () => true
	assert.deepEqual(await resolveOAuthTokens('openai-codex', ctx, files), [])
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
				secondary_window: { used_percent: 25, reset_at: nowSec + 500_000 },
			},
		}),
	})) as unknown as typeof fetch

	try {
		const status = await fetchQuotaStatus(['test-token'])
		assert.ok(status)
		assert.equal(status.remainingPercent, 0)
		assert.equal(status.resetsAt, nowSec + 2_874)
		assert.equal(status.weeklyRemainingPercent, 75)
		assert.equal(status.weeklyResetsAt, nowSec + 500_000)
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

function openaiTestToken(clientId = 'oaiapp_test'): string {
	return `header.${Buffer.from(JSON.stringify({
		iss: 'https://auth.openai.com', aud: 'https://api.openai.com/v1',
		scope: 'chatgpt.tokens.use.direct', client_id: clientId,
	})).toString('base64url')}.signature`
}

test('requires a matching app registration before reading OpenAI plan usage', async () => {
	const realFetch = globalThis.fetch
	const urls: string[] = []
	let apps: unknown = { items: [{ id: 'oaiapp_other' }] }
	globalThis.fetch = (async (url: string) => {
		urls.push(url)
		return { ok: true, json: async () => url.endsWith('/chatpass/apps') ? apps : {
			rate_limit: { primary_window: { used_percent: 15 } },
		} }
	}) as unknown as typeof fetch
	try {
		assert.equal(await fetchOpenAIQuotaStatus('opaque-token', 'codex-token'), null)
		assert.deepEqual(urls, [])
		assert.equal(await fetchOpenAIQuotaStatus(openaiTestToken(), 'codex-token'), null)
		assert.equal(urls.length, 1)
		apps = { items: [{ id: 'oaiapp_test' }, { id: 'oaiapp_test' }] }
		assert.equal(await fetchOpenAIQuotaStatus(openaiTestToken(), 'codex-token'), null)
		assert.equal(urls.length, 2)
		apps = { items: [{ id: 'oaiapp_test' }] }
		assert.equal((await fetchOpenAIQuotaStatus(openaiTestToken(), 'codex-token'))?.remainingPercent, 85)
		assert.deepEqual(urls.slice(2), [
			'https://chatgpt.com/backend-api/wham/usage/chatpass/apps',
			'https://chatgpt.com/backend-api/wham/usage',
		])
	} finally {
		globalThis.fetch = realFetch
	}
})

test('publishes quota as a shared status without replacing the footer', async () => {
	const handlers = new Map<string, (event: unknown, ctx: any) => unknown>()
	const statuses = new Map<string, string>()
	let footerCalls = 0

	const realFetch = globalThis.fetch
	const nowSec = Math.floor(Date.now() / 1000)
	globalThis.fetch = (async (url: string) => ({
		ok: true,
		json: async () => url.endsWith('/chatpass/apps') ? { items: [{ id: 'oaiapp_test' }] } : ({
			rate_limit: {
				limit_reached: true,
				primary_window: { used_percent: 100, reset_at: nowSec + 2_874 },
				secondary_window: { used_percent: 25, reset_at: nowSec + 500_000 },
			},
		}),
	})) as unknown as typeof fetch

	const dir = await mkdtemp(join(tmpdir(), 'codex-usage-'))
	const authFiles = [join(dir, 'pi.json'), join(dir, 'cli.json')]
	await writeFile(authFiles[0], JSON.stringify({
		openai: { type: 'oauth', access: openaiTestToken() },
		'openai-codex': { type: 'oauth', access: 'old-token' },
	}))
	codexUsage({
		on(event: string, handler: (event: unknown, ctx: any) => unknown) {
			handlers.set(event, handler)
		},
	} as any, { authFiles })

	const ctx = {
		mode: 'tui',
		model: { id: 'gpt-test', provider: 'openai-codex' },
		ui: {
			theme: { fg(_color: string, text: string) { return text } },
			setStatus(key: string, text: string | undefined) {
				if (text === undefined) statuses.delete(key)
				else statuses.set(key, text)
			},
			setFooter() { footerCalls++ },
		},
	}

	try {
		handlers.get('session_start')?.({}, ctx)
		await new Promise((resolve) => setTimeout(resolve, 20))
		assert.equal(statuses.get('codex-usage'), '5h - 0%, 7d - 75% · resets in 48m')
		assert.equal(footerCalls, 0)

		handlers.get('model_select')?.({ model: { provider: 'openai', api: 'openai-responses' } }, ctx)
		await new Promise((resolve) => setTimeout(resolve, 20))
		assert.equal(statuses.get('codex-usage'), '5h - 0%, 7d - 75% · resets in 48m')

		await writeFile(authFiles[0], JSON.stringify({ openai: { type: 'api_key', key: 'sk-secret' } }))
		handlers.get('model_select')?.({ model: { provider: 'deepseek' } }, ctx)
		handlers.get('model_select')?.({ model: { provider: 'openai', api: 'openai-responses' } }, ctx)
		assert.equal(statuses.has('codex-usage'), false)

		handlers.get('model_select')?.({ model: { provider: 'deepseek' } }, ctx)
		assert.equal(statuses.has('codex-usage'), false)
	} finally {
		globalThis.fetch = realFetch
		handlers.get('session_shutdown')?.({}, ctx)
		await rm(dir, { recursive: true, force: true })
	}

	assert.equal(statuses.has('codex-usage'), false)
})
