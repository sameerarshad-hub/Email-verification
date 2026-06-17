import { db } from './db';
import { batchCheckMx, batchCheckSmtp } from './mx-utils';

// Types
interface VerificationResult {
  email: string;
  user: string;
  domain: string;
  mx: string;
  code: string;     // ok, ko, mb
  message: string;  // Accepted, Limited, Rejected, Catch-All, No Mx, Mx Error, Timeout, SPAM Block
  connections: number;
}

interface KeyState {
  id: string;
  key: string;
  label: string | null;
  lastUsed: number;
  usedToday: number;
  lastResetDate: string;
  speedMs: number;
  dailyLimit: number;
  active: boolean;
  // Per-worker timers — each key runs N concurrent workers
  workerTimers: (ReturnType<typeof setTimeout> | null)[];
  workerBusy: boolean[];
  consecutive429s: number;
  // Per-key 429 backoff — when this key got a 429, only its workers pause.
  // Other keys continue processing. Better than global backoff.
  backoffUntil: number;
}

// Email column mapping (1-indexed)
const EMAIL_COLUMNS = ['email1', 'email2', 'email3', 'email4', 'email5', 'email6'] as const;
const STATUS_COLUMNS = ['status1', 'status2', 'status3', 'status4', 'status5', 'status6'] as const;
const MESSAGE_COLUMNS = ['message1', 'message2', 'message3', 'message4', 'message5', 'message6'] as const;

/**
 * Singleton verification engine with per-key parallel processing.
 *
 * CRITICAL FIX: Uses "verifying" intermediate status to atomically claim
 * an email. This prevents multiple keys from grabbing the same email.
 *
 * Flow: pending → verifying → valid/invalid/catch-all/no-mx/unverifiable/error
 *
 * 429 RATE LIMITING STRATEGY:
 * - When a 429 occurs, the email is put BACK to "pending" (not "error")
 *   so it's automatically retried later — no emails are lost.
 * - A GLOBAL backoff is applied: when ANY key gets a 429, ALL keys
 *   pause for the backoff duration (they share the same IP/account limit).
 * - Progressive backoff: 10s, 20s, 30s, ... up to 120s.
 * - When 429s stop, backoff resets to 0 and speed returns to normal.
 */
class VerificationEngine {
  private running = false;
  private currentBatchId: string | null = null;
  private currentColumn = 1; // 1-6
  private domainCache = new Map<string, 'catch-all' | 'no-mx' | 'slow-mx'>();
  private keyStates = new Map<string, KeyState>();
  // Number of concurrent workers per API key.
  // 4 workers per key = 8 total. During the initial phase, most workers handle
  // 3s timeouts for bad domains (doesn't trigger 429s since the API isn't responding).
  // Once bad domains are cached, workers do actual API calls — per-key 429 backoff
  // (capped at 5s) handles rate limiting without blocking the other key.
  private static readonly WORKERS_PER_KEY = 4;
  private stats = {
    verifiedThisRun: 0,
    skippedThisRun: 0,
    errorsThisRun: 0,
    startTime: 0,
  };
  // MX pre-check state
  private mxCheckRunning = false;
  private mxCheckProgress = { checked: 0, total: 0, noMxFound: 0, emailsMarked: 0, done: false, error: '' };
  // SMTP pre-check state
  private smtpCheckRunning = false;
  private smtpCheckProgress = { checked: 0, total: 0, unreachableFound: 0, emailsMarked: 0, done: false, error: '' };
  // Global 429 backoff — shared across all keys (they hit the same API account/IP)
  private global429BackoffUntil = 0; // timestamp when we can resume
  private globalConsecutive429s = 0;
  // Start lock — prevents duplicate auto-resume / concurrent start() calls
  private startInFlight = false;
  private autoResumeRan = false;
  // Retry tracking — prevents infinite loops on emails that always timeout.
  // Map<email, retryCount> and Map<email, nextAttemptAt>
  // After MAX_TRANSIENT_RETRIES, email is marked as 'unverifiable'.
  private retryCount = new Map<string, number>();
  private retryAfter = new Map<string, number>();
  // Domain-level failure tracking — if 2+ emails on the same domain timeout,
  // we mark the domain as "slow-mx" and skip all remaining emails for it.
  // This prevents wasting 6 emails × 15s timeout × 3 retries = 4.5 minutes per bad domain.
  private domainTimeoutCount = new Map<string, number>();
  private static readonly MAX_TRANSIENT_RETRIES = 2;
  private static readonly RETRY_COOLDOWN_MS = 8000; // 8s cooldown before retrying same email
  private static readonly DOMAIN_TIMEOUT_THRESHOLD = 1; // after 1 timeout, mark domain as slow (aggressive — most timeouts are real bad domains)

  constructor() {
    // Install process-level error handlers to prevent silent crashes
    // from unhandled promise rejections in the verification loop.
    try {
      process.on('unhandledRejection', (reason) => {
        console.error('[Engine][unhandledRejection]', reason);
      });
      process.on('uncaughtException', (err) => {
        console.error('[Engine][uncaughtException]', err);
      });
    } catch {}
    this.tryAutoResume();
  }

