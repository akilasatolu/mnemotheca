// CSS Modules 型宣言(設計 §11-1「スタイル: CSS Modules」)。
declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}

// 副作用 import 用(グローバルなテーマ CSS)。
declare module '*.css';
