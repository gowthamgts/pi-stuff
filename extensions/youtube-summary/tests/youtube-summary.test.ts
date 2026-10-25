import assert from "node:assert/strict";
import test from "node:test";
import { YoutubeTranscript, YoutubeTranscriptNotAvailableLanguageError } from "youtube-transcript-plus";
import youtubeSummary, { hasNonLatinLetters, parseVideoId, prepareTranscript, splitSummaryInput, SUMMARY_PROMPT } from "../index.ts";

const id = "EBw7gsDPAYQ";

test("accepts IDs and common YouTube URL forms", () => {
	for (const input of [id, `https://youtu.be/${id}?t=42`, `https://www.youtube.com/watch?v=${id}&t=42`,
		`https://m.youtube.com/watch?v=${id}`, `https://youtube.com/shorts/${id}`,
		`https://youtube.com/embed/${id}`, `https://youtube.com/live/${id}`]) {
		assert.equal(parseVideoId(input), id);
	}
});

test("rejects malformed inputs and lookalike domains", () => {
	for (const input of ["", "bad-id", `https://youtube.com.evil.test/watch?v=${id}`,
		`https://evil.test/${id}`, `ftp://youtube.com/watch?v=${id}`, `https://youtube.com/watch?v=${id}extra`]) {
		assert.throws(() => parseVideoId(input), /Usage:/);
	}
});

test("keeps all captions, including transcripts beyond the old hard limit", () => {
	assert.equal(prepareTranscript([{ text: " one " }, { text: "" }, { text: "two" }]), "one\ntwo");
	assert.throws(() => prepareTranscript([]), /No captions/);
	const long = "x".repeat(240_001);
	assert.equal(prepareTranscript([{ text: long }]), long);
});

test("splits all input within the model budget without corrupting Unicode", () => {
	for (const text of ["x".repeat(240_001), "视频😀 captions\n".repeat(10_000)]) {
		for (const contextWindow of [8_000, 200_000]) {
			const chunks = splitSummaryInput(text, contextWindow);
			assert.ok(chunks.length > 1);
			assert.equal(chunks.join(""), text);
			for (const chunk of chunks) {
				assert.ok(Buffer.byteLength(chunk) <= Math.min(120_000, contextWindow - 4_000));
				assert.equal(Buffer.from(chunk).toString(), chunk);
			}
		}
	}
	assert.throws(() => splitSummaryInput("captions", 4_000), /context window is too small/);
});

function harness(complete?: (model: any, context: any, options: any) => Promise<any>) {
	let handler: any;
	const sent: any[] = [];
	const notices: any[] = [];
	const calls: any[] = [];
	youtubeSummary({
		on() {},
		registerCommand(name: string, command: any) {
			assert.equal(name, "youtube-summary");
			handler = command.handler;
		},
		sendMessage(message: any, options: any) { sent.push({ message, options }); },
	} as any);
	const ctx = {
		model: { provider: "test", id: "model", contextWindow: 128_000 },
		sessionManager: { getSessionId: () => "session-1" },
		modelRegistry: {
			hasConfiguredAuth: () => true,
			async complete(model: any, context: any, options: any) {
				calls.push({ model, context, options });
				return complete ? complete(model, context, options) : {
					content: [{ type: "text", text: "A video about testing.\n\nCritical takeaways\n- Test important behavior." }],
					stopReason: "stop",
				};
			},
		},
		ui: { notify(message: string, level: string) { notices.push({ message, level }); } },
	};
	return { handler, ctx, sent, notices, calls };
}

test("summarizes in an isolated request and sends only summary to the session", async (t) => {
	const transcript = "PRIVATE RAW CAPTIONS - do not place these in the chat";
	t.mock.method(YoutubeTranscript, "fetchTranscript", async (videoId: string, config: any) => {
		assert.equal(videoId, id);
		assert.equal(config.lang, "en");
		assert.ok(config.signal instanceof AbortSignal);
		return [{ text: transcript }];
	});
	const h = harness();
	await h.handler(id, h.ctx);
	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0].context.systemPrompt, SUMMARY_PROMPT);
	assert.equal(h.calls[0].context.messages.length, 1);
	assert.ok(h.calls[0].context.messages[0].content[0].text.endsWith(transcript));
	assert.match(h.calls[0].context.messages[0].content[0].text, /English only/);
	assert.equal(h.sent.length, 1);
	assert.match(h.sent[0].message.content, /Critical takeaways/);
	assert.ok(!JSON.stringify(h.sent).includes(transcript));
	assert.equal(h.sent[0].options.triggerTurn, false);
});

