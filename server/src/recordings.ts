// 회의 녹음의 HTTP 경로: 청크 이어 붙이기, 종료(파일 확정), 끊긴 녹음 자동 종료. 상태 동기화 자체는 sync.ts 의 recordings 테이블이 한다.
// 녹음 중 청크는 <dataDir>/recordings/<id> 에 순서대로 덧붙인다 (클라이언트가 한 번에 하나씩 순서대로 보낸다).
// 종료 시 그 파일을 files 로 옮기고 files 행을 만들어 recordings.file_id 에 연결한다. 완성 파일에는 50MB 상한을 두지 않는다.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { db } from './db.ts';
import { FILES_DIR, REC_DIR } from './config.ts';
import { rid } from './auth.ts';
import { registerHooks, type Mutation } from './sync.ts';
import { createNote, dropLiveNote, finishLiveNote, hasNoteFor, pushLiveAudio, startLiveNote } from './ainotes.ts';
import { probeDurationMs } from './ai/audio.ts';

const CHUNK_LIMIT = 8 * 1024 * 1024; // 청크 하나의 상한. 32kbps 기준 5초 청크는 20KB 남짓이라 넉넉하다
export const STALE_MS = 10 * 60 * 1000; // 이만큼 청크·상태 갱신이 없으면 녹음자가 사라진 것으로 보고 자동 종료한다. 탭 닫힘은 beacon 이 즉시 알리므로 이 값은 브라우저 강제 종료 등 예외용이다
mkdirSync(REC_DIR, { recursive: true });
mkdirSync(FILES_DIR, { recursive: true });

type RecordingRow = {
    id: string; title: string; status: string; started_by: string | null; started_at: number; duration_ms: number;
    segment_started_at: number | null; file_id: string | null; last_chunk_at: number | null; transcribe: number;
    created_at: number; updated_at: number;
};

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

const getRecording = (id: string) => db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as RecordingRow | undefined;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 8 * 1024) return {};
        chunks.push(c as Buffer);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { return {}; }
}

// 요청 본문을 청크 파일 끝에 덧붙이고, 실시간 전사가 열려 있으면 같은 소리를 그쪽에도 흘려 보낸다. 상한을 넘으면 false.
async function appendBody(req: IncomingMessage, id: string): Promise<boolean> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
        size += (c as Buffer).length;
        if (size > CHUNK_LIMIT) return false;
        chunks.push(c as Buffer);
    }
    if (size) {
        const body = Buffer.concat(chunks);
        appendFileSync(REC_DIR + id, body);
        pushLiveAudio(id, body);
    }
    return true;
}

async function appendChunk(req: IncomingMessage, res: ServerResponse, rec: RecordingRow, publish: (m: Mutation) => void): Promise<void> {
    if (rec.status === 'stopped') return json(res, 409, { error: '이미 종료된 녹음입니다.' });
    // 'AI 전사' 가 켜져 있으면 첫 소리가 올라오는 순간 실시간 전사를 연다 (두 번째부터는 아무 일도 하지 않는다).
    if (rec.transcribe) startLiveNote(rec);
    if (!await appendBody(req, rec.id)) return json(res, 413, { error: '청크가 너무 큽니다.' });
    const now = Date.now();
    db.prepare('UPDATE recordings SET last_chunk_at = ?, updated_at = ? WHERE id = ?').run(now, now, rec.id);
    publish({ action: 'update', table: 'recordings', row: { id: rec.id, last_chunk_at: now, updated_at: now } });
    return json(res, 200, { ok: true });
}

