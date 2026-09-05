// src/web/src/routes/AppShell.tsx — レイアウト(設計 §11-2 / §11-3)。
// <Outlet/> + SideNav + HeaderSearch + GlobalErrorBanner + IssuesBanner + <Toaster/>。

import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { NavLink, Outlet, useNavigate, useSearchParams } from 'react-router-dom';
import styles from '../styles/app.module.css';
import { GlobalErrorBanner } from '../components/GlobalErrorBanner.js';
import { IssuesBanner } from '../components/IssuesBanner.js';
import { Toaster } from '../context/ToastContext.js';
import { useServerEvents } from '../hooks/useServerEvents.js';

const NAV = [
  { to: '/', label: '一覧', end: true },
  { to: '/search', label: '検索', end: false },
  { to: '/dashboard', label: 'ダッシュボード', end: false },
  { to: '/settings', label: '設定', end: false },
] as const;

export function AppShell(): ReactElement {
  useServerEvents();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [q, setQ] = useState(searchParams.get('q') ?? '');

  // SearchPage 側(SearchBox のデバウンス発火や直リンク)で URL `?q=` が変わったら
  // ヘッダー入力もそれに追従させる(HeaderSearch ↔ SearchPage の整合。§11-4)。
  useEffect(() => {
    setQ(searchParams.get('q') ?? '');
  }, [searchParams]);

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    const term = q.trim();
    if (term !== '') navigate(`/search?q=${encodeURIComponent(term)}`);
  };

  return (
    <div className={styles.shell}>
      <aside className={styles.sidenav}>
        <nav aria-label="メインナビゲーション">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>
              {n.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className={styles.main}>
        <header className={styles.header}>
          <form role="search" onSubmit={onSubmit}>
            <input
              type="search"
              aria-label="キーワード検索"
              placeholder="キーワード検索(Enter)"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </form>
        </header>
        <GlobalErrorBanner />
        <IssuesBanner />
        <main className={styles.content}>
          <Outlet />
        </main>
      </div>
      <Toaster />
    </div>
  );
}
