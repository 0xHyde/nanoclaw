import {
  MEMORY_EXTRACTION_ENABLED,
  MEMORY_EXTRACTION_MODEL,
  MEMORY_EXTRACTION_BASEURL,
  MEMORY_EMBEDDING_API_KEY,
} from './config.js';
import { logger } from '../logger.js';

export interface ExtractedMemory {
  content: string;
  kind:
    | 'profile'
    | 'preferences'
    | 'entities'
    | 'events'
    | 'cases'
    | 'patterns';
  importance: number;
}

const SYSTEM_PROMPT = `你是一个记忆提取引擎。给定一段对话片段，提取出应在未来对话中被记住的内容。

分类：
- profile：用户身份、职业、角色、背景
- preferences：喜好、厌恶、风格要求、沟通习惯
- entities：重要人物、宠物、项目、公司、产品
- events：里程碑、约会、截止日期、旅行、发布
- cases：具体解决的问题、做出的决定、编写的脚本
- patterns：重复出现的行为、工作流程、方法论

仅输出 JSON 数组。不要用 markdown 包裹。如果没有值得记住的内容，返回 []。

规则：
- 提取简洁、客观的事实和可复用的教训（每条 1-2 句话）。
- 如果用户纠正了你，或者你在错误或失败尝试后改变了做法，请将纠正后的做法提取为 case 或 pattern，并给予高重要性（0.8+）。
- 跳过问候、闲聊、确认和元对话。
- importance 为 0.0~1.0（越高 = 长期越有用）。
- 内容必须独立，在没有原始上下文的情况下也有意义。

示例输出：
[
  {"content":"用户偏好简洁、专业的中文回复。","kind":"preferences","importance":0.85},
  {"content":"用户有一只名叫 Nomi 的蓝金渐层猫，即将到家。","kind":"entities","importance":0.75},
  {"content":"在该主机上，Docker bind mount 必须使用绝对路径；相对路径会导致运行时错误。","kind":"patterns","importance":0.9}
]`;

function isOllamaEndpoint(): boolean {
  return (
    MEMORY_EXTRACTION_BASEURL.includes(':11434') ||
    MEMORY_EXTRACTION_BASEURL.includes('/api/')
  );
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

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
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
      : await callOpenAICompatibleExtraction(
          conversationText,
          controller.signal,
        );

    clearTimeout(timeout);

    if (!raw) return [];

    // Remove possible markdown code block wrapper
    const cleaned = raw
      .replace(/^```json\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    if (!cleaned) return [];

    // OpenAI response_format=json_object sometimes wraps array in {"memories": [...]}
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      logger.warn(
        { raw: cleaned.slice(0, 200) },
        'Extraction output is not valid JSON',
      );
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
      logger.warn(
        { raw: cleaned.slice(0, 200) },
        'Extraction output is not an array',
      );
      return [];
    }

    const results: ExtractedMemory[] = [];
    for (const rawItem of items) {
      const item = rawItem as Record<string, unknown> | null;
      if (!item || typeof item !== 'object') continue;
      if (typeof item.content !== 'string' || typeof item.kind !== 'string')
        continue;

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

      results.push({
        content,
        kind: kind as ExtractedMemory['kind'],
        importance,
      });
    }

    logger.info({ count: results.length }, 'Extracted memories');
    return results;
  } catch (err) {
    logger.warn({ err }, 'Smart extraction failed');
    return [];
  }
}
