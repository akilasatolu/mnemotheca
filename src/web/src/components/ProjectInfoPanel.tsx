// src/web/src/components/ProjectInfoPanel.tsx — プロジェクト情報の表示専用パネル(設計 §11-4 セクション1)。
//
// projectRoot / vault パス / 本体(`node_modules/mnemo`)の有無を **表示のみ** で示す。
// 入力要素・変更操作は一切置かない(設計 §10-1 に config 更新 API が無い。§13-15)。
//
// 本体の有無は `/api/config` に含まれないため、`/api/health/issues` の
// `nodeModulesMissing` を親(SettingsPage)から prop で受け取る。
//
// 規約: ESM / Bundler resolution / strict / verbatimModuleSyntax / React 19 / CSS Modules。

import type { ReactElement } from 'react';
import type { ConfigResponse } from '../api.js';
import styles from './ProjectInfoPanel.module.css';

export interface ProjectInfoPanelProps {
  config: ConfigResponse;
  /** `/api/health/issues.nodeModulesMissing`。未取得時は undefined(「確認中」表示)。 */
  nodeModulesMissing?: boolean;
}

function nodeModulesLabel(missing: boolean | undefined): string {
  if (missing === undefined) return '確認中…';
  return missing ? 'なし(`npm install` を実行してください)' : 'あり';
}

export function ProjectInfoPanel({ config, nodeModulesMissing }: ProjectInfoPanelProps): ReactElement {
  return (
    <div data-testid="project-info-panel">
      <dl className={styles.dl}>
        <dt className={styles.term}>projectRoot</dt>
        <dd className={styles.value}>
          <code>{config.projectRoot}</code>
        </dd>

        <dt className={styles.term}>vault パス</dt>
        <dd className={styles.value}>
          <code>{config.vaultPath}</code>
        </dd>

        <dt className={styles.term}>本体(node_modules/mnemo)</dt>
        <dd className={styles.value}>{nodeModulesLabel(nodeModulesMissing)}</dd>
      </dl>
      <p className={styles.note}>
        Mnemotheca はプロジェクトディレクトリ完結型です。場所を変えるには projectRoot ごと移動してください。
      </p>
    </div>
  );
}

export default ProjectInfoPanel;
