# Design Patterns

프로젝트에서 사용하는 디자인 패턴 가이드.

## 1. 상태 관리 패턴

### Zustand Store 패턴

#### 기본 구조
```typescript
import { create } from 'zustand';

// State와 Actions 분리
type State = {
    count: number;
    items: Item[];
};

type Actions = {
    increment: () => void;
    addItem: (item: Item) => void;
    reset: () => void;
};

export const useStore = create<State & Actions>((set, get) => ({
    // Initial state
    count: 0,
    items: [],

    // Actions
    increment: () => set((state) => ({ count: state.count + 1 })),
    addItem: (item) => set((state) => ({ items: [...state.items, item] })),
    reset: () => set({ count: 0, items: [] }),
}));
```

#### Selector 패턴
```typescript
// 전체 상태 대신 필요한 것만 선택
const count = useStore((state) => state.count);
const increment = useStore((state) => state.increment);

// 여러 값 선택 (shallow 비교)
import { shallow } from 'zustand/shallow';
const { count, items } = useStore(
    (state) => ({ count: state.count, items: state.items }),
    shallow
);
```

#### 영속화 패턴
```typescript
import { persist, createJSONStorage } from 'zustand/middleware';

export const useConfigStore = create<ConfigState>()(
    persist(
        (set) => ({
            theme: 'dark',
            setTheme: (theme) => set({ theme }),
        }),
        {
            name: 'config-storage',
            storage: createJSONStorage(() => localStorage),
            partialize: (state) => ({ theme: state.theme }), // 일부만 저장
        }
    )
);
```

### Slice 패턴 (대규모 스토어)
```typescript
// slices/userSlice.ts
export const createUserSlice = (set, get) => ({
    user: null,
    setUser: (user) => set({ user }),
    logout: () => set({ user: null }),
});

// slices/settingsSlice.ts
export const createSettingsSlice = (set, get) => ({
    theme: 'dark',
    setTheme: (theme) => set({ theme }),
});

// store.ts
export const useStore = create((...args) => ({
    ...createUserSlice(...args),
    ...createSettingsSlice(...args),
}));
```

## 2. 컴포넌트 패턴

### Compound Component 패턴

관련 컴포넌트를 그룹화:

```typescript
// Modal compound component
function Modal({ children }) {
    return <div className="modal">{children}</div>;
}

Modal.Header = function ModalHeader({ children }) {
    return <div className="modal-header">{children}</div>;
};

Modal.Body = function ModalBody({ children }) {
    return <div className="modal-body">{children}</div>;
};

Modal.Footer = function ModalFooter({ children }) {
    return <div className="modal-footer">{children}</div>;
};

// 사용
<Modal>
    <Modal.Header>Title</Modal.Header>
    <Modal.Body>Content</Modal.Body>
    <Modal.Footer>
        <Button>Close</Button>
    </Modal.Footer>
</Modal>
```

### Render Props 패턴

로직 재사용:

```typescript
interface MouseTrackerProps {
    render: (position: { x: number; y: number }) => React.ReactNode;
}

function MouseTracker({ render }: MouseTrackerProps) {
    const [position, setPosition] = useState({ x: 0, y: 0 });

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            setPosition({ x: e.clientX, y: e.clientY });
        };
        window.addEventListener('mousemove', handler);
        return () => window.removeEventListener('mousemove', handler);
    }, []);

    return <>{render(position)}</>;
}

// 사용
<MouseTracker
    render={({ x, y }) => (
        <div>Mouse: {x}, {y}</div>
    )}
/>
```

### Container/Presenter 패턴

로직과 UI 분리:

```typescript
// UserListContainer.tsx (로직)
function UserListContainer() {
    const [users, setUsers] = useState<User[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchUsers().then(setUsers).finally(() => setLoading(false));
    }, []);

    return <UserListPresenter users={users} loading={loading} />;
}

// UserListPresenter.tsx (UI)
interface UserListPresenterProps {
    users: User[];
    loading: boolean;
}

function UserListPresenter({ users, loading }: UserListPresenterProps) {
    if (loading) return <Spinner />;
    return (
        <ul>
            {users.map((user) => (
                <li key={user.id}>{user.name}</li>
            ))}
        </ul>
    );
}
```

