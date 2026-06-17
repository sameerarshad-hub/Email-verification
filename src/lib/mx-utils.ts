import { Resolver } from 'node:dns';
import { promisify } from 'node:util';
import * as net from 'net';

/**
 * Custom DNS resolver using Google's public DNS (8.8.8.8 / 8.8.4.4) and Cloudflare (1.1.1.1).
 * These are more reliable than the system default resolver, which often returns ESERVFAIL
 * for unfamiliar domains.
 */
const resolver = new Resolver();
resolver.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

const resolveMxAsync = promisify(resolver.resolveMx.bind(resolver));

/**
 * Check if a domain has valid MX records.
 * Returns true if MX records exist, false if no MX or domain doesn't exist.
 * 
 * This uses Node.js built-in DNS resolution — no API credits needed!
 */
export async function hasMxRecords(domain: string): Promise<boolean> {
  try {
    // Race the DNS lookup against a 5-second timeout
    const result = await Promise.race([
      resolveMxAsync(domain),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('ETIMEOUT')), 5000)
      ),
    ]);
    return result && result.length > 0;
  } catch (err: any) {
    // ENOTFOUND or ENODATA means no MX records — this is a definitive "no MX" answer
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
      return false;
    }
    // For transient errors (ESERVFAIL, ETIMEOUT, ECONNREFUSED), treat as "has MX"
    // to be safe — we don't want to skip a valid domain just because of a DNS hiccup.
    // The verification API will catch it later if it really has no MX.
    if (err.code !== 'ESERVFAIL' && err.code !== 'ETIMEOUT' && err.code !== 'ECONNREFUSED' && err.message !== 'ETIMEOUT') {
      console.warn(`[MX] DNS lookup error for ${domain}: ${err.code || err.message}`);
    }
    return true;
  }
}

/**
 * Batch check MX records for a list of unique domains.
 * Returns a Map of domain → hasMx (boolean).
 * 
 * Processes in parallel with concurrency control to avoid
 * overwhelming the DNS resolver.
 * 
 * @param domains Array of domains to check
 * @param concurrency Number of parallel DNS queries (default 50)
 * @param onProgress Optional callback for progress updates
 */
export async function batchCheckMx(
  domains: string[],
  concurrency: number = 50,
  onProgress?: (checked: number, total: number, noMxCount: number) => void
): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  let checked = 0;
  let noMxCount = 0;
  
  // Process in chunks for controlled concurrency
  for (let i = 0; i < domains.length; i += concurrency) {
    const chunk = domains.slice(i, i + concurrency);
    const checks = chunk.map(async (domain) => {
      const hasMx = await hasMxRecords(domain);
      return { domain, hasMx };
    });
    
    const chunkResults = await Promise.all(checks);
    for (const { domain, hasMx } of chunkResults) {
      results.set(domain, hasMx);
      checked++;
      if (!hasMx) noMxCount++;
    }
    
    // Report progress
    if (onProgress) {
      onProgress(checked, domains.length, noMxCount);
    }
  }
  
  return results;
}

/**
 * Try a TCP connection to host:port within timeoutMs.
 * Returns true if connection succeeds, false otherwise.
 */
function tcpConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    let done = false;
    const finish = (result: boolean) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(result);
    };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

/**
 * Resolve MX records for a domain with timeout.
 * Returns sorted array of { priority, exchange }.
 */
async function resolveMxWithTimeout(domain: string, timeoutMs: number): Promise<{ priority: number; exchange: string }[]> {
  try {
    const result = await Promise.race([
      resolveMxAsync(domain),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('ETIMEOUT')), timeoutMs)
      ),
    ]);
    return (result || []).sort((a: any, b: any) => a.priority - b.priority);
  } catch {
    return [];
  }
}

/**
 * Check if a domain's SMTP server is reachable on port 25.
 * Resolves MX records, then tries TCP connect to each MX host (up to 2).
 * Returns true if at least one MX host accepts TCP connections on port 25.
 *
 * This is used as a PRE-CHECK to identify domains where the MailTester API
 * would timeout (8-15s wasted per email). If we know SMTP is unreachable,
 * we skip the domain entirely — saving massive amounts of time.
 */
export async function checkSmtpConnectivity(domain: string, timeoutMs: number = 3000): Promise<boolean> {
  try {
    const mxRecords = await resolveMxWithTimeout(domain, 3000);
    if (mxRecords.length === 0) return false;

    // Try up to 2 MX hosts (by priority)
    for (let i = 0; i < Math.min(2, mxRecords.length); i++) {
      const host = mxRecords[i].exchange;
      if (await tcpConnect(host, 25, timeoutMs)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Batch check SMTP connectivity for a list of domains.
 * Returns a Map of domain → isSmtpReachable (boolean).
 *
 * @param domains Array of domains to check
 * @param concurrency Number of parallel checks (default 100)
 * @param timeoutMs Per-connection timeout (default 3000)
 * @param onProgress Optional callback for progress updates
 */
export async function batchCheckSmtp(
  domains: string[],
  concurrency: number = 100,
  timeoutMs: number = 3000,
  onProgress?: (checked: number, total: number, unreachableCount: number) => void
): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  let checked = 0;
  let unreachableCount = 0;

  for (let i = 0; i < domains.length; i += concurrency) {
    const chunk = domains.slice(i, i + concurrency);
    const checks = chunk.map(async (domain) => {
      const reachable = await checkSmtpConnectivity(domain, timeoutMs);
      return { domain, reachable };
    });

    const chunkResults = await Promise.all(checks);
    for (const { domain, reachable } of chunkResults) {
      results.set(domain, reachable);
      checked++;
      if (!reachable) unreachableCount++;
    }

    if (onProgress) {
      onProgress(checked, domains.length, unreachableCount);
    }
  }

  return results;
}
