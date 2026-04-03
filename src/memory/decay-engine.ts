import { deleteMemoryBulk, listMemories } from './store.js';
import { consolidateScopeMemories } from './consolidator.js';
import { logger } from '../logger.js';
import {
  MEMORY_SCORE_HALFLIFE_DAYS,
  MEMORY_MAX_PER_SCOPE,
  MEMORY_DECAY_THRESHOLD,
} from './config.js';

function calculateDecayScore(importance: number, timestamp: number): number {
  const ageDays = (Date.now() - timestamp) / (1000 * 60 * 60 * 24);
  return importance * Math.exp(-ageDays / MEMORY_SCORE_HALFLIFE_DAYS);
}

export async function cleanupMemories(): Promise<void> {
  try {
    const memories = await listMemories(undefined, 100_000);
    const byScope = new Map<string, typeof memories>();
    for (const m of memories) {
      const list = byScope.get(m.scope) || [];
      list.push(m);
      byScope.set(m.scope, list);
    }

    let totalDeleted = 0;
    const survivingByScope = new Map<string, typeof memories>();

    for (const [scope, items] of byScope) {
      const scored = items.map((m) => ({
        id: m.id,
        decayScore: calculateDecayScore(m.importance, m.timestamp),
      }));
      scored.sort((a, b) => a.decayScore - b.decayScore);

      const toDelete: string[] = [];
      let kept = 0;
      for (const item of scored) {
        if (
          item.decayScore < MEMORY_DECAY_THRESHOLD ||
          kept >= MEMORY_MAX_PER_SCOPE
        ) {
          toDelete.push(item.id);
        } else {
          kept++;
        }
      }

      const deletedSet = new Set(toDelete);
      survivingByScope.set(
        scope,
        items.filter((m) => !deletedSet.has(m.id)),
      );

      if (toDelete.length > 0) {
        await deleteMemoryBulk(toDelete);
        totalDeleted += toDelete.length;
        logger.info(
          { scope, deleted: toDelete.length, remaining: kept },
          'Memory decay cleanup',
        );
      }
    }

    if (totalDeleted > 0) {
      logger.info({ totalDeleted }, 'Memory lifecycle cleanup complete');
    } else {
      logger.debug('Memory lifecycle cleanup: nothing to delete');
    }

    let totalConsolidated = 0;
    for (const [scope, items] of survivingByScope) {
      const count = await consolidateScopeMemories(scope, items);
      totalConsolidated += count;
    }
    if (totalConsolidated > 0) {
      logger.info({ totalConsolidated }, 'Memory consolidation complete');
    }
  } catch (err) {
    logger.warn({ err }, 'Memory lifecycle cleanup failed');
  }
}
