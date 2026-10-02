// 데이터 디렉터리 백업·복원. 기동 시 마이그레이션 전 자동 백업(db.ts)과 pnpm backup·restore 스크립트가 함께 쓴다.
// 대상은 cowork.db 와 DATA_ENTRIES 다. 이름을 골라 다루므로 dataDir 안의 backups/·.tmp/ 는 사본에 들어가지 않고 복원도 건드리지 않는다.
// DB 는 node:sqlite backup API 로 떠서 서버가 켜진 상태(WAL)에서도 한 시점의 일관된 사본이 된다. 나머지 항목은 그 뒤에 복사하므로,
// 켜진 채 백업하면 그 사이에 끝난 녹음·업로드가 DB 와 어긋날 수 있다. 그래서 아카이브 이름에 live/cold 를 붙인다 (2026-10-02 admin-backup-restore).
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { config, DB_PATH, dataPath } from './config.ts';
import { SCHEMA_VERSION } from './migrations.ts';

// DB 밖의 데이터 항목. 백업·아카이브·복원이 모두 이 목록을 쓴다
export const DATA_ENTRIES = ['files', 'recordings', 'whitelist.txt', 'admin.txt', 'prompts'];
// 복원 때 함께 치우고 들여오는 DB 파일들. 백업 사본에는 -wal·-shm 이 없지만 손으로 만든 아카이브에는 있을 수 있다
const DB_FILES = ['cowork.db', 'cowork.db-wal', 'cowork.db-shm'];

