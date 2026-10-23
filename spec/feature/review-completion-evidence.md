# Review completion notification evidence

ID: SPEC-REVIEW-COMPLETION-EVIDENCE

The terminal review sender persists an attempt before calling Cc. The identity is
the PR, review job, head, verdict, merge state and merge commit. A transaction
claims each identity once, including across concurrent workers.

`sending` means an attempt began; after a process exit its result is unknown.
`accepted` means Cc returned success, not that the coding agent consumed the message.
`unconfirmed` means the send did not positively acknowledge acceptance. This can
include disabled delivery, missing target, timeout or transport rejection.

None of these states changes the review verdict or authorizes another merge.
Ambiguous sends are not replayed automatically. Recovery must reconcile the
receiver's saved receipt before deciding whether delivery is missing. A new
review attempt or terminal state may send its own notification. Late results
must not replace the evidence for a newer review.

The existing PR timeline exposes acceptance/unconfirmed outcomes. Raw exceptions,
HTTP bodies, session identifiers and notification text are not copied into it.
This is delivery evidence, not a claim that automatic recovery is implemented.
