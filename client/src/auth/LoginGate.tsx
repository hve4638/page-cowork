// 로그인·가입 신청 화면. 가입은 화이트리스트 이메일만 받고, 승인 전까지 로그인할 수 없다.
import { useState } from 'react';
import { login, signup, type Me } from './api';

export function LoginGate({ onLogin }: { onLogin: (me: Me) => void }) {
    const [mode, setMode] = useState<'login' | 'signup'>('login');
    const [email, setEmail] = useState('');
    const [loginId, setLoginId] = useState('');
    const [pw, setPw] = useState('');
    const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
    const [busy, setBusy] = useState(false);

    const submit = async () => {
        if (busy) return;
        setBusy(true);
        setMessage(null);
        try {
            if (mode === 'login') {
                const { ok, data } = await login(loginId, pw);
                if (ok) onLogin(data['user'] as Me);
                else setMessage({ error: true, text: data.error ?? '로그인에 실패했습니다.' });
            } else {
                const { ok, data } = await signup(email, loginId, pw);
                if (ok) {
                    setMode('login');
                    setMessage({ error: false, text: '가입 신청이 접수되었습니다. 관리자 승인 후 로그인할 수 있습니다.' });
                } else {
                    setMessage({ error: true, text: data.error ?? '가입 신청에 실패했습니다.' });
                }
            }
        } finally {
            setBusy(false);
        }
    };

    const inputClass = 'w-full text-sm px-2.5 py-1.5 border border-black/20 rounded';

    return (
        <div className="flex items-center justify-center h-full">
            <div className="w-[320px] border border-black/10 rounded-md p-6 shadow-sm">
                <h1 className="text-xl font-bold mb-4">cowork</h1>
                <div className="flex gap-1 mb-4 text-sm">
                    {(['login', 'signup'] as const).map(m => (
                        <button
                            key={m}
                            className={`px-3 py-1 rounded cursor-pointer ${mode === m ? 'bg-[#2e6ee1] text-white' : 'bg-[#f0f0ee]'}`}
                            onClick={() => { setMode(m); setMessage(null); }}
                        >{m === 'login' ? '로그인' : '가입 신청'}</button>
                    ))}
                </div>
                <form
                    className="flex flex-col gap-2"
                    onSubmit={e => { e.preventDefault(); submit(); }}
                >
                    {mode === 'signup' && (
                        <input className={inputClass} type="email" placeholder="이메일" value={email} onChange={e => setEmail(e.target.value)} />
                    )}
                    <input className={inputClass} placeholder="아이디" value={loginId} onChange={e => setLoginId(e.target.value)} />
                    <input className={inputClass} type="password" placeholder="비밀번호" value={pw} onChange={e => setPw(e.target.value)} />
                    <button
                        className="mt-1 text-sm py-1.5 rounded bg-[#2e6ee1] text-white cursor-pointer disabled:opacity-50"
                        type="submit"
                        disabled={busy}
                    >{mode === 'login' ? '로그인' : '가입 신청'}</button>
                </form>
                {message && (
                    <p className={`mt-3 text-[13px] ${message.error ? 'text-[#bb3322]' : 'text-[#2e6ee1]'}`}>{message.text}</p>
                )}
            </div>
        </div>
    );
}