// 현지 시각 YYYY-MM-DDTHH-MM-SS (디렉터리 이름용)
export function timestamp(now = new Date()) {
    return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// out 디렉터리에 사본을 만든다. source 를 주면 그 연결에서 DB 를 뜨고(기동 중인 db.ts), 없으면 DB_PATH 를 읽기 전용으로 연다.
// 결과 디렉터리는 그대로 dataDir 로 지정해 띄울 수 있는 완전한 데이터 디렉터리다.
export async function backupDataDir(out: string, source?: DatabaseSync) {
    mkdirSync(out, { recursive: true });
    const src = source ?? new DatabaseSync(DB_PATH, { readOnly: true });
    try { await backup(src, join(out, 'cowork.db')); }
    finally { if (!source) src.close(); }
    for (const name of DATA_ENTRIES) {
        const from = join(config.dataDir, name);
        if (existsSync(from)) cpSync(from, join(out, name), { recursive: true });
    }
    return out;
}

// 서버가 DB 를 열고 있지 않으면 배타 잠금을 잡은 연결을 돌려주고(cold), 열고 있으면 null 을 돌려준다(live).
// WAL 모드로 열린 DB 는 연결이 살아 있는 동안 공유 잠금이 걸려 있어 BEGIN EXCLUSIVE 가 바로 실패한다.
// 같은 볼륨을 보는 다른 컨테이너(docker compose run)의 서버도 이 잠금으로 알아본다.
function lockDb(): DatabaseSync | null {
    const conn = new DatabaseSync(DB_PATH, { timeout: 0 });
    try {
        conn.exec('PRAGMA locking_mode = EXCLUSIVE');
        conn.exec('BEGIN EXCLUSIVE');
        conn.exec('COMMIT');
        return conn;
    } catch {
        conn.close();
        return null;
    }
}

function tar(args: string[]): Promise<number> {
    return new Promise((resolve, reject) => {
        const p = spawn('tar', args, { stdio: ['ignore', 'inherit', 'inherit'] });
        p.on('error', reject);
        p.on('close', code => resolve(code ?? -1));
    });
}

const userVersion = (conn: DatabaseSync) => (conn.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

// dataDir 전체를 tar.gz 하나로 묶어 destDir 에 쓴다. 이름은 cowork-backup-YYMMDD-HHMMSS-v<DB 스키마 번호>-live|cold.tar.gz.
// 항목을 아카이브 루트에 두므로 빈 디렉터리에 tar -xzf 로 풀면 그대로 dataDir 이 된다.
// DB 스냅샷만 <dataDir>/.tmp 에 뜨고 files·recordings 는 원본에서 바로 묶는다 (데이터 크기만큼의 중간 사본을 만들지 않는다).
// cold 면 묶는 동안 잠금을 쥐고 있어 그 사이 서버가 뜨지 못한다.
export async function backupArchive(destDir: string): Promise<{ path: string; mode: 'live' | 'cold' }> {
    if (!existsSync(DB_PATH)) throw new Error(`DB 가 없습니다: ${DB_PATH}`);
    const lock = lockDb();
    const mode = lock ? 'cold' : 'live';
    const work = dataPath('.tmp', `backup-${timestamp()}`);
    try {
        mkdirSync(work, { recursive: true });
        const src = lock ?? new DatabaseSync(DB_PATH, { readOnly: true });
        try { await backup(src, join(work, 'cowork.db')); }
        finally { if (!lock) src.close(); }
        const snap = new DatabaseSync(join(work, 'cowork.db'), { readOnly: true });
        const version = userVersion(snap);
        snap.close();

        const stamp = timestamp().slice(2).replace(/-/g, '').replace('T', '-');
        const out = join(destDir, `cowork-backup-${stamp}-v${version}-${mode}.tar.gz`);
        mkdirSync(destDir, { recursive: true });
        const entries = DATA_ENTRIES.filter(name => existsSync(dataPath(name)));
        // 쓰는 중에는 .part 로 두어 덜 쓴 파일이 완성본처럼 보이지 않게 한다
        const code = await tar(['-czf', out + '.part', '-C', work, 'cowork.db', ...(entries.length ? ['-C', config.dataDir, ...entries] : [])]);
        // GNU tar 의 1 은 "읽는 동안 파일이 바뀌었다" 다. 아카이브 자체는 온전하므로 live 에서는 받아들인다 (진행 중인 녹음의 끝부분이 덜 담긴다)
        if (code !== 0 && !(code === 1 && mode === 'live')) {
            rmSync(out + '.part', { force: true });
            throw new Error(`tar 가 실패했습니다 (종료 코드 ${code})`);
        }
        renameSync(out + '.part', out);
        return { path: out, mode };
    } finally {
        lock?.close();
        rmSync(work, { recursive: true, force: true });
    }
}

// 아카이브로 dataDir 을 되돌린다. 서버가 멈춰 있어야 한다. 순서:
// 1) 서버가 DB 를 열고 있으면 거부 2) <dataDir>/.tmp 에 풀고 cowork.db·무결성·스키마 번호(코드 이하)를 확인, 아니면 아무것도 바꾸지 않고 거부
// 3) 현재 데이터를 backups/<ts>-pre-restore/ 로 옮기고 4) 풀어 둔 것을 들여온다. 3·4 중 실패하면 옮긴 것을 역순으로 되돌린다.
// 옮기기는 같은 파일시스템 안의 rename 이라 데이터가 커도 바로 끝나고 디스크를 더 쓰지 않는다. 마이그레이션은 다음 기동 때 돈다.
// 돌려주는 값은 안전 사본 경로 (현재 데이터가 없었으면 null).
export async function restoreArchive(archive: string): Promise<string | null> {
    if (!existsSync(archive)) throw new Error(`아카이브가 없습니다: ${archive}`);
    if (existsSync(DB_PATH)) {
        const lock = lockDb();
        if (!lock) throw new Error('서버가 이 데이터를 쓰고 있습니다. 서버를 멈춘 뒤 다시 실행하세요 (docker compose stop cowork).');
        // 옮기기 전에 닫는다. 마지막 연결이 닫히며 WAL 을 DB 에 합치므로 옮긴 사본이 cowork.db 하나로 온전해진다
        lock.close();
    }

    const work = dataPath('.tmp', `restore-${timestamp()}`);
    const unpacked = join(work, 'data');
    try {
        mkdirSync(unpacked, { recursive: true });
        if (await tar(['-xzf', archive, '-C', unpacked]) !== 0) throw new Error('아카이브를 풀지 못했습니다. tar.gz 파일이 맞는지 확인하세요.');
        const db = join(unpacked, 'cowork.db');
        if (!existsSync(db)) throw new Error('아카이브 최상위에 cowork.db 가 없습니다.');
        let version: number;
        try {
            // 읽기 전용으로 열면 WAL 부속 파일(-wal·-shm)이 남아 함께 들어온다. 쓰기로 열어 닫을 때 WAL 을 합치고 지우게 한다
            const conn = new DatabaseSync(db);
            try {
                const check = conn.prepare('PRAGMA quick_check').get() as { quick_check: string };
                if (check.quick_check !== 'ok') throw new Error(check.quick_check);
                version = userVersion(conn);
            } finally { conn.close(); }
        } catch (err) {
            throw new Error(`아카이브의 cowork.db 가 깨져 있습니다: ${(err as Error).message}`);
        }
        if (version > SCHEMA_VERSION) throw new Error(`아카이브의 DB 스키마 v${version} 가 이 서버가 아는 최신 v${SCHEMA_VERSION} 보다 새롭습니다. 새 버전의 서버로 복원하세요.`);

        const names = [...DB_FILES, ...DATA_ENTRIES];
        const pre = dataPath('backups', `${timestamp()}-pre-restore`);
        mkdirSync(pre, { recursive: true });
        const moved: string[] = [], placed: string[] = [];
        try {
            for (const name of names) {
                if (!existsSync(dataPath(name))) continue;
                renameSync(dataPath(name), join(pre, name));
                moved.push(name);
            }
            for (const name of names) {
                if (!existsSync(join(unpacked, name))) continue;
                renameSync(join(unpacked, name), dataPath(name));
                placed.push(name);
            }
        } catch (err) {
            for (const name of placed.reverse()) renameSync(dataPath(name), join(unpacked, name));
            for (const name of moved.reverse()) renameSync(join(pre, name), dataPath(name));
            rmdirSync(pre);
            throw err;
        }
        if (!readdirSync(pre).length) { rmdirSync(pre); return null; }
        return pre;
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}
