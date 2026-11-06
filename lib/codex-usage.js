const childProcess = require('child_process');

function unavailableUsage() {
  return { available: false, fetchedAt: new Date().toISOString(), windows: [] };
}

function normalizeCodexRateLimits(payload, timestamp = Date.now()) {
  const buckets = payload?.rateLimitsByLimitId;
  const snapshot = buckets?.codex || (buckets && Object.values(buckets)[0]) || payload?.rateLimits;
  if (!snapshot || typeof snapshot !== 'object') return unavailableUsage();
  const windows = [snapshot.primary, snapshot.secondary].filter(Boolean).map((window, index) => {
    const usedPercent = Math.min(100, Math.max(0, Number(window.usedPercent) || 0));
    const resetsAtSeconds = Number(window.resetsAt);
    return {
      type: index === 0 ? 'primary' : 'secondary',
      usedPercent,
      remainingPercent: 100 - usedPercent,
      windowDurationMins: Number.isFinite(Number(window.windowDurationMins)) ? Number(window.windowDurationMins) : null,
      resetsAt: Number.isFinite(resetsAtSeconds) && resetsAtSeconds > 0 ? new Date(resetsAtSeconds * 1000).toISOString() : null
    };
  });
  return {
    available: windows.length > 0,
    fetchedAt: new Date(timestamp).toISOString(),
    limitId: snapshot.limitId || null,
    limitName: snapshot.limitName || null,
    planType: snapshot.planType || null,
    rateLimitReachedType: snapshot.rateLimitReachedType || null,
    credits: snapshot.credits ? {
      hasCredits: Boolean(snapshot.credits.hasCredits),
      unlimited: Boolean(snapshot.credits.unlimited),
      balance: snapshot.credits.balance ?? null
    } : null,
    windows
  };
}

function queryCodexRateLimits(codex, { spawn = childProcess.spawn, timeoutMs = 6000 } = {}) {
  return new Promise(resolve => {
    let child;
    let buffer = '';
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      resolve(value);
    };
    const timer = setTimeout(() => finish(unavailableUsage()), timeoutMs);
    try {
      child = spawn(codex, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      finish(unavailableUsage());
      return;
    }
    child.once('error', () => finish(unavailableUsage()));
    child.once('exit', () => finish(unavailableUsage()));
    child.stdin.once('error', () => finish(unavailableUsage()));
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && message.result) {
          try {
            child.stdin.write(`${JSON.stringify({ id: 2, method: 'account/rateLimits/read', params: null })}\n`);
          } catch {
            finish(unavailableUsage());
          }
        } else if (message.id === 2) {
          finish(message.result ? normalizeCodexRateLimits(message.result) : unavailableUsage());
        }
      }
    });
    try {
      child.stdin.write(`${JSON.stringify({
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'daybreak', title: 'Daybreak Systemverwaltung', version: '1.0.0' },
          capabilities: { experimentalApi: true }
        }
      })}\n`);
    } catch {
      finish(unavailableUsage());
    }
  });
}

function createCodexUsageReader(codex, { ttlMs = 60000, query = queryCodexRateLimits } = {}) {
  let cached = null;
  let expiresAt = 0;
  let pending = null;
  return async () => {
    if (cached && Date.now() < expiresAt) return cached;
    if (pending) return pending;
    pending = Promise.resolve().then(() => query(codex)).catch(unavailableUsage).then(value => {
      cached = value?.windows ? value : unavailableUsage();
      expiresAt = Date.now() + ttlMs;
      pending = null;
      return cached;
    });
    return pending;
  };
}

module.exports = { createCodexUsageReader, normalizeCodexRateLimits, queryCodexRateLimits, unavailableUsage };
