// src/web/src/routes/SettingsPage.tsx — 設定画面(設計 §11-4 SettingsPage の 6 セクション)。
//
//   1. プロジェクト情報   … ProjectInfoPanel(表示のみ)
//   2. MCP 連携           … McpSnippetPanel
//   3. 再インデックス     … 差分 / 完全、POST /api/reindex、スピナー + 完了トースト
//   4. 診断               … GET /api/health/issues の全フィールド + 対処法
//   5. バージョン情報     … healthz の生 JSON(折りたたみ)
//   6. 既知の制限         … 静的テキスト
//
// main.tsx はこのファイルの default export をルート要素に結線している。default export 名は維持する。
//
// 規約: ESM / Bundler resolution / strict / verbatimModuleSyntax / React 19 / CSS Modules。

import { type ReactElement, type ReactNode } from 'react';
import { Button, Card, ErrorState, Spinner } from '../components/ui/index.js';
import { McpSnippetPanel } from '../components/McpSnippetPanel.js';
import { ProjectInfoPanel } from '../components/ProjectInfoPanel.js';
import { useToast } from '../context/ToastContext.js';
import { useConfig } from '../hooks/useConfig.js';
import { useHealthz, useIssues, useReindex } from '../hooks/queries.js';

import styles from './SettingsPage.module.css';

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {children}
    </section>
  );
}

function ReindexControls(): ReactElement {
  const toast = useToast();
  const reindex = useReindex();
  const pendingFull = reindex.isPending ? reindex.variables?.full === true : null;

  const run = (full: boolean): void => {
    reindex.mutate(
      { full },
      {
        onSuccess: (r) => {
          toast.push(
            `再インデックス完了(追加 ${r.added} / 更新 ${r.updated} / 削除 ${r.removed})`,
            'success',
          );
        },
        onError: (e: unknown) => {
          toast.push(e instanceof Error ? e.message : '再インデックスに失敗しました', 'error');
        },
      },
    );
  };

  return (
    <div className={styles.row}>
      <Button onClick={() => run(false)} loading={pendingFull === false} disabled={reindex.isPending}>
        差分更新
      </Button>
      <Button onClick={() => run(true)} loading={pendingFull === true} disabled={reindex.isPending}>
        完全再構築
      </Button>
    </div>
  );
}

function DiagnosticsList(): ReactElement {
  const { data, isPending, isError, error, refetch } = useIssues();

  if (isPending) return <Spinner label="診断を読み込み中" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const rows: ReactNode[] = [];

  if (data.parseErrors.length > 0) {
    rows.push(
      <li key="parse">
        frontmatter を解析できないノート: <strong>{data.parseErrors.length} 件</strong> —
        対処: 該当ファイルの frontmatter を修正するか <code>mnemo doctor --fix</code> を実行。
      </li>,
    );
  }
  if (data.conflicts.length > 0) {
    rows.push(
      <li key="conflict">
        重複の可能性があるノート: <strong>{data.conflicts.length} 件</strong> —
        対処: 内容を確認し不要な方を削除、または統合。
      </li>,
    );
  }
  if (data.vaultMarkerMissing) {
    rows.push(
      <li key="marker">
        vault マーカー(<code>.mnemotheca-vault.json</code>)が見つかりません —
        対処: projectRoot 内で <code>mnemo doctor --fix</code> を実行。
      </li>,
    );
  }
  if (data.nodeModulesMissing) {
    rows.push(
      <li key="nodemodules">
        本体(<code>node_modules/mnemo</code>)が見つかりません —
        対処: projectRoot 内で <code>npm install</code> を実行。
      </li>,
    );
  }
  if (data.indexStale > 0) {
    rows.push(
      <li key="stale">
        インデックス未反映のノート: <strong>{data.indexStale} 件</strong> —
        対処: 下の「差分更新」を押してください。
      </li>,
    );
  }
  if (data.watcherDown) {
    rows.push(
      <li key="watcher">
        ファイル監視が停止しています — 変更後は下の「差分更新」を押してください。
      </li>,
    );
  }
  if (data.organizeRecoveryPending !== null) {
    const { snapshotId, since } = data.organizeRecoveryPending;
    rows.push(
      <li key="organize">
        <strong>organize が中断されたままです</strong>(snapshot <code>{snapshotId}</code>, {since})。
        元に戻すには Claude に「前回の整理を取り消して」と伝えてください。
        中断状態のまま進めたい場合は次の organize 時に Claude がスキップします。
        {/* 破壊的操作は MCP 経由の明示承認のみ。UI からの自動 restore ボタンは出さない(§13-15)。 */}
      </li>,
    );
  }

  if (rows.length === 0) {
    return <p className={styles.ok}>問題は見つかりませんでした。</p>;
  }

  return (
    <div>
      <ul className={styles.issues}>{rows}</ul>
      <p className={styles.hint}>
        まとめて修正するには projectRoot 内で <code>mnemo doctor --fix</code> を実行してください。
      </p>
    </div>
  );
}

function VersionInfo(): ReactElement {
  const config = useConfig();
  const healthz = useHealthz();

  const version =
    typeof healthz.data?.version === 'string' && healthz.data.version !== ''
      ? healthz.data.version
      : healthz.isError
        ? 'バージョン情報を取得できません'
        : '取得中…';

  return (
    <div>
      <dl className={styles.dl}>
        <dt className={styles.term}>バージョン</dt>
        <dd className={styles.value}>{version}</dd>
        <dt className={styles.term}>projectRoot</dt>
        <dd className={styles.value}>
          <code>{config.data?.projectRoot ?? '—'}</code>
        </dd>
        <dt className={styles.term}>vault パス</dt>
        <dd className={styles.value}>
          <code>{config.data?.vaultPath ?? '—'}</code>
        </dd>
      </dl>
      <details>
        <summary className={styles.summary}>healthz の生 JSON</summary>
        <pre className={styles.raw} data-testid="healthz-raw">
          {healthz.data !== undefined
            ? JSON.stringify(healthz.data, null, 2)
            : healthz.isError
              ? '(healthz を取得できませんでした)'
              : '(取得中)'}
        </pre>
      </details>
    </div>
  );
}

export default function SettingsPage(): ReactElement {
  const config = useConfig();
  const issues = useIssues();

  return (
    <section aria-label="設定">
      <h1>設定</h1>

      <Section title="1. プロジェクト情報">
        {config.isPending ? (
          <Spinner label="設定を読み込み中" />
        ) : config.isError ? (
          <ErrorState error={config.error} onRetry={() => void config.refetch()} />
        ) : (
          <Card>
            <ProjectInfoPanel config={config.data} nodeModulesMissing={issues.data?.nodeModulesMissing} />
          </Card>
        )}
      </Section>

      <Section title="2. MCP 連携">
        <Card>
          <McpSnippetPanel />
        </Card>
      </Section>

      <Section title="3. 再インデックス">
        <ReindexControls />
      </Section>

      <Section title="4. 診断">
        <DiagnosticsList />
      </Section>

      <Section title="5. バージョン情報">
        <VersionInfo />
      </Section>

      <Section title="6. 既知の制限">
        <ul className={styles.limits}>
          <li>vault 内アセット(<code>![](attachments/x.png)</code> など)は現状表示されません。</li>
          <li>ノートの編集は Web UI では行えません(テキストエディタで編集してください)。</li>
          <li>検索はキーワード(部分一致)検索です。意味の近さでは検索しません。</li>
        </ul>
      </Section>
    </section>
  );
}
