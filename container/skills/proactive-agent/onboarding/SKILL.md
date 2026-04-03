---
name: proactive-agent-onboarding
description: "Onboarding workflow for proactive-agent. One-time setup, generates user profile."
---

# Proactive Agent Onboarding

**One-time setup.** Completes when all questions answered, populates `state.md` User section.

## Trigger

`onboarding/ONBOARDING.md` exists with `Status: in_progress`

## Process

**Read** `onboarding/ONBOARDING.md` → **Ask current question** → **Record answer** → **Update progress** → **Repeat until complete**

## Question Flow

| # | Question | Storage Field |
|---|----------|---------------|
| 1 | What should I call you? | User.Name |
| 2 | What's your role or profession? | User.Role |
| 3 | How do you prefer to communicate? | User.CommunicationStyle |
| 4 | Explain reasoning or just answers? | User.ExplainReasoning |
| 5 | Technical expertise level? | User.TechLevel |
| 6 | Programming languages/tools? | User.Tools |
| 7 | What are you currently working on? | User.CurrentProject |
| 8 | What would you like to achieve? | User.Goals |
| 9 | Code snippets or complete solutions? | User.CodePreference |
| 10 | How to handle mistakes? | User.MistakeHandling |
| 11 | Work environment (OS/IDE/stack)? | User.Environment |
| 12 | Specific constraints/requirements? | User.Constraints |

## Completion

When all 12 questions answered:

1. Transfer answers to `/workspace/group/state.md`:

```markdown
## User
**Name:** [answer 1]
**Role:** [answer 2]
**CommunicationStyle:** [answer 3]
**ExplainReasoning:** [answer 4]
**TechLevel:** [answer 5]
**Tools:** [answer 6]
**CurrentProject:** [answer 7]
**Goals:** [answer 8]
**CodePreference:** [answer 9]
**MistakeHandling:** [answer 10]
**Environment:** [answer 11]
**Constraints:** [answer 12]
```

2. Update `onboarding/ONBOARDING.md`:
   - Status: completed
   - Completed: [timestamp]

3. Configure heartbeat:
```javascript
schedule_task({
  prompt: "执行 proactive heartbeat",
  schedule_type: "cron",
  schedule_value: "0 */6 * * *",
  target_group_jid: "[current group JID]"
})
```

4. Welcome message: "Onboarding complete! I'll remember these preferences. Proactive mode is now active."

## Notes

- Can batch multiple questions if user prefers
- User can skip optional questions (marked with ?)
- Can update answers later by editing state.md directly
