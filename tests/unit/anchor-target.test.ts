import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { anchorTargetFromEnv } from '@/lib/anchoring/target';
import { registryRuntimeBytecodeHash } from '@/lib/chain/registry-artifact';

const roots: string[] = [];
function rootWith(file: string | null): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-target-'));
  roots.push(root);
  if (file !== null) {
    fs.mkdirSync(path.join(root, 'deployments'));
    fs.writeFileSync(path.join(root, 'deployments', 'local.json'), file);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const registry = '0x87ba96d1d48e280429a8ead1059334c34507c31f';
const issuer = '0xa065ec8a9d153b0f936ebb8c104353c567f8e1b4';
const valid = JSON.stringify({ chainId: 31337, address: registry, runtimeBytecodeHash: registryRuntimeBytecodeHash });

describe('the anchor target', () => {
  it('is absent when ANCHOR_NETWORK is unset', () => {
    expect(anchorTargetFromEnv({ NODE_ENV: 'test' }, rootWith(null))).toBeNull();
  });

  it('reads the deployment and checksums both addresses', () => {
    expect(anchorTargetFromEnv({ NODE_ENV: 'test', ANCHOR_NETWORK: 'local', ISSUER_ADDRESS: issuer }, rootWith(valid))).toEqual({
      network: 'local',
      chainId: 31337,
      registry: '0x87Ba96d1d48e280429A8ead1059334C34507c31F',
      issuer: '0xA065eC8A9D153B0f936Ebb8C104353C567f8E1b4',
    });
  });

  it('refuses, by name, a wrong network, a bad address, and a missing, malformed or stale deployment', () => {
    const env = { NODE_ENV: 'test' as const, ANCHOR_NETWORK: 'local', ISSUER_ADDRESS: issuer };
    expect(() => anchorTargetFromEnv({ ...env, ANCHOR_NETWORK: 'mainnet' }, rootWith(valid))).toThrow(expect.objectContaining({ code: 'ENV_INVALID' }));
    expect(() => anchorTargetFromEnv({ ...env, ISSUER_ADDRESS: 'nope' }, rootWith(valid))).toThrow(expect.objectContaining({ code: 'ENV_INVALID' }));
    expect(() => anchorTargetFromEnv(env, rootWith(null))).toThrow(expect.objectContaining({ code: 'DEPLOYMENT_MISSING' }));
    expect(() => anchorTargetFromEnv(env, rootWith('{not json'))).toThrow(expect.objectContaining({ code: 'DEPLOYMENT_INVALID' }));
    const stale = JSON.stringify({ chainId: 31337, address: registry, runtimeBytecodeHash: `0x${'1'.repeat(64)}` });
    expect(() => anchorTargetFromEnv(env, rootWith(stale))).toThrow(expect.objectContaining({ code: 'DEPLOYMENT_STALE' }));
  });
});
