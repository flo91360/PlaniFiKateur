// Purge quotidienne de l’historique et des exécutions terminées anciennes (voir docs/backups.md).
export function createRetention(
  store,
  { activityDays = 0, executionDays = 0, intervalMs = 24 * 3600000, onError = console.error, start = true } = {},
) {
  const run = () => {
    try {
      return store.purge({ activityDays, executionDays });
    } catch (error) {
      onError(`PlaniFiKateur : purge de l’historique impossible (${error.code || error.message}).`);
      return null;
    }
  };
  if (start) run();
  const timer = start && (activityDays > 0 || executionDays > 0) ? setInterval(run, intervalMs) : null;
  timer?.unref();
  return { run, close: () => clearInterval(timer) };
}
