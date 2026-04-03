---
name: self-improvement
description: "Auto-capture learnings from every container session. Writes to isolated memory files, never bloats CLAUDE.md. Always active inside NanoClaw containers."
---

# Self-Improvement (Container)

**Always active.** Before finishing any multi-step task, perform a lightweight reflection and persist the learning — without polluting `CLAUDE.md`.

## Core Rule

> **CLAUDE.md is peak context, not a dump. Keep it short.**

Learnings go to dedicated memory files. CLAUDE.md only gets a one-line pointer, if anything.

## When to Reflect

Reflect **automatically** when ONE of the following is true:
- The task required 3 or more tool calls (Read, Write, Edit, Bash, Task, etc.)
- The user explicitly says "完成", "done", "搞定", "总结教训", or "self-improve"
- You encountered an error, fixed it, and learned something reusable

If the task is trivial (1 tool call, simple factual answer), skip reflection silently.

## Reflection Protocol

Perform these steps **before** composing the final user-facing response:

```
1. PAUSE — Do not send the final reply yet
2. RECALL — What was the core task? What went wrong? What decision was made?
3. EXTRACT — Identify ONE reusable pattern or ONE mistake to avoid
4. WRITE — Append the episode to episodic memory
5. PROMOTE — If the same pattern has appeared ≥2 times recently, update semantic memory
6. THEN — Send the final reply to the user
```

## Memory Architecture

```
/workspace/group/memory/
├── episodic/           # Raw daily experiences
│   └── YYYY-MM-DD.md
├── semantic/           # Deduplicated rules (keep under 200 lines)
│   └── rules.md
└── working/            # Optional scratchpad for current session
    └── session.md
```

Create these directories as needed.

## 1. Episodic Memory

Write to:
```
/workspace/group/memory/episodic/YYYY-MM-DD.md
```

Append entries in this format:

```markdown
### <ISO-timestamp>
**Task:** <one-line summary>
**Pattern:** <reusable insight>
**Mistake:** <what went wrong and how it was fixed>
**Confidence:** <0.0-1.0>
```

- Include **either** `Pattern:` or `Mistake:` (or both).
- Keep each entry under 6 lines.
- Use the user's language.

## 2. Semantic Memory (rules.md)

This is the durable, deduplicated rulebook. Keep it concise.

Write to:
```
/workspace/group/memory/semantic/rules.md
```

Format:

```markdown
## <Rule Title>
- <Clear actionable rule>
- **Source:** <brief task summary>
- **Seen:** <count> times since <first date>
- **Confidence:** <avg>
```

Rules for maintaining `rules.md`:
- **Merge**, don't duplicate. If a similar rule exists, update its `Seen:` count and `Confidence:`.
- **Delete** obsolete rules. If a rule no longer applies to the project, remove it.
- **Cap at ~200 lines.** If it grows beyond that, summarize and archive old rules into `semantic/archive.md`.
- **One rule per concept.** Be ruthless about deduplication.

## 3. CLAUDE.md (Peak Context)

**Almost never write learnings directly to CLAUDE.md.**

The only acceptable updates:
- Add a single line under `## Learnings` pointing to the semantic memory:
  ```markdown
  ## Learnings
  See `.claude/memory/semantic/rules.md` for evolved project rules.
  ```
- Or append **one** ultra-high-confidence rule (seen ≥5 times) as a single bullet, if it changes how every future task must be executed.

If `CLAUDE.md` already has more than 5 bullets under `## Learnings`, **stop adding** — move new rules to `semantic/rules.md` instead.

## Security & Scope

- Do not write secrets, API keys, or credentials to memory files.
- Keep reflections focused on coding patterns, workflow rules, and project conventions.
- Do not modify source code files as part of reflection.
