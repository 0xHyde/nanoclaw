import {
  MEMORY_SCORE_MIN,
  MEMORY_SCORE_HALFLIFE_DAYS,
  MEMORY_REINFORCEMENT_FACTOR,
  MEMORY_MAX_HALF_LIFE_MULTIPLIER,
} from './config.js';
import { logger } from '../logger.js';
import { RerankedResult } from './reranker.js';

export interface ScoredResult extends RerankedResult {
  finalScore: number;
}

function calculateEffectiveHalfLife(
  baseHalfLife: number,
  accessCount: number,
  lastAccessedAt: number,
): number {
  const daysSinceAccess = (Date.now() - lastAccessedAt) / (1000 * 60 * 60 * 24);
  const maxMultiplier = MEMORY_MAX_HALF_LIFE_MULTIPLIER;
  const reinforcement = Math.min(accessCount * MEMORY_REINFORCEMENT_FACTOR, maxMultiplier - 1);
  const recencyFactor = Math.exp(-daysSinceAccess / 7);
  return baseHalfLife * (1 + reinforcement * recencyFactor);
}

function parseMetadata(metadataJson?: string): Record<string, unknown> {
  if (!metadataJson) return {};
  try {
    return JSON.parse(metadataJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function calculateRecencyBoost(timestamp: number, halfLifeDays: number, metadataJson?: string): number {
  const metadata = parseMetadata(metadataJson);
  const accessCount = typeof metadata.access_count === 'number' ? metadata.access_count : 0;
  const lastAccessedAt = typeof metadata.last_accessed_at === 'number' ? metadata.last_accessed_at : timestamp;
  const effectiveHL = calculateEffectiveHalfLife(halfLifeDays, accessCount, lastAccessedAt);
  const ageDays = (Date.now() - timestamp) / (1000 * 60 * 60 * 24);
  return Math.exp(-ageDays / effectiveHL) * 0.1;
}

function calculateLengthNormalization(content: string, anchor = 500): number {
  const len = content.length;
  const ratio = Math.max(len / anchor, 1);
  return 1 / (1 + 0.5 * Math.log2(ratio));
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function scorePipeline(
  results: RerankedResult[],
  hardMinScore = MEMORY_SCORE_MIN,
  preferredKinds?: string[],
): ScoredResult[] {
  const halfLife = MEMORY_SCORE_HALFLIFE_DAYS;
  const scored: ScoredResult[] = [];

  for (const r of results) {
    // Base score: rerank if available, else distance-derived
    let base = r.rerankScore;
    if (base <= 0) {
      // fallback: use LanceDB distance (lower is better)
      const normalizedDistance = Math.max(0, Math.min(1, r._distance));
      base = Math.max(0, 1 - normalizedDistance);
    } else {
      // Blend rerank score with vector distance (5:5 like original plugin)
      const normalizedDistance = Math.max(0, Math.min(1, r._distance));
      const vectorScore = Math.max(0, 1 - normalizedDistance);
      base = base * 0.5 + vectorScore * 0.5;
    }

    const recency = calculateRecencyBoost(r.timestamp, halfLife, r.metadata_json);
    const importanceWeight = 0.7 + 0.3 * (r.importance ?? 0.5);
    const lengthNorm = calculateLengthNormalization(r.content);
    const kindBoost =
      preferredKinds && preferredKinds.length > 0 && preferredKinds.includes(String(r.kind || ''))
        ? 0.05
        : 0;

    const finalScore = Math.max(0, (base + recency + kindBoost) * importanceWeight * lengthNorm);

    if (finalScore < hardMinScore) continue;

    scored.push({ ...r, finalScore });
  }

  scored.sort((a, b) => b.finalScore - a.finalScore);

  // Diversity: demote near-duplicates instead of dropping them (vector-based, language-agnostic)
  const selected: ScoredResult[] = [];
  const deferred: ScoredResult[] = [];
  for (const candidate of scored) {
    const tooSimilar = selected.some((kept) => {
      if (!candidate.vector || !kept.vector) return false;
      const a = Array.isArray(candidate.vector) ? candidate.vector : Array.from(candidate.vector as Iterable<number>);
      const b = Array.isArray(kept.vector) ? kept.vector : Array.from(kept.vector as Iterable<number>);
      const sim = cosineSimilarity(a, b);
      return sim > 0.85;
    });
    (tooSimilar ? deferred : selected).push(candidate);
  }
  const deduped = [...selected, ...deferred];

  logger.info(
    { in: results.length, scored: scored.length, out: deduped.length },
    'Scoring pipeline complete',
  );
  return deduped;
}
