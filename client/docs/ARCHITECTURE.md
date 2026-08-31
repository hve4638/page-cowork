# Architecture Guide

프로젝트 아키텍처 및 구조 가이드.

## 1. 디렉토리 구조

```
src/
├── assets/           # 정적 자산 및 스타일
│   └── style/
│       ├── theme/        # 테마 (dark/light)
│       ├── flexstyle/    # Flexbox 유틸리티
│       └── module/       # Reset, 폰트
│
├── components/       # 재사용 UI 컴포넌트
│   ├── atoms/           # 원자 요소 (Button, Input)
│   ├── layout/          # 레이아웃 컴포넌트
│   └── index.ts
│
├── features/         # 기능 모듈 (자체 포함)
│   └── modal/
│       ├── components/
│       ├── context/
│       ├── hooks/
│       └── index.ts
│
├── hooks/            # 커스텀 훅
│   └── index.ts
│
├── lib/              # 내부 라이브러리
│   ├── zustbus/         # 이벤트 버스
│   └── Latch.ts         # 비동기 동기화
│
├── stores/           # Zustand 스토어
│   ├── useAppStore.ts
│   └── useConfigStore.ts
│
├── types/            # TypeScript 타입
│   ├── common-props.ts
│   └── index.ts
│
├── constants/        # 상수
│   └── z-index.ts
│
├── utils/            # 유틸리티 함수
│
├── App.tsx           # 루트 컴포넌트
├── main.tsx          # 진입점
└── index.css         # 전역 스타일
```

## 2. 상태 관리 전략

### 계층 구조

```
┌─────────────────────────────────────────────┐
│           Zustand Stores (전역)              │
│  useAppStore, useConfigStore               │
├─────────────────────────────────────────────┤
│         React Context (기능 범위)            │
│  ModalContext, ThemeContext                │
├─────────────────────────────────────────────┤
│         Component State (로컬)              │
│  useState, useReducer                      │
└─────────────────────────────────────────────┘
```

### 언제 무엇을 사용할지

| 상태 유형 | 도구 | 예시 |
|-----------|------|------|
| 앱 전역 상태 | Zustand | 테마, 사용자 정보, 로딩 상태 |
| 영속 설정 | Zustand + persist | 폰트 크기, 언어, 사이드바 |
| 기능 범위 상태 | React Context | 모달 스택, 폼 상태 |
| 컴포넌트 로컬 상태 | useState | 입력값, 토글, hover |

### Zustand 스토어 패턴

```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// 기본 스토어
type AppState = {
    isLoading: boolean;
    theme: 'light' | 'dark';
}

type AppActions = {
    setLoading: (loading: boolean) => void;
    toggleTheme: () => void;
}

export const useAppStore = create<AppState & AppActions>((set) => ({
    // State
    isLoading: false,
    theme: 'dark',

    // Actions
    setLoading: (loading) => set({ isLoading: loading }),
    toggleTheme: () => set((state) => ({
        theme: state.theme === 'dark' ? 'light' : 'dark'
    })),
}));

// 영속화 스토어
export const useConfigStore = create<ConfigState & ConfigActions>()(
    persist(
        (set) => ({ /* ... */ }),
        { name: 'config-storage' }
    )
);
```

## 3. 컴포넌트 계층 (Atomic Design)

```
atoms/          ← 가장 작은 단위
   ↓
layout/         ← 레이아웃 구성
   ↓
features/       ← 기능 단위 조합
   ↓
pages/          ← 페이지 단위
```

### Atoms
- Button, Input, Spinner, Icon
- 단일 책임, 재사용 가능
- 도메인 로직 없음

### Layout
- Row, Column, Grid, Container
- 배치와 정렬만 담당
- 비즈니스 로직 없음

### Features
- Modal, Toast, Sidebar
- 자체 상태와 로직 포함
- 독립적으로 동작

## 4. Feature 모듈 구조

각 feature는 자체 포함적(self-contained):

