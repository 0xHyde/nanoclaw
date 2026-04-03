import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { processImage } from '../image.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: Lark.Client;
  private wsClient: Lark.WSClient | null = null;
  private opts: FeishuChannelOpts;
  private botOpenId: string = '';
  // Cache chat names to avoid repeated API calls
  private chatNameCache = new Map<string, string>();
  private mediaDir: string;

  // Markdown detection patterns
  private static _COMPLEX_MD_RE =
    /```|^\|.+\|\n\s*\|[-:\s|]+\||^#{1,6}\s+|^\s*[-*+]\s+|^\s*\d+\.\s+|\*\*.+?\*\*|__.+?__|(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|~~.+?~~/m;
  private static _TEXT_MAX_LEN = 200;
  private static _POST_MAX_LEN = 2000;
  // Match markdown table: header line + separator line + one or more data rows
  private static _TABLE_RE =
    /((?:^[ \t]*\|.+\|[ \t]*\n)(?:^[ \t]*\|[-:\s|]+\|[ \t]*\n)(?:^[ \t]*\|.+\|[ \t]*\n?)+)/gm;
  private static _CODE_BLOCK_RE = /(```[\s\S]*?```)/g;
  private static _HEADING_RE = /^(#{1,6})\s+(.+)$/gm;

  constructor(appId: string, appSecret: string, opts: FeishuChannelOpts) {
    this.client = new Lark.Client({ appId, appSecret });
    this.opts = opts;
    this.mediaDir = path.join(DATA_DIR, 'media', 'feishu');
    fs.mkdirSync(this.mediaDir, { recursive: true });
  }

  /**
   * Determine if content needs an interactive card or can be sent as plain text.
   */
  static detectMsgFormat(content: string): 'text' | 'interactive' {
    const stripped = content.trim();
    if (FeishuChannel._COMPLEX_MD_RE.test(stripped)) return 'interactive';
    if (stripped.length > FeishuChannel._POST_MAX_LEN) return 'interactive';
    return 'text';
  }

  private static stripMdFormatting(text: string): string {
    return text
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1')
      .replace(/~~(.+?)~~/g, '$1');
  }

  private static parseMdTable(
    tableText: string,
  ): Record<string, unknown> | null {
    const lines = tableText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 3) return null;
    const split = (line: string) =>
      line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => FeishuChannel.stripMdFormatting(c.trim()));
    const headers = split(lines[0]);
    const rows = lines.slice(2).map(split);
    const columns = headers.map((h, i) => ({
      tag: 'column',
      name: `c${i}`,
      display_name: h,
      width: 'auto',
    }));
    return {
      tag: 'table',
      page_size: rows.length + 1,
      columns,
      rows: rows.map((r) => {
        const obj: Record<string, string> = {};
        for (let i = 0; i < headers.length; i++) {
          obj[`c${i}`] = r[i] || '';
        }
        return obj;
      }),
    };
  }

  private static splitHeadings(content: string): Record<string, unknown>[] {
    const codeBlocks: string[] = [];
    let protectedContent = content;
    FeishuChannel._CODE_BLOCK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FeishuChannel._CODE_BLOCK_RE.exec(content)) !== null) {
      codeBlocks.push(m[1]);
      protectedContent = protectedContent.replace(
        m[1],
        `\x00CODE${codeBlocks.length - 1}\x00`,
      );
    }

    const elements: Record<string, unknown>[] = [];
    let lastEnd = 0;
    FeishuChannel._HEADING_RE.lastIndex = 0;
    while ((m = FeishuChannel._HEADING_RE.exec(protectedContent)) !== null) {
      const before = protectedContent.slice(lastEnd, m.index).trim();
      if (before) {
        elements.push({ tag: 'markdown', content: before });
      }
      const text = FeishuChannel.stripMdFormatting(m[2].trim());
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: text ? `**${text}**` : '' },
      });
      lastEnd = m.index + m[0].length;
    }

    const remaining = protectedContent.slice(lastEnd).trim();
    if (remaining) {
      elements.push({ tag: 'markdown', content: remaining });
    }

    for (let i = 0; i < codeBlocks.length; i++) {
      for (const el of elements) {
        if (el.tag === 'markdown' && typeof el.content === 'string') {
          el.content = (el.content as string).replace(
            `\x00CODE${i}\x00`,
            codeBlocks[i],
          );
        }
      }
    }

    return elements.length > 0 ? elements : [{ tag: 'markdown', content }];
  }

  private static buildCardElements(content: string): Record<string, unknown>[] {
    const elements: Record<string, unknown>[] = [];
    let lastIndex = 0;

    FeishuChannel._TABLE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = FeishuChannel._TABLE_RE.exec(content)) !== null) {
      const before = content.slice(lastIndex, match.index).trim();
      if (before) {
        elements.push(...FeishuChannel.splitHeadings(before));
      }
      const table = FeishuChannel.parseMdTable(match[1]);
      if (table) {
        elements.push(table);
      } else {
        elements.push(...FeishuChannel.splitHeadings(match[1]));
      }
      lastIndex = match.index + match[0].length;
    }

    const remaining = content.slice(lastIndex).trim();
    if (remaining) {
      elements.push(...FeishuChannel.splitHeadings(remaining));
    }

    return elements.length > 0 ? elements : [{ tag: 'markdown', content }];
  }

  private static splitElementsByTableLimit(
    elements: Record<string, unknown>[],
    maxTables = 1,
  ): Record<string, unknown>[][] {
    if (elements.length === 0) return [[]];
    const groups: Record<string, unknown>[][] = [];
    let current: Record<string, unknown>[] = [];
    let tableCount = 0;

    for (const el of elements) {
      if (el.tag === 'table') {
        if (tableCount >= maxTables && current.length > 0) {
          groups.push(current);
          current = [];
          tableCount = 0;
        }
        current.push(el);
        tableCount++;
      } else {
        current.push(el);
      }
    }

    if (current.length > 0) {
      groups.push(current);
    }

    return groups.length > 0 ? groups : [[]];
  }

  async connect(): Promise<void> {
    // Fetch bot info to get our own open_id for mention detection
    try {
      const botInfo: any = await this.client.request({
        method: 'GET',
        url: 'https://open.feishu.cn/open-apis/bot/v3/info',
      });
      this.botOpenId = botInfo?.bot?.open_id || '';
      logger.info({ botOpenId: this.botOpenId }, 'Feishu bot info retrieved');
    } catch (err) {
      logger.warn(
        { err },
        'Failed to get Feishu bot info, mention detection may not work',
      );
    }

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        await this.handleMessage(data);
      },
    });

    const { appId, appSecret } = this.client;

    this.wsClient = new Lark.WSClient({
      appId,
      appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
    });

    await this.wsClient.start({ eventDispatcher });
    logger.info('Feishu bot connected');
    console.log('\n  Feishu bot connected via WebSocket');
    console.log("  Send /chatid to the bot to get a chat's registration ID\n");
  }

  private async handleMessage(data: any): Promise<void> {
    const message = data.message;
    if (!message) return;

    const chatId = message.chat_id;
    const chatType = message.chat_type; // 'group' or 'p2p'
    const msgType = message.message_type;
    const msgId = message.message_id;
    const rawContent = message.content || '{}';
    const mentions: any[] = message.mentions || [];
    const createTime = message.create_time; // millisecond timestamp string

    const chatJid = `feishu:${chatId}`;
    const timestamp = createTime
      ? new Date(parseInt(createTime, 10)).toISOString()
      : new Date().toISOString();

    // Add reaction (best-effort)
    const groupForReaction = this.opts.registeredGroups()[chatJid];
    const reactEmoji =
      groupForReaction?.channelConfig?.feishu?.reactEmoji || 'THUMBSUP';
    this.sendReaction(msgId, reactEmoji).catch(() => {});

    // Extract sender info
    const senderId = data.sender?.sender_id?.open_id || '';
    const senderName = await this.getSenderName(data.sender, mentions);

    // Determine chat name
    const isGroup = chatType === 'group';
    let chatName: string;
    if (isGroup) {
      chatName = await this.getChatName(chatId);
    } else {
      chatName = senderName;
    }

    // Build content from message type
    let content = this.extractContent(msgType, rawContent, mentions);
    const mediaPaths: string[] = [];
    let downloadedImagePath: string | null = null;

    // Download media files to local disk
    if (msgType === 'image') {
      downloadedImagePath = await this.downloadMedia(
        msgType,
        msgId,
        rawContent,
      );
      if (downloadedImagePath) {
        mediaPaths.push(downloadedImagePath);
      }
    } else if (['audio', 'file', 'media'].includes(msgType)) {
      const savedPath = await this.downloadMedia(msgType, msgId, rawContent);
      if (savedPath) {
        mediaPaths.push(savedPath);
        content += `\n[${msgType}: ${savedPath}]`;
      }
    }

    // Check for /chatid and /ping commands (text messages starting with /)
    if (msgType === 'text' && content.startsWith('/')) {
      const cmd = content.split(/\s/)[0].toLowerCase();
      if (cmd === '/chatid') {
        await this.sendMessage(
          chatJid,
          `Chat ID: feishu:${chatId}\nName: ${chatName}\nType: ${chatType}`,
        );
        return;
      }
      if (cmd === '/ping') {
        await this.sendMessage(chatJid, `${ASSISTANT_NAME} is online.`);
        return;
      }
    }

    // Translate @bot mentions into TRIGGER_PATTERN format
    if (this.botOpenId && mentions.length > 0) {
      const isBotMentioned = mentions.some(
        (m: any) => m.id?.open_id === this.botOpenId,
      );
      if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    // Report chat metadata
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'feishu', isGroup);

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Feishu chat',
      );
      return;
    }

    // For images in registered groups, resize and copy to group attachments for vision
    if (msgType === 'image' && downloadedImagePath) {
      try {
        const groupDir = resolveGroupFolderPath(group.folder);
        const buffer = fs.readFileSync(downloadedImagePath);
        const processed = await processImage(buffer, groupDir);
        if (processed) {
          content += `\n${processed.content}`;
        } else {
          content += `\n[image: ${downloadedImagePath}]`;
        }
      } catch (err) {
        logger.warn({ err, msgId }, 'Failed to process image for vision');
        content += `\n[image: ${downloadedImagePath}]`;
      }
    }

    // Deliver message
    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender: senderId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      media: mediaPaths,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'Feishu message stored',
    );
  }

  private extractContent(
    msgType: string,
    rawContent: string,
    mentions: any[],
  ): string {
    let parsed: any;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      parsed = {};
    }

    switch (msgType) {
      case 'text': {
        let text: string = parsed.text || '';
        // Replace @mention placeholders (e.g. @_user_1) with display names
        for (const m of mentions) {
          if (m.key && m.name) {
            text = text.replace(m.key, `@${m.name}`);
          }
        }
        return text;
      }
      case 'post':
        return this.extractPostText(parsed);
      case 'image':
        return '[Image]';
      case 'file':
        return `[File: ${parsed.file_name || 'file'}]`;
      case 'audio':
        return '[Audio]';
      case 'media':
        return '[Video]';
      case 'sticker':
        return '[Sticker]';
      case 'interactive':
        return '[Card]';
      case 'share_chat':
        return '[Shared Group]';
      case 'share_user':
        return '[Shared Contact]';
      case 'merge_forward':
        return '[Merge Forward]';
      default:
        return `[Unsupported: ${msgType}]`;
    }
  }

  private extractPostText(parsed: any): string {
    // Post (rich text) content has a nested structure:
    // - Direct: { title, content: [[{tag,text},...], ...] }
    // - Localized: { zh_cn: { title, content } }
    // - Wrapped: { post: { zh_cn: { title, content } } }

    // Handle wrapped { post: {...} }
    if (parsed.post && typeof parsed.post === 'object') {
      parsed = parsed.post;
    }

    // If parsed has content directly, use it (direct format)
    // Otherwise try localized formats
    const lang = parsed.content
      ? parsed
      : parsed.zh_cn ||
        parsed.en_us ||
        parsed.ja_jp ||
        Object.values(parsed)[0];
    if (!lang || typeof lang !== 'object') return '[Post]';
    const parts: string[] = [];
    if (lang.title) parts.push(lang.title);
    if (Array.isArray(lang.content)) {
      for (const line of lang.content) {
        if (!Array.isArray(line)) continue;
        for (const node of line) {
          if (node.tag === 'text' && node.text) parts.push(node.text);
          else if (node.tag === 'a' && node.text) parts.push(node.text);
          else if (node.tag === 'at' && node.user_name)
            parts.push(`@${node.user_name}`);
          else if (node.tag === 'img') parts.push('[Image]');
          else if (node.tag === 'media') parts.push('[Video]');
        }
      }
    }
    return parts.join(' ') || '[Post]';
  }

  private async getSenderName(sender: any, mentions: any[]): Promise<string> {
    // Try to get name from mentions (if sender mentioned themselves or bot knows)
    const senderId = sender?.sender_id?.open_id;
    if (!senderId) return 'Unknown';

    // Try fetching user info via API
    try {
      const resp = await this.client.contact.v3.user.get({
        path: { user_id: senderId },
        params: { user_id_type: 'open_id' },
      });
      const name = (resp as any)?.data?.user?.name || (resp as any)?.user?.name;
      if (name) return name;
    } catch (err) {
      logger.warn({ err, senderId }, 'Failed to get Feishu user name');
    }

    // Fallback to sender open_id
    return senderId;
  }

  private async getChatName(chatId: string): Promise<string> {
    const cached = this.chatNameCache.get(chatId);
    if (cached) return cached;

    try {
      const resp = await this.client.im.v1.chat.get({
        path: { chat_id: chatId },
      });
      const name = (resp as any)?.data?.name || (resp as any)?.name;
      if (name) {
        this.chatNameCache.set(chatId, name);
        return name;
      }
    } catch {
      // Fall through
    }

    return chatId;
  }

  async sendMessage(
    jid: string,
    text: string,
    options?: { replyToMessageId?: string },
  ): Promise<void> {
    if (!this.wsClient) {
      logger.warn('Feishu bot not initialized');
      return;
    }

    const fmt = FeishuChannel.detectMsgFormat(text);
    if (fmt === 'interactive') {
      await this.sendCard(jid, text, options);
      return;
    }

    try {
      if (options?.replyToMessageId) {
        await this.client.im.v1.message.reply({
          path: { message_id: options.replyToMessageId },
          data: {
            content: JSON.stringify({ text }),
            msg_type: 'text',
          },
        });
      } else {
        const chatId = jid.replace(/^feishu:/, '');
        await this.client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            content: JSON.stringify({ text }),
            msg_type: 'text',
          },
        });
      }
      logger.info({ jid, length: text.length }, 'Feishu message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu message');
    }
  }

  async sendCard(
    jid: string,
    text: string,
    options?: { replyToMessageId?: string },
  ): Promise<void> {
    if (!this.wsClient) {
      logger.warn('Feishu bot not initialized');
      return;
    }

    const elements = FeishuChannel.buildCardElements(text);
    const groups = FeishuChannel.splitElementsByTableLimit(elements);

    try {
      for (const chunk of groups) {
        const card = { config: { wide_screen_mode: true }, elements: chunk };
        const content = JSON.stringify(card);

        if (options?.replyToMessageId) {
          await this.client.im.v1.message.reply({
            path: { message_id: options.replyToMessageId },
            data: {
              content,
              msg_type: 'interactive',
            },
          });
        } else {
          const chatId = jid.replace(/^feishu:/, '');
          await this.client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              content,
              msg_type: 'interactive',
            },
          });
        }
      }
      logger.info(
        { jid, chunks: groups.length, length: text.length },
        'Feishu card sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu card');
    }
  }

  async sendReaction(messageId: string, emoji: string): Promise<void> {
    try {
      await this.client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: {
          reaction_type: { emoji_type: emoji },
        },
      });
      logger.debug({ messageId, emoji }, 'Feishu reaction added');
    } catch (err) {
      logger.warn({ err, messageId, emoji }, 'Failed to add Feishu reaction');
    }
  }

  private async downloadMedia(
    msgType: string,
    msgId: string,
    rawContent: string,
  ): Promise<string | null> {
    let parsed: any;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      return null;
    }

    const fileKey = parsed.file_key || parsed.image_key;
    if (!fileKey) return null;

    const resourceType = msgType === 'image' ? 'image' : 'file';
    try {
      const resp = await this.client.im.v1.messageResource.get({
        path: { message_id: msgId, file_key: fileKey },
        params: { type: resourceType },
      });
      const fileName =
        parsed.file_name || (msgType === 'image' ? `${fileKey}.jpg` : fileKey);
      const destPath = path.join(this.mediaDir, fileName);
      await resp.writeFile(destPath);
      logger.debug({ msgId, msgType, destPath }, 'Feishu media downloaded');
      return destPath;
    } catch (err) {
      logger.warn(
        { err, msgId, msgType, fileKey },
        'Failed to download Feishu media',
      );
      return null;
    }
  }

  isConnected(): boolean {
    return this.wsClient !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('feishu:');
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      this.wsClient = null;
      logger.info('Feishu bot stopped');
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Feishu does not support typing indicators
  }
}

registerChannel('feishu', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  const appId = process.env.FEISHU_APP_ID || envVars.FEISHU_APP_ID || '';
  const appSecret =
    process.env.FEISHU_APP_SECRET || envVars.FEISHU_APP_SECRET || '';
  if (!appId || !appSecret) {
    logger.warn('Feishu: FEISHU_APP_ID or FEISHU_APP_SECRET not set');
    return null;
  }
  return new FeishuChannel(appId, appSecret, opts);
});