test("summarizes every part of long captions and publishes only the combined summary", async (t) => {
	const transcript = "START " + "x".repeat(240_001) + " END";
	t.mock.method(YoutubeTranscript, "fetchTranscript", async () => [{ text: transcript }]);
	const h = harness();
	await h.handler(id, h.ctx);
	assert.equal(h.calls.length, 4);
	const parts = h.calls.slice(0, 3).map((call) => call.context.messages[0].content[0].text.split("\n\n").slice(1).join("\n\n"));
	assert.equal(parts.join(""), transcript);
	assert.match(h.calls[3].context.messages[0].content[0].text, /Combine these consecutive summary notes/);
	assert.ok(!h.calls[3].context.messages[0].content[0].text.includes("START"));
	assert.equal(h.sent.length, 1);
	assert.ok(!JSON.stringify(h.sent).includes("START"));
});

test("reduces notes over multiple rounds when they do not fit a single request", async (t) => {
	t.mock.method(YoutubeTranscript, "fetchTranscript", async () => [{ text: "x".repeat(12_001) }]);
	let count = 0;
	const h = harness(async () => ({ stopReason: "stop", content: [{ type: "text", text: ++count <= 4 ? "n".repeat(1_100) : "Final summary" }] }));
	h.ctx.model.contextWindow = 8_000;
	await h.handler(id, h.ctx);
	assert.equal(h.calls.length, 7); // Four caption parts, two note parts, one final synthesis.
	assert.equal(h.sent.length, 1);
});

test("a failed chunk never publishes a partial summary", async (t) => {
	t.mock.method(YoutubeTranscript, "fetchTranscript", async () => [{ text: "x".repeat(120_001) }]);
	let count = 0;
	const h = harness(async () => ++count === 1
		? { stopReason: "stop", content: [{ type: "text", text: "Partial notes" }] }
		: { stopReason: "error", errorMessage: "Request failed", content: [] });
	await h.handler(id, h.ctx);
	assert.equal(h.sent.length, 0);
	assert.match(h.notices.at(-1).message, /Request failed/);
});

test("prefers regional English captions before falling back to another language", async (t) => {
	const configs: any[] = [];
	t.mock.method(YoutubeTranscript, "fetchTranscript", async (_id: string, config: any) => {
		configs.push(config);
		if (config.lang === "en") throw new YoutubeTranscriptNotAvailableLanguageError("en", ["ar", "en-US"], id);
		return [{ text: "English captions" }];
	});
	const h = harness();
	await h.handler(id, h.ctx);
	assert.deepEqual(configs.map((config) => config.lang), ["en", "en-US"]);
	assert.equal(configs[0].signal, configs[1].signal);
	assert.equal(h.sent.length, 1);
});

test("falls back to default captions only when English is unavailable", async (t) => {
	const languages: any[] = [];
	t.mock.method(YoutubeTranscript, "fetchTranscript", async (_id: string, config: any) => {
		languages.push(config.lang);
		if (config.lang === "en") throw new YoutubeTranscriptNotAvailableLanguageError("en", ["ar"], id);
		return [{ text: "يستعرض الفيديو" }];
	});
	const h = harness();
	await h.handler(id, h.ctx);
	assert.deepEqual(languages, ["en", undefined]);
	assert.equal(h.sent.length, 1);
	assert.equal(hasNonLatinLetters(h.sent[0].message.content), false);
	assert.ok(h.notices.some((notice) => /No English captions/.test(notice.message)));
});

