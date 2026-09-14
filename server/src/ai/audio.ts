// 소리 파일 변환. 녹음은 브라우저 MediaRecorder 가 만든 webm(Opus) 이고, 길이 정보가 헤더에 없다.
// 전사 서비스가 받는 형식이 저마다 달라서(Speechmatics 는 webm 을 받지 않는다) 서버에서 한 번 바꿔 보낸다.
// 16kHz 모노 flac 으로 맞춘다 — 음성 인식에 필요한 정보는 남기면서 파일이 작아 올리는 시간이 짧다.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import { dataPath } from '../config.ts';

const run = promisify(execFile);
const TMP_DIR = dataPath('tmp') + '/';

// 변환한 파일의 경로를 돌려준다. 쓰고 나면 부른 쪽이 discard 로 지운다.
export async function toFlac(src: string, id: string): Promise<string> {
    mkdirSync(TMP_DIR, { recursive: true });
    const out = `${TMP_DIR}${id}.flac`;
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'flac', '-y', out]);
    return out;
}

// 소리 파일의 길이(ms). 올린 파일을 녹음으로 받을 때 쓴다. 브라우저 MediaRecorder 의 webm 처럼 헤더에 길이가 없으면 0 을 돌려준다.
export async function probeDurationMs(path: string): Promise<number> {
    try {
        const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path]);
        const sec = Number(String(stdout).trim());
        return Number.isFinite(sec) ? Math.round(sec * 1000) : 0;
    } catch {
        return 0;
    }
}

export function discard(path: string): void {
    try { rmSync(path); } catch { /* 이미 없다 */ }
}

// 흘러 들어오는 소리를 실시간으로 PCM 으로 바꾼다. stdin 에 webm 조각을 이어서 넣으면 stdout 으로 16kHz 모노 s16le 가 나온다.
// MediaRecorder 의 첫 조각에만 헤더가 있고 뒤는 이어지는 구조라, 한 흐름으로 넣으면 그대로 풀린다 (2026-09-14 확인: 첫 PCM 까지 0.4초).
export function spawnToPcm(): ChildProcessWithoutNullStreams {
    return spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-fflags', 'nobuffer', '-i', 'pipe:0',
        '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-flush_packets', '1', 'pipe:1',
    ]);
}
