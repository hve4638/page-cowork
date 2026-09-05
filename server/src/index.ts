// cowork 서버: HTTP API + /sync WS. dev 에서는 vite(8770)가 이 서버(8771)로 프록시한다.
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { handleApi } from './api.ts';
import { sessionUser, type User } from './auth.ts';
import { apply, normalizePosIfNeeded, snapshot, type Mutation } from './sync.ts';
import { autoStopStale } from './recordings.ts';

const PORT = Number(process.env.PORT ?? 8771); // 워크트리 병행 검증용으로 PORT 환경변수를 받는다

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
    ws.on('message', raw => {
        let msg: { type?: string; clientId?: string; m?: Mutation };
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.type !== 'mutate' || !msg.m) return;
        const user = wsUsers.get(ws);
        if (!user) return;
        const applied = apply(msg.m, user.id);
        if (!applied.length) {
            console.log(`[drop] ${user.login_id} ${JSON.stringify(msg.m)}`);
            return;
        }
        for (const m of applied) { // 연쇄 삭제는 서버가 정한 순서대로 각각 한 건씩 내보낸다
            rev++;
            broadcast({ type: 'change', rev, clientId: msg.clientId, m });
        }
        if (normalizePosIfNeeded(msg.m)) {
            rev++;
            console.log(`[rev ${rev}] pos 정규화 실행`);
            broadcast({ type: 'snapshot', rev, tables: snapshot() });
        }
    });
});

// 녹음자가 사라진 채 남은 녹음(1시간 무신호)을 분 단위로 정리한다
setInterval(() => { try { autoStopStale(publish); } catch (err) { console.error(err); } }, 60 * 1000);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`cowork server listening on 0.0.0.0:${PORT}`);
});
