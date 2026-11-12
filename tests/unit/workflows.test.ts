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
    expect(steps[gate]).toContain('if [ "$HEAD_BRANCH" != "master" ]');
    expect(steps[gate]).toContain('elif [ -f "deployments/$NETWORK.json" ]');
    expect(steps[gate].match(/publish=true/g)).toHaveLength(1);
    expect(steps.slice(gate + 1).length).toBeGreaterThan(0);
    for (const step of steps.slice(gate + 1)) expect(step).toContain("if: steps.gate.outputs.publish == 'true'");
  });

  it('publish the verifier only for a master commit CI passed on, and build exactly that commit (#149)', () => {
    const text = read('.github/workflows/verifier-pages.yml');
    const on = text.slice(text.indexOf('\non:\n'), text.indexOf('\npermissions:'));
    expect(on).toMatch(/\n  workflow_run:\n    workflows: \[CI\]\n    types: \[completed\]\n    branches: \[master\]\n/);
    expect(on).not.toMatch(/\n  push:/);
    expect(text).toMatch(/\n    if: github\.event_name == 'workflow_dispatch' \|\| \(github\.event\.workflow_run\.conclusion == 'success' && github\.event\.workflow_run\.event == 'push'\)\n/);
    expect(text).toContain('ref: ${{ github.event.workflow_run.head_sha || github.sha }}');
    expect(text).not.toContain('--target "$GITHUB_SHA"');
  });

  it('never cancel CI on master, so every master commit gets a verdict (#149)', () => {
    expect(read('.github/workflows/ci.yml')).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });

  it('check the Prisma schema against the migrations, so no index or unique lives in one only (#149)', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code');
  });

  it('pin every container image by digest, in the workflows and the compose file (#149)', () => {
    for (const file of [...workflows, 'docker-compose.yml']) {
      const text = read(file);
      const images = [...text.matchAll(/image:\s*(\S+)/g), ...text.matchAll(/docker run[^\n]*(?:\n\s+[^\n]*)*?\s(\S+\/\S+:\S+)/g)].map((m) => m[1]);
      for (const image of images) expect(image, file).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
    expect(read('.github/workflows/ci.yml')).toMatch(/ghcr\.io\/gitleaks\/gitleaks:v[\d.]+@sha256:[0-9a-f]{64}/);
  });

  it('install in CI every outside tool a test checks a file with, so none is skipped there (#149)', () => {
    const tests = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'tests'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((file) => /\.test\.ts$/.test(file));
    const gated = tests.flatMap((file) => [...read(file).matchAll(/\.runIf\(([^)]*\btool\('[^']+'\)[^)]*)\)/g)].map((m) => ({ file, condition: m[1] })));
    expect(gated.length).toBeGreaterThan(0);
    for (const { file, condition } of gated) expect(condition, file).toContain('process.env.CI');
    const pdfJob = read('.github/workflows/ci.yml').split('\n  pdf:\n')[1].split('\n  golden-windows:')[0];
    for (const tool of ['poppler-utils', 'qpdf']) expect(pdfJob).toContain(tool);
  });

  it('measure coverage in CI and keep the report (#149)', () => {
    const ci = read('.github/workflows/ci.yml');
    for (const suite of ['npm test -- --coverage', 'npm run test:db -- --coverage', 'npm run test:anchoring -- --coverage']) expect(ci).toContain(suite);
    expect(ci).toContain('name: coverage');
  });
});

describe('Dependabot (#149)', () => {
  it('watches the compose images and the forge-std submodule, besides npm and the actions', () => {
    const config = read('.github/dependabot.yml');
    for (const ecosystem of ['npm', 'github-actions', 'docker-compose', 'gitsubmodule']) expect(config).toContain(`package-ecosystem: ${ecosystem}`);
  });
});

describe('the production toolchain (#149)', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> };
  /** What runs in production: the app, its jobs and the seed; and `postinstall`, which `npm ci --omit=dev` runs too. */
  const PRODUCTION = ['postinstall', 'start', 'worker', 'audit:check', 'monitor', 'watch:registry', 'mailer', 'ots', 'reconcile:chain', 'checkpoint', 'db:seed'];
  const binsOf = (name: string) => {
    const manifest = JSON.parse(read(path.join('node_modules', name, 'package.json'))) as { name: string; bin?: string | Record<string, string> };
    return typeof manifest.bin === 'string' ? [manifest.name.split('/').pop()!] : Object.keys(manifest.bin ?? {});
  };

  it('runs only tools that npm ci --omit=dev installs', () => {
    const productionBins = new Set(['node', ...Object.keys(pkg.dependencies).flatMap(binsOf)]);
    for (const name of PRODUCTION) {
      expect(pkg.scripts[name], name).toBeDefined();
      for (const command of pkg.scripts[name].split(/&&|\|\||;|\|/)) {
        const tool = command.trim().split(/\s+/)[0];
        expect(productionBins.has(tool), `${name}: ${tool}`).toBe(true);
      }
    }
    // The seed prisma runs (prisma.config.ts) is a tsx script.
    expect(read('prisma.config.ts')).toContain("seed: 'tsx prisma/seed.ts'");
    expect(pkg.dependencies.tsx).toBeDefined();
    for (const name of ['tsx', 'prisma']) expect(pkg.devDependencies[name], name).toBeUndefined();
  });
});
