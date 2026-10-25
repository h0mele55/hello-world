# Recipients are not getting their email

When a newer version is complete, each of the engagement's recipients is
queued a notice; the mailer (`npm run mailer`) sends it. The engagement page
shows, for each recipient, the last notice and whether it was sent.

## A notice says "waiting to be sent"

- Is the mailer running? Its passes log `"mail pass"`. After 20 failed passes
  in a row (about ten minutes) it exits for its supervisor to restart it.
- Is `SMTP_URL` right? A failed send keeps a name for the error (for example
  `ECONNREFUSED`, `EAUTH`, `EENVELOPE`) in the notice's `lastError`, never the
  server's reply:

  ```sql
  SELECT id, status, attempts, "lastError", "createdAt" FROM "Notification"
  WHERE status IN ('PENDING', 'FAILED') ORDER BY "createdAt";
  ```

## A notice says "could not be sent"

After five failed attempts a notice is FAILED, and the audit log records
`notification.failed`. The mailer does not try it again; a way to retry it from
the console is not built. Fix the cause, then tell the recipient yourself:
the engagement page names them and the version.

## Recipients say the email went to spam, or doubt it is genuine

- The sending domain in `MAIL_FROM` needs SPF, DKIM and DMARC records that
  name the SMTP server in `SMTP_URL`. Without them, look-alike email is easy
  to send and real email is easy to lose (`docs/threat-model.md`, T-M3).
- The email carries no attachment and no figure, and points to the firm's
  `/verify`. Tell recipients to check any copy there, never through a link in
  an email they did not expect.

## Changing the SMTP credentials

Put the new URL in `SMTP_URL` (it may hold the password) and restart the
mailer. Notices not yet sent stay queued.
