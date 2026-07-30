const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES_IN_WINDOW = 5;

function recordChildFailure(meta, now = Date.now()) {
  meta.failureTimestamps.push(now);
  meta.failureTimestamps = meta.failureTimestamps.filter(ts => now - ts <= FAILURE_WINDOW_MS);

  if (meta.failureTimestamps.length < MAX_FAILURES_IN_WINDOW) return false;

  meta.circuitOpen = true;
  meta.circuitReason = `${meta.failureTimestamps.length} awarii w ciagu ostatnich ${FAILURE_WINDOW_MS / 60000} minut`;
  return true;
}

module.exports = {
  FAILURE_WINDOW_MS,
  MAX_FAILURES_IN_WINDOW,
  recordChildFailure
};
