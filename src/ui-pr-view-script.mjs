// Client-side rendering for the pull-request board. Loaded before the dashboard
// controller and shares its scope, so the DOM helpers live here with the views
// that use them. Everything is built with createElement and textContent: values
// come from local review output, and string HTML would make that a template
// injection surface for a PR title.
export const PR_VIEW_SOURCE = `
  function text(value) {
    return String(value ?? '');
  }

  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = text(content);
    return node;
  }

  function cell(value, className) {
    return element('td', className, value);
  }

  function definition(list, term, value) {
    list.append(element('dt', null, term), element('dd', null, value));
  }

  function block(title, node) {
    const fragment = document.createDocumentFragment();
    fragment.append(element('h3', null, title), node);
    return fragment;
  }

  function paragraph(message) {
    return element('p', 'empty', message);
  }

  function listOf(values, emptyMessage) {
    if (!values || values.length === 0) return paragraph(emptyMessage);
    const list = document.createElement('ul');
    for (const value of values) list.append(element('li', null, value));
    return list;
  }

  function badge(label, tone) {
    return element('span', 'badge ' + (tone || 'idle'), label);
  }

  function menuDecisionLabel(decision) {
    return decision.state === 'needs_human' ? 'レビュー項目があります' : decision.label;
  }

  function prCard(pr, selectedId, select) {
    const card = element('div', pr.id === selectedId ? 'card selected' : 'card');
    card.dataset.tone = pr.decision.tone;
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    const head = element('div', 'card-head');
    head.append(
      element('span', 'pr-number', '#' + pr.number),
      badge(menuDecisionLabel(pr.decision), pr.decision.tone),
    );
    card.append(head);
    card.append(element('div', 'card-repository', pr.repository));
    card.append(element('div', 'card-title', pr.title));
    const activate = () => select(pr.id);
    card.addEventListener('click', activate);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });
    return card;
  }

  function decisionOf(pr) {
    const wrapper = document.createElement('div');
    const list = element('dl', 'meta');
    definition(list, '判定', pr.decision.label);
    definition(list, 'マージリスク', pr.decision.riskScore === null
      ? '未算定'
      : pr.decision.riskScore + ' / 100 (' + text(pr.decision.riskBandLabel)
        + ') · 閾値 ' + pr.decision.riskThreshold);
    definition(list, 'オートマージ', pr.decision.autoMergeEnabled
      ? (pr.decision.autoMergeEligible ? '対象' : '対象外')
      : '無効');
    if (pr.autoMerge) {
      definition(list, '自動マージ結果',
        (pr.autoMerge.merged ? 'マージ済み' : '見送り') + ' — ' + pr.autoMerge.reason);
    }
    wrapper.append(list);
    wrapper.append(block('人間の判断が必要な理由', listOf(pr.decision.blockers, '判断待ちの理由はありません。')));
    wrapper.append(block('マージリスクの内訳', factorsOf(pr.mergeRisk)));
    wrapper.append(block('動作確認の必要性', runtimeOf(pr.runtimeVerification)));
    return wrapper;
  }

  function factorsOf(risk) {
    if (!risk || !Array.isArray(risk.factors) || risk.factors.length === 0) {
      return paragraph('加点要因はありません。');
    }
    const list = element('ul', 'factor-list');
    for (const factor of risk.factors) {
      const item = document.createElement('li');
      item.append(
        element('span', 'points', (factor.points > 0 ? '+' : '') + factor.points),
        element('span', null, factor.detail + ' [' + factor.code + ']'),
      );
      list.append(item);
    }
    return list;
  }

  function runtimeOf(runtime) {
    if (!runtime) return paragraph('動作確認の判定はまだありません。');
    const wrapper = document.createElement('div');
    const list = element('dl', 'meta');
    definition(list, '判定', runtime.required ? '人間による動作確認が必要' : '登録テストで足りる');
    definition(list, 'スコア', runtime.score + ' / 100');
    definition(list, '動作テストの通過', (runtime.evidence || []).join(', ') || '—');
    wrapper.append(list);
    wrapper.append(factorsOf(runtime));
    return wrapper;
  }

  function planOf(plan) {
    if (!plan) return paragraph('レビュー計画はまだありません。');
    const wrapper = document.createElement('div');
    const list = element('dl', 'meta');
    definition(list, '計画元', plan.source === 'advised' ? '管制プランナー (' + text(plan.advisor) + ')' : '決定的ルール');
    if (plan.advisorError) definition(list, '管制プランナー', plan.advisorError + ' — 決定的な計画を使用');
    definition(list, '変更種別', (plan.changeProfile.kinds || []).join(', ') || '—');
    definition(list, '変更規模', plan.changeProfile.changedFiles + ' ファイル / ' + plan.changeProfile.changedLines + ' 行');
    definition(list, '動作面', (plan.changeProfile.runtimeSurfaces || []).join(', ') || '—');
    if (plan.review) definition(list, 'レビュー方式', plan.review.label || plan.review.tier || '—');
    wrapper.append(list);
    const stages = element('ul', 'stage-list');
    for (const stage of plan.stages || []) {
      const item = document.createElement('li');
      item.append(
        element('span', 'stage-mark ' + (stage.run === false ? 'idle' : 'ok'), stage.run === false ? '—' : '○'),
        element('span', null, stage.id + ' : ' + stage.reason),
      );
      stages.append(item);
    }
    wrapper.append(block('ステージ', stages));
    wrapper.append(block(
      '省略した登録テスト',
      listOf((plan.testSelection.skipped || []).map((entry) => entry.name + ' — ' + entry.reason),
        '省略した登録テストはありません。'),
    ));
    return wrapper;
  }

  function overviewOf(pr) {
    const list = element('dl', 'meta');
    definition(list, 'PR', pr.repository + ' #' + pr.number);
    definition(list, 'title', pr.title);
    definition(list, '状態', (pr.draft ? 'draft / ' : '') + pr.status + ' / ' + pr.checkStatus);
    definition(list, 'author', pr.author);
    definition(list, 'branch', pr.headRef + ' → ' + pr.baseRef);
    definition(list, 'head SHA', pr.headSha);
    definition(list, 'reviewed head SHA', pr.reviewedHeadSha || '—');
    definition(list, 'base SHA', pr.baseSha);
    definition(list, 'labels', pr.labels.join(', ') || '—');
    definition(list, '更新', pr.updatedAt);
    if (pr.body) definition(list, 'body', pr.body);
    return list;
  }

  // Failed cases only, and only when the record carries output: a review stored
  // before Revisor kept test output has no 'output' key and must still render.
  function failedTestOutputs(pr) {
    const failed = pr.ci.filter((entry) =>
      entry.status === 'failed' && entry.output && entry.output.text);
    if (failed.length === 0) return null;
    const wrapper = element('div', 'test-outputs');
    for (const entry of failed) {
      const details = element('details', 'test-output');
      details.append(element(
        'summary',
        null,
        entry.name + (entry.output.truncated ? ' (末尾のみ)' : ''),
      ));
      const body = document.createElement('pre');
      body.textContent = text(entry.output.text);
      details.append(body);
      wrapper.append(details);
    }
    return wrapper;
  }

  function testsOf(pr) {
    if (!Array.isArray(pr.ci) || pr.ci.length === 0) {
      return paragraph('テスト結果はまだありません。');
    }
    const wrapper = document.createElement('div');
    const scroll = element('div', 'table-scroll');
    const table = document.createElement('table');
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['テストケース', '結果', 'exit code', '所要', '備考']) {
      headRow.append(element('th', null, label));
    }
    head.append(headRow);
    const body = document.createElement('tbody');
    for (const entry of pr.ci) {
      const tone = entry.status === 'passed' ? 'ok' : (entry.status === 'skipped' ? 'idle' : 'bad');
      const row = document.createElement('tr');
      row.append(
        cell(entry.name),
        cell(entry.status, tone),
        cell(entry.exitCode === null || entry.exitCode === undefined ? '—' : entry.exitCode),
        cell(entry.status === 'skipped' ? '—' : Math.round((entry.durationMs || 0) / 1000) + ' s'),
        cell(entry.reason || '—'),
      );
      body.append(row);
    }
    table.append(head, body);
    scroll.append(table);
    wrapper.append(scroll);
    const outputs = failedTestOutputs(pr);
    if (outputs) {
      wrapper.append(block('失敗したテストの出力 (秘匿値はマスク済み)', outputs));
    }
    return wrapper;
  }

  function reviewOf(pr) {
    const wrapper = document.createElement('div');
    const list = element('dl', 'meta');
    definition(list, 'レビュアー', pr.reviewer || '未実施');
    definition(list, '流出スキャン', pr.leakage
      ? (pr.leakage.totalFindings + ' 件 / 追加 ' + pr.leakage.scannedAddedLines + ' 行を検査')
      : '未実施');
    definition(list, 'セキュリティスキャン', pr.security
      ? (pr.security.status === 'skipped'
        ? 'スキップ: ' + pr.security.reason
        : pr.security.status + ' / ' + pr.security.totalFindings + ' 件 (閾値 '
          + pr.security.failOnSeverity + ')'
          + (pr.security.reason ? ' — ' + pr.security.reason : ''))
      : '未実施');
    if (pr.error) definition(list, 'エラー', pr.error);
    if (pr.humanQuestion) definition(list, '人間への確認', pr.humanQuestion);
    wrapper.append(list);
    wrapper.append(block('ブロック理由', listOf(pr.reasons, 'ブロック理由はありません。')));
    wrapper.append(block('所見 (マージは止めない)', listOf(pr.advisories, '所見はありません。')));
    const geniusCards = pr.geniusGuidance?.cards || [];
    wrapper.append(block(
      'Genius の判断カード',
      listOf(geniusCards.map((card) =>
        card.judgment + ' — ' + card.rationale + ' [' + card.situation + ']'),
      'Genius の判断カードはありません。'),
    ));
    const findings = (pr.leakage && pr.leakage.findings || [])
      .map((finding) => finding.rule + '  ' + finding.path + ':' + finding.line);
    wrapper.append(block('流出候補', listOf(findings, '流出候補はありません。')));
    const securityFindings = (pr.security && pr.security.findings || [])
      .map((finding) => '[' + finding.severity + '] ' + finding.rule + '  '
        + finding.file + (finding.line === null ? '' : ':' + finding.line));
    wrapper.append(block(
      'セキュリティ finding',
      listOf(securityFindings, 'セキュリティ finding はありません。'),
    ));
    return wrapper;
  }

  function analysisOf(pr) {
    if (!pr.anatomia) return paragraph('差分解析はまだありません。');
    const wrapper = document.createElement('div');
    const list = element('dl', 'meta');
    definition(list, '解析元', pr.anatomia.source);
    definition(list, 'complexity score', pr.anatomia.baselineComplexityScore === null
      ? '計画により未計測'
      : pr.anatomia.baselineComplexityScore
        + ' → ' + (pr.anatomia.baselineComplexityScore + pr.anatomia.complexityScoreDelta)
        + ' (Δ ' + pr.anatomia.complexityScoreDelta + ')');
    definition(list, '対象ドメイン', (pr.anatomia.domain && pr.anatomia.domain.hasTargetDomain)
      ? (pr.anatomia.domain.targetDomains || [])
          .map((entry) => (entry && entry.name) || entry).join(', ') || 'あり'
      : 'なし');
    wrapper.append(list);
    const quality = pr.anatomia.quality || {};
    const architecture = pr.anatomia.architecture || {};
    wrapper.append(block(
      '孤立した変更関数',
      listOf((quality.changedOrphans || []).map((entry) =>
        entry.file ? entry.name + '  ' + entry.file + ':' + entry.line : text(entry.name)),
        '孤立した変更関数はありません。'),
    ));
    wrapper.append(block(
      'アーキテクチャ違反',
      listOf((architecture.changedViolations || [])
        .map((entry) => '[' + entry.severity + '] ' + (entry.message || entry.rule)),
        'アーキテクチャ違反はありません。'),
    ));
    return wrapper;
  }
`;
