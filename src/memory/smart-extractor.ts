import {
  MEMORY_EXTRACTION_ENABLED,
  MEMORY_EXTRACTION_MODEL,
  MEMORY_EXTRACTION_BASEURL,
  MEMORY_EMBEDDING_API_KEY,
} from './config.js';
import { logger } from '../logger.js';

export interface ExtractedMemory {
  content: string;
  kind: 'profile' | 'preferences' | 'entities' | 'events' | 'cases' | 'patterns';
  importance: number;
}

const SYSTEM_PROMPT = `You are a memory extraction engine. Given a conversation snippet, extract facts that should be remembered for future conversations.

Categories:
- profile: user identity, profession, role, background
- preferences: likes, dislikes, style requests, communication habits
- entities: important people, pets, projects, companies, products
- events: milestones, appointments, deadlines, trips, launches
- cases: specific problems solved, decisions made, scripts written
- patterns: recurring behaviors, workflows, methodologies

Output a JSON array only. Do not wrap in markdown. Return [] if nothing is worth remembering.

Rules:
- Extract concise, objective facts (1-2 sentences each).
- Skip greetings, chitchat, confirmations, and meta conversation.
- importance is 0.0-1.0 (higher = more useful long-term).
- content must be standalone and meaningful without the original context.

Example output:
[
  {"content":"User prefers concise, professional replies in Chinese.","kind":"preferences","importance":0.85},
  {"content":"User has a blue-golden-shaded cat named Nomi arriving soon.","kind":"entities","importance":0.75}
]`;

function isOllamaEndpoint(): boolean {
  return MEMORY_EXTRACTION_BASEURL.includes(':11434') || MEMORY_EXTRACTION_BASEURL.includes('/api/');
}

async function callOllamaExtraction(
  conversationText: string,
  signal: AbortSignal,
): Promise<string> {
  const url = `${MEMORY_EXTRACTION_BASEURL}/api/generate`;
  const prompt = `${SYSTEM_PROMPT}\n\n---\nConversation:\n${conversationText.trim().slice(0, 2000)}\n\nExtract memories as JSON array:`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MEMORY_EXTRACTION_MODEL,
      prompt,
      stream: false,
      format: 'json',
      options: {
        temperature: 0.2,
        num_predict: 1024,
      },
    }),
    signal,
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Ollama extraction error ${response.status}: ${errText}`);
  }
  const data = (await response.json()) as { response?: string };
  return data.response?.trim() || '';
}

async function callOpenAICompatibleExtraction(
  conversationText: string,
  signal: AbortSignal,
): Promise<string> {
  const url = `${MEMORY_EXTRACTION_BASEURL}/chat/completions`;
  const body = {
    model: MEMORY_EXTRACTION_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Conversation:\n${conversationText.trim().slice(0, 2000)}\n\nExtract memories as JSON array only.`,
      },
    ],
    temperature: 0.2,
    max_tokens: 1024,
    response_format: { type: 'json_object' as const },
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (MEMORY_EMBEDDING_API_KEY) {
    headers['Authorization'] = `Bearer ${MEMORY_EMBEDDING_API_KEY}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Extraction API error ${response.status}: ${errText}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() || '';
}

export async function extractMemories(
  conversationText: string,
): Promise<ExtractedMemory[]> {
  if (!MEMORY_EXTRACTION_ENABLED) return [];
  if (!conversationText || conversationText.trim().length < 20) return [];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    const raw = isOllamaEndpoint()
      ? await callOllamaExtraction(conversationText, controller.signal)
      : await callOpenAICompatibleExtraction(conversationText, controller.signal);

    clearTimeout(timeout);

    if (!raw) return [];

    // Remove possible markdown code block wrapper
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    if (!cleaned) return [];

    // OpenAI response_format=json_object sometimes wraps array in {"memories": [...]}
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      logger.warn({ raw: cleaned.slice(0, 200) }, 'Extraction output is not valid JSON');
      return [];
    }

    let items: unknown[] = [];
    if (Array.isArray(parsed)) {
      items = parsed;
    } else if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.memories)) {
        items = obj.memories as unknown[];
      } else {
        // Try to find any array field
        for (const v of Object.values(obj)) {
          if (Array.isArray(v)) {
            items = v as unknown[];
            break;
          }
        }
      }
    }

    if (!Array.isArray(items)) {
      logger.warn({ raw: cleaned.slice(0, 200) }, 'Extraction output is not an array');
      return [];
    }

    const results: ExtractedMemory[] = [];
    for (const rawItem of items) {
      const item = rawItem as Record<string, unknown> | null;
      if (!item || typeof item !== 'object') continue;
      if (typeof item.content !== 'string' || typeof item.kind !== 'string') continue;

      const content = item.content.trim();
      const kind = item.kind;
      const importance =
        typeof item.importance === 'number'
          ? Math.max(0, Math.min(1, item.importance))
          : 0.5;

      if (content.length < 5) continue;
      const validKinds: ExtractedMemory['kind'][] = [
        'profile',
        'preferences',
        'entities',
        'events',
        'cases',
        'patterns',
      ];
      if (!validKinds.includes(kind as ExtractedMemory['kind'])) continue;

      results.push({ content, kind: kind as ExtractedMemory['kind'], importance });
    }

    logger.info({ count: results.length }, 'Extracted memories');
    return results;
  } catch (err) {
    logger.warn({ err }, 'Smart extraction failed');
    return [];
  }
}
