import crypto from 'crypto';
import { embed } from './embedder.js';
import {
  addMemories,
  deleteMemoryById,
  getMemoryById,
  initStore,
  listMemories,
  memoryStats,
  searchMemories,
  searchMemoriesHybrid,
  SearchResult,
} from './store.js';
import {
  MEMORY_RECALL_LIMIT,
  MEMORY_HYBRID_ENABLED,
  MEMORY_EXTRACTION_ENABLED,
} from './config.js';
import { extractMemories, ExtractedMemory } from './smart-extractor.js';
import { rerank, RerankedResult } from './reranker.js';
import { scorePipeline, ScoredResult } from './scorer.js';
import { logger } from '../logger.js';
import type { NewMessage } from '../types.js';

export { initStore };
export { cleanupMemories } from './decay-engine.js';

function buildScopes(groupFolder: string): string[] {
  return ['global', `group:${groupFolder}`];
}

function shouldSkipRecall(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0) return true;
  if (/^[\u{1F300}-\u{1F9FF}\s]+$/u.test(trimmed) && trimmed.length < 10)
    return true;
  const lower = trimmed.toLowerCase();
  const skipPatterns = [
    /^hi\b/i,
    /^hello\b/i,
    /^hey\b/i,
    /^ok$/i,
    /^okay$/i,
    /^yes$/i,
    /^no$/i,
    /^thanks?$/i,
    /^got it$/i,
    /^\/compact$/,
  ];
  if (skipPatterns.some((p) => p.test(trimmed))) return true;
  if (/[\u4e00-\u9fff]/.test(lower) && trimmed.length < 6) return true;
  if (trimmed.length < 15 && !/[\u4e00-\u9fff]/.test(trimmed)) return true;
  return false;
}

function detectQueryKinds(query: string): string[] {
  const lower = query.toLowerCase();
  const kinds: string[] = [];
  if (/\b(who am i|my name|i am a|profession|job|work as|developer|engineer|designer|manager|我是|我叫|职业|工作|身份)\b/i.test(query)) kinds.push('profile');
  if (/\b(prefer|like|dislike|hate|love|want|favorite|style|喜欢|讨厌|偏好|想要|习惯|不爱)\b/i.test(query)) kinds.push('preferences');
  if (/\b(when|deadline|schedule|trip|event|launch|appointment|date|什么时候|时间|日程|会议|旅行|出发|到期)\b/i.test(query)) kinds.push('events');
  if (/\b(script|code|fix|bug|solution|solve|error|how to|pattern|workflow|怎么|解决|报错|代码|脚本|方案|流程)\b/i.test(query)) kinds.push('cases', 'patterns');
  if (/\b(project|company|product|pet|dog|cat|team|name is|called|项目|公司|产品|团队|宠物)\b/i.test(query)) kinds.push('entities');
  return kinds;
}

function formatMemories(results: ScoredResult[]): string | null {
  if (results.length === 0) return null;
  const lines = results.map((r) => {
    const date = new Date(r.timestamp).toISOString().split('T')[0];
    return `<memory scope="${r.scope}" source="${r.source}" date="${date}">${r.content}</memory>`;
  });
  return `<relevant-memories>\n${lines.join('\n')}\n</relevant-memories>`;
}

async function doRecall(
  queryText: string,
  vector: number[],
  scopes: string[],
  limit: number,
  preferredKinds?: string[],
): Promise<ScoredResult[]> {
  const candidateLimit = limit * 3;
  const candidates = MEMORY_HYBRID_ENABLED
    ? await searchMemoriesHybrid(queryText, vector, scopes, candidateLimit)
    : await searchMemories(vector, scopes, candidateLimit);

  logger.debug(
    { candidates: candidates.length, scopes: scopes.length, hybrid: MEMORY_HYBRID_ENABLED },
    'Memory candidates fetched',
  );

  const reranked = await rerank(queryText, candidates);
  const scored = scorePipeline(reranked, undefined, preferredKinds);
  logger.debug(
    { in: candidates.length, reranked: reranked.length, scored: scored.length },
    'Memory recall pipeline',
  );
  return scored.slice(0, limit);
}