// 녹음을 종료 상태로 확정한다. endAt 은 현재 구간의 끝 시각 (사용자 종료면 지금, 자동 종료면 마지막 청크 시각).
// 청크 파일이 있으면 files 로 옮겨 연결한다. 한 트랜잭션 안에서 recordings·files 를 함께 고친다.
function finalize(rec: RecordingRow, endAt: number, publish: (m: Mutation) => void): RecordingRow {
    const now = Date.now();
    const duration = rec.duration_ms + (rec.segment_started_at ? Math.max(0, endAt - rec.segment_started_at) : 0);
    let fileId: string | null = null;
    const src = REC_DIR + rec.id;
    if (existsSync(src)) {
        fileId = rid(8);
        renameSync(src, FILES_DIR + fileId);
        const file = { id: fileId, name: `${rec.title || '회의 녹음'}.webm`, mime: 'audio/webm', size: statSync(FILES_DIR + fileId).size, author_id: rec.started_by, created_at: now };
        db.prepare('INSERT INTO files (id, name, mime, size, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(file.id, file.name, file.mime, file.size, file.author_id, file.created_at);
        publish({ action: 'insert', table: 'files', row: file });
    }
    const patch = { status: 'stopped', duration_ms: duration, segment_started_at: null, file_id: fileId, updated_at: now };
    db.prepare('UPDATE recordings SET status = ?, duration_ms = ?, segment_started_at = NULL, file_id = ?, updated_at = ? WHERE id = ?')
        .run(patch.status, patch.duration_ms, patch.file_id, patch.updated_at, rec.id);
    publish({ action: 'update', table: 'recordings', row: { id: rec.id, ...patch } });
    // 실시간 전사가 돌고 있었으면 그쪽이 마무리(남은 소리·최종 결과·요약)를 맡는다. 없었으면 완성 파일로 배치 전사를 건다.
    if (!finishLiveNote(rec, fileId) && fileId) autoTranscribe({ ...rec, ...patch, file_id: fileId });
    return { ...rec, ...patch };
}

// 올린 소리 파일을 아직 시작하지 않은(idle) 녹음에 붙여 '끝난 녹음' 으로 만든다. 그래서 올린 파일도 재생·시각 메모·전사가 모두 된다.
// 길이는 ffprobe 로 잰다 (실패하면 0 — 전사가 끝나면 노트가 자기 길이를 보여 준다).
async function attachFile(req: IncomingMessage, res: ServerResponse, rec: RecordingRow, publish: (m: Mutation) => void): Promise<void> {
    if (rec.status !== 'idle') return json(res, 409, { error: '이미 시작했거나 끝난 녹음에는 파일을 붙일 수 없습니다.' });
    const body = await readJson(req);
    const fileId = typeof body.file_id === 'string' ? body.file_id : '';
    const file = fileId ? db.prepare('SELECT id, name, mime FROM files WHERE id = ?').get(fileId) as { id: string; name: string; mime: string } | undefined : undefined;
    if (!file) return json(res, 400, { error: '올린 파일을 찾지 못했습니다.' });
    if (!file.mime.startsWith('audio/') && !file.mime.startsWith('video/')) return json(res, 400, { error: '소리 파일만 붙일 수 있습니다.' });

    const now = Date.now();
    const patch = {
        status: 'stopped', duration_ms: await probeDurationMs(FILES_DIR + file.id),
        segment_started_at: null, file_id: file.id,
        title: rec.title || file.name.replace(/\.[^.]+$/, ''), updated_at: now,
    };
    db.prepare('UPDATE recordings SET status = ?, duration_ms = ?, segment_started_at = NULL, file_id = ?, title = ?, updated_at = ? WHERE id = ?')
        .run(patch.status, patch.duration_ms, patch.file_id, patch.title, patch.updated_at, rec.id);
    publish({ action: 'update', table: 'recordings', row: { id: rec.id, ...patch } });
    const updated = { ...rec, ...patch };
    autoTranscribe(updated);
    return json(res, 200, { recording: updated });
}

// 'AI 전사' 토글이 켜져 있으면 녹음이 끝나는 순간 전사를 건다. 사용자 종료·자동 종료·파일 올리기가 모두 이 길을 지난다.
// 이미 노트가 있으면 만들지 않는다 — 종료가 두 번 불려도(재시도·강제 종료) 겹치지 않게.
function autoTranscribe(rec: RecordingRow): void {
    if (!rec.transcribe || !rec.file_id || hasNoteFor(rec.id)) return;
    console.log(`[recording] ${rec.id} 종료 — AI 전사 시작`);
    createNote(rec.title || '회의 녹음', rec.file_id, rec.id, rec.started_by);
}

// POST /api/recordings/<id>/chunks (raw body) · POST /api/recordings/<id>/stop (raw body 가 있으면 마지막 청크로 덧붙인 뒤 종료)
// stop 에 본문을 허용하는 이유: 탭이 닫힐 때 sendBeacon 한 번으로 남은 청크와 종료를 함께 보내기 위해서다 (요청 둘로 나누면 순서가 보장되지 않는다).
// 같은 사용자의 다른 탭·기기도 stop 을 부를 수 있다(강제 종료). 녹음 중이던 탭은 다음 청크가 409 를 받고 스스로 접는다.
export async function handleRecordingApi(req: IncomingMessage, res: ServerResponse, url: URL, userId: string, publish: (m: Mutation) => void): Promise<boolean> {
    const m = /^\/api\/recordings\/([0-9a-f]+)\/(chunks|stop|attach)$/.exec(url.pathname);
    if (!m || req.method !== 'POST') return false;
    const rec = getRecording(m[1]);
    if (!rec) { json(res, 404, { error: '녹음이 없습니다.' }); return true; }
    if (rec.started_by !== userId) { json(res, 403, { error: '녹음한 사람만 조작할 수 있습니다.' }); return true; }
    if (m[2] === 'attach') { await attachFile(req, res, rec, publish); return true; }
    if (m[2] === 'chunks') { await appendChunk(req, res, rec, publish); return true; }
    if (rec.status === 'stopped') { json(res, 200, { recording: rec }); return true; } // 멱등: 재시도·자동 종료와 겹쳐도 무해
    await appendBody(req, rec.id);
    json(res, 200, { recording: finalize(rec, Date.now(), publish) });
    return true;
}

// 녹음 행이 지워질 때(녹음 블럭 삭제의 연쇄) 녹음 중이면 먼저 종료해 파일을 확정한다. 삭제 로그의 변경 전 이미지가 종료된 상태라서
// undo 로 되살리면 파일이 연결된 종료 녹음으로 돌아온다. 녹음자 브라우저는 자기 행이 사라진 것을 보고(또는 다음 청크의 404 로) 녹음기를 접는다.
// 종료가 만든 files 행은 돌려주어 함께 브로드캐스트한다 (undo-model 2026-09-08. 전사·요약 작업도 이 훅에 붙일 수 있다).
registerHooks('recordings', {
    beforeDelete: row => {
        const rec = row as RecordingRow;
        if (rec.status === 'stopped') return;
        dropLiveNote(rec.id); // 지워질 녹음이라 실시간 전사는 결과를 버리고 접는다
        const out: Mutation[] = [];
        finalize({ ...rec, transcribe: 0 }, Date.now(), m => out.push(m)); // 전사도 걸지 않는다
        return out;
    },
});

// 녹음자 브라우저가 죽거나 사이트를 떠나 recording·paused 로 남은 녹음을 정리한다. index.ts 가 주기적으로 부른다.
// 마지막 신호(last_chunk_at, 없으면 updated_at)로부터 STALE_MS 가 지나야 종료하며, 경과 시간은 그 신호 시각까지만 인정한다.
export function autoStopStale(publish: (m: Mutation) => void): void {
    const cutoff = Date.now() - STALE_MS;
    // idle 은 아직 시작하지 않은 녹음이라 자동 종료 대상이 아니다 (블럭만 꽂아 두고 나중에 시작할 수 있다)
    const rows = db.prepare("SELECT * FROM recordings WHERE status NOT IN ('stopped', 'idle') AND COALESCE(last_chunk_at, updated_at) < ?").all(cutoff) as RecordingRow[];
    for (const rec of rows) {
        console.log(`[recording] ${rec.id} 자동 종료 (마지막 신호로부터 10분 경과)`);
        finalize(rec, rec.last_chunk_at ?? rec.updated_at, publish);
    }
}
