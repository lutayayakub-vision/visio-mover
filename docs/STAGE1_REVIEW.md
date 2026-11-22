# Stage 1 (image cleanup) – final review notes

Reviewer: the same Claude session that wrote the code (not a separate human or agent). Core algorithm correctness rests on tests rather than a second pair of eyes; an outside review of `src/lib/inpaint/core.ts` is recommended before relying on it for anything high-stakes.

## Fixed during review
| # | Finding | Severity | Fix | Test |
|---|---|---|---|---|
| 1 | The selection mask was transferred to the Web Worker (detached), so the paste-back loop saw an empty mask and the "result" was the unchanged image | High (feature did nothing) | send a copy of the mask | UI e2e checks the exported file's pixels |
| 2 | The 5-cleanup cap was only checked at Apply, so a 6th run was computed and then refused | Medium | Reconstruct disabled at cap with message; Apply also guarded | UI e2e: 5 applies, then blocked; undo frees a slot |
| 3 | Memory: each applied cleanup keeps a full-size bitmap, so 5 on a 50 MP image could hold ~1 GB | Medium | cap = min(5, pixel budget / image size), ≥ 1 | `tests/inpaint-engine.test.ts` |
| 4 | A reconstruction still running when the source file changed (or the editor closed) could deliver its result into the new session | Medium | run token + abort on source change/unmount; stale results closed | code path only (no dedicated UI test) |
| 5 | An unapplied preview bitmap was not released on source change/unmount | Low | closed in both places | code path only |

## Verified, no change needed
- Existing editor behaviour: all pre-existing image/video suites still pass.
- No RLS/grant/trigger/bucket change: the only schema change is widening one CHECK (`edit_kind` gains `'cleanup'`). Live migration list shows exactly one new migration; Supabase security advisor shows only the pre-existing "leaked password protection" warning.
- No new network calls, env vars or secrets; no service-role usage in frontend code.
- Worker cancellation terminates the worker (verified: every started worker is terminated on success, failure and cancel paths).
- Out-of-memory: simulated getImageData failure gives a clear message, no result, nothing applied, and the image still exports pixel-identical to the original.
- Originals: never written by the engine; live test shows the stored original byte-identical after cleanup + save.
- Touch/zoom mapping: stroke lands on the object when zoomed and panned (±1 % of image); pinch zooms without leaving a stray stroke.

## Known remaining limitations
- Reset all / ops Undo do not touch applied cleanups (they have their own "Undo last cleanup").
- Real-device mobile performance and real pinch/pan feel are untested (only emulated 390 px, scripted touches).
- `tests/sql/cleanup-rules.sql` not executed (needs interactive approval); the same rules are covered via the API in the live security test.