  private async tryAutoResume() {
    if (this.autoResumeRan) return;
    this.autoResumeRan = true;
    try {
      // First, reset any "verifying" statuses back to "pending" from a previous crash
      for (let col = 0; col < 6; col++) {
        const statusCol = STATUS_COLUMNS[col];
        await db.contact.updateMany({
          where: { [statusCol]: 'verifying' } as any,
          data: { [statusCol]: 'pending' },
        });
      }

      const state = await db.verificationState.findUnique({ where: { id: 'main' } });
      if (state?.isRunning && state.currentBatchId) {
        const batch = await db.batch.findUnique({ where: { id: state.currentBatchId } });
        if (batch && batch.status === 'verifying') {
          // Bypass startInFlight (constructor-only path) but respect running flag
          // — if a start() has already kicked in, do nothing
          if (this.running || this.startInFlight) {
            console.log('[Engine] Auto-resume skipped — engine already starting/running');
          } else {
            console.log('[Engine] Auto-resuming verification for batch:', state.currentBatchId);
            this.currentBatchId = state.currentBatchId;
            this.currentColumn = state.currentColumn;
            await this.loadDomainCache();
            await this.loadKeyStates();
            this.running = true;
            this.stats.startTime = Date.now();
            this.startAllKeyLoops();
          }
        } else {
          await db.verificationState.update({
            where: { id: 'main' },
            data: { isRunning: false },
          });
        }
      }
    } catch (err) {
      console.error('[Engine] Auto-resume failed:', err);
      this.autoResumeRan = false; // allow retry on next call
    }
  }

  async start(batchId: string): Promise<{ success: boolean; message: string }> {
    // Prevent concurrent start() calls — return immediately if one is in flight
    if (this.startInFlight) {
      return { success: false, message: 'A start operation is already in progress.' };
    }
    this.startInFlight = true;
    try {
      if (this.running) {
        await this.stop();
      }

    const keys = await db.apiKey.findMany({ where: { active: true } });
    if (keys.length === 0) {
      return { success: false, message: 'No active API keys. Please add at least one API key.' };
    }

    const batch = await db.batch.findUnique({ where: { id: batchId } });
    if (!batch) {
      return { success: false, message: 'Batch not found.' };
    }

    // Find the first column with pending emails
    let startColumn = 1;
    for (let col = 1; col <= 6; col++) {
      const statusCol = STATUS_COLUMNS[col - 1];
      const pendingCount = await db.contact.count({
        where: { batchId, [statusCol]: 'pending' } as any,
      });
      if (pendingCount > 0) {
        startColumn = col;
        break;
      }
    }

    this.currentBatchId = batchId;
    this.currentColumn = startColumn;
    this.running = true;
    this.stats = { verifiedThisRun: 0, skippedThisRun: 0, errorsThisRun: 0, startTime: Date.now() };

    await this.loadDomainCache();
    await this.loadKeyStates();

    await db.verificationState.upsert({
      where: { id: 'main' },
      update: { isRunning: true, currentBatchId: batchId, currentColumn: startColumn, startedAt: new Date(), lastHeartbeat: new Date() },
      create: { id: 'main', isRunning: true, currentBatchId: batchId, currentColumn: startColumn, startedAt: new Date(), lastHeartbeat: new Date() },
    });

    await db.batch.update({ where: { id: batchId }, data: { status: 'verifying', currentColumn: startColumn } });

    this.startAllKeyLoops();
    return { success: true, message: `Verification started with ${this.keyStates.size} key(s) in parallel.` };
    } finally {
      this.startInFlight = false;
    }
  }

  /**
   * Reverify: reset error/rate-limited emails back to pending and start verification.
   */
  async reverify(batchId: string, statuses: string[]): Promise<{ success: boolean; message: string; resetCount: number }> {
    if (this.running) {
      await this.stop();
    }

    let resetCount = 0;
    for (let col = 0; col < 6; col++) {
      const statusCol = STATUS_COLUMNS[col];
      const result = await db.contact.updateMany({
        where: {
          batchId,
          [statusCol]: { in: statuses },
        } as any,
        data: { [statusCol]: 'pending' },
      });
      resetCount += result.count;
    }

    if (resetCount === 0) {
      return { success: false, message: 'No emails found with the specified statuses to reverify.', resetCount: 0 };
    }

    // Now start verification
    const startResult = await this.start(batchId);
    return { success: startResult.success, message: `Reset ${resetCount} emails to pending. ${startResult.message}`, resetCount };
  }

  /**
   * Pre-check MX records for all domains in a batch WITHOUT using API credits.
   * Uses Node.js DNS resolver to check MX records directly.
   * Marks all emails under domains with no MX as "no-mx" and caches the domain.
   * 
   * This saves API credits because the verification loop will skip
   * these domains entirely (via the domainCache check).
   * 
   * Runs in the BACKGROUND — returns immediately. Use getMxCheckStatus() to poll.
   */
  async preCheckMx(batchId: string): Promise<{
    success: boolean;
    message: string;
    totalDomains: number;
  }> {
    if (this.mxCheckRunning) {
      return {
        success: false,
        message: 'MX pre-check is already running. Wait for it to finish.',
        totalDomains: 0,
      };
    }
    if (this.running) {
      return {
        success: false,
        message: 'Cannot pre-check MX while verification is running. Stop verification first.',
        totalDomains: 0,
      };
    }

    const batch = await db.batch.findUnique({ where: { id: batchId } });
    if (!batch) {
      return { success: false, message: 'Batch not found.', totalDomains: 0 };
    }

    // Kick off the background task
    this.mxCheckRunning = true;
    this.mxCheckProgress = { checked: 0, total: 0, noMxFound: 0, emailsMarked: 0, done: false, error: '' };

    // Run async in the background — do NOT await
    this.runMxPreCheckInBackground(batchId).catch(err => {
      console.error('[Engine] MX pre-check background error:', err);
      this.mxCheckProgress.error = err.message || 'Unknown error';
      this.mxCheckProgress.done = true;
      this.mxCheckRunning = false;
    });

    return {
      success: true,
      message: 'MX pre-check started in background. Use the status endpoint to monitor progress.',
      totalDomains: 0, // Will be updated by background task
    };
  }

