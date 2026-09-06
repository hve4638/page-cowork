// 템플릿 기반 페이지 생성. 템플릿은 "제목 + 속성 행들 + 초기 블럭들" 을 돌려주는 함수 하나이고, 호출부는 결과를 그대로 WS insert 한다.
// 지금은 코드에 정의된 템플릿(회의록)뿐이지만, 저장소를 테이블로 옮겨 사용자가 미리 정의하게 되어도 이 형태(PageDraft)는 그대로 둔다.
import { rid } from '@/sync/store';
import type { BlockRow, SubpageRow } from './BlockDoc';
import { propId, type PagePropRow } from './props';

export type PageDraft = { page: SubpageRow; props: PagePropRow[]; blocks: BlockRow[] };

export type MeetingInput = {
    boardId: string;        // 소속 회의 보드의 키 (meetings 블럭의 ref)
    title: string;
    heldAt: number | null;  // 회의 일시 (ms)
    purpose: string;
    members: string[];      // 팀원별 탭의 이름표. 비어 있으면 탭 블럭을 넣지 않는다
    pos: number;            // subpages 정렬용
};

// 회의록 기본 템플릿. 속성: 일시(date)·목적(text). 본문: 안건·논의·결정 사항·다음 할 일 제목, 그 아래 팀원별 자료 탭(사용자 이름이 탭 이름).
// 팀원별 자료는 별도 페이지가 아니라 이 탭 안의 블럭이다 (사용자 결정 2026-09-07).
export function meetingNote(input: MeetingInput): PageDraft {
    const id = rid(16);
    const page: SubpageRow = { id, title: input.title, pos: input.pos, kind: 'meeting', board_id: input.boardId };
    const props: PagePropRow[] = [
        { id: propId(id, '일시'), doc_id: id, key: '일시', type: 'date', value: input.heldAt, pos: 1 },
        { id: propId(id, '목적'), doc_id: id, key: '목적', type: 'text', value: input.purpose, pos: 2 },
    ];
    // 본문 텍스트는 하나의 흐름이라 텍스트 블럭 하나에 제목들을 모두 담고, 탭 블럭만 그 뒤에 끼운다
    const headings = '## 안건\n\n## 논의\n\n## 결정 사항\n\n## 다음 할 일\n' + (input.members.length ? '\n## 팀원별 자료' : '');
    const blocks: BlockRow[] = [{ id: rid(8), doc_id: id, text: headings, pos: 1, style: {} }];
    if (input.members.length) {
        const tabs = input.members.map(label => ({ id: rid(4), label }));
        blocks.push({ id: rid(8), doc_id: id, type: 'tabs', text: '', pos: 2, style: { tabs } });
    }
    return { page, props, blocks };
}
