/** Browser lifecycle only; refresh owns fetching/rendering and onError owns presentation. */
export function createVisibleRefreshLoop({
  refresh,
  isVisible,
  onError,
  schedule = setTimeout,
  cancel = clearTimeout,
  intervalMs = 3000,
}) {
  let timer = null;
  let running = null;
  let pending = false;
  let stopped = false;

  function clearTimer() {
    if (timer !== null) cancel(timer);
    timer = null;
  }

  function requestRefresh() {
    if (stopped) return Promise.resolve();
    clearTimer();
    pending = true;
    if (running) return running;
    if (!isVisible()) return Promise.resolve();
    // Assign running before invoking even a synchronously completing refresh.
    running = Promise.resolve().then(async () => {
      while (pending && !stopped && isVisible()) {
        pending = false;
        try {
          await refresh();
        } catch (error) {
          onError(error);
        }
      }
    }).finally(() => {
      running = null;
      if (!stopped && isVisible()) {
        timer = schedule(() => {
          timer = null;
          void requestRefresh();
        }, intervalMs);
      }
    });
    return running;
  }

  return {
    requestRefresh,
    visibilityChanged() {
      clearTimer();
      if (isVisible()) return requestRefresh();
      return running ?? Promise.resolve();
    },
    stop() {
      stopped = true;
      pending = false;
      clearTimer();
    },
  };
}
