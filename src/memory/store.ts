import * as lancedb from '@lancedb/lancedb';
import path from 'path';
import fs from 'fs';
import {
  MEMORY_LANCEDB_PATH,
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_HYBRID_ENABLED,
} from './config.js';
import { logger } from '../logger.js';

let db: lancedb.Connection | null = null;
let table: lancedb.Table | null = null;

export interface MemoryRecord {
  [key: string]: unknown;
  id: string;
  content: string;
  scope: string;
  group_folder: string;
  source: 'auto' | 'tool';
  importance: number;
  kind?: string;
  metadata_json?: string;
  timestamp: number;
  vector: number[];
}

export async function initStore(): Promise<void> {
  const dbPath = path.resolve(MEMORY_LANCEDB_PATH);
  fs.mkdirSync(dbPath, { recursive: true });
  db = await lancedb.connect(dbPath);

  const tableNames = await db.tableNames();
  if (!tableNames.includes('memories')) {
    logger.info('Creating LanceDB memories table');
    const dummy: MemoryRecord = {
      id: 'init',
      content: 'init',
      scope: 'global',
      group_folder: 'main',
      source: 'auto',
      importance: 0.5,
      kind: 'general',
      metadata_json: '',
      timestamp: Date.now(),
      vector: new Array(MEMORY_EMBEDDING_DIMENSIONS).fill(0),
    };
    table = await db.createTable('memories', [dummy]);
    await table.delete("id = 'init'");
  } else {
    table = await db.openTable('memories');
    const schema = await table.schema();
    const hasKind = schema.fields.some(
      (f: { name: string }) => f.name === 'kind',
    );
    const hasMetadataJson = schema.fields.some(
      (f: { name: string }) => f.name === 'metadata_json',
    );
    if (!hasKind || !hasMetadataJson) {
      logger.info(
        'Migrating LanceDB memories table: rebuilding with kind/metadata_json columns',
      );
      const oldRows = await table.query().toArray();
      await db.dropTable('memories');
      const dummy: MemoryRecord = {
        id: 'init',
        content: 'init',
        scope: 'global',
        group_folder: 'main',
        source: 'auto',
        importance: 0.5,
        kind: 'general',
        metadata_json: JSON.stringify({}),
        timestamp: Date.now(),
        vector: new Array(MEMORY_EMBEDDING_DIMENSIONS).fill(0),
      };
      table = await db.createTable('memories', [dummy]);
      await table.delete("id = 'init'");
      if (oldRows.length > 0) {
        const migrated: MemoryRecord[] = oldRows.map((r) => {
          const raw = r as Record<string, unknown>;
          const existingMetadata = (() => {
            if (raw.metadata_json && typeof raw.metadata_json === 'string') {
              try {
                return JSON.parse(raw.metadata_json);
              } catch {
                return {};
              }
            }
            if (raw.metadata && typeof raw.metadata === 'object') {
              return raw.metadata as Record<string, unknown>;
            }
            return {};
          })();
          return {
            id: String(raw.id),
            content: String(raw.content),
            scope: String(raw.scope),
            group_folder: String(raw.group_folder),
            source: (raw.source as 'auto' | 'tool') || 'auto',
            importance: Number(raw.importance ?? 0.5),
            kind: String(raw.kind || 'general'),
            metadata_json: JSON.stringify(existingMetadata),
            timestamp: Number(raw.timestamp),
            vector: Array.from(raw.vector as Iterable<number>),
          };
        });
        await table.add(migrated);
        logger.info({ count: migrated.length }, 'Migrated existing memories');
      }
    }
  }

  if (MEMORY_HYBRID_ENABLED && table) {
    try {
      const indices = await table.listIndices();
      const hasFts = indices.some((idx) =>
        idx.name.toLowerCase().includes('fts'),
      );
      if (!hasFts) {
        logger.info('Creating LanceDB FTS index on content');
        await table.createIndex('content', {
          config: lancedb.Index.fts({
            baseTokenizer: 'simple',
            stem: false,
            removeStopWords: false,
            asciiFolding: false,
            withPosition: true,
          }),
        });
      }
    } catch (err) {
      logger.warn({ err }, 'FTS index creation failed');
    }
  }

  logger.info('LanceDB memory store initialized');
}

export async function addMemories(records: MemoryRecord[]): Promise<void> {
  if (!table) throw new Error('Memory store not initialized');
  if (records.length === 0) return;
  await table.add(records);
}

export interface SearchResult {
  id: string;
  content: string;
  scope: string;
  group_folder: string;
  source: string;
  importance: number;
  timestamp: number;
  _distance: number;
  kind?: string;
  metadata_json?: string;
  vector?: number[];
}

export interface FtsSearchResult extends Omit<SearchResult, '_distance'> {
  _score: number;
}

