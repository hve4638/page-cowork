// 사이드 뷰어. 파일 블럭(BlockDoc)에서 PDF·텍스트 파일을 열면 Workspace 오른쪽에 패널로 떠서 보여준다.
// PDF 는 서버의 GET /api/files/<id> 가 application/pdf inline 으로 주므로 브라우저 내장 뷰어(iframe)에 그대로 꽂고,
// 텍스트는 fetch 로 받아 pre 에 원문 그대로 보인다(마크다운 렌더링은 markdown-styling 티켓의 몫).
// 열린 파일은 zustand 스토어에 두어 깊이 다른 두 자리(블럭 · Workspace 레이아웃)가 공유한다.
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { FileRow } from './BlockDoc';

// 패널에서 열 수 있는 텍스트 형식. mime 이 text/* 이거나 json 이면 통과, 그 외엔 흔한 확장자로 판정한다
// (업로드 시 브라우저가 .md·.log 등에 application/octet-stream 을 붙이는 경우가 있어 확장자도 본다).
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'yaml', 'yml', 'xml', 'ini', 'toml']);
const TEXT_LIMIT = 2 * 1024 * 1024; // 이보다 크면 pre 에 올리지 않고 다운로드로 안내한다

export function peekKind(f: FileRow): 'pdf' | 'text' | null {
    if (f.mime === 'application/pdf') return 'pdf';
    if (f.mime.startsWith('text/') || f.mime === 'application/json') return 'text';
    const ext = f.name.slice(f.name.lastIndexOf('.') + 1).toLowerCase();
    return f.name.includes('.') && TEXT_EXTS.has(ext) ? 'text' : null;
}

export const useSidePeek = create<{ file: FileRow | null; open: (file: FileRow) => void; close: () => void }>(set => ({
    file: null,
    open: file => set({ file }),
    close: () => set({ file: null }),
}));

function TextView({ file }: { file: FileRow }) {
    const [text, setText] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        setText(null); setError(null);
        if (file.size > TEXT_LIMIT) { setError('2MB 를 넘는 텍스트는 미리보기 대신 다운로드해서 여세요.'); return; }
        let alive = true;
        fetch(`/api/files/${file.id}`)
            .then(r => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then(t => { if (alive) setText(t); })
            .catch(e => { if (alive) setError(`불러오지 못했습니다: ${e.message}`); });
        return () => { alive = false; };
    }, [file.id, file.size]);
    if (error) return <div className="p-4 text-sm text-[var(--c-texSec)]">{error}</div>;
    if (text === null) return <div className="p-4 text-sm text-[var(--c-texTer)]">불러오는 중…</div>;
    return <pre className="flex-1 overflow-auto p-4 text-[13px] leading-relaxed whitespace-pre-wrap break-words font-mono">{text}</pre>;
}

export function SidePeek() {
    const { file, close } = useSidePeek();
    if (!file) return null;
    return (
        <aside className="w-[45%] min-w-[360px] h-full flex flex-col border-l border-[var(--c-borPri)] bg-[var(--c-bacPri)]">
            {/* 탑바와 같은 44px 높이로 맞춘다 */}
            <header className="h-11 shrink-0 flex items-center gap-1 px-3 text-sm border-b border-[var(--c-borPri)]">
                <span className="flex-1 truncate" title={file.name}>📎 {file.name}</span>
                <a href={`/api/files/${file.id}?download`} className="text-[13px] px-2 py-1 rounded-md hover:bg-[var(--ca-bacIntTra)]">다운로드</a>
                <button className="text-[13px] px-2 py-1 rounded-md cursor-pointer hover:bg-[var(--ca-bacIntTra)]" onClick={close} aria-label="닫기">✕</button>
            </header>
            {peekKind(file) === 'pdf'
                ? <iframe key={file.id} src={`/api/files/${file.id}`} title={file.name} className="flex-1 w-full" />
                : <TextView key={file.id} file={file} />}
        </aside>
    );
}
