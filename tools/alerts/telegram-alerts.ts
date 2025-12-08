/**
 * Telegram Alerts (imp-005)
 *
 * Centralized alert system for trading events.
 * Used by pipelines to notify user of important changes.
 *
 * Alert types:
 * - trade_executed: New position opened/closed
 * - exit_trigger: Stop loss or take profit hit
 * - hypothesis_update: Hypothesis validated/invalidated
 * - price_alert: Significant price movement
 * - system_alert: Errors, warnings, daily summaries
 */

import { sendMessage } from '../telegram/bot';

export type AlertType =
  | 'trade_executed'
  | 'exit_trigger'
  | 'hypothesis_update'
  | 'price_alert'
  | 'system_alert'
  | 'daily_summary';

export interface TradeAlert {
  type: 'trade_executed';
  action: 'ENTRY' | 'EXIT';
  market: string;
  outcome: string;
  direction: 'YES' | 'NO';
  price: number;
  shares: number;
  cost: number;
  reason?: string;
}

export interface ExitTriggerAlert {
  type: 'exit_trigger';
  trigger: 'take_profit' | 'stop_loss' | 'time_limit';
  positionId: string;
  market: string;
  outcome: string;
  currentPrice: number;
  threshold: number;
  unrealizedPnL: number;
}

export interface HypothesisAlert {
  type: 'hypothesis_update';
  hypothesisId: string;
  statement: string;
  newStatus: 'validated' | 'invalidated' | 'promoted' | 'demoted';
  confidence: number;
  reason?: string;
}

export interface PriceAlert {
  type: 'price_alert';
  market: string;
  outcome: string;
  oldPrice: number;
  newPrice: number;
  changePercent: number;
  pnlChange: number;
  positionId?: string;
}

export interface SystemAlert {
  type: 'system_alert';
  severity: 'info' | 'warning' | 'error';
  title: string;
  message: string;
}

export interface DailySummaryAlert {
  type: 'daily_summary';
  date: string;
  portfolioValue: number;
  cash: number;
  unrealizedPnL: number;
  dailyChange: number;
  dailyChangePct: number;
  openPositions: number;
  activeHypotheses: number;
  alerts: string[];
}

export type Alert =
  | TradeAlert
  | ExitTriggerAlert
  | HypothesisAlert
  | PriceAlert
  | SystemAlert
  | DailySummaryAlert;

// Format helpers
function formatPrice(price: number): string {
  if (price < 0.01) return `${(price * 100).toFixed(2)}¢`;
  if (price < 1) return `${(price * 100).toFixed(1)}¢`;
  return `$${price.toFixed(2)}`;
}

function formatPnL(pnl: number): string {
  const sign = pnl >= 0 ? '+' : '';
  return `${sign}$${pnl.toFixed(2)}`;
}