  /**
   * Get current MX pre-check progress.
   */
  getMxCheckStatus() {
    return {
      running: this.mxCheckRunning,
      ...this.mxCheckProgress,
    };
  }

  /**
   * Background worker for MX pre-check. Does the actual work.
   */
  private async runMxPreCheckInBackground(batchId: string) {
    console.log('[Engine] MX pre-check starting in background for batch:', batchId);

    // Load existing domain cache first
    await this.loadDomainCache();

    // 1. Get all unique domains from the batch that aren't already cached as no-mx
    const contacts = await db.contact.findMany({
      where: { batchId },
      select: { domain: true },
    });

    const uniqueDomains = [...new Set(contacts.map(c => c.domain.toLowerCase()))];
    // Filter out domains already known to be no-mx
    const domainsToCheck = uniqueDomains.filter(d => !this.domainCache.has(d));

    this.mxCheckProgress.total = domainsToCheck.length;
    console.log(`[Engine] MX pre-check: ${uniqueDomains.length} unique domains, ${domainsToCheck.length} need checking (${this.domainCache.size} already cached)`);

    // 2. Batch check MX records (with progress callback)
    const mxResults = await batchCheckMx(domainsToCheck, 50, (checked, total, noMxCount) => {
      this.mxCheckProgress.checked = checked;
      this.mxCheckProgress.noMxFound = noMxCount;
    });

    // 3. Find no-MX domains and cache them
    const noMxDomains: string[] = [];
    for (const [domain, hasMx] of mxResults.entries()) {
      if (!hasMx) {
        noMxDomains.push(domain);
        this.domainCache.set(domain, 'no-mx');
        await db.domainCache.upsert({
          where: { domain },
          update: { status: 'no-mx' },
          create: { domain, status: 'no-mx' },
        });
      }
    }

    // Also include previously cached no-mx domains
    const cachedNoMx = uniqueDomains.filter(d => this.domainCache.get(d) === 'no-mx');
    const allNoMxDomains = [...new Set([...noMxDomains, ...cachedNoMx])];

    // 4. Mark all pending emails under no-MX domains across all 6 columns
    let emailsMarked = 0;
    for (let col = 0; col < 6; col++) {
      const statusCol = STATUS_COLUMNS[col];
      const msgCol = MESSAGE_COLUMNS[col];

      // Only update emails that are still "pending" — don't overwrite already-verified results
      for (const domain of allNoMxDomains) {
        const result = await db.contact.updateMany({
          where: {
            batchId,
            domain,
            [statusCol]: 'pending',
          } as any,
          data: {
            [statusCol]: 'no-mx',
            [msgCol]: 'No MX records (pre-check)',
          },
        });
        emailsMarked += result.count;
        this.mxCheckProgress.emailsMarked = emailsMarked;
      }
    }

    // 5. Update batch progress
    await this.updateBatchProgressForBatch(batchId);

    this.mxCheckProgress.done = true;
    this.mxCheckRunning = false;
    console.log(`[Engine] MX pre-check complete: ${noMxDomains.length} new no-MX domains, ${emailsMarked} emails marked`);
  }

  /**
   * Pre-check SMTP connectivity for all domains in a batch.
   * For each domain that HAS MX records, tries TCP connect to port 25 on the MX host.
   * If unreachable, marks the domain as "slow-mx" and skips all its emails.
   *
   * This saves massive time: without it, the verification engine wastes 5s per email
   * on domains with unreachable SMTP servers (8s API timeout × multiple emails × retries).
   * With this pre-check, those domains are identified in ~3s each (parallel) and skipped.
   *
   * Runs in the BACKGROUND — returns immediately. Use getSmtpCheckStatus() to poll.
   */
  async preCheckSmtp(batchId: string): Promise<{
    success: boolean;
    message: string;
    totalDomains: number;
  }> {
    if (this.smtpCheckRunning) {
      return {
        success: false,
        message: 'SMTP pre-check is already running. Wait for it to finish.',
        totalDomains: 0,
      };
    }
    if (this.running) {
      return {
        success: false,
        message: 'Cannot pre-check SMTP while verification is running. Stop verification first.',
        totalDomains: 0,
      };
    }

    const batch = await db.batch.findUnique({ where: { id: batchId } });
    if (!batch) {
      return { success: false, message: 'Batch not found.', totalDomains: 0 };
    }

    this.smtpCheckRunning = true;
    this.smtpCheckProgress = { checked: 0, total: 0, unreachableFound: 0, emailsMarked: 0, done: false, error: '' };

    this.runSmtpPreCheckInBackground(batchId).catch(err => {
      console.error('[Engine] SMTP pre-check background error:', err);
      this.smtpCheckProgress.error = err.message || 'Unknown error';
      this.smtpCheckProgress.done = true;
      this.smtpCheckRunning = false;
    });

    return {
      success: true,
      message: 'SMTP pre-check started in background. Use the status endpoint to monitor progress.',
      totalDomains: 0,
    };
  }

