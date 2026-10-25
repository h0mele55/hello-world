# Moving the registry's ownership to a Safe

The owner decides which keys write in the firm's name. Today the owner is the
key that deployed the registry. In production it should be a Safe multisig,
so that no single stolen key can register a rogue issuer (#67,
`docs/threat-model.md` T-C2).

Ownership moves in two steps, so a wrong address cannot take it:

1. the current owner offers it;
2. the new owner accepts it.

`scripts/owner-call.ts` prints each transaction and never sends either one.

## Steps

1. **The owner creates the Safe** on the same network: its signers and their
   threshold (for example 2 of 3) are the owner's decision. Note its address.
2. **Prepare the offer.**

   ```sh
   npx tsx scripts/owner-call.ts sepolia transfer-owner <safe address>
   ```

   It checks the chain and the registry against the deployment record,
   simulates the call from the current owner, and prints
   `{ from, to, value, data }`. It warns if the address holds no code, which
   means it is not a Safe.
3. **The current owner executes it** from the deployer key's wallet: the
   `to` and `data` printed, value 0. Nothing has moved yet: `pendingOwner`
   is now the Safe.
4. **Prepare the acceptance.**

   ```sh
   npx tsx scripts/owner-call.ts sepolia accept-owner
   ```

   It prints the transaction for the Safe.
5. **The Safe executes it.** In the Safe's app: New transaction, then
   Transaction Builder. Enter the registry's address and the printed `data`
   as custom data, with value 0. The signers sign, and it is executed.
6. **Check** that `owner()` is the Safe, for example by running step 4 again:
   it refuses with "no ownership transfer is pending". Then record the new
   owner in `deployments/sepolia.json` (`owner`) in a pull request.

From then on every owner act (`add-issuer`, `remove-issuer`) is printed for
the Safe; `--send` refuses, because the owner is not a key the script holds.

## Undoing it

Until step 5, the current owner can offer ownership to another address, which
replaces the pending offer. After step 5, only the Safe can move ownership
again, by the same two steps.
