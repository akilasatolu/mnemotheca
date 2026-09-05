// src/web/src/components/IssuesBanner.tsx — /api/health/issues の警告表示(設計 §11-3 / §11-4 / §13-15)。
//
// 重要: `organizeRecoveryPending` は「案内のみ」。自動 restore ボタンは置かない
//       (破壊的操作は MCP 経由の明示承認のみ。設計 §11-4 セクション 4 / §13-15)。

import type { ReactElement, ReactNode } from 'react';
import styles from '../styles/app.module.css';
import { useIssues } from '../hooks/useIssues.js';

export function IssuesBanner(): ReactElement | null {
  const { data } = useIssues();
  if (data === undefined) return null;

  const rows: ReactNode[] = [];

  if (data.organizeRecoveryPending !== null) {
    const { snapshotId, since } = data.organizeRecoveryPending;
    rows.push(
      <li key="organize">
        <strong>organize が中断されたままです</strong>(snapshot {snapshotId}, {since})。
        元に戻すには Claude に「前回の整理を取り消して」と伝えてください。
        中断状態のまま進めたい場合は次の organize 時に Claude がスキップします。
      </li>,
    );
  }

  if (data.watcherDown) {
    rows.push(
      <li key="watcher">
        ファイル監視停止 — 変更後は設定の「差分更新」を押してください。
      </li>,
    );
  }

  if (data.parseErrors.length > 0) {
    rows.push(<li key="parse">frontmatter を解析できないノート: {data.parseErrors.length} 件</li>);
  }

  if (data.conflicts.length > 0) {
    rows.push(<li key="conflict">重複の可能性があるノート: {data.conflicts.length} 件</li>);
  }

  if (data.indexStale > 0) {
    rows.push(<li key="stale">インデックス未反映のノート: {data.indexStale} 件</li>);
  }

  if (data.vaultMarkerMissing) {
    rows.push(<li key="marker">vault マーカー(.mnemotheca-vault.json)が見つかりません</li>);
  }

  if (data.nodeModulesMissing) {
    rows.push(<li key="nodemodules">本体(node_modules/mnemo)が見つかりません(npm install を実行)</li>);
  }

  if (rows.length === 0) return null;

  return (
    <aside className={styles.issuesBanner} role="status" aria-label="診断">
      <ul>{rows}</ul>
    </aside>
  );
}
