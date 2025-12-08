/**
 * Health Check Pipeline
 *
 * Analyzes system state and proposes actions that need user approval.
 * Runs on schedule, identifies issues, creates pending approvals.
 *
 * Usage: npx ts-node tools/pipelines/health-check.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const STATE_DIR = path.join(__dirname, '../../state');
const HYPOTHESES_FILE = path.join(STATE_DIR, 'hypotheses.json');
const ENGINE_STATUS_FILE = path.join(STATE_DIR, 'engine-status.json');
const PENDING_APPROVALS_FILE = path.join(STATE_DIR, 'pending_approvals.json');
const IMPROVEMENTS_FILE = path.join(STATE_DIR, 'improvements.json');

interface Approval {
  id: string;
  type: string;
  title: string;
  description: string;
  proposedAt: string;
  status: string;
  context: Record<string, unknown>;
  decidedAt: string | null;
  decisionNote: string | null;
}

interface PendingApprovals {
  approvals: Approval[];
}

interface HealthCheckOutput {
  runAt: string;
  issuesFound: number;
  proposalsCreated: number;
  proposals: Array<{
    id: string;
    type: string;
    title: string;
    action: string;
  }>;
  summary: string;
}

function loadJson(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function saveJson(filePath: string, data: any): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function generateApprovalId(): string {
  return `approval-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
}

function addApproval(approval: Approval): void {
  const approvals: PendingApprovals = loadJson(PENDING_APPROVALS_FILE) || { approvals: [] };

  // Don't add duplicate proposals (check by title + type)
  const exists = approvals.approvals.some(
    a => a.title === approval.title && a.type === approval.type && a.status === 'pending'
  );

  if (!exists) {
    approvals.approvals.push(approval);
    saveJson(PENDING_APPROVALS_FILE, approvals);
  }
}

function checkHypothesisHealth(hypotheses: any, engineStatus: any): Array<{issue: string; proposal: Approval}> {
  const issues: Array<{issue: string; proposal: Approval}> = [];
  const hypList = hypotheses.hypotheses || [];

  for (const h of hypList) {
    // Check for low confidence hypotheses that should be invalidated
    if (['proposed', 'testing'].includes(h.status) && h.confidence <= 0.25 && (h.evidence?.length || 0) >= 3) {
      issues.push({
        issue: `${h.id} has low confidence (${(h.confidence * 100).toFixed(0)}%) with ${h.evidence.length} pieces of negative evidence`,
        proposal: {
          id: generateApprovalId(),
          type: 'hypothesis_action',
          title: `Invalidate ${h.id}: ${h.statement.substring(0, 50)}...`,
          description: `Hypothesis ${h.id} has ${(h.confidence * 100).toFixed(0)}% confidence after ${h.evidence.length} pieces of evidence, mostly negative. Recommended action: invalidate and move on.`,
          proposedAt: new Date().toISOString(),
          status: 'pending',
          context: {
            hypothesisId: h.id,
            action: 'invalidate',
            currentConfidence: h.confidence,
            evidenceCount: h.evidence?.length || 0,
            negativeEvidence: h.evidence?.filter((e: any) => !e.supports).length || 0
          },
          decidedAt: null,
          decisionNote: null
        }
      });
    }

    // Check for stale proposed hypotheses (proposed > 7 days with no action)
    if (h.status === 'proposed') {
      const daysSinceCreated = (Date.now() - new Date(h.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceCreated > 7 && !engineStatus.blockedHypotheses?.some((b: any) => b.hypothesisId === h.id)) {
        issues.push({
          issue: `${h.id} has been proposed for ${daysSinceCreated.toFixed(0)} days without testing`,
          proposal: {
            id: generateApprovalId(),
            type: 'hypothesis_action',
            title: `Start testing ${h.id} or deprioritize`,
            description: `Hypothesis ${h.id} has been in 'proposed' status for ${daysSinceCreated.toFixed(0)} days. Either start testing or mark as low priority.`,
            proposedAt: new Date().toISOString(),
            status: 'pending',
            context: {
              hypothesisId: h.id,
              action: 'review',
              daysPending: daysSinceCreated,
              statement: h.statement
            },
            decidedAt: null,
            decisionNote: null
          }
        });
      }
    }
  }

  return issues;
}

function checkEngineHealth(engineStatus: any, improvements: any): Array<{issue: string; proposal: Approval}> {
  const issues: Array<{issue: string; proposal: Approval}> = [];

  // If engine is starved and there are blocked hypotheses with known fixes
  if (engineStatus.engineState === 'starved' && engineStatus.blockedHypotheses?.length > 0) {
    // Find blocked hypotheses that have a known improvement to unblock them
    for (const blocked of engineStatus.blockedHypotheses) {
      if (blocked.improvementId) {
        const improvement = improvements.backlog?.find((i: any) => i.id === blocked.improvementId);
        if (improvement && improvement.effort !== 'high') {
          issues.push({
            issue: `Engine starved, ${blocked.hypothesisId} blocked by ${blocked.blockedBy}`,
            proposal: {
              id: generateApprovalId(),
              type: 'improvement',
              title: `Build ${improvement.id}: ${improvement.title}`,
              description: `Engine is starved (only ${engineStatus.hypothesisHealth?.testableNow || 0} testable hypotheses). Building ${improvement.id} would unblock ${blocked.hypothesisId}. Effort: ${improvement.effort}`,
              proposedAt: new Date().toISOString(),
              status: 'pending',
              context: {
                improvementId: improvement.id,
                action: 'build',
                unblocks: blocked.hypothesisId,
                effort: improvement.effort,
                leverage: improvement.leverage
              },
              decidedAt: null,
              decisionNote: null
            }
          });
        }
      }
    }
  }

  return issues;
}

async function runHealthCheck(): Promise<HealthCheckOutput> {
  const output: HealthCheckOutput = {
    runAt: new Date().toISOString(),
    issuesFound: 0,
    proposalsCreated: 0,
    proposals: [],
    summary: ''
  };

  console.error('Running health check...');

  const hypotheses = loadJson(HYPOTHESES_FILE);
  const engineStatus = loadJson(ENGINE_STATUS_FILE);
  const improvements = loadJson(IMPROVEMENTS_FILE);

  if (!hypotheses || !engineStatus) {
    output.summary = 'Failed to load required state files';
    return output;
  }

  // Collect all issues
  const allIssues: Array<{issue: string; proposal: Approval}> = [];

  allIssues.push(...checkHypothesisHealth(hypotheses, engineStatus));
  allIssues.push(...checkEngineHealth(engineStatus, improvements));

  output.issuesFound = allIssues.length;

  // Create proposals for each issue
  for (const {issue, proposal} of allIssues) {
    console.error(`Issue: ${issue}`);
    addApproval(proposal);
    output.proposalsCreated++;
    output.proposals.push({
      id: proposal.id,
      type: proposal.type,
      title: proposal.title,
      action: (proposal.context as any).action
    });
  }

  // Generate summary
  if (output.issuesFound === 0) {
    output.summary = 'No issues found. System healthy.';
  } else {
    output.summary = `Found ${output.issuesFound} issues, created ${output.proposalsCreated} proposals for review.`;
  }

  console.error(output.summary);

  return output;
}

// Run the health check
runHealthCheck()
  .then(output => {
    console.log(JSON.stringify(output, null, 2));
    process.exit(0);
  })
  .catch(error => {
    console.error(`Health check failed: ${error.message}`);
    process.exit(1);
  });
