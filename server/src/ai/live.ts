// 녹음이 도는 동안 소리를 전사 서비스로 흘려 보내는 자리 (2026-09-14 ai-meeting-notes).
// 브라우저는 5초(전사를 켜면 1.5초)마다 webm 조각을 HTTP 로 올린다. 그 조각을 ffmpeg 하나에 계속 물려 16kHz 모노 PCM 으로 바꾸고,
// 나오는 대로 전사 서비스의 WebSocket 으로 보낸다. 첫 조각에만 헤더가 있고 뒤는 이어지는 구조라 한 흐름으로 그대로 풀린다.
// 브라우저에서 PCM 을 직접 만들어 보내는 길도 있지만, 그러면 녹음 파일 저장 경로를 따로 두어야 해서 서버에서 바꾸는 쪽을 골랐다.
// 실시간이 열리지 않거나 도중에 끊기면 여기서는 조용히 접고, 부른 쪽(ainotes.ts)이 녹음이 끝난 뒤 배치 전사로 물러선다.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { ai } from '../config.ts';
import { spawnToPcm } from './audio.ts';
import { stt } from './index.ts';
import { canStream, type LiveStream, type Segment, type Transcript } from './types.ts';

const FF_FLUSH_MS = 3000; // 종료 시 ffmpeg 가 남은 PCM 을 뱉기를 기다리는 한도

type Session = {
    ff: ChildProcessWithoutNullStreams;
    stream: LiveStream | null; // 서비스 쪽 연결. 아직 열리는 중이면 null
    waiting: Buffer[];         // 연결이 열리기 전에 나온 PCM
    dead: boolean;             // 열지 못했거나 끊겼다. 이 녹음은 배치로 물러선다
};
const sessions = new Map<string, Session>();

export const liveReady = (): boolean => canStream(stt());

// 실시간 전사를 연다. 이미 열려 있거나 제공자가 실시간을 지원하지 않으면 아무 일도 하지 않는다.
// 연결이 서기 전에 들어온 소리는 모아 두었다가 열리는 즉시 밀어 넣는다 — 회의 첫마디를 놓치지 않으려는 것이다.
export function openLive(key: string, onUpdate: (segments: Segment[]) => void, onFail: (reason: string) => void): boolean {
    const provider = stt();
    if (!canStream(provider) || sessions.has(key)) return sessions.has(key);

    const ff = spawnToPcm();
    const s: Session = { ff, stream: null, waiting: [], dead: false };
    sessions.set(key, s);

    const die = (reason: string) => {
        if (s.dead) return;
        s.dead = true;
        s.stream?.abort();
        s.stream = null;
        s.waiting = [];
        console.error(`[live] ${key} 실시간 전사 중단 — ${reason}`);
        onFail(reason);
    };

    ff.stdout.on('data', (d: Buffer) => {
        if (s.dead) return;
        if (s.stream) s.stream.push(d);
        else s.waiting.push(d);
    });
    ff.stderr.on('data', (d: Buffer) => console.error(`[live] ${key} ffmpeg: ${String(d).trim().slice(0, 200)}`));
    ff.on('error', err => die(`소리 변환을 시작하지 못했습니다 (${err.message})`));

    void provider.openStream(ai.stt.language, onUpdate).then(
        stream => {
            if (s.dead) { stream.abort(); return; }
            s.stream = stream;
            for (const b of s.waiting) stream.push(b);
            s.waiting = [];
            console.log(`[live] ${key} 실시간 전사 시작 (${provider.name})`);
        },
        (err: Error) => die(err.message),
    );
    return true;
}

// 브라우저가 올린 webm 조각을 변환기에 넣는다. 세션이 없거나 접힌 뒤면 버린다 (녹음 파일 자체는 부른 쪽이 따로 저장한다).
export function pushLive(key: string, webm: Buffer): void {
    const s = sessions.get(key);
    if (!s || s.dead || !webm.length) return;
    s.ff.stdin.write(webm);
}

// 남은 소리까지 보내고 최종 전사를 받는다. 실시간이 없었거나 중간에 접혔으면 null — 부른 쪽은 배치로 물러선다.
export async function closeLive(key: string): Promise<Transcript | null> {
    const s = sessions.get(key);
    if (!s) return null;
    sessions.delete(key);

    s.ff.stdin.end();
    await new Promise<void>(resolve => {
        const done = setTimeout(resolve, FF_FLUSH_MS);
        s.ff.once('close', () => { clearTimeout(done); resolve(); });
    });

    if (s.dead || !s.stream) { s.stream?.abort(); return null; }
    for (const b of s.waiting) s.stream.push(b);
    try {
        return await s.stream.end();
    } catch (err) {
        console.error(`[live] ${key} 마무리 실패`, err);
        return null;
    }
}

// 결과를 버리고 접는다 (녹음 행이 지워지는 경우).
export function abortLive(key: string): void {
    const s = sessions.get(key);
    if (!s) return;
    sessions.delete(key);
    s.dead = true;
    s.stream?.abort();
    s.ff.kill();
}
