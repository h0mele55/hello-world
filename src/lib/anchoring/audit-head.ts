import type { PublicClient } from 'viem';
import type { AuditHeadWitness } from '@/lib/audit-check';
import { agreedFinalizedBlock, readOnBoth } from '@/lib/chain/agree';
import { orgIdFor } from '@/lib/chain/deploy';
import type { Deployment } from '@/lib/chain/deployment';
import { createRegistryReader } from '@/lib/chain/reader';
import type { AnchorTarget } from './target';

/**
 * The registry as the nightly check's witness (#94): a firm's audit-log heads,
 * read on two endpoints at one finalized block both agree on (#92), after both
 * have shown the chain and the registry are the expected ones (rule 7). A head
 * the registry's owner voided is left out; the rest the log must hold.
 */
export function registryHeadWitness(input: { clients: readonly [PublicClient, PublicClient]; deployment: Deployment; target: AnchorTarget | null }): AuditHeadWitness {
  const { clients, deployment } = input;
  const readers = [createRegistryReader(clients[0], deployment), createRegistryReader(clients[1], deployment)] as const;
  let checked: Promise<void> | null = null;
  return {
    target: input.target,
    async heads(org) {
      checked ??= Promise.all(readers.map((r) => r.assertDeployment())).then(() => undefined);
      await checked;
      const at = await agreedFinalizedBlock(clients);
      const onChainOrgId = orgIdFor(org.name);
      const heads = await readOnBoth(clients, 'the firm’s audit-log heads', (client) =>
        (client === clients[0] ? readers[0] : readers[1]).auditHeads(onChainOrgId, { blockNumber: at }),
      );
      return heads.filter((h) => !h.voided).map((h) => ({ index: h.index, head: h.head, recordedAt: h.recordedAt }));
    },
  };
}
