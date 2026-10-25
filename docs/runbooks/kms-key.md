# The issuer key in Cloud KMS

With `SIGNER=kms` the worker signs through a Google Cloud KMS key that never
leaves KMS (#62). The worker host holds no key at all. Whoever takes it can
ask KMS to sign only while they keep its credentials, and every request is
logged. This runbook is the key ceremony: making the key, giving the worker
the right to use it, and switching to it.

The signing code is `src/lib/chain/kms-account.ts`. It is tested against a
stand-in KMS, on Anvil, by `tests/anchoring/worker.test.ts` › "anchors,
copies and completes a version with a key that never leaves KMS". A real key
is the owner's, and this runbook is how it is made.

## The ceremony

Two people: the owner, or someone they name, and the operator who runs the
worker. Write down what is done, by whom and when.

1. **Make the key**, in the project and region the worker runs in:

   ```sh
   gcloud kms keyrings create anchor --location europe-west1
   gcloud kms keys create issuer --keyring anchor --location europe-west1 \
     --purpose asymmetric-signing --default-algorithm ec-sign-secp256k1-sha256 \
     --protection-level hsm
   ```

   Its first version is
   `projects/<project>/locations/europe-west1/keyRings/anchor/cryptoKeys/issuer/cryptoKeyVersions/1`.
   That full name is `KMS_KEY_NAME`.
2. **Give the worker, and only the worker, the right to sign.** Grant its
   service account `roles/cloudkms.signer` and `roles/cloudkms.publicKeyViewer`
   **on this key**, not on the project. Nobody holds `roles/cloudkms.admin`
   day to day; destroying a key version takes it, and KMS keeps a destroyed
   version recoverable for the scheduled-destruction period.
3. **Log every signature.** Turn on Data Access audit logs for Cloud KMS in
   the project, so each signing request is recorded with its caller. Comparing
   them with the journal is #93.
4. **Read the key's address.**

   ```sh
   npx tsx scripts/kms-address.ts <KMS_KEY_NAME>
   ```

   It reads the public key, checks it is secp256k1, and prints the address.
   It signs nothing.
5. **Register and switch** as for any new key: follow
   [key-rotation.md](key-rotation.md) from step 2 (fund it), with step 5
   being:

   ```text
   SIGNER=kms
   KMS_KEY_NAME=projects/…/cryptoKeyVersions/1
   ISSUER_ADDRESS=<the address from step 4>
   ```

   **Remove `ISSUER_PRIVATE_KEY`** from the worker's environment; the worker
   refuses to start with both. On the worker's host, credentials come from the
   attached service account (Application Default Credentials). Do not put a
   service-account key file on the host if the platform can attach one.
6. **Rehearse**: one DRY_RUN approval, then one LIVE anchor. The worker logs
   `worker started` with the KMS key's address as its issuer.

## What the worker refuses, by name

| Refusal | Meaning |
| --- | --- |
| `KEY_NAME_INVALID` | `KMS_KEY_NAME` is not a key version's full name. |
| `NOT_SECP256K1` | The key is another algorithm or curve: make a new one, as above. |
| `PUBLIC_KEY_CORRUPTED`, `DIGEST_CORRUPTED`, `SIGNATURE_CORRUPTED` | A response failed its CRC32C check: something between the worker and KMS changed it. The write is not sent. |
| `WRONG_KEY_VERSION` | KMS signed with another version than `KMS_KEY_NAME`. |
| `SIGNATURE_UNREADABLE`, `RECOVERY_FAILED` | The signature is not one this key made. |

A signing refusal during a write leaves the row INTENT. The worker tries it
again once its two-minute lease runs out, and nothing is sent until a
signature checks out.

## Rotating it

A new key version is a new address. Treat it as a key rotation
([key-rotation.md](key-rotation.md)):
1. make the version;
2. read its address;
3. the owner registers it;
4. drain the old one;
5. point `KMS_KEY_NAME` at the new version;
6. the owner retires the old address.

Disable the old version only after its address is retired. Verification never
needs any key, so a disabled or destroyed version changes nothing for
verifiers.
