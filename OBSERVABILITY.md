# Observability table: how each FIP-0118 action can be observed

For every action in FIP-0118 (by the SWA multisigs, the SRA multisigs, an Orchestrator, or anyone): which
event it writes, what that event leaves out, and where an observer finds the rest. It describes the chain,
not any particular tool: anyone with access to a Filecoin node can use these sources.

Checked against solstice `main` at `0fa8cca` (2026-09-17) and the f02 event table in FIP-0118 §2.4.9
(PR #1286 head `e2e6421`). Claude's reading, not reviewed by an implementer.

## Three sources

1. **Event.** A public note the SWA, the SRA or f02 writes when an action succeeds. A failed action writes
   none (§2.4.9: "Reverted calls emit no event").
2. **Message.** The call itself, as sent to the chain: who sent it, what it asked for, and whether it
   succeeded or failed (with the reason). It is the only trace of a failed action.
3. **Read.** A value an observer looks up (f02 state, a contract view, a wallet balance).

The method: no single source is enough. For every action an observer takes the event, then fills what the
event leaves out from the message or from a read. The last column of each table says which one.

## Why the event alone is not enough (actions that need both multisigs)

Both multisigs send the same call. The three events below are emitted by the contract the call was sent to:
the SWA for an SWA action, the SRA for an SRA action. They carry a code (`taskId`), never the content.

| Step | The event | What the event tells us | What only the message tells us |
|---|---|---|---|
| First multisig sends it | `Submitted`, `Approved` | Something was proposed, and by which multisig. Not what | **What was proposed**: the action and all its values |
| Second multisig sends it | `Approved`, then the action's own event (tables below) | The action happened, or entered its hold | Nothing more: from here the action's own event has the content |
| One multisig cancels it (`veto`) | `Rejected` | A proposal with this code was cancelled, and by which multisig | Which proposal it was: match the code to the first message |

With events alone, a proposal is an unreadable code until it takes effect. With the message, the community
can read it at the first approval.

## SWA multisigs

| Action | The event, and who emits it | What the event leaves out | Where to find it |
|---|---|---|---|
| `RegisterStream`, `RemoveStream`, `SetWeightRecords`, `SetDistribution` | f02: `write-queued`, when the second multisig approves. It carries the whole write and its effective epoch. The write then waits `SWA_TIMELOCK` in f02 | Whether the write later took effect or was dropped: f02 writes no visible event at that moment | Read: the f02 state after the effective epoch |
| `CancelPending`, `CancelPendingWeight` (one multisig is enough) | f02: `write-cancelled` | Nothing | |
| `SetGateParams` | **None.** After both approvals it waits a hold inside the SWA; then anyone sends the same call a third time and it takes effect, with no event | Everything: that it took effect, when, and with which values | Message: the third call, with its values. Read: the SWA's raw storage also holds the values, but no function returns them, and a raw read breaks if an upgrade moves the storage layout |
| `ReplaceOwner` | SWA: `OwnerRemoved`, `OwnerAdded`, `OwnerReplaced` | Nothing | |
| Contract upgrade | SWA: `Upgraded`, with the address of the new code, when it takes effect after the hold (an OpenZeppelin event; not checked against the OpenZeppelin version solstice uses) | That an upgrade is waiting in its hold | Message: the two approvals during the hold |

## SRA multisigs (no hold: the action binds when the second multisig approves)

| Action | The event, and who emits it | What the event leaves out | Where to find it |
|---|---|---|---|
| `AddOrchestrator` | SRA: `OrchestratorAdmitted` (identity and wallet). The initial Orchestrator got the same event when the SRA was deployed | Nothing | |
| `RemoveOrchestrator` | SRA: `OrchestratorRemoved` | That its share-map row was removed and its share now burns (§2.4.4: "removes the row and burns its share"; f099 is never a stored recipient): f02 writes no event for that change. **And whether f02 made the change at all**: the SRA ignores f02's answer, so the event and the successful message appear even when f02 rejected the call | Read: the share map in the f02 state. The row is gone and the remaining shares sum to less than 1 |
| `ReplaceWallet` | SRA: `OrchestratorWalletReplaced` | That the share map now pays the new wallet: no f02 event. **And whether f02 made the change at all**, as for `RemoveOrchestrator` | Read: the share map in the f02 state |
| `ReassignBinding`, `ReassignBindings` | SRA: `BindingReassigned`, one per pair | Nothing | |
| `SetAdmittedLists` | SRA: `AdmittedListsUpdated`, with both full lists | Nothing. But the SRA stores nothing, so **this event is the only record**: the lists cannot be read back from the SRA's state | The event history only. An observer needs a node or an index that still serves the event |
| `SetPricingParams` | SRA: `PricingParamsUpdated`, with all five values | Same: the event is the only record | The event history only |
| `CorrectVolume` | SRA: `VolumeCorrected` | Nothing | |
| `ReplaceOwner`, contract upgrade | As for the SWA, emitted by the SRA | | |

## Orchestrators

| Action | The event, and who emits it | What the event leaves out | Where to find it |
|---|---|---|---|
| `RegisterPairs` | SRA: `BindingDeclared`, one per pair | The epoch the registration applies from | Worked out from the event's epoch and the rules of §2.2 (cutoff, back-cover) |
| `CancelBinding` | SRA: `BindingCanceled` | Nothing | |
| `PostVolume` | SRA: `VolumePosted` | Nothing | |

## Calls anyone can make

| Action | The event, and who emits it | What the event leaves out | Where to find it |
|---|---|---|---|
| `SubmitShares` | SRA: `SharesSubmitted`, with the number of recipients and the USD total. **None at all when the quarter's total is 0** (nobody posted, or every value was corrected to 0): the call succeeds silently | The shares themselves. In the silent case, that the quarter now counts as submitted | Read: the share map in the f02 state. Message: the successful call, in the silent case |
| `QuarterlyGateCheck` | SWA: `QuarterlyGateCheckResult` (quarter, passed or not, steps). On a pass also f02: `write-queued` for the step, which cannot be cancelled | Nothing | |
| `Claim` | f02: `claim-payout`, with recipient and amount. None when the claim pays nothing | That the FIL reached the wallet. And a claim that paid nothing, or failed | Read: the wallet balance just before and just after. Message: the `Claim` call, which is sent to f02 directly, not to the SRA or the SWA |

## What f02 does on its own

| What happens | The event | Where to find it |
|---|---|---|
| A queued write takes effect, or is dropped | `write-applied` / `write-dropped` exist but are not visible on chain when f02 runs them inside a block reward (§2.4.9, until FIP-0107) | Read: the f02 state, compared with the queue |
| The weights in force; the burn | None | Read: the weight records, `total_burn_minted`, the f099 balance |
| Rewards building up for the service stream | None | Read: `accrued`, `total_explicit_minted` |

## Failed actions

A failed action writes no event, so its only trace is the failed message. The chain keeps the reason in the
message's receipt. For an action sent through a multisig, the receipt holds the multisig's own result, so the
reason of the call inside it may need a replay of that call. Examples:
`PostVolume` outside the posting window (`NotInPostingWindow`), a second `SubmitShares`
(`AlreadySubmitted`), cancelling a gate step (`CancelPendingFailed`), a stream with no headroom
(`RegisterStreamFailed`), `RemoveOrchestrator` while a share map is pending (`PendingShares`), a gate check
while a `SetGateParams` or `SetWeightRecords` is outstanding (`PendingGateParams`, `PendingWeightWrite`).

## What no source shows

These leave nothing on chain:

1. An Orchestrator checking its own figure: it happens off chain.
2. A missed posting window: nothing is written. It shows only as the absence of `VolumePosted` for that
   quarter, and a bound value of 0.
3. What the new code of an upgraded contract does: that needs a code review.

## Where the event is weakest

1. `SetGateParams` taking effect: no event at all.
2. `SetAdmittedLists`, `SetPricingParams`: the event is the only record. Nothing in the SRA's state holds
   the lists or the values, so they exist only in the event history.
3. `SubmitShares` when the quarter's total is 0: no event.
4. Share map changes in f02 (`SubmitShares`, `RemoveOrchestrator`, `ReplaceWallet`): no f02 event.
5. `RemoveOrchestrator` and `ReplaceWallet`: the SRA event says "removed" or "replaced" even when f02 rejected its
   half. f02 rejects when the old wallet is not in the stored share map (normal for an Orchestrator that never
   got a share), when the new wallet is already in the map, or when an address does not resolve to an existing
   actor (§2.4.4). Only a share map read shows whether f02 changed.
