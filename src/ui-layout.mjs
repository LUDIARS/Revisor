const STYLES = `
    :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; }
    body { margin: 0; background: #10141c; color: #edf1f7; }
    main { width: min(1180px, calc(100% - 32px)); margin: 32px auto; display: grid; gap: 20px; }
    section { background: #19202c; border: 1px solid #2d394a; border-radius: 14px; padding: 24px; }
    h1 { margin: 0; font-size: 1.5rem; } h2 { margin-top: 0; } h3 { margin: 24px 0 8px; font-size: 1rem; }
    header.bar { display: flex; align-items: baseline; gap: 20px; flex-wrap: wrap; }
    nav { display: flex; gap: 12px; margin-left: auto; }
    nav a { color: #aebbd0; text-decoration: none; border: 1px solid #2d394a; border-radius: 8px; padding: 6px 14px; }
    nav a.active { color: #edf1f7; border-color: #5871e5; background: #1f2942; }
    .field { display: grid; gap: 8px; margin: 18px 0; }
    input, select, textarea, button { font: inherit; border-radius: 8px; border: 1px solid #40506a; padding: 10px 12px; }
    input, select, textarea { color: inherit; background: #111722; }
    textarea { min-height: 120px; resize: vertical; }
    button { color: white; background: #405bd8; border-color: #5871e5; cursor: pointer; }
    button.secondary { background: #26314a; border-color: #40506a; }
    button:disabled { opacity: .5; cursor: default; }
    .check { display: flex; gap: 10px; align-items: center; }
    pre { white-space: pre-wrap; background: #0e131b; border-radius: 8px; padding: 14px; overflow: auto; }
    .note { color: #aebbd0; }
    .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid #2d394a; padding: 10px 8px; vertical-align: top; }
    tbody tr.selectable { cursor: pointer; }
    tbody tr.selectable:hover { background: #1e273a; }
    tbody tr.selected { background: #223055; }
    .ok { color: #62d59a; } .warn { color: #f5c66b; } .bad { color: #ff7d8d; } .idle { color: #aebbd0; }
    dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
    dl.meta dt { color: #aebbd0; } dl.meta dd { margin: 0; word-break: break-all; }
    .empty { color: #aebbd0; padding: 12px 0; }
`;

function navigation(activeNav) {
  return [
    { href: "/", label: "ダッシュボード", key: "dashboard" },
    { href: "/settings", label: "設定", key: "settings" },
  ]
    .map((item) =>
      `<a href="${item.href}"${item.key === activeNav ? ' class="active"' : ""}>${item.label}</a>`)
    .join("");
}

export function renderPage({ sessionToken, title, activeNav, bodyHtml, scriptSource }) {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>${STYLES}</style>
</head>
<body>
<main>
  <section>
    <header class="bar">
      <h1>Revisor</h1>
      <span class="note">LUDIARS LOCAL PR WORKFLOW。作業ブランチを GitHub へ送らず、ローカルで CI・Anatomia・レビュー・squash merge を完結します。</span>
      <nav>${navigation(activeNav)}</nav>
    </header>
  </section>
${bodyHtml}
</main>
<script nonce="${sessionToken}">
  const sessionToken = ${JSON.stringify(sessionToken).replace(/</g, "\\u003c")};
${scriptSource}
</script>
</body>
</html>`;
}
