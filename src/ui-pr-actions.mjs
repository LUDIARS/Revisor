export function actionRequestOptions(action, promptForReason) {
    if (action !== 'close') return { method: 'POST' };
    const entered = promptForReason('取り下げ理由を入力してください。');
    if (entered === null) return null;
    const reason = entered.trim();
    if (!reason) throw new Error('取り下げ理由を入力してください。');
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    };
  }

export const PR_ACTION_SOURCE = [actionRequestOptions.toString()].join("\n");
