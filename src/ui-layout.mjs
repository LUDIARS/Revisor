import { STYLES } from "./ui-styles.mjs";

function navigation(activeNav) {
  return [
    { href: "/", label: "PR", key: "prs" },
    { href: "/dashboard", label: "ダッシュボード", key: "dashboard" },
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
