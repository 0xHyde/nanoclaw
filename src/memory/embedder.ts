import OpenAI from 'openai';
import {
  MEMORY_EMBEDDING_API_KEY,
  MEMORY_EMBEDDING_BASEURL,
  MEMORY_EMBEDDING_MODEL,
  MEMORY_EMBEDDING_PROVIDER,
} from './config.js';
import { logger } from '../logger.js';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: MEMORY_EMBEDDING_API_KEY,
      baseURL: MEMORY_EMBEDDING_BASEURL,
    });
  }
  return client;
}

async function embedOllama(text: string): Promise<number[]> {
  const url = `${MEMORY_EMBEDDING_BASEURL}/api/embeddings`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MEMORY_EMBEDDING_MODEL,
      prompt: text,
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Ollama embedding error ${response.status}: ${errText}`);
  }
  const data = (await response.json()) as { embedding?: number[] };
  if (!data.embedding || !Array.isArray(data.embedding)) {
    throw new Error('Ollama embedding response missing embedding array');
  }
  return data.embedding;
}

async function embedOpenAI(text: string): Promise<number[]> {
  if (!MEMORY_EMBEDDING_API_KEY) {
    throw new Error('MEMORY_EMBEDDING_API_KEY is not configured');
  }
  const response = await getClient().embeddings.create({
    model: MEMORY_EMBEDDING_MODEL,
    input: text,
  });
  return response.data[0].embedding;
}

export async function embed(text: string): Promise<number[]> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Cannot embed empty text');
  }
  try {
    if (MEMORY_EMBEDDING_PROVIDER === 'ollama') {
      return await embedOllama(trimmed);
    }
    return await embedOpenAI(trimmed);
  } catch (err) {
    logger.error({ err, provider: MEMORY_EMBEDDING_PROVIDER }, 'Embedding request failed');
    throw err;
  }
}
