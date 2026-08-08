// Rendering helpers for the local PR "Files changed" overlay. The controller
// owns network state; this module only turns already validated API values into
// DOM nodes through the board's textContent-based helpers.
export const PR_DIFF_VIEW_SOURCE = `
  function changedFilesOf(pr, openChangedFiles) {
    const wrapper = element('div', 'changed-files-summary');
    wrapper.append(paragraph('提出時の base/head SHA を比較して、変更ファイルと unified diff を確認します。'));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = '変更ファイルと diff を確認';
    button.addEventListener('click', () => openChangedFiles(pr));
    wrapper.append(button);
    return wrapper;
  }

  function diffFileLabel(file) {
    const labels = {
      added: '追加',
      deleted: '削除',
      renamed: '名前変更',
      copied: 'コピー',
      modified: '変更',
    };
    return labels[file.status] || '変更';
  }

  function renderDiffFileList(container, files, selectedPath, selectFile) {
    container.replaceChildren(...files.map((file) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'diff-file ' + (file.path === selectedPath ? 'selected' : '');
      button.append(
        element('span', 'diff-file-status ' + file.status, diffFileLabel(file)),
        element('span', 'diff-file-path', file.path),
      );
      if (file.previousPath) button.title = file.previousPath + ' → ' + file.path;
      button.addEventListener('click', () => selectFile(file));
      return button;
    }));
  }

  function unifiedDiffView(diff) {
    const code = element('pre', 'unified-diff');
    const lines = text(diff).split('\\n');
    code.replaceChildren(...lines.map((line) => {
      let tone = 'context';
      if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('diff --git')) tone = 'meta';
      else if (line.startsWith('@@')) tone = 'hunk';
      else if (line.startsWith('+')) tone = 'added';
      else if (line.startsWith('-')) tone = 'deleted';
      return element('span', 'diff-line ' + tone, line + '\\n');
    }));
    return code;
  }
`;
