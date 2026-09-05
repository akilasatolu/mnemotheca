// src/core — CLI / MCP / server から共有する純ロジック層。
// I/O は node:fs / node:path / node:crypto / node:os と、gray-matter / minisearch /
// proper-lockfile のみ。外部通信は行わない(設計 §1-3)。
//
// paths / config / frontmatter / note / slug / id / lock / snapshot / usage-log /
// categories-index / pii / search / similarity / mcp-snippet などの
// モジュールは後続タスクで追加し、この index から再エクスポートする。
export { MnemoError, isMnemoError, ERROR_CODES } from './errors.js';
export type { ErrorCode } from './errors.js';