  getSmtpCheckStatus() {
    return {
      running: this.smtpCheckRunning,
      ...this.smtpCheckProgress,
    };
  }

  private async runSmtpPreCheckInBackground(batchId: string) {
    console.log('[Engine] SMTP pre-check starting in background for batch:', batchId);

    await this.loadDomainCache();

    // 1. Get all unique domains from the batch that aren't already cached (no-mx, slow-mx, etc.)
    const contacts = await db.contact.findMany({
      where: { batchId },
      select: { domain: true },
    });

    const uniqueDomains = [...new Set(contacts.map(c => c.domain.toLowerCase()))];
    // Only check domains NOT already in cache (no-mx, slow-mx are already handled)
    const domainsToCheck = uniqueDomains.filter(d => !this.domainCache.has(d));

    this.smtpCheckProgress.total = domainsToCheck.length;
    console.log(`[Engine] SMTP pre-check: ${uniqueDomains.length} unique domains, ${domainsToCheck.length} need SMTP connectivity check (${this.domainCache.size} already cached)`);

    // 2. Batch check SMTP connectivity (TCP port 25 to MX hosts)
    const smtpResults = await batchCheckSmtp(domainsToCheck, 100, 3000, (checked, total, unreachableCount) => {
      this.smtpCheckProgress.checked = checked;
      this.smtpCheckProgress.unreachableFound = unreachableCount;
    });

    // 3. Find unreachable domains and mark them as slow-mx
    const slowDomains: string[] = [];
    for (const [domain, reachable] of smtpResults.entries()) {
      if (!reachable) {
        slowDomains.push(domain);
        this.domainCache.set(domain, 'slow-mx');
        await db.domainCache.upsert({
          where: { domain },
          update: { status: 'slow-mx' },
          create: { domain, status: 'slow-mx' },
        });
      }
    }

    console.log(`[Engine] SMTP pre-check: ${slowDomains.length} domains have unreachable SMTP servers, marking emails as skipped-slow-mx`);

    // 4. Bulk-mark all pending emails under slow-SMTP domains across all 6 columns
    let emailsMarked = 0;
    for (let col = 0; col < 6; col++) {
      const statusCol = STATUS_COLUMNS[col];
      const msgCol = MESSAGE_COLUMNS[col];

      for (const domain of slowDomains) {
        const result = await db.contact.updateMany({
          where: {
            batchId,
            domain,
            [statusCol]: 'pending',
          } as any,
          data: {
            [statusCol]: 'skipped-slow-mx',
            [msgCol]: 'SMTP server unreachable (pre-check)',
          },
        });
        emailsMarked += result.count;
        this.smtpCheckProgress.emailsMarked = emailsMarked;
      }
    }

    // 5. Update batch progress
    await this.updateBatchProgressForBatch(batchId);

    this.smtpCheckProgress.done = true;
    this.smtpCheckRunning = false;
    console.log(`[Engine] SMTP pre-check complete: ${slowDomains.length} slow-SMTP domains, ${emailsMarked} emails marked as skipped-slow-mx`);
  }

  async stop(): Promise<{ success: boolean; message: string }> {
    this.running = false;

    for (const [, keyState] of this.keyStates.entries()) {
      if (keyState.workerTimers) {
        for (const t of keyState.workerTimers) {
          if (t) clearTimeout(t);
        }
      }
      keyState.workerTimers = [];
    }

    // Reset any "verifying" statuses back to "pending"
    for (let col = 0; col < 6; col++) {
      const statusCol = STATUS_COLUMNS[col];
      await db.contact.updateMany({
        where: { [statusCol]: 'verifying' } as any,
        data: { [statusCol]: 'pending' },
      }).catch(() => {});
    }

    await db.verificationState.upsert({
      where: { id: 'main' },
      update: { isRunning: false, currentColumn: this.currentColumn, lastHeartbeat: new Date() },
      create: { id: 'main', isRunning: false, currentColumn: this.currentColumn, lastHeartbeat: new Date() },
    });

    if (this.currentBatchId) {
      await db.batch.update({ where: { id: this.currentBatchId }, data: { status: 'paused', currentColumn: this.currentColumn } });
    }

    await this.flushKeyUsage();
    return { success: true, message: 'Verification stopped.' };
  }

  getStatus() {
    const now = Date.now();
    // Check if any key is in backoff
    let anyKeyInBackoff = false;
    let maxBackoffRemaining = 0;
    for (const [, ks] of this.keyStates.entries()) {
      if (ks.backoffUntil > now) {
        anyKeyInBackoff = true;
        const remaining = Math.ceil((ks.backoffUntil - now) / 1000);
        if (remaining > maxBackoffRemaining) maxBackoffRemaining = remaining;
      }
    }
    return {
      isRunning: this.running,
      currentBatchId: this.currentBatchId,
      currentColumn: this.currentColumn,
      stats: { ...this.stats },
      activeKeys: this.keyStates.size,
      rateLimited: anyKeyInBackoff,
      rateLimitBackoffSeconds: maxBackoffRemaining,
      consecutive429s: this.globalConsecutive429s,
    };
  }