```
features/modal/
├── components/          # UI 컴포넌트
│   ├── Modal.tsx
│   ├── ModalBox.tsx
│   └── ModalBackground.tsx
├── context/             # React Context
│   ├── ModalContext.ts
│   └── ModalProvider.tsx
├── hooks/               # 전용 훅
│   ├── useModal.ts
│   └── useModalInstance.ts
├── types.ts             # 타입 정의
└── index.ts             # Public API
```

### 외부 노출 (index.ts)
```typescript
// 필요한 것만 export
export { Modal, ModalBox } from './components';
export { ModalProvider } from './context';
export { useModal, useModalInstance } from './hooks';
export type { ModalRequiredProps } from './types';
```

## 5. 이벤트 기반 통신

### Zustbus

컴포넌트 간 느슨한 결합을 위한 타입 안전 이벤트 버스:

```typescript
import { createBus } from '@/lib/zustbus';

// 1. 이벤트 타입 정의
type AppEvents = {
    'user:login': { userId: string };
    'user:logout': undefined;
    'theme:change': 'light' | 'dark';
};

// 2. 버스 생성
const [emit, useOn, useValue] = createBus<AppEvents>();

// 3. 이벤트 발행
emit('user:login', { userId: '123' });
emit('user:logout');

// 4. 이벤트 구독 (컴포넌트 내)
useOn('user:login', (data) => {
    console.log('User logged in:', data.userId);
});

// 5. 최신 값 읽기
const theme = useValue('theme:change');
```

### 사용 시나리오
- 모듈 간 통신 (서로 import 없이)
- 전역 알림 (토스트, 에러)
- 상태 동기화

## 6. 스타일 시스템

### 테마

CSS 변수 기반 다크/라이트 테마:

```scss
// theme.scss
.theme-dark {
    --bgcolor: rgb(23, 23, 23);
    --text-color: white;
    --text-color-dim: rgb(102, 102, 102);
}

.theme-light {
    --bgcolor: rgb(245, 247, 248);
    --text-color: black;
    --text-color-dim: rgb(100, 100, 100);
}
```

```tsx
// 사용
<div className="theme-dark">
    <p style={{ color: 'var(--text-color)' }}>Hello</p>
</div>
```

### Flexbox 유틸리티

```html
<!-- 클래스 기반 레이아웃 -->
<div class="row main-spacebetween sub-center">
    <span>Left</span>
    <span>Right</span>
</div>

<div class="column center fill">
    <!-- 세로 중앙 정렬, 부모 채움 -->
</div>
```

주요 클래스:
- `row`, `column` - 방향
- `center` - 중앙 정렬
- `main-*`, `sub-*` - 축별 정렬
- `fill`, `wfill`, `hfill` - 크기
- `flex` - flex: 1

## 7. 경로 별칭

### tsconfig.app.json
```json
{
    "paths": {
        "@/*": ["*"]
    }
}
```

### vite.config.ts
```typescript
resolve: {
    alias: [
        { find: '@', replacement: 'src' },
        { find: 'components', replacement: 'src/components' },
        { find: 'hooks', replacement: 'src/hooks' },
        { find: 'stores', replacement: 'src/stores' },
        // ...
    ]
}
```

### 사용
```typescript
// 둘 다 가능
import { Button } from '@/components';
import { Button } from 'components';
```

## 8. 에러 처리

### 컴포넌트 에러 경계
```typescript
// ErrorBoundary 사용 권장
<ErrorBoundary fallback={<ErrorPage />}>
    <App />
</ErrorBoundary>
```

### API 에러
```typescript
try {
    const data = await fetchData();
} catch (error) {
    if (error instanceof ApiError) {
        // 처리
    }
    throw error;
}
```

## 9. 성능 고려사항

### React Compiler
- `babel-plugin-react-compiler` 활성화
- 자동 메모이제이션으로 수동 `useMemo`, `useCallback` 최소화

### 최적화 훅
- `useDebounce` - 입력 지연
- `useThrottle` - 스크롤, 리사이즈
- `useCache` - LRU 캐싱
