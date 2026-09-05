// src/web/src/components/UsageCharts.tsx — 利用状況グラフ群(設計 §11-4 DashboardPage / §11-3)。
//
// recharts で 3 種のグラフ + 最終利用日カードを描画する:
//   (1) 保存件数推移(日次・棒)         … data.storeCountByDay
//   (2) カテゴリ別ノート数(横棒)        … data.notesByCategory
//   (3) モード別回数(月次・積み上げ棒)  … data.modeCountByMonth
//   (4) 最終利用日(store/organize/show) … data.lastUsedAt(カード表示)
//
// データが 0 件でも「0 埋め」でグラフ枠(<svg>)を必ず描画する(設計 §11-4 / §13-15)。
//
// テスト容易性: jsdom では `ResponsiveContainer` が 0 サイズになり <svg> が出ないため、
// `width` / `height` を prop で受け取れるようにしている。値が渡された場合は固定サイズの
// チャートを描画し、未指定なら `ResponsiveContainer`(実ブラウザ)を使う。
//
// 規約: ESM / Bundler resolution / strict / verbatimModuleSyntax / React 19 / CSS Modules。

import { cloneElement, type ReactElement } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DashboardResponse } from '../api.js';
import styles from './UsageCharts.module.css';

export interface UsageChartsProps {
  data: DashboardResponse;
  /** テスト用の固定幅。未指定なら ResponsiveContainer を使う。 */
  width?: number;
  /** チャート高さ(既定 240)。 */
  height?: number;
}

const CATEGORY_COLORS = ['#4c6ef5', '#12b886', '#f59f00', '#e8590c', '#ae3ec9', '#1098ad', '#748ffc'];

/** 固定 width が渡されたら固定サイズで、なければ ResponsiveContainer でラップする。 */
function Sized({
  width,
  height,
  children,
}: {
  width: number | undefined;
  height: number;
  children: ReactElement<{ width?: number; height?: number }>;
}): ReactElement {
  if (width !== undefined) {
    return cloneElement(children, { width, height });
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      {children}
    </ResponsiveContainer>
  );
}

function fmtDateTime(iso: string | null): string {
  if (iso === null) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString();
}

const LAST_USED: readonly [keyof DashboardResponse['lastUsedAt'], string][] = [
  ['store', '保存(store)'],
  ['organize', '整理(organize)'],
  ['show', '表示(show)'],
];

export function UsageCharts({ data, width, height = 240 }: UsageChartsProps): ReactElement {
  const storeByDay = data.storeCountByDay;
  const byCategory = data.notesByCategory;
  const byMonth = data.modeCountByMonth;

  return (
    <div className={styles.root} data-testid="usage-charts">
      <section className={styles.section} aria-label="最終利用日">
        <h2 className={styles.heading}>最終利用日</h2>
        <div className={styles.cards}>
          {LAST_USED.map(([key, label]) => (
            <div key={key} className={styles.card} data-testid={`last-used-${key}`}>
              <div className={styles.cardLabel}>{label}</div>
              <div>{fmtDateTime(data.lastUsedAt[key])}</div>
            </div>
          ))}
        </div>
      </section>

      <figure className={styles.figure} aria-label="保存件数の推移">
        <figcaption className={styles.figcaption}>保存件数の推移(日次)</figcaption>
        <Sized width={width} height={height}>
          <BarChart data={storeByDay}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="date" />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Bar dataKey="count" name="保存件数" fill="#4c6ef5" />
          </BarChart>
        </Sized>
      </figure>

      <figure className={styles.figure} aria-label="カテゴリ別ノート数">
        <figcaption className={styles.figcaption}>カテゴリ別ノート数</figcaption>
        <Sized width={width} height={height}>
          <BarChart data={byCategory} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis type="number" allowDecimals={false} />
            <YAxis type="category" dataKey="category" width={120} />
            <Tooltip />
            <Bar dataKey="count" name="ノート数">
              {byCategory.map((entry, i) => (
                <Cell key={entry.category} fill={CATEGORY_COLORS[i % CATEGORY_COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </Sized>
      </figure>

      <figure className={styles.figure} aria-label="モード別回数">
        <figcaption className={styles.figcaption}>モード別回数(月次・積み上げ)</figcaption>
        <Sized width={width} height={height}>
          <BarChart data={byMonth}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="month" />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Legend />
            <Bar dataKey="store" stackId="m" name="保存" fill="#4c6ef5" />
            <Bar dataKey="organize" stackId="m" name="整理" fill="#12b886" />
            <Bar dataKey="show" stackId="m" name="表示" fill="#f59f00" />
          </BarChart>
        </Sized>
      </figure>
    </div>
  );
}

export default UsageCharts;
