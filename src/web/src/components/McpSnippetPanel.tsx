// src/web/src/components/McpSnippetPanel.tsx — MCP 連携スニペット表示(設計 §11-4 セクション2 / §9-5)。
//
// - `?client` タブ(desktop / code)。既定 desktop。
// - `GET /api/config/mcp-snippet?client=` を `useMcpSnippet(client)`(hooks/queries.ts)で取得。
// - 表示: サーバーキー(`mnemotheca-<projectSlug>`)、スニペット全文、コピーボタン、
//   貼り付け先ファイル(`claude_desktop_config.json` / `.mcp.json`)、複数プロジェクト注記。
// - コピーは `navigator.clipboard.writeText`(テストではモック)。
//
// 規約: ESM / Bundler resolution / strict / verbatimModuleSyntax / React 19 / CSS Modules。

import { useState, type ReactElement } from 'react';
import { useMcpSnippet } from '../hooks/queries.js';
import { Button, ErrorState, Spinner } from './ui/index.js';
import styles from './McpSnippetPanel.module.css';

type Client = 'desktop' | 'code';

const CLIENT_TABS: readonly { key: Client; label: string }[] = [
  { key: 'desktop', label: 'Claude Desktop' },
  { key: 'code', label: 'Claude Code' },
];

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function McpSnippetPanel(): ReactElement {
  const [client, setClient] = useState<Client>('desktop');
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);

  const query = useMcpSnippet(client);

  const onCopy = (): void => {
    if (query.data === undefined) return;
    void copyText(query.data.snippet).then((ok) => setCopied(ok ? 'ok' : 'fail'));
  };

  return (
    <div data-testid="mcp-snippet-panel">
      <div className={styles.tabs} role="tablist" aria-label="MCP クライアント">
        {CLIENT_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={client === t.key}
            className={styles.tab}
            onClick={() => {
              setClient(t.key);
              setCopied(null);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {query.isPending ? (
        <Spinner />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <dl className={styles.dl}>
            <dt className={styles.term}>サーバーキー</dt>
            <dd className={styles.value}>
              <code>{query.data.serverKey}</code>
            </dd>
            <dt className={styles.term}>貼り付け先ファイル</dt>
            <dd className={styles.value}>
              <code>{query.data.filename}</code>
            </dd>
          </dl>

          <pre className={styles.snippet} data-testid="mcp-snippet-text">
            {query.data.snippet}
          </pre>

          <div className={styles.copyRow}>
            <Button variant="primary" onClick={onCopy}>
              スニペットをコピー
            </Button>
            {copied === 'ok' ? <span role="status">コピーしました</span> : null}
            {copied === 'fail' ? <span role="status">コピーできませんでした(手動で選択してください)</span> : null}
          </div>

          <p className={styles.note}>
            既存の Claude 設定がある場合は <code>mcpServers</code> にこのキーを追記してください(既存キーは消さない)。
            複数の Mnemotheca プロジェクトを使う場合、各プロジェクトのスニペットを同じ <code>mcpServers</code> に
            別キーで追記してください(このキーはプロジェクトごとに自動で一意化されています)。
          </p>
        </>
      )}
    </div>
  );
}

export default McpSnippetPanel;
