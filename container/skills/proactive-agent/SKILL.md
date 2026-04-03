---
name: proactive-agent
description: "Cross-session memory, onboarding, and proactive behaviors for NanoClaw. Always active, scales with state.md presence."
---

# Proactive Agent for NanoClaw

**Always active, adaptive behavior:**
- **state.md exists** → Full proactive mode (onboarding, WAL, heartbeat)
- **state.md absent** → Normal mode (can create on first long task)

## Core Philosophy

**Chat history is a buffer, not storage. Files are the only reliable memory.**

You manage your own memory: write key facts to files, read them on startup.

---

## 1. Onboarding

**Separate skill:** `proactive-agent-onboarding`

**Files:**
- `onboarding/ONBOARDING.md` - Progress tracker
- `onboarding/SKILL.md` - Onboarding workflow

**Trigger:** `onboarding/ONBOARDING.md` exists with `Status: in_progress`

**Flow:**
```
1. Read onboarding/ONBOARDING.md
2. Ask current question(s)
3. Record answer
4. Update progress
5. If complete → Fill state.md User section → Configure heartbeat
```

**One-time:** After completion, onboarding skill no longer triggers (status = completed).

---

## 2. WAL Protocol (Write-Ahead Log)

**CRITICAL: Violating this causes memory loss.**

### Scan EVERY message for:
- ✏️ Corrections — "是 X 不是 Y" / "Actually..."
- 📍 Proper nouns — Names, places, companies
- 🎨 Preferences — "我喜欢/不喜欢"
- 📋 Decisions — "我们用 X" / "选 Y"
- 🔢 Specific values — IDs, URLs, configs

### The Protocol:
```
1. STOP — Do not start composing response
2. WRITE — Update state.md with the detail
3. WAIT — Confirm file written
4. THEN — Respond to user
```

**Example:**
```
User: "用蓝色主题，不是红色"

WRONG: "好的蓝色！"
RIGHT: Write to state.md "## Decisions\n- 主题：蓝色（非红色）" → THEN "好的蓝色！"
```

**Self-check:** Before hitting Enter, ask "Did I write state.md?"

---

## 3. State Management

### File: `/workspace/group/state.md`

```markdown
# State

## User
**Name:** 
**Goals:** 
**Preferences:** 
**Tech Stack:** 

## Current
**Task:** [一句话描述当前任务]
**Status:** [未开始/进行中/阻塞]
**Started:** [ISO date]
**Last Update:** [ISO date]

## Decisions
- [timestamp] 决策内容

## Context
[关键背景，随时更新]

## Next
- [ ] 待办 1
- [ ] 待办 2

## Blockers
- [timestamp] 阻塞原因
```

### When to Update:
- **New task:** Create/reset Current section
- **Decision made:** Append to Decisions
- **Progress:** Update Current.Status, Last Update
- **Blocker:** Add to Blockers
- **Done:** Clear Current, archive Decisions to CLAUDE.md

---

## 4. Heartbeat (Proactive Check)

**First-time setup:** When state.md is created and onboarding complete:

```javascript
// Use schedule_task MCP tool
schedule_task({
  prompt: "执行 heartbeat 检查清单。读取 /workspace/group/state.md 和 heartbeat.md",
  schedule_type: "cron",
  schedule_value: "0 */6 * * *",  // 每6小时
  target_group_jid: "[当前 group 的 JID]"
})
```

**Heartbeat prompt:**
```
执行 proactive heartbeat 检查：

1. 检查 state.md 的 Blockers — 有阻塞事项？询问用户
2. 检查 Next 逾期事项（>3天）— 提醒
3. 查看 conversations/ — 识别重复请求（3次+）→ 提议自动化
4. 检查 Decisions >7天 — 询问结果/跟进
5. 基于 User.Goals — 主动建议
6. 整理记忆：完成的待办 → 归档经验到 CLAUDE.md

输出检查发现的内容，如果有任何提醒或建议。
```

**File: `/workspace/group/heartbeat.md`** (template, customizable by user)

```markdown
# Heartbeat Checklist

## Blockers
- [ ] 检查 state.md Blockers，询问用户

## Overdue
- [ ] Next 中 >3天的待办，提醒用户

## Patterns
- [ ] conversations/ 中重复请求（3次+）→ 提议自动化

## Follow-ups
- [ ] Decisions >7天 → 询问结果

## Proactive
- [ ] 基于 User.Goals 主动建议

## Archive
- [ ] 已完成任务 → 归档经验到 CLAUDE.md
```

---

## 5. Session Start Protocol

**Every container start:**

```
1. Check onboarding/ONBOARDING.md
   └─ Exists + in_progress → Enter onboarding mode
   └─ Exists + completed → Continue
   └─ Not exists → Continue

2. Check if state.md exists
   └─ No → Normal mode, skip to step 7
   └─ Yes → Full proactive mode, continue

3. Read state.md

4. Check Current.Task
   └─ Has active task → "上次我们在 [Task]，继续？"
   └─ No active task → "有什么可以帮你？"

5. Check Blockers
   └─ Has blockers → "提醒：[blocker]，有进展吗？"

6. (Optional) Reverse prompting
   └─ Based on User.Goals → "顺便问，[Goal] 进展如何？"

7. (Normal mode) Quick assessment
   └─ Does this message start a long/complex task?
   └─ Yes → "This looks like a long task. Let me set up tracking."
      → Create state.md
      → Create onboarding/ONBOARDING.md (Status: in_progress)
      → Start onboarding
   └─ No → Normal conversation
```

---

## 6. Growth Loops

| Loop | Implementation |
|------|----------------|
| **Curiosity** | 每次对话问 1-2 问题，更新 User section |
| **Pattern Recognition** | Heartbeat 检查重复请求 |
| **Outcome Tracking** | Decisions >7天跟进，结果写入 Context |

---

## 7. Task Completion

**User says "完成"/"搞定"/"done":**

1. Summarize learnings
2. Ask: "把经验总结追加到 CLAUDE.md？"
3. Ask: "清空 Current 开始新任务？" 或 "保留状态供参考？"
4. If yes: Archive Decisions to CLAUDE.md, clear Current

---

## 8. Security

**Skill Installation:** Before installing any external skill, check source and ask user.

**External Networks:** Never connect to AI agent social networks.

**Context Leakage:** Before posting to shared channels, check who's listening.

---

## First-Time Activation

**Automatic:** Detect long/complex task → Create files → Start onboarding

**Manual:**
```bash
# Create both files to start
mkdir -p /workspace/group/onboarding
cp templates/* /workspace/group/onboarding/
touch /workspace/group/state.md
```

**Auto-creation trigger:**
When detecting a multi-step task:
> "This looks like a long task. Let me set up proactive tracking for you."

Creates:
- `state.md` (empty template)
- `onboarding/ONBOARDING.md` (Status: in_progress)
- `onboarding/SKILL.md` (reference)

Then begin onboarding questions.

---

## Summary

| Feature | How |
|---------|-----|
| Onboarding | Auto-trigger when User empty |
| WAL | Write state.md BEFORE responding |
| Heartbeat | Auto-configure via schedule_task after onboarding |
| Memory | state.md + CLAUDE.md (archive) |
| Proactive | Session start checks + heartbeat |