  private startAllKeyLoops() {
    const totalWorkers = this.keyStates.size * VerificationEngine.WORKERS_PER_KEY;
    console.log(`[Engine] Starting ${this.keyStates.size} keys × ${VerificationEngine.WORKERS_PER_KEY} workers = ${totalWorkers} parallel workers`);
    for (const [keyStr, keyState] of this.keyStates.entries()) {
      if (!keyState.active) continue;
      keyState.workerTimers = [];
      keyState.workerBusy = [];
      for (let w = 0; w < VerificationEngine.WORKERS_PER_KEY; w++) {
        keyState.workerTimers[w] = null;
        keyState.workerBusy[w] = false;
        // Stagger worker start to spread out initial API calls
        const staggerMs = (w * keyState.speedMs) / VerificationEngine.WORKERS_PER_KEY + Math.random() * 100;
        this.scheduleNext(keyStr, w, staggerMs);
      }
    }
  }

  /**
   * Schedule the next processNextForKey call for a specific worker.
   * Centralizes timer management so all paths use the same mechanism.
   */
  private scheduleNext(keyStr: string, workerIndex: number, delayMs: number) {
    const keyState = this.keyStates.get(keyStr);
    if (!keyState) return;
    if (keyState.workerTimers[workerIndex]) {
      clearTimeout(keyState.workerTimers[workerIndex]!);
    }
    keyState.workerTimers[workerIndex] = setTimeout(() => {
      this.processNextForKey(keyStr, workerIndex);
    }, delayMs);
  }

