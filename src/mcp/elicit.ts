// src/mcp/elicit.ts — elicitation の「上乗せ」ヘルパ(設計 §8-Q)。
//
// MCP tool の主線は「dry-run 相当の結果を tool 戻り値で返し、Claude が会話で承認を取る」方式。
// `ctx.mcpReq.elicitInput` は MCP SDK v2 では 2025 era 限定・deprecated で、対応しない
// クライアントでは undefined。`tryElicit` はそれを検出し、非対応なら **例外を投げず null** を
// 返す no-op(呼び出し側はそのまま戻り値方式の処理を続行する)。

/** MCP SDK の tool handler context のうち、本ヘルパが参照する部分だけの構造型。 */
export interface ElicitCapableContext {
  mcpReq?: {
    /** 2025 era 限定・deprecated。非対応クライアントでは undefined。 */
    elicitInput?: (...args: unknown[]) => unknown;
  } | undefined;
}

/**
 * `ctx.mcpReq.elicitInput` が関数なら呼び、その結果を返す。
 * 非対応(undefined)・呼び出しで例外 → いずれも `null`(no-op)。
 *
 * @param ctx    tool handler の context(undefined/null も許容)
 * @param params elicitation のスキーマ/パラメータ(SDK にそのまま渡す)
 */
export async function tryElicit<T = unknown>(
  ctx: ElicitCapableContext | null | undefined,
  params: unknown,
): Promise<T | null> {
  const mcpReq = ctx?.mcpReq;
  const fn = mcpReq?.elicitInput;
  if (typeof fn !== 'function') return null;
  try {
    return (await fn.call(mcpReq, params)) as T;
  } catch {
    return null;
  }
}
