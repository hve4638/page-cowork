import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'

function alias(find: string, replacement: string) {
    return {
        find: find,
        replacement: path.resolve(__dirname, replacement)
    }
}

// 워크트리에서 main 과 나란히 띄울 수 있도록 PORT(vite)·API_PORT(서버) 환경변수를 받는다
const API_PORT = process.env.API_PORT ?? '8771'

export default defineConfig({
    base: './',
    server: {
        port: Number(process.env.PORT ?? 8770),
        host: '0.0.0.0',
        proxy: {
            '/api': `http://127.0.0.1:${API_PORT}`,
            '/sync': { target: `ws://127.0.0.1:${API_PORT}`, ws: true },
        },
    },
    plugins: [
        react({
            babel: {
                plugins: [
                    ['babel-plugin-react-compiler'],
                ],
            },
        }),
        tailwindcss(),
    ],
    resolve: {
        alias: [
            alias('@', 'src'),
            alias('components', 'src/components'),
            alias('context', 'src/context'),
            alias('utils', 'src/utils'),
            alias('lib', 'src/lib'),
            alias('types', 'src/types'),
            alias('hooks', 'src/hooks'),
            alias('assets', 'src/assets'),
            alias('pages', 'src/pages'),
            alias('features', 'src/features'),
            alias('stores', 'src/stores'),
            alias('constants', 'src/constants'),
        ]
    }
})