## 3. 훅 패턴

### Custom Hook 추출

반복 로직을 훅으로 추출:

```typescript
// 추출 전
function Component() {
    const [value, setValue] = useState('');
    const [debouncedValue, setDebouncedValue] = useState('');

    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedValue(value);
        }, 300);
        return () => clearTimeout(timer);
    }, [value]);

    // ...
}

// 추출 후
function useDebouncedValue<T>(value: T, delay: number): T {
    const [debouncedValue, setDebouncedValue] = useState(value);

    useEffect(() => {
        const timer = setTimeout(() => setDebouncedValue(value), delay);
        return () => clearTimeout(timer);
    }, [value, delay]);

    return debouncedValue;
}

function Component() {
    const [value, setValue] = useState('');
    const debouncedValue = useDebouncedValue(value, 300);
}
```

### useLatestRef 패턴

콜백에서 최신 값 참조:

```typescript
function useLatestRef<T>(value: T) {
    const ref = useRef(value);
    ref.current = value;
    return ref;
}

// 사용: 클로저 문제 해결
function useInterval(callback: () => void, delay: number) {
    const callbackRef = useLatestRef(callback);

    useEffect(() => {
        const id = setInterval(() => callbackRef.current(), delay);
        return () => clearInterval(id);
    }, [delay]); // callback이 deps에 없어도 최신 값 사용
}
```

## 4. Context 패턴

### Provider + Hook 패턴

```typescript
// context/ThemeContext.tsx
const ThemeContext = createContext<ThemeContextType | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const [theme, setTheme] = useState<'light' | 'dark'>('dark');

    const value = useMemo(() => ({
        theme,
        setTheme,
        toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
    }), [theme]);

    return (
        <ThemeContext.Provider value={value}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme() {
    const context = useContext(ThemeContext);
    if (!context) {
        throw new Error('useTheme must be used within ThemeProvider');
    }
    return context;
}
```

### Context Selector 패턴 (성능)

```typescript
// 큰 Context를 분리
const ThemeValueContext = createContext<Theme>('dark');
const ThemeActionsContext = createContext<ThemeActions | null>(null);

export function ThemeProvider({ children }) {
    const [theme, setTheme] = useState<Theme>('dark');

    // Actions는 메모이제이션
    const actions = useMemo(() => ({
        setTheme,
        toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
    }), []);

    return (
        <ThemeActionsContext.Provider value={actions}>
            <ThemeValueContext.Provider value={theme}>
                {children}
            </ThemeValueContext.Provider>
        </ThemeActionsContext.Provider>
    );
}

// 값만 필요한 경우 (값이 바뀔 때만 리렌더)
export const useThemeValue = () => useContext(ThemeValueContext);

// 액션만 필요한 경우 (리렌더 없음)
export const useThemeActions = () => useContext(ThemeActionsContext);
```

## 5. 이벤트 패턴

### Event Bus (Zustbus)

```typescript
import { createBus, Ping } from '@/lib/zustbus';

// 이벤트 타입 정의
type Events = {
    'toast:show': { message: string; type: 'success' | 'error' };
    'toast:hide': Ping;  // 데이터 없는 이벤트
    'modal:open': { component: React.ComponentType };
};

// 싱글톤 버스 생성
export const [emit, useOn, useValue] = createBus<Events>();

// 발행
emit('toast:show', { message: 'Saved!', type: 'success' });

// 구독
function ToastContainer() {
    useOn('toast:show', (data) => {
        showToast(data.message, data.type);
    });

    return <div id="toast-container" />;
}
```

### Observer 패턴 (클래스)

