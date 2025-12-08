/**
 * Daily Briefing Pipeline
 *
 * Runs daily. Sends CEO (user) a summary via Telegram:
 * - Portfolio status
 * - What happened today
 * - What's planned for tomorrow
 * - Any decisions needed
 */

import * as fs from 'fs';
import * as path from 'path';
import { sendMessage } from '../telegram/bot';

const STATE_DIR = path.join(__dirname, '../../state');

interface Portfolio {
  cash: number;
  startingCapital: number;
  positions: any[];
  metrics: {
    totalReturn: number;
    totalReturnPct: number;
  };
}

interface Hypothesis {
  id: string;
  title: string;
  status: string;
  confidence: number;
}

interface PendingApproval {
  id: string;
  type: string;
  summary: string;
  priority: string;
}

function loadJson(filename: string): any {
  try {
    const filepath = path.join(STATE_DIR, filename);
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } catch {
    return null;
  }
}

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatPercent(pct: number): string {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

async function generateBriefing(): Promise<string> {
  const portfolio: Portfolio = loadJson('trading/portfolio.json');
  const hypotheses = loadJson('trading/hypotheses.json');
  const pendingApprovals = loadJson('shared/pending_approvals.json');
  const reflections = loadJson('shared/session-reflections.json');

  const lines: string[] = [];

  // Header
  lines.push('📊 *Daily Briefing*');
  lines.push('');

  // Portfolio
  if (portfolio) {
    const totalValue = portfolio.cash + portfolio.positions.reduce((sum, p) => {
      return sum + (p.shares * (p.currentPrice || p.entryPrice));
    }, 0);

    lines.push('*Portfolio*');
    lines.push(`Value: ${formatCurrency(totalValue)} (${formatPercent(portfolio.metrics.totalReturnPct)})`);
    lines.push(`Cash: ${formatCurrency(portfolio.cash)}`);
    lines.push(`Positions: ${portfolio.positions.length}`);

    // Show positions briefly
    if (portfolio.positions.length > 0) {
      for (const pos of portfolio.positions.slice(0, 3)) {
        const pnl = pos.unrealizedPnL || 0;
        const pnlStr = pnl >= 0 ? `+${pnl.toFixed(2)}` : pnl.toFixed(2);
        lines.push(`  • ${pos.outcome}: ${formatCurrency(pos.currentPrice * 100)}/share (${pnlStr})`);
      }
    }
    lines.push('');
  }

  // Hypotheses summary
  if (hypotheses?.hypotheses) {
    const hyps = hypotheses.hypotheses;
    const testing = hyps.filter((h: Hypothesis) => h.status === 'testing').length;
    const proposed = hyps.filter((h: Hypothesis) => h.status === 'proposed').length;

    lines.push('*Hypotheses*');
    lines.push(`Testing: ${testing} | Proposed: ${proposed}`);

    // Show active ones
    const active = hyps.filter((h: Hypothesis) => h.status === 'testing').slice(0, 3);
    for (const h of active) {
      lines.push(`  • ${h.id}: ${Math.round(h.confidence * 100)}% confidence`);
    }
    lines.push('');
  }

  // Pending approvals
  if (pendingApprovals?.pending?.length > 0) {
    lines.push(`⚠️ *${pendingApprovals.pending.length} pending approvals*`);
    for (const approval of pendingApprovals.pending.slice(0, 3)) {
      lines.push(`  • [${approval.priority}] ${approval.summary}`);
    }
    lines.push('Use /pending to review');
    lines.push('');
  }

  // Recent friction (from reflections)
  if (reflections?.sessions?.length > 0) {
    const recent = reflections.sessions.slice(-3);
    const allFriction = recent.flatMap((s: any) => s.friction || []);

    if (allFriction.length > 0) {
      lines.push('*Recent friction*');
      for (const f of allFriction.slice(0, 2)) {
        lines.push(`  • ${f.slice(0, 60)}${f.length > 60 ? '...' : ''}`);
      }
      lines.push('');
    }
  }

  // What's next
  lines.push('*What should I focus on?*');
  lines.push('Reply with priorities or say "continue" to proceed with current plan.');

  return lines.join('\n');
}

async function main() {
  try {
    const briefing = await generateBriefing();
    await sendMessage(briefing);

    console.log(JSON.stringify({
      success: true,
      summary: 'Daily briefing sent to Telegram'
    }));
  } catch (error: any) {
    console.log(JSON.stringify({
      success: false,
      error: error.message
    }));
    process.exit(1);
  }
}

main();
