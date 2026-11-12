import { getAddress, type Hex, type PublicClient } from 'viem';
import type { AuditHeadWitness } from '@/lib/audit-check';
import { agreedFinalizedBlock, readOnBoth } from '@/lib/chain/agree';
import { orgIdFor } from '@/lib/chain/deploy';
import type { Deployment } from '@/lib/chain/deployment';
import { createRegistryReader } from '@/lib/chain/reader';
import { registryAbi } from '@/lib/chain/registry-artifact';
import type { AnchorTarget } from './target';

/**
 * The registry as the nightly check's witness (#94): a firm's audit-log heads,
 * read on two endpoints at one finalized block both agree on (#92), after both
 * have shown the chain and the registry are the expected ones (rule 7). A head
 * the registry's owner voided is left out; the rest the log must hold.
 *
 * Heads are filed on chain under the firm the writing key is registered to,
 * so that firm, read on both endpoints, is the one whose heads are read
 * (#141): never the database firm's name, which may not be what the key was
 * registered under.
 */
export function registryHeadWitness(input: { clients: readonly [PublicClient, PublicClient]; deployment: Deployment; target: AnchorTarget | null }): AuditHeadWitness {
  const { clients, deployment } = input;
  const readers = [createRegistryReader(clients[0], deployment), createRegistryReader(clients[1], deployment)] as const;
  let checked: Promise<void> | null = null;
  const ready = () => (checked ??= Promise.all(readers.map((r) => r.assertDeployment())).then(() => undefined));
  const target = input.target;
  /** The firm the key that writes the heads is registered to, as both endpoints read it at one finalized block. */
  const firm = target
    ? async (): Promise<Hex> => {
        await ready();
        const at = await agreedFinalizedBlock(clients);
        // A key is registered to one firm for good (setIssuer refuses a change), active or not.
        const [orgId] = await readOnBoth(clients, `the firm of key ${target.issuer}`, (client) =>
          client.readContract({ address: getAddress(deployment.address), abi: registryAbi, functionName: 'issuers', args: [target.issuer], blockNumber: at }),
        );
        return orgId;
      }
    : undefined;
  return {
    target,
    firm,
    async heads(org) {
      await ready();
      const onChainOrgId = firm ? await firm() : orgIdFor(org.name);
      const at = await agreedFinalizedBlock(clients);
      const heads = await readOnBoth(clients, 'the firm’s audit-log heads', (client) =>
        (client === clients[0] ? readers[0] : readers[1]).auditHeads(onChainOrgId, { blockNumber: at }),
      );
      return heads.filter((h) => !h.voided).map((h) => ({ index: h.index, head: h.head, recordedAt: h.recordedAt }));
    },
  };
}