function formatPercent(pct: number): string {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

// Alert formatters
function formatTradeAlert(alert: TradeAlert): string {
  const emoji = alert.action === 'ENTRY' ? '📈' : '📉';
  const action = alert.action === 'ENTRY' ? 'Opened' : 'Closed';

  let msg = `${emoji} *Trade ${action}*\n\n`;
  msg += `*Market:* ${alert.market}\n`;
  msg += `*Outcome:* ${alert.outcome} (${alert.direction})\n`;
  msg += `*Price:* ${formatPrice(alert.price)}\n`;
  msg += `*Shares:* ${alert.shares.toLocaleString()}\n`;
  msg += `*Cost:* $${alert.cost.toFixed(2)}`;

  if (alert.reason) {
    msg += `\n\n_${alert.reason}_`;
  }

  return msg;
}

function formatExitTriggerAlert(alert: ExitTriggerAlert): string {
  let emoji = '⚠️';
  let triggerName = 'Exit Trigger';

  if (alert.trigger === 'stop_loss') {
    emoji = '🔴';
    triggerName = 'STOP LOSS';
  } else if (alert.trigger === 'take_profit') {
    emoji = '🟢';
    triggerName = 'TAKE PROFIT';
  } else if (alert.trigger === 'time_limit') {
    emoji = '⏰';
    triggerName = 'TIME LIMIT';
  }

  let msg = `${emoji} *${triggerName} HIT*\n\n`;
  msg += `*Position:* ${alert.positionId}\n`;
  msg += `*Market:* ${alert.market}\n`;
  msg += `*Outcome:* ${alert.outcome}\n`;
  msg += `*Current:* ${formatPrice(alert.currentPrice)}`;

  if (alert.trigger !== 'time_limit') {
    msg += ` (threshold: ${formatPrice(alert.threshold)})`;
  }

  msg += `\n*P&L:* ${formatPnL(alert.unrealizedPnL)}`;
  msg += `\n\n_Action required: Review and confirm exit_`;

  return msg;
}

function formatHypothesisAlert(alert: HypothesisAlert): string {
  const emojis: Record<string, string> = {
    validated: '✅',
    invalidated: '❌',
    promoted: '⬆️',
    demoted: '⬇️'
  };

  const emoji = emojis[alert.newStatus] || '📊';
  const statusText = alert.newStatus.charAt(0).toUpperCase() + alert.newStatus.slice(1);

  let msg = `${emoji} *Hypothesis ${statusText}*\n\n`;
  msg += `*ID:* ${alert.hypothesisId}\n`;
  msg += `*Statement:* ${alert.statement.slice(0, 100)}${alert.statement.length > 100 ? '...' : ''}\n`;
  msg += `*Confidence:* ${(alert.confidence * 100).toFixed(0)}%`;

  if (alert.reason) {
    msg += `\n\n_${alert.reason}_`;
  }

  return msg;
}

function formatPriceAlert(alert: PriceAlert): string {
  const direction = alert.changePercent >= 0 ? '📈' : '📉';
  const emoji = Math.abs(alert.changePercent) > 10 ? '🚨' : direction;

  let msg = `${emoji} *Price Movement*\n\n`;
  msg += `*Market:* ${alert.market}\n`;
  msg += `*Outcome:* ${alert.outcome}\n`;
  msg += `*Price:* ${formatPrice(alert.oldPrice)} → ${formatPrice(alert.newPrice)} (${formatPercent(alert.changePercent)})\n`;

  if (alert.positionId) {
    msg += `*Position P&L Change:* ${formatPnL(alert.pnlChange)}`;
  }

  return msg;
}

function formatSystemAlert(alert: SystemAlert): string {
  const emojis: Record<string, string> = {
    info: 'ℹ️',
    warning: '⚠️',
    error: '❌'
  };

  const emoji = emojis[alert.severity] || 'ℹ️';

  return `${emoji} *${alert.title}*\n\n${alert.message}`;
}

function formatDailySummaryAlert(alert: DailySummaryAlert): string {
  const emoji = alert.dailyChange >= 0 ? '📈' : '📉';

  let msg = `${emoji} *Daily Summary - ${alert.date}*\n\n`;
  msg += `*Portfolio:* $${alert.portfolioValue.toFixed(2)}\n`;
  msg += `*Cash:* $${alert.cash.toFixed(2)}\n`;
  msg += `*Unrealized P&L:* ${formatPnL(alert.unrealizedPnL)}\n`;
  msg += `*Today:* ${formatPnL(alert.dailyChange)} (${formatPercent(alert.dailyChangePct)})\n\n`;
  msg += `*Open Positions:* ${alert.openPositions}\n`;
  msg += `*Active Hypotheses:* ${alert.activeHypotheses}`;

  if (alert.alerts.length > 0) {
    msg += `\n\n*Alerts:*\n`;
    for (const a of alert.alerts) {
      msg += `• ${a}\n`;
    }
  }

  return msg;
}

// Main alert function
export async function sendAlert(alert: Alert): Promise<boolean> {
  let message: string;

  switch (alert.type) {
    case 'trade_executed':
      message = formatTradeAlert(alert);
      break;
    case 'exit_trigger':
      message = formatExitTriggerAlert(alert);
      break;
    case 'hypothesis_update':
      message = formatHypothesisAlert(alert);
      break;
    case 'price_alert':
      message = formatPriceAlert(alert);
      break;
    case 'system_alert':
      message = formatSystemAlert(alert);
      break;
    case 'daily_summary':
      message = formatDailySummaryAlert(alert);
      break;
    default:
      console.error('Unknown alert type:', alert);
      return false;
  }

  const result = await sendMessage(message);
  return result !== null;
}

// Convenience functions
export async function alertTradeExecuted(
  action: 'ENTRY' | 'EXIT',
  market: string,
  outcome: string,
  direction: 'YES' | 'NO',
  price: number,
  shares: number,
  cost: number,
  reason?: string
): Promise<boolean> {
  return sendAlert({
    type: 'trade_executed',
    action,
    market,
    outcome,
    direction,
    price,
    shares,
    cost,
    reason
  });
}

export async function alertExitTrigger(
  trigger: 'take_profit' | 'stop_loss' | 'time_limit',
  positionId: string,
  market: string,
  outcome: string,
  currentPrice: number,
  threshold: number,
  unrealizedPnL: number
): Promise<boolean> {
  return sendAlert({
    type: 'exit_trigger',
    trigger,
    positionId,
    market,
    outcome,
    currentPrice,
    threshold,
    unrealizedPnL
  });
}

export async function alertHypothesisUpdate(
  hypothesisId: string,
  statement: string,
  newStatus: 'validated' | 'invalidated' | 'promoted' | 'demoted',
  confidence: number,
  reason?: string
): Promise<boolean> {
  return sendAlert({
    type: 'hypothesis_update',
    hypothesisId,
    statement,
    newStatus,
    confidence,
    reason
  });
}

export async function alertPriceMovement(
  market: string,
  outcome: string,
  oldPrice: number,
  newPrice: number,
  pnlChange: number = 0,
  positionId?: string
): Promise<boolean> {
  const changePercent = ((newPrice - oldPrice) / oldPrice) * 100;

  return sendAlert({
    type: 'price_alert',
    market,
    outcome,
    oldPrice,
    newPrice,
    changePercent,
    pnlChange,
    positionId
  });
}

export async function alertSystem(
  severity: 'info' | 'warning' | 'error',
  title: string,
  message: string
): Promise<boolean> {
  return sendAlert({
    type: 'system_alert',
    severity,
    title,
    message
  });
}

export async function alertDailySummary(
  portfolioValue: number,
  cash: number,
  unrealizedPnL: number,
  dailyChange: number,
  openPositions: number,
  activeHypotheses: number,
  alerts: string[] = []
): Promise<boolean> {
  const dailyChangePct = (dailyChange / (portfolioValue - dailyChange)) * 100;

  return sendAlert({
    type: 'daily_summary',
    date: new Date().toISOString().split('T')[0],
    portfolioValue,
    cash,
    unrealizedPnL,
    dailyChange,
    dailyChangePct,
    openPositions,
    activeHypotheses,
    alerts
  });
}

// CLI interface for testing
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'test') {
    // Send test alerts
    (async () => {
      console.log('Sending test alerts...');

      await alertSystem('info', 'Test Alert', 'This is a test of the alert system.');

      console.log('Done!');
    })();
  } else if (command === 'trade') {
    (async () => {
      await alertTradeExecuted(
        'ENTRY',
        'Test Market',
        'Test Outcome',
        'YES',
        0.25,
        1000,
        250,
        'Testing trade alert'
      );
    })();
  } else if (command === 'exit') {
    (async () => {
      await alertExitTrigger(
        'stop_loss',
        'trade-test',
        'Test Market',
        'Test Outcome',
        0.03,
        0.04,
        -100
      );
    })();
  } else if (command === 'hypothesis') {
    (async () => {
      await alertHypothesisUpdate(
        'hyp-test',
        'Test hypothesis about market behavior',
        'validated',
        0.85,
        'Strong evidence from recent trades'
      );
    })();
  } else if (command === 'price') {
    (async () => {
      await alertPriceMovement(
        'Test Market',
        'Test Outcome',
        0.10,
        0.15,
        250,
        'trade-test'
      );
    })();
  } else if (command === 'summary') {
    (async () => {
      await alertDailySummary(
        10250,
        9500,
        -88.88,
        50,
        1,
        3,
        ['AAPL position down 15%', 'hyp-002 showing weak momentum signals']
      );
    })();
  } else {
    console.log(`
Telegram Alerts CLI

Usage:
  npx ts-node tools/alerts/telegram-alerts.ts test        # Send test system alert
  npx ts-node tools/alerts/telegram-alerts.ts trade       # Test trade alert
  npx ts-node tools/alerts/telegram-alerts.ts exit        # Test exit trigger alert
  npx ts-node tools/alerts/telegram-alerts.ts hypothesis  # Test hypothesis alert
  npx ts-node tools/alerts/telegram-alerts.ts price       # Test price alert
  npx ts-node tools/alerts/telegram-alerts.ts summary     # Test daily summary alert
    `);
  }
}