export async function searchMemories(
  vector: number[],
  scopes: string[],
  limit: number,
): Promise<SearchResult[]> {
  if (!table) throw new Error('Memory store not initialized');

  const allResults: SearchResult[] = [];
  for (const scope of scopes) {
    const rows = await table
      .search(vector)
      .limit(limit * 2)
      .where(`scope = '${scope}'`)
      .toArray();
    for (const row of rows) {
      const raw = row as unknown as MemoryRecord;
      const vec = raw.vector
        ? Array.from(raw.vector as Iterable<number>)
        : undefined;
      allResults.push({ ...(raw as unknown as SearchResult), vector: vec });
    }
  }

  const seen = new Set<string>();
  const unique = allResults.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  unique.sort((a, b) => a._distance - b._distance);
  return unique.slice(0, limit);
}

async function searchMemoriesFts(
  queryText: string,
  scopes: string[],
  limit: number,
): Promise<FtsSearchResult[]> {
  if (!table) throw new Error('Memory store not initialized');

  const allResults: FtsSearchResult[] = [];
  for (const scope of scopes) {
    const rows = await table
      .query()
      .fullTextSearch(queryText, { columns: 'content' })
      .limit(limit * 2)
      .where(`scope = '${scope}'`)
      .toArray();
    for (const row of rows) {
      const raw = row as unknown as MemoryRecord;
      const vec = raw.vector
        ? Array.from(raw.vector as Iterable<number>)
        : undefined;
      allResults.push({ ...(raw as unknown as FtsSearchResult), vector: vec });
    }
  }

  const seen = new Set<string>();
  const unique = allResults.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  unique.sort((a, b) => b._score - a._score);
  return unique.slice(0, limit);
}

function rrfFuse(
  vectorResults: SearchResult[],
  ftsResults: FtsSearchResult[],
  limit: number,
  k = 60,
): SearchResult[] {
  const scores = new Map<string, number>();
  const records = new Map<string, SearchResult>();

  vectorResults.forEach((r, idx) => {
    const rank = idx + 1;
    scores.set(r.id, (scores.get(r.id) || 0) + 1 / (k + rank));
    records.set(r.id, r);
  });

  ftsResults.forEach((r, idx) => {
    const rank = idx + 1;
    scores.set(r.id, (scores.get(r.id) || 0) + 1 / (k + rank));
    if (!records.has(r.id)) {
      records.set(r.id, { ...r, _distance: 0 });
    }
  });

  const fused = Array.from(scores.entries())
    .map(([id, score]) => ({ id, score, record: records.get(id)! }))
    .sort((a, b) => b.score - a.score);

  return fused.slice(0, limit).map((x) => x.record);
}

export async function searchMemoriesHybrid(
  queryText: string,
  vector: number[],
  scopes: string[],
  limit: number,
): Promise<SearchResult[]> {
  const [vectorResults, ftsResults] = await Promise.all([
    searchMemories(vector, scopes, limit * 2),
    searchMemoriesFts(queryText, scopes, limit * 2),
  ]);
  return rrfFuse(vectorResults, ftsResults, limit);
}

export async function deleteMemoryById(id: string): Promise<void> {
  if (!table) throw new Error('Memory store not initialized');
  await table.delete(`id = '${id}'`);
}

export async function deleteMemoryBulk(ids: string[]): Promise<void> {
  if (!table) throw new Error('Memory store not initialized');
  if (ids.length === 0) return;
  const quoted = ids.map((id) => `'${id}'`).join(', ');
  await table.delete(`id IN (${quoted})`);
}

export interface MemoryListResult extends Omit<SearchResult, '_distance'> {
  vector: number[];
}

export async function listMemories(
  scope?: string,
  limit = 50,
): Promise<MemoryListResult[]> {
  if (!table) throw new Error('Memory store not initialized');
  let builder = table.query().limit(limit);
  if (scope) {
    builder = builder.where(`scope = '${scope}'`);
  }
  const rows = await builder.toArray();
  return rows.map((r) => {
    const raw = r as unknown as MemoryRecord;
    const { vector, ...rest } = raw;
    return { ...rest, vector: Array.from(vector as Iterable<number>) };
  });
}

export async function getMemoryById(
  id: string,
): Promise<MemoryListResult | null> {
  if (!table) throw new Error('Memory store not initialized');
  const rows = await table.query().where(`id = '${id}'`).limit(1).toArray();
  if (rows.length === 0) return null;
  const raw = rows[0] as unknown as MemoryRecord;
  const { vector, ...rest } = raw;
  return { ...rest, vector: Array.from(vector as Iterable<number>) };
}

export async function memoryStats(): Promise<{
  total: number;
  byScope: Record<string, number>;
}> {
  if (!table) throw new Error('Memory store not initialized');
  const all = await table.query().toArray();
  const byScope: Record<string, number> = {};
  for (const row of all) {
    const s = (row as unknown as SearchResult).scope;
    byScope[s] = (byScope[s] || 0) + 1;
  }
  return { total: all.length, byScope };
}
