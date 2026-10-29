import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { orgIdFor } from '@/lib/chain/deploy';
import { registryRuntimeBytecodeHash } from '@/lib/chain/registry-artifact';
import { standaloneVerifierUrlOf, verifierSetupFromEnv } from '@/lib/verify-setup';
import { createTestPki, pemOf } from '../helpers/test-pki';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-setup-'));
const ADDRESS = '0x87ba96d1d48e280429a8ead1059334c34507c31f';
const deployment = (chainId: number, issuer?: unknown) => ({ chainId, address: ADDRESS, runtimeBytecodeHash: registryRuntimeBytecodeHash, issuer });
fs.mkdirSync(path.join(root, 'deployments'));
fs.writeFileSync(path.join(root, 'deployments', 'sepolia.json'), JSON.stringify(deployment(11155111, { orgId: orgIdFor('Ledger Audit Ltd'), orgName: 'Ledger Audit Ltd' })));
fs.writeFileSync(path.join(root, 'deployments', 'local.json'), JSON.stringify(deployment(31337, { orgId: 'not an id', orgName: 'x' })));

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const sepolia = { VERIFY_NETWORK: 'sepolia', VERIFY_RPC_URL_1: 'https://rpc.one.example/sepolia', VERIFY_RPC_URL_2: 'https://rpc.two.example' };
const reason = (env: Record<string, string>) => {
  const result = verifierSetupFromEnv(env, root);
  return result.ok ? 'OK' : result.reason;
};

describe('the verifier setup', () => {
  it('hands the page the registry, two endpoints and the issuer the deployment registered', () => {
    const result = verifierSetupFromEnv(sepolia, root);
    expect(result).toEqual({
      ok: true,
      setup: {
        network: 'sepolia',
        chainId: 11155111,
        registry: '0x87Ba96d1d48e280429A8ead1059334C34507c31F',
        runtimeBytecodeHash: registryRuntimeBytecodeHash,
        rpcUrls: ['https://rpc.one.example/sepolia', 'https://rpc.two.example'],
        issuers: { [orgIdFor('Ledger Audit Ltd')]: 'Ledger Audit Ltd' },
        sealRoots: [],
        reanchorArchives: 0,
      },
    });
  });

  it('tells the page how many re-anchor archives there are, never where they are (#126)', () => {
    const result = verifierSetupFromEnv({ ...sepolia, REANCHOR_ARCHIVES: ' /srv/a/archive.json , ,/srv/b/proof.json,' }, root);
    expect(result.ok && result.setup.reanchorArchives).toBe(2);
    expect(JSON.stringify(result)).not.toContain('/srv/');
  });

  it('hands the page the seal’s published roots, and none for a file it cannot read (#120)', async () => {
    const pki = await createTestPki();
    const pem = path.join(root, 'roots.pem');
    fs.writeFileSync(pem, pemOf(pki.rootDer) + pemOf(pki.tsaDer));
    const result = verifierSetupFromEnv({ ...sepolia, SEAL_TRUST_ANCHORS: pem }, root);
    expect(result.ok && result.setup.sealRoots).toEqual([Buffer.from(pki.rootDer).toString('base64'), Buffer.from(pki.tsaDer).toString('base64')]);
    fs.writeFileSync(path.join(root, 'broken.pem'), '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n');
    for (const file of [path.join(root, 'broken.pem'), path.join(root, 'missing.pem')]) {
      const unreadable = verifierSetupFromEnv({ ...sepolia, SEAL_TRUST_ANCHORS: file }, root);
      expect(unreadable.ok && unreadable.setup.sealRoots).toEqual([]);
    }
  });

  it('falls back to the anchoring network, and for a local chain to its one node', () => {
    const result = verifierSetupFromEnv({ ANCHOR_NETWORK: 'local', LOCAL_RPC_URL: 'http://127.0.0.1:9545' }, root);
    expect(result).toMatchObject({ ok: true, setup: { network: 'local', rpcUrls: ['http://127.0.0.1:9545', 'http://127.0.0.1:9545'], issuers: {} } });
  });

  it('refuses, by name, anything short of two independent public https endpoints on a known deployment', () => {
    expect(reason({})).toBe('NOT_CONFIGURED');
    expect(reason({ VERIFY_NETWORK: 'polygon' })).toBe('NETWORK_INVALID');
    expect(verifierSetupFromEnv(sepolia, path.join(root, 'nowhere'))).toEqual({ ok: false, reason: 'DEPLOYMENT_UNAVAILABLE' });
    expect(reason({ ...sepolia, VERIFY_RPC_URL_2: '' })).toBe('RPC_URLS_MISSING');
    expect(reason({ ...sepolia, VERIFY_RPC_URL_2: 'not a url' })).toBe('RPC_URLS_INVALID');
    expect(reason({ ...sepolia, VERIFY_RPC_URL_2: 'http://rpc.two.example' })).toBe('RPC_URLS_INVALID');
    expect(reason({ ...sepolia, VERIFY_RPC_URL_2: 'https://user:secret@rpc.two.example' })).toBe('RPC_URLS_INVALID');
    expect(reason({ ...sepolia, VERIFY_RPC_URL_2: 'https://rpc.one.example/other' })).toBe('RPC_URLS_NOT_INDEPENDENT');
  });

  it('links the published single-file verifier only by an https URL with no credentials (#85)', () => {
    expect(standaloneVerifierUrlOf({})).toBeNull();
    expect(standaloneVerifierUrlOf({ STANDALONE_VERIFIER_URL: '  ' })).toBeNull();
    expect(standaloneVerifierUrlOf({ STANDALONE_VERIFIER_URL: 'https://firm.github.io/verifier' })).toBe('https://firm.github.io/verifier');
    expect(standaloneVerifierUrlOf({ STANDALONE_VERIFIER_URL: 'https://firm.github.io' })).toBe('https://firm.github.io/');
    for (const bad of ['firm.github.io', 'http://firm.github.io/', 'https://user:secret@firm.github.io/', 'javascript:alert(1)', `https://firm.github.io/${'a'.repeat(200)}`]) {
      expect(standaloneVerifierUrlOf({ STANDALONE_VERIFIER_URL: bad }), bad).toBe('INVALID');
    }
  });
});
