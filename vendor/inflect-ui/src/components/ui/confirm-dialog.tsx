"use client";

/**
 * <ConfirmDialog> — top-level export for destructive-action confirmations.
 *
 * The implementation lives at `Modal.Confirm` (modal.tsx) to share the
 * focus-trap, drawer/dialog responsiveness, and Promise-handling code
 * paths with the rest of the modal system. This file is the
 * discoverable top-level surface — use it (or `Modal.Confirm`,
 * interchangeably) for delete / revoke / rotate / remove / archive
 * flows that previously called `window.confirm()`.
 *
 * Usage:
 *
 *     const [confirmOpen, setConfirmOpen] = useState(false);
 *     <button onClick={() => setConfirmOpen(true)}>Revoke key</button>
 *     <ConfirmDialog
 *         showModal={confirmOpen}
 *         setShowModal={setConfirmOpen}
 *         tone="danger"
 *         title="Revoke API key?"
 *         description="Integrations using this key will lose access immediately. This cannot be undone."
 *         confirmLabel="Revoke key"
 *         onConfirm={async () => { await revoke(keyId); }}
 *     />
 *
 * Tone semantics:
 *   - `danger`  — irreversible destructive (delete, revoke, rotate)
 *   - `warning` — significant consequence (close cycle, mark complete)
 *   - `info`    — confirmable but non-destructive (run job now)
 */

import {
    Modal,
    type ConfirmModalProps,
    type ConfirmTone,
} from "./modal";

export type { ConfirmModalProps as ConfirmDialogProps, ConfirmTone };

export const ConfirmDialog = Modal.Confirm;
