// Split out of the layout so the shell stays about structure. The rules below are
// written mobile-last: the desktop layout comes first, then one narrow-screen
// block collapses every multi-column construct. The phone case that matters is
// "which PR needs my decision", so decision cards, badges and buttons keep full
// width and touch-sized targets there while tables are allowed to scroll.

export const STYLES = `
    :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #10141c; color: #edf1f7; }
    main { width: calc(100% - 32px); margin: 32px auto; display: grid; gap: 20px; }
    section { background: #19202c; border: 1px solid #2d394a; border-radius: 14px; padding: 24px; }
    h1 { margin: 0; font-size: 1.5rem; } h2 { margin-top: 0; } h3 { margin: 24px 0 8px; font-size: 1rem; }
    header.bar { display: flex; align-items: baseline; gap: 20px; flex-wrap: wrap; }
    nav { display: flex; gap: 12px; margin-left: auto; }
    nav a { color: #aebbd0; text-decoration: none; border: 1px solid #2d394a; border-radius: 8px; padding: 6px 14px; }
    nav a.active { color: #edf1f7; border-color: #5871e5; background: #1f2942; }
    .field { display: grid; gap: 8px; margin: 18px 0; }
    input, select, textarea, button { font: inherit; border-radius: 8px; border: 1px solid #40506a; padding: 10px 12px; max-width: 100%; }
    input, select, textarea { color: inherit; background: #111722; }
    textarea { min-height: 120px; resize: vertical; }
    button { color: white; background: #405bd8; border-color: #5871e5; cursor: pointer; }
    button.secondary { background: #26314a; border-color: #40506a; }
    button:disabled { opacity: .5; cursor: default; }
    .check { display: flex; gap: 10px; align-items: center; }
    pre { white-space: pre-wrap; background: #0e131b; border-radius: 8px; padding: 14px; overflow: auto; }
    .note { color: #aebbd0; }
    .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
    .table-scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid #2d394a; padding: 10px 8px; vertical-align: top; }
    tbody tr.selectable { cursor: pointer; }
    tbody tr.selectable:hover { background: #1e273a; }
    tbody tr.selected { background: #223055; }
    .ok { color: #62d59a; } .warn { color: #f5c66b; } .bad { color: #ff7d8d; } .idle { color: #aebbd0; }
    dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
    dl.meta dt { color: #aebbd0; } dl.meta dd { margin: 0; word-break: break-all; }
    .empty { color: #aebbd0; padding: 12px 0; }

    .cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); }
    .card {
      display: grid; gap: 10px; padding: 14px 16px; cursor: pointer;
      background: #161d28; border: 1px solid #2d394a; border-left-width: 4px; border-radius: 12px;
    }
    .card:hover { background: #1e273a; }
    .card.selected { border-color: #5871e5; background: #223055; }
    .card[data-tone="bad"] { border-left-color: #ff7d8d; }
    .card[data-tone="warn"] { border-left-color: #f5c66b; }
    .card[data-tone="ok"] { border-left-color: #62d59a; }
    .card[data-tone="idle"] { border-left-color: #40506a; }
    .card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .card-title { font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
    .card-repository { color: #aebbd0; font-size: .85rem; overflow-wrap: anywhere; }
    .pr-number { color: #aebbd0; font-variant-numeric: tabular-nums; font-weight: 600; }

    .badge {
      display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
      border-radius: 999px; padding: 3px 12px; font-size: .8rem; font-weight: 600;
      border: 1px solid currentColor;
    }
    .filter-bar { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; margin: 8px 0 16px; }
    .filter-projects { margin: 0; min-width: min(280px, 100%); }
    .filter-projects select { min-height: 6.5rem; }
    .stage-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
    .stage-list li { display: flex; gap: 8px; align-items: baseline; font-size: .9rem; }
    .stage-list .stage-mark { width: 1.4em; flex: none; font-weight: 600; }
    .factor-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
    .factor-list li { display: flex; gap: 10px; font-size: .9rem; }
    .factor-list .points { min-width: 3.2em; text-align: right; color: #f5c66b; font-variant-numeric: tabular-nums; }
    .test-outputs { display: grid; gap: 8px; }
    .test-output > summary { cursor: pointer; color: #ff7d8d; font-size: .9rem; }
    .test-output > pre { margin: 8px 0 0; max-height: 420px; font-size: .8rem; }
    .workflow-log { display: grid; gap: 10px; }
    .workflow-log-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .workflow-log-toolbar select { min-width: 10rem; }
    .button-link {
      display: inline-flex; align-items: center; min-height: 42px; padding: 8px 12px;
      border: 1px solid #40506a; border-radius: 8px; color: #edf1f7;
      background: #26314a; text-decoration: none;
    }
    .workflow-log-entries {
      display: grid; gap: 8px; max-height: 260px; overflow-y: auto;
      scroll-behavior: smooth; margin: 0; padding: 0; list-style: none;
    }
    .workflow-log-entries li { display: grid; gap: 4px; white-space: pre-wrap; }
    .workflow-log-entries time { color: #aebbd0; font-size: .8rem; }
    body.overlay-open { overflow: hidden; }
    .log-overlay {
      position: fixed; inset: 0; z-index: 1000; padding: 20px;
      background: rgba(5, 8, 13, .88);
    }
    .log-overlay[hidden] { display: none; }
    .log-overlay-panel {
      width: 100%; height: 100%; display: grid; grid-template-rows: auto 1fr;
      background: #10141c; border: 1px solid #40506a; border-radius: 12px; padding: 18px;
    }
    .log-overlay-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .log-overlay-head h2 { margin: 0; }
    .log-overlay pre { min-height: 0; margin: 16px 0 0; white-space: pre-wrap; overflow: auto; }

    .diff-overlay {
      position: fixed; inset: 0; z-index: 1000; padding: 20px;
      background: rgba(5, 8, 13, .88);
    }
    .diff-overlay[hidden] { display: none; }
    .diff-overlay-panel {
      width: 100%; height: 100%; display: grid; grid-template-rows: auto 1fr;
      background: #10141c; border: 1px solid #40506a; border-radius: 12px; padding: 18px;
    }
    .diff-viewer { min-height: 0; display: grid; grid-template-columns: minmax(240px, 28%) 1fr; gap: 16px; }
    .diff-files-pane, .diff-content-pane { min-height: 0; overflow: auto; border: 1px solid #2d394a; border-radius: 8px; padding: 12px; }
    .diff-files-pane { background: #141a24; }
    .diff-file { width: 100%; display: grid; grid-template-columns: max-content 1fr; gap: 8px; text-align: left; background: transparent; border: 0; border-radius: 5px; padding: 7px; }
    .diff-file:hover, .diff-file.selected { background: #223055; }
    .diff-file-status { font-size: .78rem; font-weight: 600; }
    .diff-file-status.added { color: #62d59a; } .diff-file-status.deleted { color: #ff7d8d; }
    .diff-file-status.renamed, .diff-file-status.copied { color: #f5c66b; }
    .diff-file-path { overflow-wrap: anywhere; }
    .diff-content-pane { background: #0e131b; }
    .diff-content-pane > .note { margin-top: 0; }
    .unified-diff { margin: 0; padding: 0; white-space: pre; overflow: visible; background: transparent; border-radius: 0; }
    .diff-line { display: block; min-width: max-content; padding: 0 8px; }
    .diff-line.meta { color: #aebbd0; } .diff-line.hunk { color: #8db3ff; background: #1b2943; }
    .diff-line.added { color: #c8f3db; background: #123b2a; } .diff-line.deleted { color: #ffd7dd; background: #48202a; }

    .pr-board { display: grid; grid-template-columns: minmax(340px, 2fr) minmax(0, 3fr); gap: 20px; align-items: start; }
    .pr-list-pane .cards { grid-template-columns: 1fr; max-height: calc(100vh - 260px); overflow-y: auto; padding-right: 4px; }
    .pr-detail-pane { position: sticky; top: 16px; max-height: calc(100vh - 32px); overflow-y: auto; }
    .test-workflow-summary ul { display: flex; flex-wrap: wrap; gap: 8px 24px; margin-bottom: 0; }
    .test-workflow-summary li { cursor: pointer; }
    .review-work-summary { margin-top: 18px; }
    #review-work-queues { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .review-work-queue { border: 1px solid #2d394a; border-radius: 8px; padding: 12px; }
    .review-work-queue h3 { margin-top: 0; font-size: .95rem; }
    .review-work-items { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
    .review-work-items li { display: grid; gap: 2px; padding-left: 10px; border-left: 3px solid #51617b; }
    .review-work-items li.running { border-left-color: #44d7a8; }
    .review-work-items li.queued { border-left-color: #ffcf6e; }
    .review-work-items span { color: #aebbd0; font-size: .82rem; }
    .pr-event-log { margin-top: 24px; border-top: 1px solid #2d394a; padding-top: 4px; }
    .pr-event-log-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    .pr-event-log ol { display: grid; gap: 6px; max-height: 220px; overflow-y: auto; scroll-behavior: smooth; margin: 0; padding: 0; list-style: none; }
    .pr-event-log li { display: grid; grid-template-columns: max-content 1fr; gap: 10px; font-size: .85rem; }
    .pr-event-log time { color: #aebbd0; font-variant-numeric: tabular-nums; }

    @media (max-width: 960px) {
      .pr-board { grid-template-columns: 1fr; }
      .pr-list-pane .cards { max-height: none; overflow-y: visible; }
      .pr-detail-pane { position: static; max-height: none; overflow-y: visible; }
      .diff-viewer { grid-template-columns: 1fr; grid-template-rows: minmax(150px, 32%) 1fr; }
    }

    @media (max-width: 700px) {
      main { width: calc(100% - 16px); margin: 12px auto; gap: 12px; }
      section { padding: 16px; border-radius: 10px; }
      h1 { font-size: 1.25rem; }
      h3 { margin: 18px 0 8px; }
      header.bar { gap: 10px; }
      nav { margin-left: 0; width: 100%; }
      nav a { flex: 1; text-align: center; }
      .cards { grid-template-columns: 1fr; }
      /* 16px keeps iOS Safari from zooming the viewport on focus. */
      input, select, textarea, button { font-size: 16px; min-height: 44px; }
      textarea { min-height: 96px; }
      .actions button { flex: 1 1 100%; }
      dl.meta { grid-template-columns: 1fr; gap: 2px; }
      dl.meta dt { margin-top: 8px; font-size: .8rem; }
      th, td { padding: 8px 6px; font-size: .9rem; white-space: nowrap; }
      pre { font-size: .8rem; }
    }
`;
