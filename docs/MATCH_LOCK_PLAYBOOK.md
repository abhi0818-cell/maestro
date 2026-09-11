# Match Lock / Delay / Abandon — Admin Playbook

_Written: August 2026. Covers the toss → delay → restart / abandon decision tree for
the admin Schedule tab, and how it interacts with SL squad locking (`lock-matches`),
daily teams, transfers, and boosters._

## The one rule everything else follows

**Once a match's lock gate fires, there is no recourse.** `lock-matches` runs every
minute; the instant `effectiveLockTime(m)` (`lock_time ?? start_time`) is in the past,
it locks every SL squad's XI, logs transfers, reconciles boosters, and flips the match
to `live`. Nothing in the admin panel reverses that cleanly:

- **Revert Lock** deletes the locked `user_match_xi` rows (all squads, blanket, not
  per-squad) so editing reopens — it does **not** restore a prior team, and does
  **not** touch `user_transfers` or `user_booster_activations`. Whatever was spent
  stays spent.
- **Revert Daily Lock** only clears the "Locked" badge (cosmetic). The actual RLS
  gate still checks `lock_time`/`start_time`, so it does nothing by itself.
- Nothing anywhere reconciles boosters after the fact, ever.

So the entire strategy below is built around **never letting the gate fire while a
match's status is still in doubt.** Every scenario is really the same question asked
at a different moment: *is lock_time still safely in the future, yes or no?*

## The state model, in one picture

```
status:      scheduled ──────► delayed ──────► live ──────► completed
                 │                 │                            ▲
                 │                 └──(revert)──► scheduled     │
                 │                                               │
                 └──────────────────► abandoned ◄─────────────────
                                    (also reachable from delayed)
```

Gate (`effectiveLockTime`):
- `scheduled` → gate = `lock_time ?? start_time`
- `delayed` **with** `lock_time` set → gate = `lock_time`
- `delayed` **without** `lock_time` set → **no gate at all** (never auto-locks —
  see Trap 1 below)
- `abandoned` / `cancelled` / `completed` → excluded from gating entirely, excluded
  from "next match" resolution, excluded from history/leaderboards

`lock-matches` only queries two buckets: `status IN ('scheduled','in_progress') AND
start_time <= now`, or `status = 'delayed' AND lock_time IS NOT NULL AND lock_time <=
now`. A `delayed` match with a null `lock_time` matches neither query — it will sit
untouched indefinitely.

---

## Scenario 1 — Toss delayed, new start time known, well ahead of lock_time

**Situation:** Rain/covers, but the broadcaster/officials have announced a firm
restart time, and it's comfortably before the current `lock_time`.

**Action:** None required. The gate hasn't moved and doesn't need to — the match
will lock at the original time as scheduled. Optionally mark it `delayed` for
visibility on the admin board, but there's no functional need to.

---

## Scenario 2 — Toss delayed, new start time known, but it's past the current lock_time

**Situation:** The real restart is later than what's currently set as the lock gate.
If you do nothing, the gate fires at the old time and locks squads into XIs picked
before anyone knew about the delay.

**Action (must happen before the old gate fires):**
1. Click 🌧 Delay if not already delayed (auto-promotes `scheduled` → `delayed` the
   first time a lock_time changes too, so this step is sometimes automatic).
2. Set the lock gate to the real new time: the **+15m/+30m** buttons always push
   `lock_time` forward now (from `lock_time` if already set, otherwise from
   `start_time` as the base) — repeat as needed, or type an exact value into the
   `lock_time` field directly. (Previously, on a match with no `lock_time` yet,
   +15/+30 silently pushed `start_time` instead and left `lock_time` null — see
   the historical note under Trap 1 below. Fixed as of Aug 2026.)
3. Confirm the badge still reads 🌧 Delayed with a `lock_time` populated (check the
   raw field, not just the badge) before walking away.

**Outcome:** No squads/daily teams touched. Users keep editing normally until the
new gate.

---

## Scenario 3 — Toss delayed, no restart time known yet (open-ended)

**Situation:** Ground's underwater, no ETA. You don't have a real time to set.

**Action:** Mark it `delayed` and push `lock_time` (or set it manually) far enough
out to be safe — e.g., a few hours ahead, or to the last realistic cutoff for that
match format — then revisit and push again as the picture clarifies. Repeat
Scenario 2's mechanics each time new information arrives. This is safe indefinitely
as long as you keep the gate ahead of "now."

The one thing to avoid: setting `delayed` with **no** `lock_time` at all and assuming
that's "safe by default." It is safe (no gate = never locks), but it also means the
match will never lock on its own even once play resumes — you must eventually set a
real `lock_time` yourself, or it stays open forever and squads never get scored.

