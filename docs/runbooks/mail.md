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

## The monitor says `NOTICE_RETRYING`

A notice has failed six times in a row, about half an hour of attempts. The
mailer waits longer after each failure (a minute, doubling to four hours) and
keeps trying for about three days when it cannot reach the server, the server
asks it to try later (4xx), or the server refuses the firm's own sign-in
(`EAUTH`). The `reasons` name the errors. Usually the SMTP server is down or
`SMTP_URL` is wrong: fix that, and the notices go out at their next attempt,
within four hours. Nothing is lost while it retries.

## A notice says "could not be sent"

A notice is FAILED, and the audit log records `notification.failed`, in two
cases:

- after five attempts, when the server turned the address away for good (a
  5xx reply: the mailbox does not exist, or the server refuses mail for it);
- after about three days of failed attempts for any other reason. The mailer does not try it again; a way to retry it from
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
