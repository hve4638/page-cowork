// 프로젝트 항목의 종류 (마일스톤 > 작업 > 티켓). 항목은 kind 가 이 값인 서브페이지이고, 상태·담당자·기한은 page_props 다 (2026-09-12 project-items).
// 의존이 없는 상수 모듈이다 — props.tsx(속성 표의 '상위' 줄)와 items.tsx(보드)가 함께 쓰므로 순환을 피해 따로 둔다.
export type ItemKind = 'milestone' | 'work' | 'ticket';
export const ITEM_KINDS: ItemKind[] = ['milestone', 'work', 'ticket'];
export const ITEM_META: Record<ItemKind, { label: string; icon: string; block: 'milestones' | 'works' | 'tickets'; parent: ItemKind | null }> = {
    milestone: { label: '마일스톤', icon: '🏁', block: 'milestones', parent: null },
    work: { label: '작업', icon: '🧩', block: 'works', parent: 'milestone' },
    ticket: { label: '티켓', icon: '🎫', block: 'tickets', parent: 'work' },
};
export const isItemKind = (k: unknown): k is ItemKind => typeof k === 'string' && (ITEM_KINDS as string[]).includes(k);
// 보드 블럭 type → 항목 kind
export const kindOfBlock = (type: string | undefined): ItemKind | null => ITEM_KINDS.find(k => ITEM_META[k].block === type) ?? null;
// 상태 속성. 세 값 고정 (사용자 결정 2026-09-06). 선택지에 없는 값을 치면 늘어나는 select 의 기본 동작은 그대로다
export const STATUS_KEY = '상태';
export const STATUSES = ['todo', 'doing', 'done'] as const;
export const ASSIGNEE_KEY = '담당자';
export const DUE_KEY = '기한';
