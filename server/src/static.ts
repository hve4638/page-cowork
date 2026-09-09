// 정적 서빙 + SPA fallback: config.staticDir (client/dist) 의 파일을 내주고, 없는 경로는 index.html 로 답한다.
// 개발 시에는 client/dist 가 없으므로 아무것도 하지 않고 vite 가 화면을 담당한다.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { config } from './config.ts';

const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.map': 'application/json',
};

export const staticEnabled = existsSync(join(config.staticDir, 'index.html'));

export function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    if (!staticEnabled || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, ''); // 경로 탈출 방지
    let file = join(config.staticDir, safe);
    if (!file.startsWith(config.staticDir)) return false;
    let stat = existsSync(file) ? statSync(file) : null;
    if (!stat || stat.isDirectory()) { // SPA fallback: /p/cowork/<id> 같은 클라이언트 라우트
        file = join(config.staticDir, 'index.html');
        stat = statSync(file);
    }
    const ext = extname(file);
    // vite 산출물은 assets/ 아래 해시 파일명이라 영구 캐시, index.html 은 매번 확인
    const cache = safe.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'content-length': stat.size, 'cache-control': cache });
    if (req.method === 'HEAD') { res.end(); return true; }
    createReadStream(file).pipe(res);
    return true;
}
