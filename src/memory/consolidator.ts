import crypto from 'crypto';
import {
  MEMORY_CONSOLIDATION_ENABLED,
  MEMORY_CONSOLIDATION_SIMILARITY,
  MEMORY_CONSOLIDATION_MIN_CLUSTER,
  MEMORY_EXTRACTION_BASEURL,
  MEMORY_EXTRACTION_MODEL,
  MEMORY_EMBEDDING_API_KEY,
} from './config.js';
import { embed } from './embedder.js';
import { cosineSimilarity } from './engine.js';
import { addMemories, deleteMemoryBulk, MemoryListResult } from './store.js';
import { logger } from '../logger.js';

const CONSOLIDATION_PROMPT = `You are a memory consolidation engine. Given several related memory fragments about a user, merge them into a single concise, standalone memory.

Rules:
- Preserve all key facts and details.
- Remove redundancies and duplicates.
- Do not add new information that is not in the fragments.
- Output only the consolidated memory text. No markdown, no JSON, no labels.
- The result must be standalone and meaningful without the original context.

Memories to merge:
{{MEMORIES}}`;

function isOllamaEndpoint(): boolean {
  return (
    MEMORY_EXTRACTION_BASEURL.includes(':11434') ||
    MEMORY_EXTRACTION_BASEURL.includes('/api/')
  );
}

async function callOllamaConsolidation(
  memories: string[],
  signal: AbortSignal,
): Promise<string> {
  const prompt = CONSOLIDATION_PROMPT.replace(
    '{{MEMORIES}}',
    memories.map((m, i) => `${i + 1}. ${m}`).join('\n'),
  );
  const url = `${MEMORY_EXTRACTION_BASEURL}/api/generate`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MEMORY_EXTRACTION_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.2, num_predict: 512 },
    }),
    signal,
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Ollama consolidation error ${response.status}: ${errText}`,
    );
  }
  const data = (await response.json()) as { response?: string };
  return data.response?.trim() || '';
}

async function callOpenAICompatibleConsolidation(
  memories: string[],
  signal: AbortSignal,
): Promise<string> {
  const prompt = CONSOLIDATION_PROMPT.replace(
    '{{MEMORIES}}',
    memories.map((m, i) => `${i + 1}. ${m}`).join('\n'),
  );
  const url = `${MEMORY_EXTRACTION_BASEURL}/chat/completions`;
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
      model: MEMORY_EXTRACTION_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 512,
    }),
    signal,
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Consolidation API error ${response.status}: ${errText}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() || '';
}

async function mergeCluster(memories: string[]): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const raw = isOllamaEndpoint()
      ? await callOllamaConsolidation(memories, controller.signal)
      : await callOpenAICompatibleConsolidation(memories, controller.signal);
    if (!raw) throw new Error('Empty consolidation response');
    return raw;
  } finally {
    clearTimeout(timeout);
  }
}

function buildClusters(
  memories: MemoryListResult[],
  threshold: number,
  minCluster: number,
): MemoryListResult[][] {
  if (memories.length < minCluster) return [];
  const clusters: MemoryListResult[][] = [];
  const used = new Set<string>();

  // Use highest-importance memories as seeds
  const sorted = [...memories].sort((a, b) => b.importance - a.importance);

  for (const seed of sorted) {
    if (used.has(seed.id)) continue;
    const cluster: MemoryListResult[] = [seed];
    used.add(seed.id);
    for (const other of sorted) {
      if (used.has(other.id)) continue;
      const sim = cosineSimilarity(seed.vector, other.vector);
      if (sim >= threshold) {
        cluster.push(other);
        used.add(other.id);
      }
    }
    clusters.push(cluster);
  }

  return clusters.filter((c) => c.length >= minCluster);
}

export async function consolidateScopeMemories(
  scope: string,
  items: MemoryListResult[],
): Promise<number> {
  if (!MEMORY_CONSOLIDATION_ENABLED) return 0;
  const autoMemories = items.filter((m) => m.source === 'auto');
  if (autoMemories.length < MEMORY_CONSOLIDATION_MIN_CLUSTER) return 0;

  const clusters = buildClusters(
    autoMemories,
    MEMORY_CONSOLIDATION_SIMILARITY,
    MEMORY_CONSOLIDATION_MIN_CLUSTER,
  );
  if (clusters.length === 0) return 0;

  let totalMerged = 0;
  for (const cluster of clusters) {
    try {
      const contents = cluster.map((m) => m.content);
      const merged = await mergeCluster(contents);
      if (!merged || merged.length < 10) continue;

      const maxImportance = Math.max(...cluster.map((m) => m.importance));
      const groupFolder = cluster[0].group_folder;
      const vector = await embed(merged);

      await deleteMemoryBulk(cluster.map((m) => m.id));
      await addMemories([
        {
          id: crypto.randomUUID(),
          content: merged,
          scope,
          group_folder: groupFolder,
          source: 'auto',
          importance: maxImportance,
          timestamp: Date.now(),
          vector,
        } as any,
      ]);

      totalMerged += cluster.length;
      logger.info(
        { scope, mergedFrom: cluster.length, newLength: merged.length },
        'Consolidated memories',
      );
    } catch (err) {
      logger.warn(
        { err, scope, clusterSize: cluster.length },
        'Memory consolidation failed for cluster',
      );
    }
  }

  return totalMerged;
}
