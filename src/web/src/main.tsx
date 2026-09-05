// src/web/src/main.tsx — SPA エントリ(設計 §11-1 / §11-3)。
//   QueryClientProvider + AuthProvider + ToastProvider + RouterProvider(createBrowserRouter)。
//
// ルート定義(`appRoutes`)はテストからも使えるよう export する。
// 画面コンポーネント(CategoryListPage 等)は各 `routes/*.tsx` に実装されている
// (各ファイルは default export を維持していれば main.tsx の変更は不要)。

import './styles/theme.css';
import './styles/markdown.css';
import { StrictMode, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider, type RouteObject } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext.js';
import { ToastProvider } from './context/ToastContext.js';
import { reportApiError } from './components/GlobalErrorBanner.js';
import { AppShell } from './routes/AppShell.js';
import { NotFoundPage } from './routes/NotFoundPage.js';
import CategoryListPage from './routes/CategoryListPage.js';
import NoteViewPage from './routes/NoteViewPage.js';
import SearchPage from './routes/SearchPage.js';
import DashboardPage from './routes/DashboardPage.js';
import SettingsPage from './routes/SettingsPage.js';

export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <CategoryListPage /> },
      { path: 'note/:id', element: <NoteViewPage /> },
      { path: 'search', element: <SearchPage /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

/** アプリ用の QueryClient。vault 503 は QueryCache.onError → GlobalErrorBanner に流す。 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: reportApiError }),
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false },
    },
  });
}

export function AppProviders({
  client,
  children,
}: {
  client: QueryClient;
  children: ReactElement;
}): ReactElement {
  return (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <ToastProvider>{children}</ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

function mount(): void {
  const container = document.getElementById('root');
  if (container === null) return;
  const router = createBrowserRouter(appRoutes);
  const client = createQueryClient();
  createRoot(container).render(
    <StrictMode>
      <AppProviders client={client}>
        <RouterProvider router={router} />
      </AppProviders>
    </StrictMode>,
  );
}

mount();
