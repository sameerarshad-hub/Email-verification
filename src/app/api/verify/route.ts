import { NextRequest, NextResponse } from 'next/server';
import { getVerificationEngine } from '@/lib/verification-engine';
import { db } from '@/lib/db';

// POST - Start, stop, or reverify
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, batchId, statuses } = body;
    const engine = getVerificationEngine();

    if (action === 'start') {
      if (!batchId) {
        return NextResponse.json({ error: 'Batch ID is required' }, { status: 400 });
      }
      const result = await engine.start(batchId);
      return NextResponse.json(result);
    } else if (action === 'stop') {
      const result = await engine.stop();
      return NextResponse.json(result);
    } else if (action === 'reverify') {
      if (!batchId) {
        return NextResponse.json({ error: 'Batch ID is required' }, { status: 400 });
      }
      const result = await engine.reverify(batchId, statuses || ['error']);
      return NextResponse.json(result);
    } else if (action === 'precheck-mx') {
      if (!batchId) {
        return NextResponse.json({ error: 'Batch ID is required' }, { status: 400 });
      }
      const result = await engine.preCheckMx(batchId);
      return NextResponse.json(result);
    } else if (action === 'precheck-smtp') {
      if (!batchId) {
        return NextResponse.json({ error: 'Batch ID is required' }, { status: 400 });
      }
      const result = await engine.preCheckSmtp(batchId);
      return NextResponse.json(result);
    } else {
      return NextResponse.json({ error: 'Invalid action. Use "start", "stop", "reverify", "precheck-mx", or "precheck-smtp".' }, { status: 400 });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// GET - Get verification status + breakdown
export async function GET() {
  try {
    const engine = getVerificationEngine();
    const engineStatus = engine.getStatus();

    // Check if engine should be running but isn't (stale state)
    const state = await db.verificationState.findUnique({ where: { id: 'main' } });
    if (state?.isRunning && !engineStatus.isRunning && state.currentBatchId) {
      const lastHeartbeat = state.lastHeartbeat ? new Date(state.lastHeartbeat).getTime() : 0;
      const staleMs = Date.now() - lastHeartbeat;
      if (staleMs > 30000) {
        // Defensive: only auto-resume if the engine truly isn't running.
        // Re-check status right before calling start() to avoid races with
        // the constructor's auto-resume path.
        const recheck = engine.getStatus();
        if (!recheck.isRunning) {
          console.log('[Status] Engine stale, attempting auto-resume');
          await engine.start(state.currentBatchId);
        }
      }
    }

    // Get active keys info
    const keys = await db.apiKey.findMany({ where: { active: true } });
    const today = new Date().toISOString().split('T')[0];
    const totalKeyCount = keys.length;
    const totalDailyLimit = keys.reduce((sum, k) => {
      return sum + (k.lastResetDate === today ? (k.dailyLimit - k.usedToday) : k.dailyLimit);
    }, 0);
    const totalUsedToday = keys.reduce((sum, k) => {
      return sum + (k.lastResetDate === today ? k.usedToday : 0);
    }, 0);

    // Get batch progress + breakdown
    let batchProgress = null;
    let statusBreakdown: Record<string, number> = {};
    if (engineStatus.currentBatchId) {
      const batch = await db.batch.findUnique({ where: { id: engineStatus.currentBatchId } });
      if (batch) {
        batchProgress = {
          totalContacts: batch.totalContacts,
          totalEmails: batch.totalEmails,
          verifiedEmails: batch.verifiedEmails,
          skippedEmails: batch.skippedEmails,
          currentColumn: batch.currentColumn,
          status: batch.status,
        };

        // Get status breakdown across all 6 email columns
        const STATUS_VALUES = ['valid', 'invalid', 'catch-all', 'no-mx', 'unverifiable', 'error', 'pending', 'verifying'];
        for (const sv of STATUS_VALUES) {
          let count = 0;
          for (const col of ['status1', 'status2', 'status3', 'status4', 'status5', 'status6']) {
            if (sv === 'pending') {
              // Pending includes both "pending" and "verifying" for display
              count += await db.contact.count({ where: { batchId: batch.id, [col]: { in: ['pending', 'verifying'] } } } as any);
            } else {
              count += await db.contact.count({ where: { batchId: batch.id, [col]: sv } } as any);
            }
          }
          statusBreakdown[sv] = count;
        }

        // Also count skipped
        let skippedCount = 0;
        for (const col of ['status1', 'status2', 'status3', 'status4', 'status5', 'status6']) {
          skippedCount += await db.contact.count({ where: { batchId: batch.id, [col]: { startsWith: 'skipped' } } } as any);
        }
        statusBreakdown['skipped'] = skippedCount;
      }
    }

    // Calculate effective speed
    const avgSpeedMs = keys.length > 0 ? Math.round(keys.reduce((s, k) => s + k.speedMs, 0) / keys.length) : 0;
    const effectivePerSecond = keys.length > 0 ? keys.length / (avgSpeedMs / 1000) : 0;
    const effectivePerDay = Math.round(effectivePerSecond * 86400);

    // Count pending emails across all batches
    const allBatches = await db.batch.findMany({ where: { status: { in: ['uploaded', 'paused', 'verifying'] } } });
    let totalPending = 0;
    for (const b of allBatches) {
      for (const col of ['status1', 'status2', 'status3', 'status4', 'status5', 'status6']) {
        const count = await db.contact.count({ where: { batchId: b.id, [col]: 'pending' } } as any);
        totalPending += count;
      }
    }

    return NextResponse.json({
      isRunning: engineStatus.isRunning,
      currentBatchId: engineStatus.currentBatchId,
      currentColumn: engineStatus.currentColumn,
      stats: engineStatus.stats,
      activeKeys: engineStatus.activeKeys,
      rateLimited: engineStatus.rateLimited,
      rateLimitBackoffSeconds: engineStatus.rateLimitBackoffSeconds,
      consecutive429s: engineStatus.consecutive429s,
      batchProgress,
      statusBreakdown,
      keys: {
        total: totalKeyCount,
        usedToday: totalUsedToday,
        remainingToday: totalDailyLimit,
        effectivePerSecond: Math.round(effectivePerSecond * 100) / 100,
        effectivePerDay,
      },
      totalPending,
      mxCheck: engine.getMxCheckStatus(),
      smtpCheck: engine.getSmtpCheckStatus(),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