---

## Scenario 4 — You catch the delay too late, gate has already passed

**Situation:** `lock-matches` already ran — status is `live`, XIs are locked,
transfers/boosters processed — before you had a chance to push the time.

**Action:** Per the base rule, there's no clean recourse. Your only lever is
Revert Lock (reopens editing) + Revert Daily Lock + pushing `lock_time` forward so
the match can lock again *correctly* later. This does **not** undo the transfers or
boosters already recorded from the bad lock — those are sunk. If the match relocks
again later (once the pushed `lock_time` passes), `lock-matches` will recompute and
overwrite `user_transfers` for that squad+match fresh — so transfers can end up
correct after a second real lock, but boosters never get reconciled regardless.

**Practical takeaway:** treat this purely as damage control, not a fix. Communicate
to affected users if the discrepancy matters (e.g., a booster burned on a team that
then got the chance to re-pick).

---

## Scenario 5 — Match called off entirely, before lock_time

**Situation:** Abandoned/no play possible, and the gate hasn't fired yet.

**Action:** Click 🚫 Abandon. Confirm.

**Outcome:** Clean. `status = 'abandoned'` — excluded from `isMatchOver`-gated logic
everywhere (web and mobile both), so no squad ever locks into it, and any user
currently viewing it is automatically pointed at the next scheduled match
(`findNextScheduledMatch` / `findNextUnlockedMatch`). Nothing was ever spent, so
there's nothing to preserve or revert — the match simply never entered the lock
pipeline. It also never appears in history/leaderboards (fails `isMatchPlayed()`),
consistent with never being scored.

---

## Scenario 6 — Match called off entirely, after lock_time

**Situation:** Squads already locked in before the abandonment became clear.

**Action:** Click 🚫 Abandon anyway once you know it's not resuming — it stops the
match from ever locking again and rolls users forward for their *next* pick.

**Outcome:** Per the base rule, this does **not** unwind what already happened.
Locked XIs, spent transfers, and active boosters for that match stay exactly as
recorded. Because the match never reaches `completed`, it's never finalized (no
`player_match_stats`), so it contributes 0 points — but it also disappears from
history/leaderboard views entirely (`isMatchPlayed()` excludes `abandoned`), so a
squad can have a transfer/booster consumed on a match that then vanishes from their
visible history. There is no admin UI action that reconciles this; it would need a
manual database fix if it matters enough to correct.

---

## Scenario 7 — Real-world abandoned match reported by CricAPI (not the admin button)

**Situation:** This is a distinct code path from Scenarios 5/6 and easy to confuse
with them. When CricAPI itself reports a match result as abandoned/no-result/tied/
drawn/etc., `cricStatusToOurs()` maps that text straight to internal
**`status: 'completed'`** — not `'abandoned'`. This is the normal "match finished,
go score it" path: Finalize/Recalc becomes available, and whatever partial
scorecard data exists (e.g., a D/L-adjusted result, or partial-innings stats) gets
scored through the regular pipeline.

**Implication:** if you're relying on "abandoned = never scores," that's only true
for the manual 🚫 Abandon button. A real-world abandoned match that CricAPI reports
with a result will still get finalized and will still count partial points. Don't
manually hit Abandon on a match CricAPI has already resolved to `completed` — that
would suppress legitimate scoring; use Abandon only for matches you're taking out of
the pipeline entirely (no result, no data, not worth tracking).

---

## Scenario 8 — Delay resolved, match restarts and locks normally

**Situation:** You worked Scenario 2/3 correctly — `delayed` with a real `lock_time`
set ahead of the actual restart.

**Action:** None. `lock-matches` picks it up on its normal 1-minute tick once
`lock_time` passes, locks every SL squad against whatever's currently in their
`squad_draft_xi`, logs transfers against the correct baseline, flips status to
`live`. This is the fully-intended path — everything upstream of this document
exists to make sure matches land here instead of Scenario 4 or 6.

---

## Traps to remember

**Trap 1 — "Delayed" with no `lock_time` has no gate at all.** Not "gate pushed to
start_time," not "locks eventually" — it simply never locks until someone sets a
real `lock_time`. Historical note: before Aug 2026, the +15/+30 buttons would not
create one for you if it didn't already exist — they pushed `start_time` instead in
that case, silently, which combined with this trap to make a freshly-pushed match
show "no lock gate set." Both the mobile admin screen and the web admin panel now
have +15/+30 always write `lock_time`, so this can no longer happen via those
buttons — it can still happen if a match is manually marked `delayed` (via the
🌧 Delay toggle or a direct status edit) without ever setting `lock_time` at all.