test("fetch and model failures never publish raw captions or partial responses", async (t) => {
	const mock = t.mock.method(YoutubeTranscript, "fetchTranscript", async () => { throw new Error("Captions unavailable"); });
	const failedFetch = harness();
	await failedFetch.handler(id, failedFetch.ctx);
	assert.equal(mock.mock.callCount(), 1); // Network/access failures must not trigger a fallback fetch.
	assert.equal(failedFetch.calls.length, 0);
	assert.equal(failedFetch.sent.length, 0);
	assert.match(failedFetch.notices.at(-1).message, /Captions unavailable/);
	mock.mock.mockImplementation(async () => [{ text: "captions" }]);
	for (const stopReason of ["error", "aborted", "length"]) {
		const h = harness(async () => ({ stopReason, content: [{ type: "text", text: "partial" }] }));
		await h.handler(id, h.ctx);
		assert.equal(h.sent.length, 0);
		assert.equal(h.notices.at(-1).level, "error");
	}
	const empty = harness(async () => ({ stopReason: "stop", content: [] }));
	await empty.handler(id, empty.ctx);
	assert.equal(empty.sent.length, 0);
	assert.match(empty.notices.at(-1).message, /empty summary/);
});

test("script guard catches non-Latin text without rejecting English punctuation or Latin names", () => {
	assert.equal(hasNonLatinLetters("RouterOS 7.24 — René's advice: update now."), false);
	for (const text of ["يستعرض الفيديو", "视频摘要", "Обзор видео"]) assert.equal(hasNonLatinLetters(text), true);
});

test("rewrites Arabic output in English and publishes only the corrected summary", async (t) => {
	t.mock.method(YoutubeTranscript, "fetchTranscript", async () => [{ text: "RAW CAPTIONS" }]);
	const arabic = "يستعرض الفيديو أبرز التغييرات\n\nCritical takeaways\n- ينصح بالتحديث";
	let count = 0;
	const h = harness(async () => ({ stopReason: "stop", content: [{ type: "text", text: ++count === 1
		? arabic : "The video covers RouterOS updates.\n\nCritical takeaways\n- The speaker recommends updating." }] }));
	await h.handler(id, h.ctx);
	assert.equal(h.calls.length, 2);
	assert.match(h.calls[1].context.messages[0].content[0].text, /entirely in English/);
	assert.ok(h.calls[1].context.messages[0].content[0].text.includes(arabic));
	assert.ok(!h.calls[1].context.messages[0].content[0].text.includes("RAW CAPTIONS"));
	assert.equal(h.sent.length, 1);
	assert.equal(hasNonLatinLetters(h.sent[0].message.content), false);
});

test("refuses to display non-Latin output if the rewrite also fails", async (t) => {
	t.mock.method(YoutubeTranscript, "fetchTranscript", async () => [{ text: "captions" }]);
	const h = harness(async () => ({ stopReason: "stop", content: [{ type: "text", text: "يستعرض الفيديو" }] }));
	await h.handler(id, h.ctx);
	assert.equal(h.calls.length, 2);
	assert.equal(h.sent.length, 0);
	assert.match(h.notices.at(-1).message, /did not return an English summary/);
});

test("validates input and auth before fetching", async (t) => {
	const mock = t.mock.method(YoutubeTranscript, "fetchTranscript", async () => { throw new Error("must not fetch"); });
	const h = harness();
	await h.handler("invalid", h.ctx);
	h.ctx.modelRegistry.hasConfiguredAuth = () => false;
	await h.handler(id, h.ctx);
	assert.equal(mock.mock.callCount(), 0);
	assert.equal(h.sent.length, 0);
});

test("prevents duplicate work and discards output after a session switch", async (t) => {
	t.mock.method(YoutubeTranscript, "fetchTranscript", async () => [{ text: "captions" }]);
	let finish: (value: any) => void = () => {};
	const h = harness(() => new Promise((resolve) => { finish = resolve; }));
	const running = h.handler(id, h.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	await h.handler(id, h.ctx);
	assert.match(h.notices.at(-1).message, /already running/);
	h.ctx.sessionManager.getSessionId = () => "session-2";
	finish({ stopReason: "stop", content: [{ type: "text", text: "summary" }] });
	await running;
	assert.equal(h.calls.length, 1);
	assert.equal(h.sent.length, 0);
});
