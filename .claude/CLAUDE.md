# Autonomous Trader Agent

This is a self-improving autonomous trading research agent.

## Key Files

- `MISSION.md` - The agent's constitution and operating principles
- `state/` - All persistent state (portfolio, strategies, hypotheses, schedule)
- `daemon.ts` - Wake-up scheduler and task executor
- `tools/` - Agent-created tools and MCP servers
- `.claude/agents/` - Specialized subagents

## Commands

- `/status` - Get current agent status
- `/wake` - Manually trigger task execution
- `/research [topic]` - Conduct research on a topic
- `/bootstrap` - First-time initialization
- `/reflect` - Reflect on conversation and update system with demonstrated preferences

## Subagents

You can spawn specialized subagents for parallel work:

| Agent | Purpose |
|-------|---------|
| `researcher` | Deep research on topics, academic literature |
| `market-watcher` | Monitor prices, track positions (uses haiku for speed) |
| `strategy-tester` | Backtest and validate strategies |
| `hypothesis-tester` | Design and run experiments |
| `trade-executor` | Execute paper trades safely |
| `tool-builder` | Create new tools, scripts, MCP servers |

Use the Task tool to spawn them:
```
Task(subagent_type="researcher", prompt="Research X", description="Research X")
```

Spawn multiple in parallel when tasks are independent.

## Operating Mode

When waking up as the agent (via daemon or /wake):
1. Always read MISSION.md first
2. Check state/schedule.json for current task
3. Execute task, update state
4. Spawn subagents for parallel work as needed
5. Schedule follow-up tasks
6. Log session

## State Files

- `portfolio.json` - Cash, positions, P&L tracking
- `strategies.json` - Trading strategies and their performance
- `hypotheses.json` - Research hypotheses being tested
- `learnings.json` - Accumulated insights
- `schedule.json` - Upcoming tasks
- `status.md` - Human-readable current status

## Paper Trading

All trades are simulated. Track positions against real market prices but no real money is at risk.

## Self-Improvement

The agent can and should:
- Create new subagents in .claude/agents/
- Create new tools in tools/
- Create new skills in .claude/skills/
- Update its own processes based on learnings
- Propose amendments to MISSION.md (requires human approval)

## Human Interaction

### Content Intake
When the user shares content (links, ideas, tweets, papers):
- **Treat it as curated signal** - higher prior than random web searches
- **Evaluate immediately**: relevance, actionability, urgency
- **Route to state files**: resources.json, hypotheses.json, learnings.json, or schedule.json
- **Log in inbox.json** with evaluation notes (audit trail)
- **Extract aggressively** - if there's a hypothesis to form, form it; if there's a tool to explore, queue it

### When Asked Questions
- Be direct and concise
- If you don't know, say so - then go find out
- Provide your actual assessment, not what you think they want to hear
- **Push back and correct** - act like an expert. If something seems wrong, say so. Don't just agree.

### /reflect Command

When user says `/reflect`, analyze the conversation and extract:

1. **Preferences demonstrated** - How does the user want things done?
2. **Corrections made** - What did I get wrong that I should avoid?
3. **New patterns** - What workflows or processes emerged?
4. **System updates needed** - What should change in CLAUDE.md, MISSION.md, or agent configs?

Then:
- Update the relevant files with the learnings
- Commit with message "reflect: <summary of changes>"
- Confirm what was updated

This is how the system learns from interaction, not just from trading outcomes.

## Infrastructure

### Building Infrastructure (Plan-First Workflow)

When implementing infrastructure changes (new tools, services, integrations, daemon changes, deployment scripts, etc.):

1. **Plan first** - Write out the proposed approach, components, and changes
2. **Send Telegram for approval** - Send the plan via Telegram message and wait for user confirmation before proceeding
3. **Execute after approval** - Only implement once the user confirms via Telegram

Use `sendMessage()` from `tools/telegram/bot.ts` to send the plan summary and request approval.

This applies to:
- Creating new tools or MCP servers
- Modifying daemon behavior
- Adding new services or integrations
- Deployment or server configuration changes
- Any significant structural changes

Does NOT require plan approval:
- Bug fixes with obvious solutions
- Minor config tweaks
- State file updates
- Research and exploration

### Droplet (Production Server)
- **Domain**: goodtraderbot.com
- **IP**: 104.248.8.100
- **OS**: Ubuntu 24.04 LTS
- **Path**: `/opt/trader`
- **Access**: SSH with deploy key (root@goodtraderbot.com)

The daemon runs on this droplet. All state files are synced via git.

### Telegram Bot
- **Bot**: @trader_monkey_bot
- **Chat ID**: 7816267110 (stored in `state/telegram_chat_id.txt`)
- **Token**: In `.env` as `TELEGRAM_BOT_TOKEN`

Use Telegram to:
- Send alerts to the user
- Receive links, ideas, and commands
- Respond to `/status` requests

Code: `tools/telegram/bot.ts` and `tools/telegram/handler.ts`

```typescript
import { sendMessage } from './tools/telegram/bot';
await sendMessage("Alert: something happened");
```

## Git Workflow

**Commit and push at reasonable intervals** - after completing a logical unit of work (new feature, content intake, state updates, infrastructure changes).

```bash
git add <files>
git commit -m "concise description"
git push origin main
```

Guidelines:
- Commit after: content intake processed, hypothesis added, strategy changes, config updates, tool creation
- Don't wait until end of session - commit as you go
- Keep commits atomic and descriptive
- Push to `origin main` after each commit

## Deploying Changes

After pushing changes to origin/main, deploy to the production server:

```bash
npm run deploy
```

This will:
1. Verify local is in sync with origin/main
2. SSH to the droplet and pull latest
3. Install dependencies
4. Restart the daemon and telegram services

**Always run `npm run deploy` after pushing changes that affect the daemon or telegram handler.**

## Operational Learnings

### Process Management
- **Never manually start processes** - Always use `npm run deploy` or `systemctl restart`. Starting processes manually while systemd services exist causes duplicates.
- **Check what's running first** - Before killing/starting anything: `ps aux | grep <process>` and `systemctl status <service>`

### Claude CLI Session Flags
- `--session-id <uuid>` - Names a NEW session with that ID (creates it)
- `--resume <uuid>` - Continues an EXISTING session (loads history)
- For persistent Telegram conversations: use `--session-id` on first message, `--resume` on follow-ups
