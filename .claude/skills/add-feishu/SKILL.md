---
name: add-feishu
description: Add Feishu (Lark) as a channel. Uses WebSocket long connection - no public IP or webhook required. Requires Feishu Open Platform app credentials.
---

# Add Feishu (Lark) Channel

This skill adds Feishu/Lark support to NanoClaw. It uses WebSocket long connection to receive events, so no public IP or webhook configuration is required.

## Prerequisites

You need a Feishu Open Platform app:

1. Go to [Feishu Open Platform](https://open.feishu.cn/app)
2. Create a new app (企业自建应用)
3. Enable Bot capability (机器人)
4. Subscribe to events:
   - `im.message.receive_v1` (receive messages)
   - `im.message.reaction.created_v1` (optional, for emoji reactions)
5. Get your App ID and App Secret from the Credentials & Basic Info page

## Phase 1: Install Dependencies

Install the Feishu SDK:

```bash
npm install
```

## Phase 2: Configure Credentials

AskUserQuestion: Do you want to configure Feishu now?
- **Yes** - Enter credentials
- **Skip** - Configure later in .env

If Yes, ask for:

1. **App ID** (cli_xxx)
2. **App Secret**

Optional (for encrypted events):
3. **Encrypt Key** (if you enable encryption)
4. **Verification Token** (if you enable verification)

Add to `.env`:

```bash
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# Optional:
# FEISHU_ENCRYPT_KEY=your_encrypt_key
# FEISHU_VERIFICATION_TOKEN=your_verification_token
```

## Phase 3: Build

```bash
npm run build
```

## Phase 4: Register Main Chat

AskUserQuestion: Where do you want to chat with the assistant?
- **Self-chat** - Message yourself in Feishu (推荐)
- **P2P with bot** - Direct message with the bot
- **Group chat** - Add bot to a group

### For self-chat:

1. Open Feishu
2. Search for your own name
3. Open the conversation
4. Right-click → Copy Link
5. Extract the chat ID from the URL (the part after `open_chat=`)

Or use the group sync to find your user ID:

```bash
npx tsx setup/index.ts --step feishu-sync
```

### For group chat:

1. Add the bot to the group
2. @ mention the bot and say "hello"
3. Check the logs for the chat ID:

```bash
tail -f logs/nanoclaw.log | grep "Feishu message"
```

### Register the chat:

```bash
npx tsx setup/index.ts --step register \
  --jid "<chat-id>" \
  --name "main" \
  --trigger "@Claw" \
  --folder "feishu_main" \
  --channel feishu \
  --assistant-name "Claw" \
  --is-main
```

For groups with trigger:

```bash
npx tsx setup/index.ts --step register \
  --jid "<chat-id>" \
  --name "group-name" \
  --trigger "@Claw" \
  --folder "feishu_group" \
  --channel feishu
```

## Phase 5: Verify

Restart the service:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

Test the connection:

1. Send a message in your registered Feishu chat
2. The bot should respond within a few seconds

For groups, use the trigger word: `@Claw 你好`

Check logs if needed:

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

1. Check credentials are set in `.env`
2. Verify the bot is enabled in Feishu Open Platform
3. Check event subscriptions are configured
4. Look at logs: `tail -50 logs/nanoclaw.log`

### "Invalid app_id or app_secret"

- Verify App ID and App Secret are correct
- Make sure there are no extra spaces in `.env`

### Messages not being received

- Check that `im.message.receive_v1` event is subscribed
- Verify the bot has been added to the chat (for groups)
- Ensure the bot has necessary permissions

### Group chat issues

- In group chats, you must @ mention the bot for it to respond
- Make sure the bot is added as a group member
- The bot needs `im:chat:readonly` permission for group info

## Feishu Permissions Required

Your app needs these permissions:

- `im:chat:readonly` - Read chat info
- `im:message` - Send messages
- `im:message.p2p_msg:readonly` - Read 1-on-1 messages
- `im:message.group_msg:readonly` - Read group messages
- `im:message.reaction:readonly` - Read reactions (optional)

## After Setup

If running `npm run dev` while the service is active:

```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Removal

To remove Feishu integration:

1. Remove credentials from `.env`
2. Delete Feishu registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE channel = 'feishu'"`
3. Rebuild and restart: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
