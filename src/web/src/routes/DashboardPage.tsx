// src/web/src/routes/DashboardPage.tsx — 利用状況ダッシュボード(設計 §11-4 DashboardPage)。
//
// - `/api/dashboard`(`useDashboard`)。期間フィルタ(全期間 / 今年 / 今月)。
// - `UsageCharts` で 3 グラフ + 最終利用日カード。データ 0 件でも 0 埋めで描画。
// - `skippedLogLines > 0` なら注記。
//
// main.tsx はこのファイルの default export をルート要素に結線している。default export 名は維持する。
//
// 規約: ESM / Bundler resolution / strict / verbatimModuleSyntax / React 19 / CSS Modules。

import { useMemo, useState, type ReactElement } from 'react';
import { ErrorState, Spinner } from '../components/ui/index.js';
import { UsageCharts } from '../components/UsageCharts.js';
import { useDashboard } from '../hooks/useDashboard.js';
import styles from './DashboardPage.module.css';

type Period = 'all' | 'year' | 'month';

const PERIODS: readonly { key: Period; label: string }[] = [
  { key: 'all', label: '全期間' },
  { key: 'year', label: '今年' },
  { key: 'month', label: '今月' },
];

/** 期間フィルタ → `/api/dashboard` の `from`(ISO date)。`to` は指定しない(現在まで)。 */
export function rangeForPeriod(period: Period, now: Date = new Date()): { from?: string } {
  if (period === 'all') return {};
  const y = now.getFullYear();
  if (period === 'year') return { from: `${y}-01-01` };
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return { from: `${y}-${m}-01` };
}

export default function DashboardPage(): ReactElement {
  const [period, setPeriod] = useState<Period>('all');
  const range = useMemo(() => rangeForPeriod(period), [period]);
  const query = useDashboard(range);

  return (
    <section aria-label="利用状況ダッシュボード">
      <h1>利用状況</h1>

      <div className={styles.filters} role="group" aria-label="期間フィルタ">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            type="button"
            aria-pressed={period === p.key}
            className={styles.filterButton}
            onClick={() => setPeriod(p.key)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {query.isPending ? (
        <Spinner label="利用状況を読み込み中" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          {query.data.skippedLogLines > 0 ? (
            <p className={styles.skipped} role="note">
              {query.data.skippedLogLines} 行のログを読み取れませんでした。集計から除外しています。
            </p>
          ) : null}
          <UsageCharts data={query.data} />
        </>
      )}
    </section>
  );
}
