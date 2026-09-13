import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRequestHandler } from '../src/server.mjs';
import { removeFixture } from './helpers/fixture-cleanup.mjs';

test('changes HTTP route uses the real Git binding and returns deployed commits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'revisor-changes-route-'));
  const run = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  try {
    run('init', '--initial-branch=main');
    run('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'Initial');
    const from = run('rev-parse', 'HEAD');
    run('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'Deployed change');
    const to = run('rev-parse', 'HEAD');
    const repository = { id: 'repo-1', repository: 'LUDIARS/Fixture', rootPath: root, baseRef: 'main' };
    const handler = createRequestHandler({ env: {}, sessionToken: 'test', queue: { state: () => ({}) },
      localPrService: { store: { listRepositories: () => [repository], listPullRequests: () => [
        { repository: repository.repository, status: 'merged', number: 1, mergeCommitSha: to, title: 'Deployed change', author: 'fixture' },
      ] } },
    });
    const output = { status: 0, body: '', writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    await handler({ method: 'GET', url: `/v1/repositories/repo-1/changes?from=${from}&to=${to}`,
      socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:4240' } }, output);
    assert.equal(output.status, 200, output.body);
    const body = JSON.parse(output.body);
    assert.deepEqual(body.commits.map(entry => entry.sha), [to]);
    assert.deepEqual(body.pullRequests.map(entry => entry.number), [1]);
    assert.match(body.notice, /Deployed change/);
  } finally { removeFixture(root); }
});
