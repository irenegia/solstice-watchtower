#!/usr/bin/env node
// Writes site/data/sample/: a SAMPLE record to look at the page before the contracts are on calibnet.
// Nothing here is chain data. Every record is built as a raw input and then passed through the real decoders,
// so the page shows exactly what the reader would write. Epochs are placed around "now" so time left is visible.
// Usage: npm run sample
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import * as dagCbor from '@ipld/dag-cbor'
import { encodeFunctionData, encodeErrorResult } from 'viem'
import { epochToTime, quarterOf } from '../lib/chain.js'
import { decodeActorEvent, decodeStreamsState } from '../site/lib/f02.js'
import { abi, decodeLog, decodeCall, decodeRevert } from '../lib/evm.js'
import { PCT, entry, idAddress, tokenBytes, flat, sampleLog } from '../tests/samples.js'

const base = JSON.parse(readFileSync('config/calibnet.json', 'utf8'))
const now = Math.floor((Date.now() / 1000 - base.genesisTimestamp) / base.epochSeconds)
const cfg = { ...base, activationEpoch: now - 7 * base.epochsPerQuarter - 1500 } // we are 12.5 hours into quarter 8
const USD = 10n ** 18n
const A = '0x97A90f5696be5E3C8d3752C92Adac287c2b4484e' // Orchestrator A identity (deployments.json initialOrchestrator)
const A_WALLET = '0x00000000000000000000000000000000000a11e7' // made-up payout wallet
const SRA = '0x00000000000000000000000000000000005a5a5a' // made-up contract addresses
const SWA = '0x00000000000000000000000000000000005b5b5b'
const ZERO = '0x0000000000000000000000000000000000000000'
const fakeTx = (n) => '0x' + n.toString(16).padStart(64, '0')

const records = []
const rec = (kind, epoch, source, name, fields, extra = {}) =>
  records.push({ kind, epoch, time: epochToTime(cfg, epoch), quarter: quarterOf(cfg, epoch), source, name, fields, ...extra })
let n = 0
const event = (epoch, source, eventName, args) => rec('event', epoch, source, ...Object.values(decodeLog(sampleLog(eventName, args))), { tx: fakeTx(++n) })
const f02event = (epoch, entries) => rec('event', epoch, 'f02', ...Object.values(decodeActorEvent({ entries }, 't')), { msgCid: 'bafy2bzaceSAMPLE' + ++n })
function message(epoch, source, from, functionName, args, { error, safe } = {}) {
  let input = encodeFunctionData({ abi, functionName, args })
  if (safe) input = encodeFunctionData({ abi, functionName: 'execTransaction', args: [source === 'SRA' ? SRA : SWA, 0n, input, 0, 0n, 0n, 0n, ZERO, ZERO, '0x'] })
  const call = decodeCall(input)
  rec('message', epoch, source, call.name, call.fields, { from, via: safe, ok: !error, error: error && decodeRevert(encodeErrorResult({ abi, ...error })), tx: fakeTx(++n) })
}

// quarter 7, yesterday: the plan's "Q6 cycle" ends with a pass
const y = now - 1500 - 1000
message(y, 'SRA', A, 'submitShares', [6n])
event(y, 'SRA', 'SharesSubmitted', { q: 6n, recipientCount: 1n, totalUsd: 4100n * USD })
message(y + 1, 'SWA', A, 'quarterlyGateCheck', [])
event(y + 1, 'SWA', 'QuarterlyGateCheckResult', { quarter: 6n, passed: true, steps: 4n })

// quarter 8, today: the plan's "Q7 cycle"
const q8 = now - 1500
message(q8, 'SRA', A, 'postVolume', [7n, 5200n * USD])
event(q8, 'SRA', 'VolumePosted', { q: 7n, orchestrator: A, volume: 5200n * USD })
message(q8 + 30, 'SRA', A_WALLET, 'postVolume', [7n, 1n * USD], { error: { errorName: 'NotAdmitted', args: [A_WALLET] } })
const correct = ['correctVolume', [A, 7n, 4900n * USD]]
const taskId = '0x' + '7a'.repeat(32)
message(q8 + 300, 'SRA', '0x1111111111111111111111111111111111111111', ...correct, { safe: 'sraOwner1' })
event(q8 + 300, 'SRA', 'Submitted', { taskId })
event(q8 + 300, 'SRA', 'Approved', { taskId, owner: base.owners.sraOwner1 })
message(q8 + 330, 'SRA', '0x2222222222222222222222222222222222222222', ...correct, { safe: 'sraOwner2' })
event(q8 + 330, 'SRA', 'Approved', { taskId, owner: base.owners.sraOwner2 })
event(q8 + 330, 'SRA', 'VolumeCorrected', { q: 7n, orchestrator: A, volume: 4900n * USD })

// a discretionary write that was queued and then cancelled inside the window
f02event(now - 900, [entry('$type', 'write-queued'), entry('op', 4), entry('effective-epoch', now - 180), entry('stream-id', 2), entry('payload', dagCbor.encode([idAddress(5001)]))])
message(now - 850, 'SWA', '0x3333333333333333333333333333333333333333', 'cancelPending', [2n, 4], { safe: 'swaOwner1' })
f02event(now - 850, [entry('$type', 'write-cancelled'), entry('op', 4), entry('effective-epoch', now - 180), entry('stream-id', 2)])

