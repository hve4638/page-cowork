// 회의 녹음의 HTTP 경로: 청크 이어 붙이기, 종료(파일 확정), 끊긴 녹음 자동 종료. 상태 동기화 자체는 sync.ts 의 recordings 테이블이 한다.
// 녹음 중 청크는 server/data/recordings/<id> 에 순서대로 덧붙인다 (클라이언트가 한 번에 하나씩 순서대로 보낸다).
// 종료 시 그 파일을 files 로 옮기고 files 행을 만들어 recordings.file_id 에 연결한다. 완성 파일에는 50MB 상한을 두지 않는다.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db } from './db.ts';
import { rid } from './auth.ts';
import type { Mutation } from './sync.ts';

const CHUNK_LIMIT = 8 * 1024 * 1024; // 청크 하나의 상한. 32kbps 기준 5초 청크는 20KB 남짓이라 넉넉하다
export const STALE_MS = 60 * 60 * 1000; // 이만큼 청크·상태 갱신이 없으면 녹음자가 사라진 것으로 보고 자동 종료한다
const REC_DIR = fileURLToPath(new URL('../data/recordings/', import.meta.url));
const FILES_DIR = fileURLToPath(new URL('../data/files/', import.meta.url));
mkdirSync(REC_DIR, { recursive: true });
mkdirSync(FILES_DIR, { recursive: true });

type RecordingRow = {
    id: string; title: string; status: string; started_by: string | null; started_at: number; duration_ms: number;
    segment_started_at: number | null; file_id: string | null; last_chunk_at: number | null; created_at: number; updated_at: number;
};

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

const getRecording = (id: string) => db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as RecordingRow | undefined;

// 요청 본문을 청크 파일 끝에 덧붙인다. 상한을 넘으면 false.
async function appendBody(req: IncomingMessage, id: string): Promise<boolean> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
        size += (c as Buffer).length;
        if (size > CHUNK_LIMIT) return false;
        chunks.push(c as Buffer);
    }
    if (size) appendFileSync(REC_DIR + id, Buffer.concat(chunks));
    return true;
}

async function appendChunk(req: IncomingMessage, res: ServerResponse, rec: RecordingRow, publish: (m: Mutation) => void): Promise<void> {
    if (rec.status === 'stopped') return json(res, 409, { error: '이미 종료된 녹음입니다.' });
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
    return { ...rec, ...patch };
}

// POST /api/recordings/<id>/chunks (raw body) · POST /api/recordings/<id>/stop (raw body 가 있으면 마지막 청크로 덧붙인 뒤 종료)
// stop 에 본문을 허용하는 이유: 탭이 닫힐 때 sendBeacon 한 번으로 남은 청크와 종료를 함께 보내기 위해서다 (요청 둘로 나누면 순서가 보장되지 않는다).
// 같은 사용자의 다른 탭·기기도 stop 을 부를 수 있다(강제 종료). 녹음 중이던 탭은 다음 청크가 409 를 받고 스스로 접는다.
export async function handleRecordingApi(req: IncomingMessage, res: ServerResponse, url: URL, userId: string, publish: (m: Mutation) => void): Promise<boolean> {
    const m = /^\/api\/recordings\/([0-9a-f]+)\/(chunks|stop)$/.exec(url.pathname);
    if (!m || req.method !== 'POST') return false;
    const rec = getRecording(m[1]);
    if (!rec) { json(res, 404, { error: '녹음이 없습니다.' }); return true; }
    if (rec.started_by !== userId) { json(res, 403, { error: '녹음한 사람만 조작할 수 있습니다.' }); return true; }
    if (m[2] === 'chunks') { await appendChunk(req, res, rec, publish); return true; }
    if (rec.status === 'stopped') { json(res, 200, { recording: rec }); return true; } // 멱등: 재시도·자동 종료와 겹쳐도 무해
    await appendBody(req, rec.id);
    json(res, 200, { recording: finalize(rec, Date.now(), publish) });
    return true;
}

// 녹음자 브라우저가 죽거나 사이트를 떠나 recording·paused 로 남은 녹음을 정리한다. index.ts 가 주기적으로 부른다.
// 마지막 신호(last_chunk_at, 없으면 updated_at)로부터 STALE_MS 가 지나야 종료하며, 경과 시간은 그 신호 시각까지만 인정한다.
export function autoStopStale(publish: (m: Mutation) => void): void {
    const cutoff = Date.now() - STALE_MS;
    const rows = db.prepare("SELECT * FROM recordings WHERE status != 'stopped' AND COALESCE(last_chunk_at, updated_at) < ?").all(cutoff) as RecordingRow[];
    for (const rec of rows) {
        console.log(`[recording] ${rec.id} 자동 종료 (마지막 신호로부터 1시간 경과)`);
        finalize(rec, rec.last_chunk_at ?? rec.updated_at, publish);
    }
}
