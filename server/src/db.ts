// SQLite 하나가 전체 저장소다. Node 22 의 내장 node:sqlite 를 사용한다 (--experimental-sqlite 플래그 필요).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupDataDir, timestamp } from './backup.ts';
import { config, DB_PATH } from './config.ts';
import { migrations, SCHEMA_VERSION } from './migrations.ts';

mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

// 마이그레이션 실행. 목록과 버전 규칙은 migrations.ts.
{
    const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    // 새 이미지로 올렸다가 옛 이미지로 돌아온 경우. 옛 코드는 모르는 스키마를 건드리지 않고 멈춘다.
    if (current > SCHEMA_VERSION) {
        console.error(`[migrate] DB 스키마 v${current} 가 이 서버가 아는 최신 v${SCHEMA_VERSION} 보다 새롭다 (${DB_PATH}). 기동을 거부한다. 새 이미지를 쓰거나 ${join(config.dataDir, 'backups')}/ 의 사본을 복원하라.`);
        process.exit(1);
    }
    const pending = migrations.filter(m => m.version > current);
    // 테이블이 하나도 없는 새 DB 는 뜰 내용이 없으므로 백업을 건너뛴다
    if (pending.length && db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get()) {
        const out = join(config.dataDir, 'backups', `${timestamp()}-pre-v${SCHEMA_VERSION}`);
        try { await backupDataDir(out, db); }
        catch (err) {
            console.error(`[migrate] 백업 실패 (${out}). 마이그레이션을 진행하지 않고 종료한다.`, err);
            process.exit(1);
        }
        console.log(`[migrate] v${current} → v${SCHEMA_VERSION} 적용 전 백업: ${out}`);
    }
    for (const m of pending) {
        if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF');
        db.exec('BEGIN');
        try {
            m.up(db);
            db.exec(`PRAGMA user_version = ${m.version}`);
            db.exec('COMMIT');
        } catch (err) {
            if (db.isTransaction) db.exec('ROLLBACK');
            console.error(`[migrate] v${m.version} ${m.name} 실패. 롤백했고 DB 는 v${m.version - 1} 에 머문다.`, err);
            process.exit(1);
        }
        if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON');
        console.log(`[migrate] v${m.version} ${m.name} 적용`);
    }
}

// 홈은 subpages 의 고정 행(id='home')이다. 제목만 여기 살고 본문 블럭은 다른 페이지처럼 blocks.doc_id='home' 이다.
// 링크 블럭 입구가 없어 연쇄 삭제에 걸리지 않고, 직접 delete 는 sync.ts 가 거부한다.
export const HOME_PAGE_ID = 'home';
db.prepare('INSERT OR IGNORE INTO subpages (id, title, pos, created_by, created_at, updated_at) VALUES (?, ?, 0, NULL, ?, ?)')
    .run(HOME_PAGE_ID, 'cowork', Date.now(), Date.now());

// 내장 템플릿. 템플릿은 kind='template' 인 서브페이지이고 본문·속성을 보통 페이지처럼 편집한다. 첫 기동 때 한 번 심고(INSERT OR IGNORE)
// 그 뒤로는 사용자가 고친 내용이 남는다 — "사용자가 고친 템플릿으로 새 회의가 만들어진다" 가 목표라 읽기 전용이 아니다.
// {{변수}} 는 매크로가 템플릿을 넣을 때 치환한다. 탭 이름이 목록 변수 하나({{팀원}})면 원소마다 탭이 하나씩 생긴다 (templates.ts).
export const MEETING_TEMPLATE_ID = 'tpl-meeting';
if (!db.prepare('SELECT 1 FROM subpages WHERE id = ?').get(MEETING_TEMPLATE_ID)) {
    const now = Date.now();
    db.prepare("INSERT INTO subpages (id, title, pos, created_by, created_at, updated_at, kind) VALUES (?, '회의록', 0, NULL, ?, ?, 'template')")
        .run(MEETING_TEMPLATE_ID, now, now);
    const prop = db.prepare('INSERT INTO page_props (id, doc_id, key, type, value, pos, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    prop.run(`${MEETING_TEMPLATE_ID}:일시`, MEETING_TEMPLATE_ID, '일시', 'date', 'null', 1, now);
    prop.run(`${MEETING_TEMPLATE_ID}:목적`, MEETING_TEMPLATE_ID, '목적', 'text', '"{{목적}}"', 2, now);
    const block = db.prepare('INSERT INTO blocks (id, doc_id, parent_id, type, ref, text, pos, style, updated_at) VALUES (?, ?, NULL, ?, NULL, ?, ?, ?, ?)');
    block.run('tpl-meeting-h', MEETING_TEMPLATE_ID, 'text', '## 안건\n\n## 논의\n\n## 결정 사항\n\n## 다음 할 일\n\n## 팀원별 자료', 1, '{}', now);
    block.run('tpl-meeting-t', MEETING_TEMPLATE_ID, 'tabs', '', 2, JSON.stringify({ tabs: [{ id: 'mbr0', label: '{{팀원}}' }] }), now);
}