  /**
   * Core processing loop for each API key worker.
   * Uses atomic "verifying" status to claim emails — prevents duplicate processing.
   * Each key runs WORKERS_PER_KEY concurrent workers for parallel API calls.
   */
  private async processNextForKey(keyStr: string, workerIndex: number = 0) {
    if (!this.running || !this.currentBatchId) return;

    const keyState = this.keyStates.get(keyStr);
    if (!keyState || !keyState.active) return;

    // Per-worker busy flag — prevents a worker from running twice in parallel
    // (shouldn't happen with proper scheduling, but defensive)
    if (keyState.workerBusy[workerIndex]) return;
    keyState.workerBusy[workerIndex] = true;

    try {
      // Check daily limit
      const today = new Date().toISOString().split('T')[0];
      if (keyState.lastResetDate !== today) {
        keyState.usedToday = 0;
        keyState.lastResetDate = today;
      }
      if (keyState.usedToday >= keyState.dailyLimit) {
        if (workerIndex === 0) console.log(`[Engine] Key ${keyState.label || keyStr.substring(0, 8) + '...'} daily limit reached`);
        keyState.workerBusy[workerIndex] = false;
        this.scheduleNext(keyStr, workerIndex, 5 * 60 * 1000);
        return;
      }

      // PER-KEY 429 BACKOFF CHECK — if this key got a 429 recently, its workers wait.
      // Other keys continue processing independently.
      const now = Date.now();
      if (keyState.backoffUntil > now) {
        const waitMs = keyState.backoffUntil - now;
        keyState.workerBusy[workerIndex] = false;
        this.scheduleNext(keyStr, workerIndex, waitMs + 100);
        return;
      }

      // NOTE: Per-key rate limit (speedMs wait) is NOT enforced here because
      // keyState.lastUsed is shared across all workers, which would cause workers
      // to block each other. Instead, each worker waits keyState.speedMs AFTER its
      // API call completes (in the scheduleNext at the end of this function).
      // This gives true parallelism: N workers × 1/API_latency calls per second.
      // The 429 backoff handles API rate limiting globally.

      // ATOMIC CLAIM: Find a pending email and mark it as "verifying" in one operation
      // This prevents multiple keys from grabbing the same email.
      //
      // COOLDOWN-AWARE SELECTION: We fetch a batch of candidates (up to 100) and
      // pick the first one whose retry cooldown has expired. This prevents the
      // engine from looping forever on emails that always timeout — instead of
      // re-picking the same email immediately after a transient failure, we
      // skip it for RETRY_COOLDOWN_MS and try other emails in the queue.
      const statusCol = STATUS_COLUMNS[this.currentColumn - 1];
      const emailCol = EMAIL_COLUMNS[this.currentColumn - 1];
      const msgCol = MESSAGE_COLUMNS[this.currentColumn - 1];

      const candidates = await db.contact.findMany({
        where: { batchId: this.currentBatchId, [statusCol]: 'pending' } as any,
        orderBy: { id: 'asc' },
        take: 100,
      });

      if (candidates.length === 0) {
        // No more pending emails in this column, move to next
        this.currentColumn++;
        if (this.currentColumn > 6) {
          await this.completeVerification();
          return;
        }
        await db.verificationState.update({ where: { id: 'main' }, data: { currentColumn: this.currentColumn } });
        await db.batch.update({ where: { id: this.currentBatchId! }, data: { currentColumn: this.currentColumn } });
        keyState.workerBusy[workerIndex] = false;
        this.scheduleNext(keyStr, workerIndex, 0);
        return;
      }

      // Pick first candidate whose cooldown has expired (or who has never been retried)
      const nowMs = Date.now();
      let contact: typeof candidates[0] | null = null;
      for (const c of candidates) {
        const e = (c as any)[emailCol] as string | null;
        if (!e) { contact = c; break; } // no email — handle below
        const after = this.retryAfter.get(e) || 0;
        if (after <= nowMs) { contact = c; break; }
      }

      if (!contact) {
        // All candidates are in cooldown — wait 2s and try again.
        keyState.workerBusy[workerIndex] = false;
        this.scheduleNext(keyStr, workerIndex, 2000);
        return;
      }

      const email = (contact as any)[emailCol] as string | null;

      if (!email) {
        await db.contact.update({
          where: { id: contact.id },
          data: { [statusCol]: 'skipped', [msgCol]: 'No email generated' },
        });
        this.stats.skippedThisRun++;
        await this.updateBatchProgress();
        keyState.workerBusy[workerIndex] = false;
        this.scheduleNext(keyStr, workerIndex, 0);
        return;
      }

      // ATOMIC CLAIM: Mark as "verifying" so no other key picks this up
      const claimResult = await db.contact.updateMany({
        where: { id: contact.id, [statusCol]: 'pending' } as any,
        data: { [statusCol]: 'verifying' },
      });

      if (claimResult.count === 0) {
        // Another key already claimed this email — skip and try next
        keyState.workerBusy[workerIndex] = false;
        this.scheduleNext(keyStr, workerIndex, 0);
        return;
      }

      // Check domain cache for catch-all / no-mx / slow-mx
      const domain = email.split('@')[1]?.toLowerCase();
      if (domain && this.domainCache.has(domain)) {
        const cacheStatus = this.domainCache.get(domain)!;
        await db.contact.update({
          where: { id: contact.id },
          data: { [statusCol]: `skipped-${cacheStatus}`, [msgCol]: `Domain is ${cacheStatus}` },
        });
        this.stats.skippedThisRun++;
        await this.updateBatchProgress();
        keyState.workerBusy[workerIndex] = false;
        // Continue immediately — no API call was made
        this.scheduleNext(keyStr, workerIndex, 0);
        return;
      }

      // Make API call
      try {
        const result = await this.verifyEmail(email, keyState.key);

        let status = result.code;
        let message = result.message;

        if (message === 'Catch-All') {
          status = 'catch-all';
          if (domain) {
            this.domainCache.set(domain, 'catch-all');
            await db.domainCache.upsert({ where: { domain }, update: { status: 'catch-all' }, create: { domain, status: 'catch-all' } });
          }
        } else if (message === 'No Mx') {
          status = 'no-mx';
          if (domain) {
            this.domainCache.set(domain, 'no-mx');
            await db.domainCache.upsert({ where: { domain }, update: { status: 'no-mx' }, create: { domain, status: 'no-mx' } });
          }
        } else if (result.code === 'ok') {
          status = 'valid';
        } else if (result.code === 'ko') {
          status = 'invalid';
        } else if (result.code === 'mb') {
          status = 'unverifiable';
        }

        await db.contact.update({
          where: { id: contact.id },
          data: { [statusCol]: status, [msgCol]: message },
        });

        // Success — clear retry tracking for this email
        this.retryCount.delete(email);
        this.retryAfter.delete(email);

        this.stats.verifiedThisRun++;
        keyState.lastUsed = Date.now();
        keyState.usedToday++;
        keyState.consecutive429s = 0;
        keyState.backoffUntil = 0; // Reset per-key backoff on success
        // Reset global counter on success
        if (this.globalConsecutive429s > 0) {
          this.globalConsecutive429s = 0;
        }
      } catch (err: any) {
        const errMsg = err.message || 'Unknown error';

        // ========== 429 RATE LIMIT HANDLING (PER-KEY BACKOFF) ==========
        if (errMsg.includes('429')) {
          // Increment per-key consecutive 429 counter
          keyState.consecutive429s++;
          this.globalConsecutive429s++;

          // PER-KEY 429 backoff: 3s, 5s, 5s, 5s... (cap at 5s).
          // Only this key's workers pause — other keys continue processing.
          // Capped low to prevent keys from getting stuck in escalating backoff loops.
          const backoffMs = keyState.consecutive429s <= 1 ? 3000 : 5000;
          keyState.backoffUntil = Date.now() + backoffMs;

          console.log(`[Engine] 429 rate limit on key ${keyState.label || keyStr.substring(0, 8) + '...'} (x${keyState.consecutive429s}) — this key backing off ${backoffMs / 1000}s. Email put back to pending.`);

          // Put the email BACK to "pending" so it's retried automatically.
          // 429 doesn't count against the per-email retry counter (it's not the email's fault).
          await db.contact.update({
            where: { id: contact.id },
            data: { [statusCol]: 'pending', [msgCol]: `Retrying after rate limit (backoff ${backoffMs / 1000}s)` },
          });

          keyState.workerBusy[workerIndex] = false;
          this.scheduleNext(keyStr, workerIndex, backoffMs + 200);
          await this.updateHeartbeat();
          await this.updateBatchProgress();
          return;
        }

        // ========== TIMEOUT / NETWORK ERROR — RETRY WITH COUNTER ==========
        if (errMsg.includes('timeout') || errMsg.includes('aborted') || errMsg.includes('fetch failed') || errMsg.includes('ECONNRESET') || errMsg.includes('ETIMEDOUT')) {
          const currentRetry = (this.retryCount.get(email) || 0) + 1;
          this.retryCount.set(email, currentRetry);

          // Track per-domain timeout count. After DOMAIN_TIMEOUT_THRESHOLD timeouts
          // on the same domain, mark it as "slow-mx" so all remaining emails for
          // that domain are skipped automatically (no API calls wasted).
          // We also bulk-update all pending emails for this domain in the batch
          // to "skipped-slow-mx" immediately — saves picking them up one by one.
          const domainOfEmail = email.split('@')[1]?.toLowerCase();
          if (domainOfEmail) {
            const domainFails = (this.domainTimeoutCount.get(domainOfEmail) || 0) + 1;
            this.domainTimeoutCount.set(domainOfEmail, domainFails);
            if (domainFails >= VerificationEngine.DOMAIN_TIMEOUT_THRESHOLD && !this.domainCache.has(domainOfEmail)) {
              console.warn(`[Engine] Domain ${domainOfEmail} failed ${domainFails}x — marking as slow-mx, bulk-skipping all pending emails for this domain`);
              this.domainCache.set(domainOfEmail, 'slow-mx');
              await db.domainCache.upsert({
                where: { domain: domainOfEmail },
                update: { status: 'slow-mx' },
                create: { domain: domainOfEmail, status: 'slow-mx' },
              }).catch(() => {});

              // BULK SKIP: mark all other pending emails for this domain across all 6 columns
              // This avoids picking them up one by one (which wastes a DB query + update each).
              let bulkSkipped = 0;
              for (let col = 0; col < 6; col++) {
                const sCol = STATUS_COLUMNS[col];
                const mCol = MESSAGE_COLUMNS[col];
                const r = await db.contact.updateMany({
                  where: {
                    batchId: this.currentBatchId!,
                    domain: domainOfEmail,
                    [sCol]: 'pending',
                  } as any,
                  data: {
                    [sCol]: 'skipped-slow-mx',
                    [mCol]: 'Domain marked slow-mx (mail server unreachable)',
                  },
                });
                bulkSkipped += r.count;
              }
              if (bulkSkipped > 0) {
                console.log(`[Engine] Bulk-skipped ${bulkSkipped} pending emails for slow domain ${domainOfEmail}`);
                this.stats.skippedThisRun += bulkSkipped;
              }

              // The current email is also part of this domain — mark it as skipped-slow-mx
              // (instead of putting it back to pending for retry)
              await db.contact.update({
                where: { id: contact.id },
                data: {
                  [statusCol]: 'skipped-slow-mx',
                  [msgCol]: `Domain marked slow-mx after ${domainFails}x timeout`,
                },
              });
              this.stats.skippedThisRun++;
              this.retryCount.delete(email);
              this.retryAfter.delete(email);

              // Continue to next email — no point retrying this one
              keyState.lastUsed = Date.now();
              keyState.workerBusy[workerIndex] = false;
              this.scheduleNext(keyStr, workerIndex, 1000);
              await this.updateHeartbeat();
              await this.updateBatchProgress();
              return;
            }
          }

          // After MAX retries, give up on this email — mark as unverifiable
          // so the engine can move on. Otherwise we loop forever on bad domains.
          if (currentRetry > VerificationEngine.MAX_TRANSIENT_RETRIES) {
            console.warn(`[Engine] Max retries (${currentRetry - 1}) exceeded for ${email} — marking as unverifiable`);
            await db.contact.update({
              where: { id: contact.id },
              data: {
                [statusCol]: 'unverifiable',
                [msgCol]: `Max retries exceeded (${currentRetry - 1}x transient error): ${errMsg.substring(0, 100)}`,
              },
            });
            this.retryCount.delete(email);
            this.retryAfter.delete(email);
            this.stats.verifiedThisRun++; // count as "processed" (not error)
          } else {
            console.warn(`[Engine] Transient error for ${email} (retry ${currentRetry}/${VerificationEngine.MAX_TRANSIENT_RETRIES}): ${errMsg.substring(0, 80)}`);
            // Put back to pending + set cooldown so the queue picker skips it
            // for RETRY_COOLDOWN_MS. Other emails can proceed meanwhile.
            this.retryAfter.set(email, Date.now() + VerificationEngine.RETRY_COOLDOWN_MS);
            await db.contact.update({
              where: { id: contact.id },
              data: {
                [statusCol]: 'pending',
                [msgCol]: `Retry ${currentRetry}/${VerificationEngine.MAX_TRANSIENT_RETRIES} after transient: ${errMsg.substring(0, 120)}`,
              },
            });
          }

          // Short backoff for this key only (not global) — 2 seconds
          keyState.lastUsed = Date.now();
          keyState.workerBusy[workerIndex] = false;
          this.scheduleNext(keyStr, workerIndex, 2000);
          await this.updateHeartbeat();
          await this.updateBatchProgress();
          return;
        }

        // ========== OTHER ERRORS — MARK AS ERROR (real failures) ==========
        console.error('[Engine] Verification error:', errMsg);
        await db.contact.update({
          where: { id: contact.id },
          data: { [statusCol]: 'error', [msgCol]: errMsg.substring(0, 200) },
        });
        this.stats.errorsThisRun++;
        keyState.lastUsed = Date.now();
      }

      await this.updateHeartbeat();
      await this.updateBatchProgress();

      // Schedule next for this worker after its speed delay
      keyState.lastUsed = Date.now();
      keyState.workerBusy[workerIndex] = false;
      this.scheduleNext(keyStr, workerIndex, keyState.speedMs);
    } catch (err) {
      console.error('[Engine] Process error for key:', keyStr, err);
      keyState.workerBusy[workerIndex] = false;
      this.scheduleNext(keyStr, workerIndex, 5000);
    }
  }

