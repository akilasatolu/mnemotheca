// src/web/src/components/CategoryTree.tsx — 左ペインのカテゴリツリー(設計 §11-3 / §11-4 / §13-15)。
//
// - `/api/categories` の `CategoryNode[]` を再帰表示。ルート(「すべて」)含む。
// - `_uncategorized`(未分類)は末尾固定表示。
// - 各ノードに件数バッジ(`noteCount`)。
// - 選択状態は props(URL クエリ `?category=` 由来)。選択でその経路を `onSelect` に渡す。
// - 折りたたみ状態は `localStorage['mnemo.tree.collapsed']`(経路の JSON 配列)に永続化。

import { useCallback, useState, type ReactElement } from 'react';
import type { CategoryNode } from '../api.js';
import styles from './CategoryTree.module.css';

const COLLAPSED_KEY = 'mnemo.tree.collapsed';
export const UNCATEGORIZED = '_uncategorized';

function readCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    if (raw === null || raw === '') return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

function writeCollapsed(set: Set<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
  } catch {
    /* private mode 等では黙って諦める(表示は動く) */
  }
}

interface TreeProps {
  tree: CategoryNode[];
  uncategorizedCount: number;
  selected: string | null;
  onSelect: (path: string | null) => void;
}

export function CategoryTree({ tree, uncategorizedCount, selected, onSelect }: TreeProps): ReactElement {
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);

  const toggle = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      writeCollapsed(next);
      return next;
    });
  }, []);

  const renderNode = (node: CategoryNode, depth: number): ReactElement => {
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsed.has(node.path);
    const isSelected = selected === node.path;
    return (
      <li key={node.path}>
        <div className={styles.row} style={{ paddingLeft: depth * 12 }}>
          {hasChildren ? (
            <button
              type="button"
              className={styles.toggle}
              aria-label={isCollapsed ? `${node.title} を展開` : `${node.title} を折りたたむ`}
              aria-expanded={!isCollapsed}
              onClick={() => toggle(node.path)}
            >
              {isCollapsed ? '▸' : '▾'}
            </button>
          ) : (
            <span className={styles.spacer} />
          )}
          <button
            type="button"
            className={styles.node}
            onClick={() => onSelect(node.path)}
            aria-current={isSelected ? 'true' : undefined}
            data-selected={isSelected ? 'true' : undefined}
          >
            <span>{node.title}</span>
            <span className={styles.badge} aria-label={`${node.title} のノート件数`}>
              {node.noteCount}
            </span>
          </button>
        </div>
        {hasChildren && !isCollapsed ? (
          <ul className={styles.list}>{node.children.map((child) => renderNode(child, depth + 1))}</ul>
        ) : null}
      </li>
    );
  };

  return (
    <nav aria-label="カテゴリ">
      <ul className={styles.list}>
        <li>
          <div className={styles.row}>
            <span className={styles.spacer} />
            <button
              type="button"
              className={styles.node}
              onClick={() => onSelect(null)}
              aria-current={selected === null ? 'true' : undefined}
              data-selected={selected === null ? 'true' : undefined}
            >
              すべて
            </button>
          </div>
        </li>
        {tree.map((node) => renderNode(node, 0))}
        <li>
          <div className={styles.row}>
            <span className={styles.spacer} />
            <button
              type="button"
              className={styles.node}
              onClick={() => onSelect(UNCATEGORIZED)}
              aria-current={selected === UNCATEGORIZED ? 'true' : undefined}
              data-selected={selected === UNCATEGORIZED ? 'true' : undefined}
            >
              <span>未分類</span>
              <span className={styles.badge} aria-label="未分類のノート件数">
                {uncategorizedCount}
              </span>
            </button>
          </div>
        </li>
      </ul>
    </nav>
  );
}
