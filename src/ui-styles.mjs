// Split out of the layout so the shell stays about structure. The rules below are
// written mobile-last: the desktop layout comes first, then one narrow-screen
// block collapses every multi-column construct. The phone case that matters is
// "which PR needs my decision", so decision cards, badges and buttons keep full
// width and touch-sized targets there while tables are allowed to scroll.

export const STYLES = `
    :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #10141c; color: #edf1f7; }
    main { width: min(1180px, calc(100% - 32px)); margin: 32px auto; display: grid; gap: 20px; }
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
    .card-sub { color: #aebbd0; font-size: .85rem; overflow-wrap: anywhere; }
    .card-blockers { margin: 0; padding-left: 18px; color: #ffc2ca; font-size: .85rem; }
    .card-blockers li { margin: 2px 0; overflow-wrap: anywhere; }

    .badge {
      display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
      border-radius: 999px; padding: 3px 12px; font-size: .8rem; font-weight: 600;
      border: 1px solid currentColor;
    }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip {
      display: inline-flex; gap: 6px; align-items: baseline; white-space: nowrap;
      background: #111722; border: 1px solid #2d394a; border-radius: 6px;
      padding: 2px 8px; font-size: .8rem; color: #aebbd0;
    }
    .chip strong { color: #edf1f7; font-weight: 600; }
    .meter { height: 6px; border-radius: 999px; background: #111722; overflow: hidden; }
    .meter span { display: block; height: 100%; border-radius: 999px; background: currentColor; }
    .meter-row { display: grid; gap: 6px; }
    .filter-bar { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; margin: 8px 0 16px; }
    .stage-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
    .stage-list li { display: flex; gap: 8px; align-items: baseline; font-size: .9rem; }
    .stage-list .stage-mark { width: 1.4em; flex: none; font-weight: 600; }
    .factor-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
    .factor-list li { display: flex; gap: 10px; font-size: .9rem; }
    .factor-list .points { min-width: 3.2em; text-align: right; color: #f5c66b; font-variant-numeric: tabular-nums; }
    .test-outputs { display: grid; gap: 8px; }
    .test-output > summary { cursor: pointer; color: #ff7d8d; font-size: .9rem; }
    .test-output > pre { margin: 8px 0 0; max-height: 420px; font-size: .8rem; }

    .pr-board { display: grid; grid-template-columns: minmax(340px, 460px) 1fr; gap: 20px; align-items: start; }
    .pr-list-pane .cards { grid-template-columns: 1fr; max-height: calc(100vh - 260px); overflow-y: auto; padding-right: 4px; }
    .pr-detail-pane { position: sticky; top: 16px; max-height: calc(100vh - 32px); overflow-y: auto; }

    @media (max-width: 960px) {
      .pr-board { grid-template-columns: 1fr; }
      .pr-list-pane .cards { max-height: none; overflow-y: visible; }
      .pr-detail-pane { position: static; max-height: none; overflow-y: visible; }
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