// the gate passes: a StepWeightRecords write queues for SWA_TIMELOCK and cannot be cancelled
// StreamWeightActor.sol:129-136: next = (steps + 3) * 5%, tStart = quarterStart(checked quarter); here steps 4 -> 35%, Start(7)
const step = dagCbor.encode([[[2, flat(35n, cfg.activationEpoch + 6 * cfg.epochsPerQuarter)]]])
message(now - 401, 'SRA', A, 'submitShares', [7n])
event(now - 401, 'SRA', 'SharesSubmitted', { q: 7n, recipientCount: 1n, totalUsd: 4900n * USD })
message(now - 400, 'SWA', A, 'quarterlyGateCheck', [])
event(now - 400, 'SWA', 'QuarterlyGateCheckResult', { quarter: 7n, passed: true, steps: 5n })
f02event(now - 400, [entry('$type', 'write-queued'), entry('op', 1), entry('effective-epoch', now - 400 + cfg.swaTimelockEpochs), entry('payload', step)])
message(now - 380, 'SWA', '0x3333333333333333333333333333333333333333', 'cancelPendingWeight', [1], { safe: 'swaOwner1', error: { errorName: 'CancelPendingFailed', args: [16n] } })

// a Claim, and its balance check
f02event(now - 300, [entry('$type', 'claim-payout'), entry('stream-id', 2), entry('recipient', 1234), entry('amount', tokenBytes(125n * 10n ** 17n))])
rec('read', now - 299, 'f02', 'claim check', { recipient: 't01234', amountAttoFil: '12500000000000000000', balanceBefore: '100000000000000000000', balanceAfter: '112500000000000000000', difference: '12500000000000000000', matches: true })

// a new stream, approved by both SWA multisigs, queued in f02
const newStream = [flat(3n, now + 520), [idAddress(5002), [[idAddress(7001), 10n ** 18n]]]]
const register = ['registerStream', [3n, { vStart: 3n * PCT, slope: 0n, tStart: BigInt(now + 520), floor: 3n * PCT, cap: 3n * PCT }, '0x00000000000000000000000000000000000057a3', [{ wallet: '0x00000000000000000000000000000000000071de', share: 10n ** 18n }], BigInt(now + 520)]]
message(now - 210, 'SWA', '0x3333333333333333333333333333333333333333', ...register, { safe: 'swaOwner1' })
message(now - 200, 'SWA', '0x4444444444444444444444444444444444444444', ...register, { safe: 'swaOwner2' })
f02event(now - 200, [entry('$type', 'write-queued'), entry('op', 2), entry('effective-epoch', now + 520), entry('stream-id', 3), entry('payload', dagCbor.encode(newStream))])

// reads
const streams = dagCbor.encode([
  [[1, [90n * PCT, -(40n * PCT) / BigInt(9 * cfg.epochsPerQuarter), cfg.activationEpoch, 50n * PCT, 90n * PCT], null],
    [2, flat(30n, cfg.activationEpoch + 5 * cfg.epochsPerQuarter), [idAddress(5000), [[idAddress(1234), 10n ** 18n]], [], []]]],
  [],
  [[null, 1, step, now - 400 + cfg.swaTimelockEpochs], [3, 2, dagCbor.encode(newStream), now + 520]],
])
rec('read', now - 6, 'f02', 'f02 streams', decodeStreamsState(streams, 't'))
rec('read', now - 6, 'f02', 'f02 state', { total_minted_reward: '109786514820930607405928998', total_burn_minted: '2113400000000000000000', total_explicit_minted: '901200000000000000000', swa_timelock_epochs: cfg.swaTimelockEpochs, accrued: [{ id: 2, amount: '18400000000000000000' }] })
rec('read', now - 6, 'balance', 'balance of f099 (burn)', { address: base.wallets['f099 (burn)'], attoFil: '48711161763076331835419171' })
rec('read', now - 6, 'SRA', 'SRA aggregatedFilecoinPayVolume(7)', { usd: '4900000000000000000000' })
rec('read', now - 6, 'SRA', 'SRA aggregatedFilecoinPayVolume(8)', { reverted: decodeRevert(encodeErrorResult({ abi, errorName: 'NotBound', args: [8n] })) })
rec('read', now - 6, 'SRA', 'SRA admittedCount', { result: '1' })

records.sort((a, b) => a.epoch - b.epoch)
mkdirSync('site/data/sample', { recursive: true })
writeFileSync('site/data/sample/records.jsonl', records.map((r) => JSON.stringify(r)).join('\n') + '\n')
const { genesisTimestamp, epochSeconds, activationEpoch, epochsPerQuarter, swaTimelockEpochs } = cfg
writeFileSync('site/data/sample/status.json', JSON.stringify({ network: 'SAMPLE', genesisTimestamp, epochSeconds, activationEpoch, epochsPerQuarter, swaTimelockEpochs, lastEpoch: now - 6, lastRun: new Date().toISOString() }, null, 2))
console.log(`${records.length} sample records -> site/data/sample/`)
