import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import subscriptionUsage, {
	fetchAnthropicQuotaStatus,
	formatDuration,
	formatQuotaStatus,
	parseAnthropicQuotaStatus,
	parseCodexQuotaStatus,
	readAccessTokens,
	subscriptionFor,
} from '../index.ts'

test('maps providers to subscriptions', () => {
	assert.equal(subscriptionFor('anthropic'), 'anthropic')
	assert.equal(subscriptionFor('openai'), 'codex')
	assert.equal(subscriptionFor('openai-codex'), 'codex')
	assert.equal(subscriptionFor('deepseek'), undefined)
	assert.equal(subscriptionFor(undefined), undefined)
})

test('parses Codex quota', () => {
	const now = 1_000
	assert.deepEqual(
		parseCodexQuotaStatus({
			rate_limit: {
				primary_window: { used_percent: 40, reset_at: now + 600 },
				secondary_window: { used_percent: 25, reset_at: now + 5_000 },
			},
		}, now),
		{ remainingPercent: 60, resetsAt: now + 600, weeklyRemainingPercent: 75, weeklyResetsAt: now + 5_000 },
	)
	assert.equal(parseCodexQuotaStatus({}, now), null)
	assert.equal(parseCodexQuotaStatus({ rate_limit: { limit_reached: true } }, now)?.remainingPercent, 0)
})

test('parses Anthropic quota', () => {
	const now = Date.parse('2025-01-01T00:00:00Z') / 1000
	assert.deepEqual(
		parseAnthropicQuotaStatus({
			five_hour: { utilization: 85.4, resets_at: '2025-01-01T00:30:00Z' },
			seven_day: { utilization: 20, resets_at: '2024-12-31T00:00:00Z' },
		}, now),
		{ remainingPercent: 15, resetsAt: now + 1_800, weeklyRemainingPercent: 80, weeklyResetsAt: null },
	)
	assert.equal(parseAnthropicQuotaStatus({ five_hour: { utilization: 150 } }, now)?.remainingPercent, 0)
	assert.equal(parseAnthropicQuotaStatus({ five_hour: null, seven_day: null }, now), null)
	assert.equal(parseAnthropicQuotaStatus(null, now), null)
})

test('formats durations and status', () => {
	assert.equal(formatDuration(2_874), '48m')
	assert.equal(formatDuration(11_520), '3h12m')
	assert.equal(formatDuration(3_720), '1h2m')
	assert.equal(formatDuration(3_599), '1h')
	assert.equal(formatDuration(3 * 86_400 + 5 * 3_600), '3d5h')
	assert.equal(formatDuration(2 * 86_400), '2d')
	assert.equal(formatQuotaStatus(null), '5h - –, 7d - –')
	assert.equal(
		formatQuotaStatus({ remainingPercent: 10, resetsAt: 2_874, weeklyRemainingPercent: 75, weeklyResetsAt: null }, 0),
		'5h - 10% (r in 48m), 7d - 75%',
	)
	assert.equal(
		formatQuotaStatus({ remainingPercent: 69, resetsAt: 3_720, weeklyRemainingPercent: 30, weeklyResetsAt: 3 * 86_400 + 5 * 3_600 }, 0),
		'5h - 69% (r in 1h2m), 7d - 30% (r in 3d5h)',
	)
	const wide = { remainingPercent: 69, resetsAt: 3_720, weeklyRemainingPercent: 30, weeklyResetsAt: 3 * 86_400 + 5 * 3_600 }
	assert.equal(formatQuotaStatus(wide, 0, 42), '5h - 69% (r in 1h2m), 7d - 30% (r in 3d5h)')
	assert.equal(formatQuotaStatus(wide, 0, 41), '5h - 69% (r in 1h2m), 7d - 30%')
	assert.equal(formatQuotaStatus(wide, 0, 29), '5h - 69%, 7d - 30%')
})

test('reads only OAuth credentials for anthropic', async (t) => {
	const dir = await mkdtemp(join(tmpdir(), 'subscription-usage-'))
	t.after(() => rm(dir, { recursive: true, force: true }))
	const file = join(dir, 'auth.json')
	await writeFile(file, JSON.stringify({ anthropic: { type: 'oauth', access: 'sk-ant-oat' } }))
	assert.deepEqual(readAccessTokens('anthropic', [file]), ['sk-ant-oat'])
	await writeFile(file, JSON.stringify({ anthropic: { type: 'api_key', key: 'sk-ant-api' } }))
	assert.deepEqual(readAccessTokens('anthropic', [file]), [])
})

test('fetches Anthropic usage with the OAuth beta header', async () => {
	const realFetch = globalThis.fetch
	let seen: { url: string; headers: Record<string, string> } | undefined
	globalThis.fetch = (async (url: string, init: { headers: Record<string, string> }) => {
		seen = { url, headers: init.headers }
		return { ok: true, json: async () => ({ five_hour: { utilization: 30, resets_at: null } }) }
	}) as unknown as typeof fetch
	try {
		const status = await fetchAnthropicQuotaStatus(['tok'])
		assert.equal(status?.remainingPercent, 70)
		assert.equal(seen?.url, 'https://api.anthropic.com/api/oauth/usage')
		assert.equal(seen?.headers.Authorization, 'Bearer tok')
		assert.equal(seen?.headers['anthropic-beta'], 'oauth-2025-04-20')
	} finally {
		globalThis.fetch = realFetch
	}
})