**Trap 2 — the push buttons disappear once locked.** `canPush` excludes `live`/
`in_progress`/`completed`/`abandoned`/`cancelled`. Once the gate fires and status
flips to `live`, you're already in Scenario 4 territory — there's no more pushing,
only reverting.

**Trap 3 — cron runs on a 1-minute tick, not instantly.** Build in buffer. Pushing
the gate at the literal minute it's about to fire is a coin flip against the cron.

**Trap 4 — Revert Lock is blanket, not per-squad.** It deletes locked XIs for
*every* squad on that match, not just one you're troubleshooting.

**Trap 5 — Abandoned matches vanish from history even if they were locked.**
`isMatchPlayed()` only counts `completed`/`in_progress`/`live`. A squad that had a
transfer/booster consumed on a match that later gets abandoned will not see that
match in their match-by-match breakdown at all — the spend is invisible, not just
unscored.

---

## Quick-reference

| Situation | Gate status | Safe action | Recourse if missed |
|---|---|---|---|
| Restart known, before old lock | not yet fired | usually none needed | — |
| Restart known, later than old lock | not yet fired | Delay + push/set `lock_time` to new time | — |
| No restart time yet | not yet fired | Delay, push `lock_time` out repeatedly, must eventually set a real one | — |
| Discovered after gate fired | already fired | Revert Lock + Revert Daily Lock + push `lock_time` forward | Transfers may self-correct on next real lock; boosters never do |
| Called off, before gate | not yet fired | Abandon | — (nothing was ever spent) |
| Called off, after gate | already fired | Abandon (stops further damage only) | None — locked spend is sunk, match drops from history |
| CricAPI reports a real abandoned/no-result match | N/A — maps to `completed` | Let it finalize normally | N/A, this is normal scoring |

---

## Planned — not yet built

### Actionable toss-delay confirmation (tap-to-app-screen)

**Problem today:** when `check-toss` flags a match `delay_flagged` (Scenario 2/3
territory, T-10 decision point), the admin gets a push notification, but it's purely
informational. The admin still has to open the app, find the match on the Schedule
tab, and manually work through Scenario 2/3's steps (Delay + push/set `lock_time`) —
or decide to let it lock at the scheduled time as-is.

**Goal:** turn that notification into a decision, not just information — effectively
a **Yes (push the lock back ~10 min) / No (lock at the scheduled time)** choice,
answerable from the notification itself.

**Chosen approach:** tap-to-open-app-to-a-confirm-screen — **not** native OS
notification action buttons. Native action buttons need to run their handler in the
background, including when the app has been fully killed (not just backgrounded);
Expo push (what `send-push-notification` already uses) can't guarantee that reliably.
A single admin tapping through to a small in-app confirm screen is slower by a second
or two but actually works every time, which matters a lot more given the "no
recourse once the gate fires" rule this whole playbook is built around.

**Depends on:** the `cricbuzz_status` / `cricketaddictor_status` observational
columns on `matches` (migration `v67_source_status_signals`, shipped in check-toss
v16, 2026-09-09). These give two independent per-source signals of what's actually
happening with a match (Preview/Toss/In Progress/Complete from Cricbuzz;
SCHEDULED/LIVE/COMPLETED from CricketAddictor) without either one driving
`matches.status` directly. The idea is that once those signals reliably line up
with each other (e.g. both sources agree the match hasn't actually started), the
admin can trust the "delay" read enough to act on a single tap instead of
cross-checking multiple apps/sites by hand.

**Not yet built — pieces needed later:**
- A new edge function (e.g. `resolve-toss-delay`) taking `matchId` + an
  `action` of `'push_delay' | 'lock_now'`, reusing `send-push-notification`'s
  existing admin-auth pattern (session JWT checked against `ADMIN_EMAIL`, since this
  is an admin-initiated write, not a system one).
  - `push_delay` would do what Scenario 2 does today by hand: ensure `status =
    'delayed'`, push `lock_time` forward (e.g. +10m from now, or from the current
    `lock_time`/`start_time` base per the existing +15/+30 convention).
  - `lock_now` would simply be a no-op / acknowledgement — let the existing gate
    fire at the scheduled time as normal.
- A small in-app confirm screen the notification deep-links into, showing the match,
  the current signals (Cricbuzz/CricketAddictor status + toss info if any), and the
  two action buttons.
- Deep-linking wired off the `data: {matchId, kind: 'toss_delay'}` payload that
  `check-toss`'s `notifyAdmin()` already attaches to every `toss_delay` notification
  today — no changes needed on the sending side for this part, the hook point
  already exists.

**Explicitly out of scope for this phase:** no automatic/unattended action —  a
human still taps Yes or No. Full automation (acting on the signals with no admin tap
at all) is a further-out idea and not part of this plan.
