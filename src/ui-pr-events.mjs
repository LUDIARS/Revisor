// Browser-side WebSocket controller. Events carry identifiers and status only;
// the board always refetches the authoritative projection before rendering.
export const PR_EVENTS_SOURCE = `
  const prEventStatus = document.querySelector('#pr-event-status');
  const prEventEntries = document.querySelector('#pr-event-entries');
  const prEvents = [];
  let prEventSocket = null;
  let prEventReconnectDelay = 1000;
  let leavingPrPage = false;

  function renderPrEventLog() {
    const visible = prEvents.filter((entry) =>
      !entry.pullRequestId || !selectedPrId || entry.pullRequestId === selectedPrId);
    prEventEntries.replaceChildren(...visible.slice(-50).map((entry) => {
      const item = element('li', entry.tone || 'idle');
      item.append(
        element('time', null, entry.time),
        element('span', null, entry.message),
      );
      return item;
    }));
    prEventEntries.scrollTo?.({ top: prEventEntries.scrollHeight, behavior: 'smooth' });
  }

  function recordPrEvent(message, pullRequestId = null, tone = 'idle') {
    prEvents.push({
      message,
      pullRequestId,
      tone,
      time: new Date().toLocaleTimeString('ja-JP', { hour12: false }),
    });
    if (prEvents.length > 50) prEvents.shift();
    renderPrEventLog();
  }

  function connectPrEvents() {
    if (leavingPrPage) return;
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = scheme + '//' + location.host + '/v1/pr-events';
    prEventStatus.textContent = '接続中…';
    prEventSocket = new WebSocket(url, 'revisor-session.' + sessionToken);
    prEventSocket.addEventListener('open', () => {
      prEventReconnectDelay = 1000;
      prEventStatus.textContent = 'リアルタイム接続済み';
      recordPrEvent('WebSocket に接続しました。', null, 'ok');
    });
    prEventSocket.addEventListener('message', async (message) => {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      if (!event) return;
      if (event.type === 'review_work.updated') {
        recordPrEvent('レビュー worker queue が更新されました。', null, 'idle');
        await refresh();
        return;
      }
      if (!String(event.type).startsWith('pull_request.')) return;
      const label = event.repository + ' #' + event.number + ' — '
        + event.status + ' / ' + event.checkStatus;
      recordPrEvent(label, event.pullRequestId,
        event.checkStatus === 'test_ok' ? 'ok' : 'warn');
      await refresh();
    });
    prEventSocket.addEventListener('close', () => {
      if (leavingPrPage) return;
      prEventStatus.textContent = '再接続待ち';
      recordPrEvent('接続が切れました。再接続します。', null, 'warn');
      const delay = prEventReconnectDelay;
      prEventReconnectDelay = Math.min(prEventReconnectDelay * 2, 30_000);
      setTimeout(connectPrEvents, delay);
    });
  }

  addEventListener('beforeunload', () => {
    leavingPrPage = true;
    prEventSocket?.close();
  });
`;