export async function recallDetails(
  query: string,
  groupFolder: string,
): Promise<{ text: string | null; ids: string[] }> {
  if (shouldSkipRecall(query)) {
    logger.debug('Skipping memory recall for query (adaptive)');
    return { text: null, ids: [] };
  }
  try {
    const vector = await embed(query);
    const scopes = buildScopes(groupFolder);
    const preferredKinds = detectQueryKinds(query);
    const results = await doRecall(query, vector, scopes, MEMORY_RECALL_LIMIT, preferredKinds);
    const text = formatMemories(results);
    logger.info(
      { count: results.length, groupFolder, hybrid: MEMORY_HYBRID_ENABLED, preferredKinds },
      text ? 'Recalled memories' : 'No memories passed scoring',
    );
    return { text, ids: results.map((r) => r.id) };
  } catch (err) {
    logger.warn({ err, groupFolder }, 'Memory recall failed');
    return { text: null, ids: [] };
  }
}

export async function recall(
  query: string,
  groupFolder: string,
): Promise<string | null> {
  return (await recallDetails(query, groupFolder)).text;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function dedupAndStore(
  items: ExtractedMemory[],
  groupFolder: string,
): Promise<void> {
  for (const item of items) {
    try {
      const scope = `group:${groupFolder}`;
      const vector = await embed(item.content);
      const similar = await searchMemories(vector, [scope], 3);

      let existingId: string | null = null;
      for (const s of similar) {
        const sim = cosineSimilarity(vector, (s as unknown as { vector: number[] }).vector || []);
        if (sim >= 0.88) {
          existingId = s.id;
          break;
        }
      }

      if (existingId && (item.kind === 'profile' || item.kind === 'preferences' || item.kind === 'entities')) {
        await deleteMemoryById(existingId);
      }

      const id = existingId || crypto.randomUUID();
      await addMemories([
        {
          id,
          content: item.content,
          scope,
          group_folder: groupFolder,
          source: 'auto',
          importance: item.importance,
          kind: item.kind,
          timestamp: Date.now(),
          vector,
        } as any,
      ]);
      logger.debug({ id, groupFolder, kind: item.kind }, 'Stored extracted memory');
    } catch (err) {
      logger.warn({ err, item }, 'Dedup/store failed for extracted memory');
    }
  }
}

async function rawCapture(
  messages: NewMessage[],
  groupFolder: string,
  assistantReply?: string,
): Promise<void> {
  const relevant = messages
    .filter((m) => !m.is_bot_message && m.content.trim().length > 0)
    .slice(-6);
  if (relevant.length === 0) return;

  const parts: string[] = [];
  for (const m of relevant) {
    const role = m.is_from_me ? 'Assistant' : 'User';
    parts.push(`${role}: ${truncate(m.content.trim(), 300)}`);
  }
  if (assistantReply && assistantReply.trim().length > 0) {
    parts.push(`Assistant: ${truncate(assistantReply.trim(), 300)}`);
  }

  const content = parts.join('\n');
  if (content.length < 40) return;

  const vector = await embed(content);
  const id = crypto.randomUUID();
  await addMemories([
    {
      id,
      content,
      scope: `group:${groupFolder}`,
      group_folder: groupFolder,
      source: 'auto',
      importance: 0.5,
      kind: 'general',
      timestamp: Date.now(),
      vector,
    } as any,
  ]);
  logger.debug({ id, groupFolder }, 'Captured raw memory fallback');
}

export async function capture(
  messages: NewMessage[],
  groupFolder: string,
  assistantReply?: string,
): Promise<void> {
  try {
    const relevant = messages
      .filter((m) => !m.is_bot_message && m.content.trim().length > 0)
      .slice(-6);
    if (relevant.length === 0) return;

    const parts: string[] = [];
    for (const m of relevant) {
      const role = m.is_from_me ? 'Assistant' : 'User';
      parts.push(`${role}: ${truncate(m.content.trim(), 300)}`);
    }
    if (assistantReply && assistantReply.trim().length > 0) {
      parts.push(`Assistant: ${truncate(assistantReply.trim(), 300)}`);
    }
    const conversationText = parts.join('\n');
    if (conversationText.length < 40) return;

    if (MEMORY_EXTRACTION_ENABLED) {
      const extracted = await extractMemories(conversationText);
      if (extracted.length > 0) {
        await dedupAndStore(extracted, groupFolder);
        return;
      }
    }

    await rawCapture(messages, groupFolder, assistantReply);
  } catch (err) {
    logger.warn({ err, groupFolder }, 'Memory capture failed');
    try {
      await rawCapture(messages, groupFolder, assistantReply);
    } catch {}
  }
}

export async function storeMemory(
  content: string,
  scope: string,
  groupFolder: string,
  importance = 0.5,
  kind = 'general',
): Promise<string> {
  const vector = await embed(content);
  const similar = await searchMemories(vector, [scope], 3);

  let existingId: string | null = null;
  for (const s of similar) {
    if (!s.vector) continue;
    if (cosineSimilarity(vector, s.vector) >= 0.88) {
      existingId = s.id;
      break;
    }
  }

  const existing = existingId ? await getMemoryById(existingId).catch(() => null) : null;
  const id = existingId || crypto.randomUUID();
  if (existingId) {
    await deleteMemoryById(existingId);
  }

  await addMemories([
    {
      id,
      content,
      scope,
      group_folder: groupFolder,
      source: 'tool',
      importance,
      kind,
      metadata_json: existing?.metadata_json || JSON.stringify({}),
      timestamp: Date.now(),
      vector,
    } as any,
  ]);
  return id;
}

export async function forgetMemory(id: string): Promise<void> {
  await deleteMemoryById(id);
}

export async function updateMemory(
  id: string,
  content: string,
  scope: string,
  groupFolder: string,
  importance = 0.5,
  kind = 'general',
): Promise<void> {
  const existing = await getMemoryById(id);
  await deleteMemoryById(id);
  const vector = await embed(content);
  await addMemories([
    {
      id,
      content,
      scope,
      group_folder: groupFolder,
      source: 'tool',
      importance,
      kind,
      metadata_json: existing?.metadata_json || JSON.stringify({}),
      timestamp: Date.now(),
      vector,
    } as any,
  ]);
}

export async function boostMemories(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  for (const id of ids) {
    try {
      const mem = await getMemoryById(id);
      if (!mem) continue;
      const newImportance = Math.min(1, mem.importance + 0.05);
      const metadata = (() => {
        if (typeof mem.metadata_json === 'string' && mem.metadata_json.length > 0) {
          try { return JSON.parse(mem.metadata_json) as Record<string, unknown>; } catch { return {}; }
        }
        return {};
      })();
      const accessCount = (typeof metadata.access_count === 'number' ? metadata.access_count : 0) + 1;
      metadata.access_count = accessCount;
      metadata.last_accessed_at = Date.now();
      await deleteMemoryById(id);
      await addMemories([
        {
          id: mem.id,
          content: mem.content,
          scope: mem.scope,
          group_folder: mem.group_folder,
          source: mem.source as 'auto' | 'tool',
          importance: newImportance,
          kind: mem.kind || 'general',
          metadata_json: JSON.stringify(metadata),
          timestamp: mem.timestamp,
          vector: mem.vector,
        } as any,
      ]);
      logger.debug({ id, newImportance, accessCount }, 'Boosted memory importance and access');
    } catch (err) {
      logger.warn({ err, id }, 'Failed to boost memory importance');
    }
  }
}

export async function searchMemoryTool(
  query: string,
  scope?: string,
  groupFolder?: string,
  limit = 5,
): Promise<SearchResult[]> {
  const vector = await embed(query);
  const scopes = scope ? [scope] : buildScopes(groupFolder || 'main');
  const candidates = MEMORY_HYBRID_ENABLED
    ? await searchMemoriesHybrid(query, vector, scopes, limit * 3)
    : await searchMemories(vector, scopes, limit * 3);
  const reranked = await rerank(query, candidates);
  const scored = scorePipeline(reranked);
  return scored.slice(0, limit);
}

export { listMemories, memoryStats };
export type { SearchResult } from './store.js';
