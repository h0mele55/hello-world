# MEMORY EXPORT — paste at each checkpoint / end of session

Paste the block below whenever you finish a build prompt (or end a working session) so
the project's memory is persisted into the `agri-saas` repo and a future session can
resume with zero loss.

```
Checkpoint the project memory so a future session can resume with zero loss.

1) Write/refresh ag-saas/MEMORY.md (create the ag-saas/ folder in THIS repo if needed)
   with: STATUS (modules built + migration names + test/tsc results, per module),
   DECISION LOG (any choice made + why, esp. deviations from PLAN.md), DEVIATIONS from
   PLAN.md/REPOS.md, OPEN QUESTIONS, and NEXT STEP (which build prompt is next).
2) If scope or design evolved, update ag-saas/PLAN.md accordingly (keep it the source
   of truth) and note the change in MEMORY.md.
3) Ensure THIRD_PARTY_NOTICES.md lists every ported MIT/Apache/BSD/CC0 source used so far.
4) Commit everything on the current feature branch with a clear message and push.
   Print the branch name, the MEMORY.md "NEXT STEP", and any red/failing checks.
```

## Note on where MEMORY.md lives

The export writes `ag-saas/MEMORY.md` **inside the agri-saas repo** (the working repo of
that session). The import prompt reads it from there first. The copies in this
`hello-world` repo (`PLAN.md`, `REPOS.md`, `BUILD-KIT.md`, the two MEMORY-*.md prompts)
are the **seed/reference** context that bootstrapped the project; once agri-saas has its
own `MEMORY.md`, that becomes the live source of truth for status.
