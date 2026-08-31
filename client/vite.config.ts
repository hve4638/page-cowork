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

export default defineConfig({
    base: './',
    server: {
        port: 8770,
        host: '0.0.0.0',
        proxy: {
            '/api': 'http://127.0.0.1:8771',
            '/sync': { target: 'ws://127.0.0.1:8771', ws: true },
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
