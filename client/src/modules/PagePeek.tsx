// 사이드 패널에 띄우는 서브페이지. SidePeek 이 lazy import 로 불러 쓴다 — BlockDoc ↔ SidePeek 이 서로 값을 import 하는 순환을 피하기 위해서다.
// 본문 페이지(App.tsx 의 SubPage)와 같은 구성(제목 input + BlockDoc)이고, 상단의 '전체 보기' 로 그 페이지로 전환한다.
import { Link } from 'react-router';
import { table } from '@/sync/handle';
import { useMeta } from '@/sync/store';
import { BlockDoc, pageTitle, type BlockRow, type FileRow, type SubpageRow } from './BlockDoc';
import type { RecordingRow } from './recorder';
import { PageProps, type PagePropRow } from './props';

export default function PagePeek({ id, close }: { id: string; close: () => void }) {
    const subpages = table<SubpageRow>('subpages', 'rw');
    const page = subpages.useRows().find(p => p.id === id);
    const props = table<PagePropRow>('page_props', 'rw');
    const { loaded } = useMeta();
    return (
        <>
            <header className="h-11 shrink-0 flex items-center gap-1 px-3 text-sm border-b border-[var(--c-borPri)]">
                <span className="flex-1 truncate">📄 {loaded ? pageTitle(page) : ''}</span>
                {page && <Link to={`/p/cowork/${page.id}`} onClick={close} className="text-[13px] px-2 py-1 rounded-md hover:bg-[var(--ca-bacIntTra)]">전체 보기</Link>}
                <button className="text-[13px] px-2 py-1 rounded-md cursor-pointer hover:bg-[var(--ca-bacIntTra)]" onClick={close} aria-label="닫기">✕</button>
            </header>
            <div className="flex-1 overflow-y-auto px-4 md:px-8 pb-[30vh]">
                {!loaded ? null : !page
                    ? <h1 className="notion-page-title text-[var(--c-texTer)]">{pageTitle(undefined)}</h1>
                    : (
                        <>
                            <input
                                className="notion-page-title"
                                placeholder="제목 없음"
                                value={page.title}
                                onChange={e => subpages.update({ id: page.id, title: e.target.value })}
                            />
                            <PageProps docId={page.id} props={props} page={page} subpages={subpages} />
                            <BlockDoc docId={page.id} db={table<BlockRow>('blocks', 'rw')} subpages={subpages} props={props} files={table<FileRow>('files', 'ro')} recordings={table<RecordingRow>('recordings', 'ro')} inPeek />
                        </>
                    )}
            </div>
        </>
    );
}