test('switches status with the selected model', async () => {
	const handlers = new Map<string, (event: unknown, ctx: any) => unknown>()
	const statuses = new Map<string, string>()
	const realFetch = globalThis.fetch
	const nowSec = Math.floor(Date.now() / 1000)
	globalThis.fetch = (async (url: string) => ({
		ok: true,
		json: async () => url.includes('anthropic.com')
			? { five_hour: { utilization: 90, resets_at: new Date((nowSec + 600) * 1000).toISOString() }, seven_day: { utilization: 10, resets_at: null } }
			: { rate_limit: { primary_window: { used_percent: 50, reset_at: nowSec + 600 }, secondary_window: { used_percent: 25, reset_at: nowSec + 5_000 } } },
	})) as unknown as typeof fetch

	const dir = await mkdtemp(join(tmpdir(), 'subscription-usage-'))
	const authFiles = [join(dir, 'pi.json'), join(dir, 'cli.json')]
	await writeFile(authFiles[0], JSON.stringify({
		anthropic: { type: 'oauth', access: 'ant-token' },
		'openai-codex': { type: 'oauth', access: 'codex-token' },
	}))
	subscriptionUsage({
		on(event: string, handler: (event: unknown, ctx: any) => unknown) { handlers.set(event, handler) },
	} as any, { authFiles })

	const ctx = {
		mode: 'tui',
		model: { id: 'claude-test', provider: 'anthropic' },
		ui: {
			theme: { fg(_color: string, text: string) { return text } },
			setStatus(key: string, text: string | undefined) {
				if (text === undefined) statuses.delete(key)
				else statuses.set(key, text)
			},
		},
	}
	const wait = () => new Promise((resolve) => setTimeout(resolve, 20))
	const key = 'subscription-usage'

	try {
		handlers.get('session_start')?.({}, ctx)
		await wait()
		assert.match(statuses.get(key) ?? '', /^5h - 10% \(r in (9|10)m\), 7d - 90%$/)

		handlers.get('model_select')?.({ model: { provider: 'openai-codex' } }, ctx)
		await wait()
		assert.match(statuses.get(key) ?? '', /^5h - 50% \(r in (9|10)m\), 7d - 75% \(r in 1h(2[2-4]|23)m\)$/)

		handlers.get('model_select')?.({ model: { provider: 'deepseek' } }, ctx)
		assert.equal(statuses.has(key), false)

		handlers.get('model_select')?.({ model: { provider: 'anthropic' } }, ctx)
		await wait()
		assert.match(statuses.get(key) ?? '', /^5h - 10%/)
	} finally {
		globalThis.fetch = realFetch
		handlers.get('session_shutdown')?.({}, ctx)
		await rm(dir, { recursive: true, force: true })
	}
	assert.equal(statuses.has(key), false)
})

test('resizing redraws from cached quota without refetching', async () => {
	const handlers = new Map<string, (event: unknown, ctx: any) => unknown>()
	const realFetch = globalThis.fetch
	const realColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns')
	let fetches = 0
	const nowSec = Math.floor(Date.now() / 1000)
	globalThis.fetch = (async () => {
		fetches++
		return {
			ok: true,
			json: async () => ({
				five_hour: { utilization: 31, resets_at: new Date((nowSec + 3_720) * 1000).toISOString() },
				seven_day: { utilization: 70, resets_at: new Date((nowSec + 280_000) * 1000).toISOString() },
			}),
		}
	}) as unknown as typeof fetch

	const dir = await mkdtemp(join(tmpdir(), 'subscription-usage-'))
	const authFiles = [join(dir, 'pi.json'), join(dir, 'cli.json')]
	await writeFile(authFiles[0], JSON.stringify({ anthropic: { type: 'oauth', access: 'ant-token' } }))
	subscriptionUsage({
		on(event: string, handler: (event: unknown, ctx: any) => unknown) { handlers.set(event, handler) },
	} as any, { authFiles })

	let draws = 0
	let last = ''
	const ctx = {
		mode: 'tui',
		model: { provider: 'anthropic' },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (_key: string, text: string | undefined) => { draws++; last = text ?? '' },
		},
	}
	const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
	try {
		handlers.get('session_start')?.({}, ctx)
		await wait(20)
		assert.equal(fetches, 1)

		const drawsBefore = draws
		Object.defineProperty(process.stdout, 'columns', { value: 70, configurable: true })
		for (let i = 0; i < 10; i++) process.stdout.emit('resize')
		await wait(120)

		assert.equal(fetches, 1, 'resize must not hit the API')
		assert.equal(draws - drawsBefore, 1, 'a burst of resizes redraws once')
		assert.match(last, /^5h - 69% \(r in 1h2m\), 7d - 30%$/)
	} finally {
		globalThis.fetch = realFetch
		if (realColumns) Object.defineProperty(process.stdout, 'columns', realColumns)
		else delete (process.stdout as { columns?: number }).columns
		handlers.get('session_shutdown')?.({}, ctx)
		await rm(dir, { recursive: true, force: true })
	}
})
