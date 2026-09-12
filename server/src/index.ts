// cowork 서버: HTTP API + /sync WS + 정적 서빙(client/dist 가 있을 때). dev 에서는 vite(8770)가 이 서버(8771)로 프록시한다.
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { handleApi } from './api.ts';
import { sessionUser, type User } from './auth.ts';
import { apply, autoVersionIfDue, createVersion, groupSummary, normalizePosIfNeeded, restoreVersion, revert, snapshot, versionMutation, type Mutation } from './sync.ts';
import { autoStopStale } from './recordings.ts';
import { gcFiles } from './api.ts';
import { config } from './config.ts';
import { serveStatic, staticEnabled } from './static.ts';

const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname.startsWith('/api/')) {
        try { await handleApi(req, res, url, publish); }
        catch (err) {
            console.error(err);
            if (!res.headersSent) res.writeHead(500);
            res.end();
        }
        return;
    }
    if (serveStatic(req, res, url.pathname)) return;
    res.writeHead(404).end();
});

let rev = 0;
const wss = new WebSocketServer({ noServer: true });
const wsUsers = new WeakMap<WebSocket, User>();

// WS 업그레이드가 인증 관문이다: 세션 쿠키가 유효한 active 사용자만 101 을 받는다
server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/sync') { socket.destroy(); return; }
    const user = sessionUser(req);
    if (!user || user.status !== 'active') {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
        wsUsers.set(ws, user);
        wss.emit('connection', ws, req);
    });
});

function broadcast(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(data);
    }
}

// HTTP 경로(파일 업로드)에서 생긴 행도 WS 변경과 같은 rev 열에 태워 내보낸다
function publish(m: Mutation): void {
    rev++;
    broadcast({ type: 'change', rev, m });
}

wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'snapshot', rev, tables: snapshot() }));
    // mutate: 변경 하나 (group 은 클라이언트의 undo 묶음 id). revert: 묶음 되감기 (as 는 되감기 결과가 기록될 새 묶음 id).
    // version: 현재 시점을 이름 붙인 버전으로 (로그 없음, versions 행만). restore: 버전으로 되돌아가기 (group 은 되감기 결과가 기록될 새 묶음 id).
    ws.on('message', raw => {
        let msg: { type?: string; clientId?: string; group?: string; as?: string; m?: Mutation; name?: string; version?: string };
        try { msg = JSON.parse(String(raw)); } catch { return; }
        const user = wsUsers.get(ws);
        if (!user) return;
        if (msg.type === 'version') {
            const name = typeof msg.name === 'string' ? msg.name.trim().slice(0, 80) : '';
            if (!name) return;
            publish(versionMutation(createVersion(name, user.id, false)));
            return;
        }
        if (typeof msg.group !== 'string' || !msg.group) return;
        let applied: Mutation[];
        const logged = msg.type === 'revert' ? msg.as : msg.group; // 이번 메시지가 로그를 남기는 묶음
        try {
            if (msg.type === 'revert') {
                if (typeof msg.as !== 'string' || !msg.as) return;
                applied = revert(msg.group, msg.as, user.id);
                if (!applied.length) { console.log(`[drop] ${user.name} revert ${msg.group}`); return; }
            } else if (msg.type === 'restore') {
                if (typeof msg.version !== 'string' || !msg.version) return;
                applied = restoreVersion(msg.version, msg.group, user.id);
                if (!applied.length) { console.log(`[drop] ${user.name} restore ${msg.version}`); return; }
                console.log(`[restore] ${user.name} → ${msg.version} (${applied.length}건)`);
            } else if (msg.type === 'mutate' && msg.m) {
                applied = apply(msg.m, user.id, msg.group);
                if (!applied.length) { console.log(`[drop] ${user.name} ${JSON.stringify(msg.m)}`); return; }
            } else return;
        } catch (err) { console.error(`[error] ${user.name}`, err); return; } // 적용 실패는 그 메시지만 버린다 (트랜잭션은 롤백됨)
        const summary = logged ? groupSummary(logged) : null; // 사이드바 변경사항 목록: 묶음 요약을 매번 다시 내려 amend·연쇄가 반영되게 한다
        if (summary) applied.push({ action: 'insert', table: 'change_groups', row: summary });
        for (const m of applied) { // 연쇄 삭제는 서버가 정한 순서대로 각각 한 건씩 내보낸다
            rev++;
            broadcast({ type: 'change', rev, clientId: msg.clientId, m });
        }
        if (msg.m && normalizePosIfNeeded(msg.m)) {
            rev++;
            console.log(`[rev ${rev}] pos 정규화 실행`);
            broadcast({ type: 'snapshot', rev, tables: snapshot() });
        }
    });
});

// 녹음자가 사라진 채 남은 녹음(10분 무신호)을 분 단위로 정리한다
setInterval(() => { try { autoStopStale(publish); } catch (err) { console.error(err); } }, 60 * 1000);
// 자정 기준 자동 버전: 기동 시와 분 단위로 확인한다 (sync.ts autoVersionIfDue)
const runAutoVersion = () => { try { const v = autoVersionIfDue(); if (v) { console.log(`[version] 자동 버전 ${v.name}`); publish(versionMutation(v)); } } catch (err) { console.error(err); } };
runAutoVersion();
setInterval(runAutoVersion, 60 * 1000);
// 포인터가 없고 로그에서도 30일간 등장하지 않은 파일을 기동 시와 1시간마다 지운다
const runGc = () => { try { gcFiles(publish); } catch (err) { console.error(err); } };
runGc();
setInterval(runGc, 60 * 60 * 1000);

server.listen(config.port, config.host, () => {
    console.log(`cowork server listening on ${config.host}:${config.port}`);
    console.log(`  config: ${config.path ?? '(없음, 기본값)'}  data: ${config.dataDir}  static: ${staticEnabled ? config.staticDir : '(없음, API 만)'}`);
});