  private async completeVerification() {
    this.running = false;

    for (const [, keyState] of this.keyStates.entries()) {
      if (keyState.workerTimers) {
        for (const t of keyState.workerTimers) {
          if (t) clearTimeout(t);
        }
      }
      keyState.workerTimers = [];
    }

    if (this.currentBatchId) {
      await db.batch.update({ where: { id: this.currentBatchId }, data: { status: 'completed' } });
    }
    await db.verificationState.update({ where: { id: 'main' }, data: { isRunning: false } });
    await this.flushKeyUsage();
    console.log('[Engine] Verification complete for batch:', this.currentBatchId);
  }

  private async loadDomainCache() {
    const caches = await db.domainCache.findMany();
    this.domainCache.clear();
    for (const c of caches) {
      if (c.status === 'catch-all' || c.status === 'no-mx' || c.status === 'slow-mx') {
        this.domainCache.set(c.domain, c.status as any);
      }
    }
    console.log(`[Engine] Loaded ${this.domainCache.size} domain cache entries`);
  }

  private async loadKeyStates() {
    const keys = await db.apiKey.findMany({ where: { active: true } });
    this.keyStates.clear();
    const today = new Date().toISOString().split('T')[0];
    for (const k of keys) {
      const lastResetDate = k.lastResetDate || today;
      const usedToday = lastResetDate === today ? k.usedToday : 0;
      this.keyStates.set(k.key, {
        id: k.id,
        key: k.key,
        label: k.label,
        lastUsed: 0,
        usedToday,
        lastResetDate: today,
        speedMs: k.speedMs,
        dailyLimit: k.dailyLimit,
        active: true,
        workerTimers: [],
        workerBusy: [],
        consecutive429s: 0,
        backoffUntil: 0,
      });
      if (lastResetDate !== today) {
        await db.apiKey.update({ where: { id: k.id }, data: { usedToday: 0, lastResetDate: today } });
      }
    }
    console.log(`[Engine] Loaded ${this.keyStates.size} API keys (${this.keyStates.size * VerificationEngine.WORKERS_PER_KEY} workers total)`);
  }

