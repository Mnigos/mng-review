# ADR 0013: Main reviewer conversations are sized to read every changed file

**Status:** Proposed
**Date:** 2026-11-24

## Context

ADR 0011 lets the bot approve only a run whose main reviewer received every changed file in its scope whole. On large deep reviews that never happened. Over one day of deep runs on a private repository, every run that measured coverage left changed files unread (up to 42 of 78), so none of them was approved. The causes were in the loop, not in the models:

- A unit's share of the run's tokens was too small to read the files its first message cut. A quarter of it was held back for a continuation turn, which was less than one call.
- The tool step refused every output once the conversation could not afford two more calls, so first-turn reads that would have fit before the answer were refused.
- The continuation turn fired only for files no tool call had touched, while the report counted files not received whole. A file read in part, or with `read_file` though its diff deletes lines, never got the turn and still counted as unread.
- The first message and the tool descriptions offered `read_file` as an equal way to read a cut file, but a read of the head never shows deleted lines.
- The report gave only a count, so nobody could check which files were unread or why.
- A deep review split into as many units as its share paid for. On a 78-file change the narrowed second reviewer ran one conversation over 46 files, which needs more reads than the 40 tool calls one agent may make.
- The sizing below counts 3 characters a token for every model. Once it shipped, one reviewer model still left files unread on both large changes while the other read every file: its tokenizer spent about twice as many tokens on the same first message (13,600 to 15,300 against 6,900 to 8,300), so each of its units ran out of tokens before its reads were done, and the budget that forced its answer also skipped the continuation.

## Decision

- The tool step refuses no call for tokens. It runs the calls and refuses only the outputs that do not fit before the answer call (`toAffordableOutputs`). A conversation with a pool first claims what the outputs lack (`claimFor`). The turn-level rule stays: a turn may read only while two more calls fit.
- No share is held back for the continuation. The whole share pays for reading before the first answer, for the main reviewer and for the rater.
- The continuation turn fires on the files the whole-read test counts as unread (`getUnreadFiles`), the same test the report uses. A finding on a file no longer counts as reading it.
- Each unread file carries a reason: `untouched`, `partial` (part of its diff or of its added lines came back) or `deletions` (`read_file` at the head of a file whose diff deletes lines). The continuation, the agent report (`unreadFiles`), the result file and the review body name each file with its reason.
- The first message, the continuation and the descriptions of `diff` and `read_file` steer each cut file to every part of `diff(path)`.
- The review builds every finder's conversations before it runs them (`FinderService.jobs`). Each main reviewer conversation carries `need`: the tokens to read every page of each cut file's diff, plus 10,000 tokens of context, over at least three turns of at most six reads each (more for a file with more pages), then answer, under the loop's rules with 1,000 output tokens a call (`getReadingTokens`). Where its share is smaller, the review grants the difference and plans that much more, for finders and validation alike (`toSizedJobs`).
- The grant is sized at the estimated rate, so after a granted conversation's first call the loop measures its token rate: the call's real input tokens over the estimate of its first message (`getTokenRate`). At a rate above 1 it adds its grant times the rate less 1 to the conversation's share, so a conversation at twice the estimate gets twice the grant. A rate under 1 adds nothing; no conversation gets less than the sizing granted. The extra comes from the finder tokens left under the cap below, what the plan and the grants did not use (`TokenRoom`), first come first served; what the room gives raises the run's finder total for every finder and for validation. When the room runs out the conversation gets what is left and the run is `capped` with the rest added to what it needed. Each agent report lists its conversations' rates (`tokenRates`). No prompt changes: telling the model to read cut files first was left out because it can cost recall on the files shown whole.
- A deep review also splits into one unit per 60,000 diff characters when that is more units than its share pays for, still at most 8, so each unit can read its cut files within its tool calls.
- The cap is `limits.tokens_per_run`, which was already the hard cap of one run: the finders together plan at most 70% of it, so validation keeps its usual share. When the grants do not fit, each is cut by the same factor, the report records `capped` with what was needed and the cap, and the coverage check adds the gap `cap`, so the run comments and names the cap in its body. The approval rule does not change: every changed file in scope must be received whole.
- The default of `limits.tokens_per_run` rises from 1,500,000 to 2,000,000. Offline replays of the measured deep runs with the engine's own functions and a scripted model that reads every cut file put the largest finder plan at 1,335,130 tokens (a 78-file, 5,270-line change, two reviewer models and six agents); 70% of 2,000,000 is 1,400,000, which covers it with about 5% to spare. The next largest needed about 1,030,000.
- Publishing says what it knows about the pull request: a draft, closed or merged pull request is named as such, and a head read that fails is named as a failed read, never as a draft. Neither gets an approval.

## Consequences

- Large deep reviews cost more. In the replays the 78-file change goes from about 480,000 to 940,000 tokens and the 34-file change from about 430,000 to 545,000; changes whose first messages show every file whole cost the same. Real models also read context, so real runs spend more than the replays.
- More units on large changes shorten each conversation but queue behind `limits.concurrency`; the replays estimate the 78-file run at 150 s instead of 95 s.
- The sizing assumes at least six parallel reads a turn. A model that reads one file a turn still runs out before it finishes and stays unread; the continuation and the unread list show that.
- Balanced runs are sized too, since the same coverage rule decides their approval; a large balanced change plans more than `tokens_by_depth.balanced` up to the same cap.
- Raising `tokens_per_run` raises the hard stop for every run kind, the reply and rater conversations and the per-tick bound of ADR 0009 included. Their own budgets are far below it.
- An answer the token budget forces no longer gets a reserved continuation; the budget is sized so it should not be forced, and the continuation runs only while the budget allows a turn.
- Rejected: more than one continuation turn (each re-sends the whole conversation and the reads it needs belong before the first answer); counting a fully inlined diff as read (it already counts); weakening the whole-read rule for `read_file` (it cannot show deletions); a separate configuration key for the cap (two per-run caps would overlap, and the hard stop must sit above the plan anyway).
- A model whose tokenizer runs over the estimate costs up to its rate times its grant; at about twice the estimate that roughly doubles its granted tokens. The rate is measured on the first call, whose input also holds the tool definitions, so a model at the estimate still measures a little over 1 and takes a little more.
- The room is shared first come first served, so on a change whose plan sits near the cap the conversations that answer their first call first can take what a later one at a higher rate needed; that one stays short and the run reports the cap. A conversation restarted on a fallback model measures and takes again, and what the first attempt took is not given back.
- Follow-up: measure findings, tokens and wall time on the golden bench with real models; the replays only exercise the budget rules.

## Related

- `ARCHITECTURE.md`: Review flow, step 7 (Find)
- `docs/spec.md`: Depth (token budget) and Find
- ADR 0011: the review state carries the verdict
- ADR 0012: the rater, which shares the loop