```typescript
class EventEmitter<T extends Record<string, any>> {
    #listeners = new Map<keyof T, Set<(data: any) => void>>();

    on<K extends keyof T>(event: K, callback: (data: T[K]) => void) {
        if (!this.#listeners.has(event)) {
            this.#listeners.set(event, new Set());
        }
        this.#listeners.get(event)!.add(callback);

        return () => this.#listeners.get(event)?.delete(callback);
    }

    emit<K extends keyof T>(event: K, data: T[K]) {
        this.#listeners.get(event)?.forEach((cb) => cb(data));
    }
}
```

## 6. 비동기 패턴

### Latch 패턴

여러 비동기 흐름을 단일 신호로 제어:

```typescript
import { Latch } from '@/lib/Latch';

// 사용 예: 초기화 완료 대기
const initLatch = new Latch();

async function initialize() {
    await loadConfig();
    await connectDatabase();
    initLatch.release(); // 초기화 완료 신호
}

async function doWork() {
    await initLatch.wait(); // 초기화 완료까지 대기
    // 작업 수행
}
```

### Async Queue 패턴

```typescript
class AsyncQueue {
    #queue: (() => Promise<void>)[] = [];
    #running = false;

    async add(task: () => Promise<void>) {
        this.#queue.push(task);
        if (!this.#running) {
            this.#process();
        }
    }

    async #process() {
        this.#running = true;
        while (this.#queue.length > 0) {
            const task = this.#queue.shift()!;
            await task();
        }
        this.#running = false;
    }
}
```

## 7. Feature-Sliced Design (FSD) 개요

대규모 프로젝트를 위한 아키텍처 방법론:

```
src/
├── app/          # 앱 초기화, 프로바이더
├── pages/        # 라우트 페이지
├── widgets/      # 독립적 UI 블록 (Header, Sidebar)
├── features/     # 사용자 시나리오 (login, search)
├── entities/     # 비즈니스 엔티티 (user, product)
└── shared/       # 공유 유틸, UI, API
```

### 레이어 규칙
- 상위 레이어만 하위 레이어 import 가능
- `pages` → `widgets` → `features` → `entities` → `shared`
- 같은 레이어 내 import 금지

### 현재 템플릿과 매핑
| FSD | 현재 템플릿 |
|-----|-------------|
| shared | `lib/`, `hooks/`, `types/`, `components/atoms/` |
| entities | (필요시 추가) |
| features | `features/` |
| widgets | `components/layout/` |
| pages | (필요시 추가) |
| app | `App.tsx`, `main.tsx` |

## 8. MVVM 패턴 개요

Model-View-ViewModel 패턴 (React 적용):

```
┌─────────────────────────────────────────────┐
│  View (React Component)                     │
│  - UI 렌더링                                 │
│  - 사용자 입력 처리                          │
└──────────────────┬──────────────────────────┘
                   │ 바인딩
┌──────────────────▼──────────────────────────┐
│  ViewModel (Custom Hook / Zustand)          │
│  - UI 상태 관리                              │
│  - View 로직                                 │
│  - Model 데이터 변환                         │
└──────────────────┬──────────────────────────┘
                   │ 호출
┌──────────────────▼──────────────────────────┐
│  Model (Service / API)                      │
│  - 비즈니스 로직                             │
│  - 데이터 페칭                               │
│  - 상태 영속화                               │
└─────────────────────────────────────────────┘
```

### React에서 적용

```typescript
// Model (service)
class UserService {
    async getUser(id: string): Promise<User> {
        return fetch(`/api/users/${id}`).then((r) => r.json());
    }
}

// ViewModel (hook)
function useUserViewModel(userId: string) {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        userService.getUser(userId)
            .then(setUser)
            .finally(() => setLoading(false));
    }, [userId]);

    return {
        user,
        loading,
        displayName: user ? `${user.firstName} ${user.lastName}` : '',
    };
}

// View (component)
function UserProfile({ userId }: { userId: string }) {
    const { displayName, loading } = useUserViewModel(userId);

    if (loading) return <Spinner />;
    return <h1>{displayName}</h1>;
}
```
