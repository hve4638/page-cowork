# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

React 19 frontend template using TypeScript, Vite, Zustand, and Tailwind CSS 4. Documentation and responses should be in Korean (per project convention).

## Commands

- **Dev server:** `pnpm dev` (port 8680)
- **Build:** `pnpm build` (runs `tsc -b && vite build`)
- **Type check only:** `pnpm check:build`
- **Lint:** `pnpm lint`
- **Preview production build:** `pnpm preview`

Package manager is **pnpm** (>=9.0.0, Node >=20.0.0). Do not use npm or yarn.

## Architecture

### State Management
Two Zustand stores with distinct purposes:
- `useAppStore` — ephemeral runtime state (theme, loading)
- `useConfigStore` — localStorage-persisted user preferences (fontSize, language, sidebarOpen) via Zustand `persist` middleware

### Styling (3 layers)
1. **Tailwind CSS 4** — primary utility classes, with `tailwind-merge` for conflict resolution
2. **CSS Modules** (`*.module.css`) — component-scoped styles
3. **CSS Variables** — theme system (`--text-primary`, `--bg-primary`, `--border-primary`, etc.) toggled via `theme-dark`/`theme-light` class

Class composition uses the `cn` utility (wraps `clsx`).

### Component Architecture (Atomic Design)
- `components/atoms/` — primitives (Button, Input, CheckBox, Dropdown, Slider)
- `components/container/` — container components (ListView, InfiniteScroll)
- `components/layout/` — layout primitives (Flex, Grid, Row, Column, Center, Gap)
- `features/` — self-contained feature modules with own components, hooks, context, and types

### Modal System
Context-based with stack management and focus locking. Programmatic API via `useModal()` hook.

### Event Bus
Custom `zustbus` library at `lib/zustbus/` with type-safe hooks: `useOn()`, `useValue()`.

### Path Aliases
`@/*` maps to `src/*`. Direct aliases also exist: `components`, `hooks`, `stores`, `utils`, `features`, `pages`, `assets`, `constants`, `context`, `lib`, `types`.

## Key Conventions (from CONVENTION.md)

- **No native HTML elements** — use atoms (Button, Input, CheckBox, Dropdown, Slider) and layout components instead of raw `<button>`, `<input>`, `<div>` for layout
- **Named exports only** — no default exports
- **Enum pattern** — use `const X = {} as const` + `typeof` instead of TypeScript `enum`
- **Import order** — third-party → type imports → internal (`@/`) → relative (`./`)
- **Cross-directory imports** — always use `@/` alias; relative imports only for siblings/children
- **Barrel exports** — every directory has `index.ts`; import from barrels, not deep paths
- **String quotes** — single quotes (`'`)
- **Component files** — PascalCase; utilities/hooks — camelCase

### Component File Structure
```
ComponentName/
├── index.ts                    # export and style import
├── ComponentName.tsx           # main component
├── ComponentName.module.scss   # styles
├── types.ts                    # types (if needed)
└── utils.ts                    # utilities (if needed)
```

## Important Notes

- **React Compiler** is enabled via `babel-plugin-react-compiler` — avoid manual memoization patterns that conflict with it
- **No test framework** is currently configured
- **`@typescript-eslint/no-explicit-any`** is turned off — `any` usage is permitted
