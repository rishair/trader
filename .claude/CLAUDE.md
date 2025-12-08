# Autonomous Polymarket Trading System

A self-improving autonomous trading system focused on Polymarket prediction markets.

## Architecture: Two-Role System

The system has two agent roles that coordinate through responsibilities and handoffs:

| Role | Focus | Powers |
|------|-------|--------|
| **Trade Research Engineer** | Polymarket research, hypotheses, strategies, trades | Owns `trading/*` state |
| **Agent Engineer** | System improvement, tools, infrastructure | Can modify agents, tools, daemon |

## Key Files

- `MISSION.md` - The agent's constitution and operating principles
- `state/` - All persistent state (organized by ownership)
- `daemon.ts` - Orchestrator: schedules responsibilities, processes handoffs
- `tools/` - Agent-created tools, pipelines, and MCP servers
- `.claude/agents/` - Agent prompt definitions

## Commands

- `/status` - Get current agent status
- `/wake` - Manually trigger task execution
- `/research [topic]` - Conduct research on a topic
- `/bootstrap` - First-time initialization
- `/reflect` - Reflect on conversation and update system with demonstrated preferences

## State File Organization

```
state/
  orchestrator/           # Daemon state
    schedule.json         # Scheduled tasks
    handoffs.json         # Async requests between agents
    responsibilities.json # Standing duties and their schedules

  trading/                # Owned by Trade Research Engineer
    hypotheses.json       # Research hypotheses
    strategies.json       # Trading strategies
    experiments.json      # Active experiments
    portfolio.json        # Positions and P&L
    engine-status.json    # Hypothesis engine state
    learnings.json        # Accumulated insights
    price-history.json    # Price tracking data
    leaderboard/          # Top trader tracking

  agent-engineering/      # Owned by Agent Engineer
    health.json           # System health metrics
    issues.json           # Active bugs/issues
    capabilities.json     # Tool registry

  improvements/           # Shared - any agent can write ideas
    ideas.json            # Improvement proposals
    implemented.json      # Completed improvements

  shared/                 # Both can read/write
    inbox.json            # User content intake
    pending_approvals.json# Actions awaiting user approval
    status.md             # Human-readable status
    resources.json        # Tracked resources
```

## Standing Responsibilities

Each agent has recurring duties on a schedule (managed in `responsibilities.json`):

### Trade Research Engineer
- `hypothesis-health` (4h) - Review hypothesis statuses
- `market-scan` (8h) - Check for new opportunities
- `portfolio-review` (daily) - Check positions and P&L
- `experiment-progress` (daily) - Review running experiments
- `strategy-review` (weekly) - What's working, what's not
- `learning-synthesis` (weekly) - Extract patterns from learnings

### Agent Engineer
- `idea-triage` (6h) - Review improvement ideas, prioritize
- `build-sprint` (daily) - Implement top 1-2 ideas
- `system-health` (daily) - Check for errors, fix issues
- `agent-review` (weekly) - Are agent prompts effective?
- `capability-audit` (weekly) - Review tool registry

## Agent Communication

### Synchronous (Spawn & Wait)
Use Task tool when blocked and need immediate answer:
```typescript
// Agent spawns another and waits for result
const result = await Task({
  subagent_type: 'trade-research',
  prompt: 'Analyze market X',
  description: 'Market analysis'
});
```

### Asynchronous (Handoffs)
Use `lib/handoffs.ts` when not blocking:
```typescript
import { createHandoff } from './lib/handoffs';
createHandoff('trade-research', 'agent-engineer', 'build_capability', {
  description: 'Need price history tracker'
});
```

## Self-Improvement System

Any agent can log improvement ideas to `improvements/ideas.json`:
```json
{
  "type": "capability",  // or "self-improvement", "process", "fix"
  "description": "Need Twitter sentiment analyzer",
  "rationale": "Would improve momentum detection"
}
```

Agent Engineer reviews and implements improvements, which may include:
- Updating agent prompts (`.claude/agents/*.md`)
- Creating new tools (`tools/`)
- Modifying the daemon or handler
- Updating this documentation

## Paper Trading

All trades are simulated. Track positions against real market prices but no real money is at risk.

## Human Interaction

### The User is CEO

You report to them. This means:

**Daily Briefing (via Telegram)**
- Every day, send a short summary: portfolio, what happened, what's next
- End with: "What should I focus on?"
- Wait for direction or "continue" before proceeding with big changes

**Approval Gates**
Get explicit approval before:
- Opening new positions
- Infrastructure changes (tools, daemon, agents)
- Promoting hypotheses to active strategies
- Anything novel or experimental

**How to request approval:**
1. Send concise summary via Telegram (not raw JSON)
2. Include: what, why, risk, what you need from them
3. Wait for response before executing

**Communication Style**
- Short, scannable messages
- No walls of text or JSON dumps
- Lead with the decision needed, then context if they ask
- Respect their time — they have other things going on

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
- **Include GitHub link in Telegram**: When notifying via Telegram about a commit, include the link: `https://github.com/rishair/trader/commit/<hash>`

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
- **Use `npm run deploy`** - Works from anywhere:
  - On local machine: SSHs to server and deploys
  - On server (trader): Pulls latest and restarts services locally
- **Never manually start processes** - Starting processes manually while systemd services exist causes duplicates
- **Check what's running first** - Before killing/starting anything: `ps aux | grep <process>` and `systemctl status <service>`

### Claude CLI Session Flags
- `--session-id <uuid>` - Names a NEW session with that ID (creates it)
- `--resume <uuid>` - Continues an EXISTING session (loads history)
- For persistent Telegram conversations: use `--session-id` on first message, `--resume` on follow-ups
