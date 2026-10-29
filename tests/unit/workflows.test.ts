import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const workflows = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '.github/workflows'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((file) => /\.ya?ml$/.test(file));
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('the GitHub workflows', () => {
  it('pin every action to a full commit, with the version it is beside', () => {
    expect(workflows).toContain('.github/workflows/verifier-pages.yml');
    for (const file of workflows) {
      for (const line of read(file).split('\n').filter((l) => /^\s*(-\s+)?uses:/.test(l))) {
        expect(line, file).toMatch(/uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/);
      }
    }
  });

  it('build the published verifier from public settings only: every value baked into it is read by everyone (#85)', () => {
    const text = read('.github/workflows/verifier-pages.yml');
    expect(text).not.toMatch(/\$\{\{\s*secrets\./);
    // The build step's settings are repository variables, never secrets.
    for (const name of ['VERIFY_RPC_URL_1', 'VERIFY_RPC_URL_2', 'APP_PUBLIC_URL', 'SEAL_TRUST_ANCHORS_PEM']) {
      expect(text).toContain(`${name}: \${{ vars.${name} }}`);
    }
  });

  it('publish nothing, and release nothing, from any branch but master or before the network’s deployment record is committed (#85)', () => {
    const text = read('.github/workflows/verifier-pages.yml');
    const [build, deploy] = text.split(/\n  deploy:\n/);
    expect(deploy).toMatch(/\n    if: needs\.build\.outputs\.publish == 'true'\n/);
    const steps = build.split(/\n      - /).slice(1);
    const gate = steps.findIndex((step) => step.includes('id: gate'));
    expect(steps[gate]).toContain('if [ "$GITHUB_REF" != "refs/heads/master" ]');
    expect(steps[gate]).toContain('elif [ -f "deployments/$NETWORK.json" ]');
    expect(steps[gate].match(/publish=true/g)).toHaveLength(1);
    expect(steps.slice(gate + 1).length).toBeGreaterThan(0);
    for (const step of steps.slice(gate + 1)) expect(step).toContain("if: steps.gate.outputs.publish == 'true'");
  });
});
