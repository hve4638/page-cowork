// /login·/signup 화면. 가입은 화이트리스트 이메일만 받고, 승인 전까지 로그인할 수 없다.
import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { login, signup, type Me } from './api';
import './login.css';

type Mode = 'login' | 'signup';
type LocationState = { from?: string; notice?: string } | null;

// 비로그인 상태로 보호된 경로에 왔을 때 /login 으로 보낸다. 가려던 경로는 state.from 에 실어
// 로그인 성공 후 그 자리로 돌려보낸다.
export function RedirectToLogin() {
    const location = useLocation();
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
}

// 세션이 있으면 화면을 그리지 않고 돌려보낸다: 리다이렉트로 왔다면 가려던 경로로, 직접 접근이면 /p/cowork 로.
export function LoginPage({ me, onLogin, mode = 'login' }: { me: Me | null; onLogin: (me: Me) => void; mode?: Mode }) {
    const state = useLocation().state as LocationState;
    if (me) return <Navigate to={state?.from ?? '/p/cowork'} replace />;
    return <AuthForm key={mode} mode={mode} onLogin={onLogin} notice={state?.notice} />; // key: 모드 전환 시 입력값을 비운다
}

function AuthForm({ mode, onLogin, notice }: { mode: Mode; onLogin: (me: Me) => void; notice?: string }) {
    const navigate = useNavigate();
    const [email, setEmail] = useState('');
    const [name, setName] = useState('');
    const [pw, setPw] = useState('');
    const [pw2, setPw2] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const isLogin = mode === 'login';

    const submit = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            if (isLogin) {
                const { ok, data } = await login(email, pw);
                if (ok) onLogin(data['user'] as Me);
                else setError(data.error ?? '로그인에 실패했습니다.');
            } else {
                if (pw !== pw2) { setError('비밀번호 확인이 일치하지 않습니다.'); return; }
                const { ok, data } = await signup(email, name, pw);
                // 가입 성공 안내는 /login 으로 넘어가면서 state 로 전달한다
                if (ok) navigate('/login', { state: { notice: '회원 가입이 접수되었습니다. 관리자 승인 후 로그인할 수 있습니다.' } });
                else setError(data.error ?? '회원 가입에 실패했습니다.');
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="login-page">
            <div className="login-brand">cowork</div>
            <div className="login-body">
                <div className="login-box">
                    <h1 className="login-title">{isLogin ? '로그인' : '회원 가입'}</h1>
                    <form onSubmit={e => { e.preventDefault(); submit(); }}>
                        <div className="login-field">
                            <label htmlFor="login-email">이메일</label>
                            <input id="login-email" className="login-input" type="email" placeholder="name@example.com" autoComplete="email" autoFocus value={email} onChange={e => setEmail(e.target.value)} />
                        </div>
                        {!isLogin && (
                            <div className="login-field">
                                <label htmlFor="login-name">닉네임</label>
                                <input id="login-name" className="login-input" placeholder="닉네임" autoComplete="nickname" maxLength={40} value={name} onChange={e => setName(e.target.value)} />
                            </div>
                        )}
                        <div className="login-field">
                            <label htmlFor="login-pw">비밀번호</label>
                            <input id="login-pw" className="login-input" type="password" placeholder="비밀번호" autoComplete={isLogin ? 'current-password' : 'new-password'} value={pw} onChange={e => setPw(e.target.value)} />
                        </div>
                        {!isLogin && (
                            <div className="login-field">
                                <label htmlFor="login-pw2">비밀번호 확인</label>
                                <input id="login-pw2" className="login-input" type="password" placeholder="비밀번호 확인" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} />
                            </div>
                        )}
                        <button className="login-submit" type="submit" disabled={busy}>
                            {isLogin ? '로그인' : '회원 가입'}
                        </button>
                    </form>
                    {error && <p className="login-message is-error">{error}</p>}
                    {!error && notice && <p className="login-message">{notice}</p>}
                    <div className="login-switch">
                        {isLogin
                            ? <>계정이 없으신가요?<Link to="/signup">회원 가입</Link></>
                            : <>이미 계정이 있으신가요?<Link to="/login">로그인</Link></>}
                    </div>
                </div>
            </div>
        </div>
    );
}