  private async flushKeyUsage() {
    for (const [key, state] of this.keyStates.entries()) {
      await db.apiKey.updateMany({
        where: { key },
        data: { usedToday: state.usedToday, lastResetDate: state.lastResetDate },
      });
    }
  }

  private async verifyEmail(email: string, apiKey: string): Promise<VerificationResult> {
    const url = `https://happy.mailtester.ninja/ninja?email=${encodeURIComponent(email)}&key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) {
      throw new Error(`API returned ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    return data as VerificationResult;
  }

  private async updateHeartbeat() {
    try {
      await db.verificationState.update({ where: { id: 'main' }, data: { lastHeartbeat: new Date() } });
    } catch {}
  }

  private async updateBatchProgress() {
    if (!this.currentBatchId) return;
    try {
      await this.updateBatchProgressForBatch(this.currentBatchId, this.currentColumn);
    } catch (err) {
      console.error('[Engine] Progress update error:', err);
    }
  }

  /**
   * Update batch progress for any batch ID (used by preCheckMx and normal verification).
   */
  private async updateBatchProgressForBatch(batchId: string, currentColumn?: number) {
    try {
      let verifiedCount = 0;
      let skippedCount = 0;
      for (let col = 0; col < 6; col++) {
        const statusCol = STATUS_COLUMNS[col];
        const v = await db.contact.count({
          where: {
            batchId,
            OR: [
              { [statusCol]: 'valid' }, { [statusCol]: 'invalid' },
              { [statusCol]: 'unverifiable' }, { [statusCol]: 'catch-all' },
              { [statusCol]: 'no-mx' }, { [statusCol]: 'error' },
            ],
          } as any,
        });
        verifiedCount += v;
        const s = await db.contact.count({
          where: { batchId, [statusCol]: { startsWith: 'skipped' } } as any,
        });
        skippedCount += s;
      }
      const data: any = { verifiedEmails: verifiedCount, skippedEmails: skippedCount };
      if (currentColumn !== undefined) {
        data.currentColumn = currentColumn;
      }
      await db.batch.update({ where: { id: batchId }, data });
    } catch (err) {
      console.error('[Engine] Batch progress update error:', err);
    }
  }
}

let engineInstance: VerificationEngine | null = null;

export function getVerificationEngine(): VerificationEngine {
  if (!engineInstance) {
    engineInstance = new VerificationEngine();
  }
  return engineInstance;
}
