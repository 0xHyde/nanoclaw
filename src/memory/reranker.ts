import {
  MEMORY_RERANK_ENABLED,
  MEMORY_RERANK_MODEL,
  MEMORY_RERANK_BASEURL,
  MEMORY_EMBEDDING_API_KEY,
} from './config.js';
import { logger } from '../logger.js';
import { SearchResult } from './store.js';

export interface RerankedResult extends SearchResult {
  rerankScore: number;
}

export async function rerank(
  query: string,
  candidates: SearchResult[],
): Promise<RerankedResult[]> {
  if (!MEMORY_RERANK_ENABLED || candidates.length === 0) {
    return candidates.map((r) => ({ ...r, rerankScore: 0 }));
  }

  const url = `${MEMORY_RERANK_BASEURL}/rerank`;
  const docs = candidates.map((r) => r.content);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (MEMORY_EMBEDDING_API_KEY) {
      headers['Authorization'] = `Bearer ${MEMORY_EMBEDDING_API_KEY}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: MEMORY_RERANK_MODEL,
        query,
        documents: docs,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Rerank API error ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as {
      results?: Array<{ index: number; relevance_score: number }>;
    };

    const scores = new Map<number, number>();
    for (const r of data.results || []) {
      scores.set(r.index, r.relevance_score);
    }

    const results: RerankedResult[] = candidates.map((c, idx) => ({
      ...c,
      rerankScore: scores.get(idx) || 0,
    }));

    results.sort((a, b) => b.rerankScore - a.rerankScore);

    logger.info(
      { in: candidates.length, out: results.length },
      'Rerank complete',
    );
    return results;
  } catch (err) {
    logger.warn({ err }, 'Rerank failed, falling back to vector order');
    return candidates.map((r) => ({ ...r, rerankScore: 0 }));
  }
}
