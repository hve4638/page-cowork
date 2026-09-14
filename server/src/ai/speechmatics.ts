// Speechmatics 전사. SDK 없이 REST(배치)와 WebSocket(실시간) 만 쓴다 — 서버 의존성을 늘리지 않고 응답을 우리 형태로 바꾸는 코드가 이 파일에 모인다.
// 흐름: 작업 만들기(POST /v2/jobs) → 상태 묻기(GET /v2/jobs/<id>) 반복 → 결과 받기(GET /v2/jobs/<id>/transcript).
// 지원 형식 목록에 webm 이 없어서 올리기 전에 flac 으로 바꾼다 (audio.ts).
// 화자 분리를 켜면 낱말마다 화자(S1·S2…)가 붙고, 시각은 초 단위 실수라서 밀리초 정수로 바꾼다.
// 실시간은 WebSocket 하나에 StartRecognition → AddAudio(2진) → AddTranscript → EndOfStream → EndOfTranscript 순으로 오간다.
// 실시간이 받는 형식은 raw PCM 이라 브라우저의 webm 을 그대로 보낼 수 없다. 변환은 부르는 쪽이 한다 (ai/live.ts).
import { readFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { ai } from '../config.ts';
import { discard, toFlac } from './audio.ts';
import { segmentsFromWords, type LiveStream, type StreamingStt, type Transcript, type Word } from './types.ts';

const BASE = () => ai.stt.baseUrl || 'https://asr.api.speechmatics.com/v2';
const RT_URL = () => ai.stt.liveUrl || 'wss://eu2.rt.speechmatics.com/v2';
const POLL_MS = 5000;
const TIMEOUT_MS = 60 * 60 * 1000; // 한 시간이 지나도 안 끝나면 포기한다
const MAX_DELAY_S = 3;      // 낱말을 확정하기 전에 뒤쪽을 더 듣는 시간. 길수록 정확하고 화면에 늦게 뜬다 (허용 범위 0.7~4).
                            // 회의록은 화면 속도보다 정확도가 중요해서 넉넉히 잡았다 — 한국어는 조사·어미가 뒤에 붙어 뒤 맥락이 특히 크게 작용한다 (사용자 결정 2026-09-14)
const END_WAIT_MS = 15000;  // EndOfStream 뒤 남은 결과를 기다리는 한도. 넘으면 받은 데까지 쓴다

type SmWord = { start_time: number; end_time: number; type: string; alternatives?: { content: string; speaker?: string }[] };

async function call(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(BASE() + path, {
        ...init,
        headers: { authorization: `Bearer ${ai.stt.apiKey}`, ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`Speechmatics ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res;
}

// 낱말·문장부호 목록을 우리 Word 로. 화자가 없으면(분리를 끄면) null 로 둔다.
const toWords = (results: SmWord[]): Word[] =>
    results.map(r => ({
        speaker: r.alternatives?.[0]?.speaker ?? null,
        startMs: Math.round(r.start_time * 1000),
        endMs: Math.round(r.end_time * 1000),
        text: r.alternatives?.[0]?.content ?? '',
    })).filter(w => w.text);

export const speechmaticsStt: StreamingStt = {
    name: 'speechmatics',
    async transcribe(input, onStage): Promise<Transcript> {
        if (!ai.stt.apiKey) throw new Error('Speechmatics API 키가 없습니다. 설정 파일의 ai.stt.apiKey 또는 환경변수 STT_API_KEY 를 채워 주세요.');
        onStage('소리 파일 변환');
        const flac = await toFlac(input.path, `sm-${Date.now()}`);
        try {
            onStage('전사 요청');
            const form = new FormData();
            form.append('data_file', new Blob([await readFile(flac)]), 'audio.flac');
            form.append('config', JSON.stringify({
                type: 'transcription',
                transcription_config: {
                    language: input.language || 'ko',
                    operating_point: 'enhanced',
                    diarization: 'speaker',
                },
            }));
            const created = await (await call('/jobs/', { method: 'POST', body: form })).json() as { id: string };

            onStage('전사');
            const until = Date.now() + TIMEOUT_MS;
            for (;;) {
                await new Promise<void>(r => setTimeout(r, POLL_MS));
                const { job } = await (await call(`/jobs/${created.id}`)).json() as { job: { status: string; errors?: { message: string }[] } };
                if (job.status === 'done') break;
                if (job.status !== 'running') throw new Error(`전사가 끝나지 못했습니다 (${job.status}): ${job.errors?.map(e => e.message).join(', ') ?? ''}`);
                if (Date.now() > until) throw new Error('전사가 한 시간 안에 끝나지 않았습니다.');
            }

            onStage('결과 정리');
            const out = await (await call(`/jobs/${created.id}/transcript?format=json-v2`)).json() as
                { results?: SmWord[]; job?: { duration?: number } };
            const words = toWords(out.results ?? []);
            return {
                provider: 'speechmatics',
                language: input.language || 'ko',
                durationMs: Math.round((out.job?.duration ?? 0) * 1000) || (words.at(-1)?.endMs ?? 0),
                segments: segmentsFromWords(words),
                words,
            };
        } finally {
            discard(flac);
        }
    },

    // 실시간 전사. 연결이 서고 RecognitionStarted 를 받은 뒤에 돌려준다 — 그래야 키·한도 문제를 부른 쪽이 곧바로 알고 배치로 물러설 수 있다.
    async openStream(language, onUpdate): Promise<LiveStream> {
        if (!ai.stt.apiKey) throw new Error('Speechmatics API 키가 없습니다. 설정 파일의 ai.stt.apiKey 또는 환경변수 STT_API_KEY 를 채워 주세요.');
        const ws = new WebSocket(RT_URL(), { headers: { authorization: `Bearer ${ai.stt.apiKey}` } });
        const words: Word[] = [];
        let seq = 0, closed = false;
        let settle: { ok: (t: Transcript) => void; fail: (e: Error) => void } | null = null;

        const result = (): Transcript => ({
            provider: 'speechmatics', language,
            durationMs: words.at(-1)?.endMs ?? 0,
            segments: segmentsFromWords(words), words,
        });

        // 연결과 인사말까지 끝내고 나서야 쓸 수 있는 손잡이를 준다
        await new Promise<void>((resolve, reject) => {
            const hello = (raw: unknown) => {
                const m = JSON.parse(String(raw)) as { message: string; type?: string; reason?: string };
                if (m.message === 'RecognitionStarted') { ws.off('message', hello); resolve(); return; }
                if (m.message === 'Error') reject(new Error(`Speechmatics 실시간 ${m.type ?? ''}: ${m.reason ?? ''}`));
            };
            ws.once('error', (e: Error) => reject(e));
            ws.once('open', () => ws.send(JSON.stringify({
                message: 'StartRecognition',
                audio_format: { type: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
                transcription_config: {
                    language: language || 'ko', operating_point: 'enhanced',
                    diarization: 'speaker', max_delay: MAX_DELAY_S,
                },
            })));
            ws.on('message', hello);
        });

        ws.on('message', raw => {
            const m = JSON.parse(String(raw)) as { message: string; results?: SmWord[]; type?: string; reason?: string };
            if (m.message === 'AddTranscript') { words.push(...toWords(m.results ?? [])); onUpdate(segmentsFromWords(words)); return; }
            if (m.message === 'EndOfTranscript') { closed = true; settle?.ok(result()); ws.close(); return; }
            if (m.message === 'Error') { closed = true; settle?.fail(new Error(`Speechmatics 실시간 ${m.type ?? ''}: ${m.reason ?? ''}`)); ws.close(); }
        });
        // 우리가 끝내기 전에 끊기면 받은 데까지 쓴다 — 회의 도중 끊겼다고 전사를 통째로 버리지는 않는다
        ws.on('close', () => { if (!closed) { closed = true; settle?.ok(result()); } });

        return {
            push(pcm) { if (!closed && ws.readyState === WebSocket.OPEN) { ws.send(pcm); seq++; } },
            end(): Promise<Transcript> {
                if (closed) return Promise.resolve(result());
                return new Promise<Transcript>((ok, fail) => {
                    settle = { ok, fail };
                    ws.send(JSON.stringify({ message: 'EndOfStream', last_seq_no: seq }));
                    setTimeout(() => { if (!closed) { closed = true; ws.close(); ok(result()); } }, END_WAIT_MS);
                });
            },
            abort() { closed = true; try { ws.close(); } catch { /* 이미 닫혔다 */ } },
        };
    },
};
