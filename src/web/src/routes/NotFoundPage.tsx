import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState } from '../components/ui/index.js';

export function NotFoundPage(): ReactElement {
  return (
    <EmptyState
      title="ページが見つかりません"
      description="URL が正しいかご確認ください。"
      action={<Link to="/">一覧へ戻る</Link>}
    />
  );
}
