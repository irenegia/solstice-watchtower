// Every input in this file is a SAMPLE written by hand from FIP-0118 §2.4.2 / §2.4.9 and the solstice
// Solidity sources. None of it is chain data. Run with: npm test
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as dagCbor from '@ipld/dag-cbor'
import { encodeFunctionData, encodeErrorResult } from 'viem'
import { quarterOf, epochToTime } from '../lib/chain.js'
import { decodeActorEvent, decodeStreamsState, computeWeight, bigFromBytes, idToEthAddress } from '../site/lib/f02.js'
import { abi, decodeLog, decodeCall, decodeRevert } from '../lib/evm.js'
import { PCT, entry, idAddress, tokenBytes, flat, sampleLog } from './samples.js'

const cfg = JSON.parse(readFileSync(new URL('../config/calibnet.json', import.meta.url), 'utf8'))
const stepTo15 = dagCbor.encode([[[2, flat(15n, 4100000)]]]) // payload of a StepWeightRecords write: stream 2 to 15%

test('quarter numbers follow Start(Q) = ACTIVATION_EPOCH + (Q-1) * EPOCHS_PER_QUARTER', () => {
  const c = { activationEpoch: 1000, epochsPerQuarter: 2880 }
  assert.equal(quarterOf(c, 999), 0) // before activation
  assert.equal(quarterOf(c, 1000), 1) // Start(1) is the activation epoch
  assert.equal(quarterOf(c, 1000 + 2879), 1) // last epoch of quarter 1
  assert.equal(quarterOf(c, 1000 + 2880), 2) // Start(2)
  assert.equal(quarterOf({ activationEpoch: 0, epochsPerQuarter: 2880 }, 5000), 0) // activation epoch not chosen yet
  // real calibnet block 0x3e3578 (epoch 4076920) carries timestamp 0x6aaba5bc: checks genesisTimestamp in the config
  assert.equal(epochToTime(cfg, 0x3e3578), new Date(0x6aaba5bc * 1000).toISOString())
})

test('f02 event: write-queued for a gate step', () => {
  const ev = { entries: [entry('$type', 'write-queued'), entry('op', 1), entry('effective-epoch', 4100720), entry('payload', stepTo15)] }
  assert.deepEqual(decodeActorEvent(ev, 't'), {
    name: 'write-queued',
    fields: {
      op: 'StepWeightRecords',
      cancellable: false,
      effectiveEpoch: 4100720,
      payload: { updates: [{ id: 2, record: { vStart: '150000000000000000', slope: '0', tStart: 4100000, floor: '150000000000000000', cap: '150000000000000000' } }] },
    },
  })
})

test('f02 event: write-cancelled for a stream op carries the stream id and no payload', () => {
  const ev = { entries: [entry('$type', 'write-cancelled'), entry('op', 3), entry('effective-epoch', 4100720), entry('stream-id', 7)] }
  assert.deepEqual(decodeActorEvent(ev, 't'), { name: 'write-cancelled', fields: { op: 'RemoveStream', cancellable: true, effectiveEpoch: 4100720, streamId: 7 } })
})

test('f02 event: claim-payout', () => {
  const ev = { entries: [entry('$type', 'claim-payout'), entry('stream-id', 2), entry('recipient', 1234), entry('amount', tokenBytes(5n * 10n ** 18n))] }
  assert.deepEqual(decodeActorEvent(ev, 't'), { name: 'claim-payout', fields: { streamId: 2, recipient: 't01234', amountAttoFil: '5000000000000000000' } })
})

test('f02 state behind streams_root', () => {
  const service = [2, flat(10n, 4000000), [idAddress(5000), [[idAddress(1234), 10n ** 18n]], [[idAddress(1234), tokenBytes(7n)]], []]]
  const state = decodeStreamsState(dagCbor.encode([[[1, flat(90n, 4000000), null], service], [], [[null, 1, stepTo15, 4100720]]]), 't')
  assert.equal(state.streams[0].distribution, null) // consensus stream: IMPLICIT, nothing stored
  assert.deepEqual(state.streams[1].distribution, {
    writer: 't05000',
    shares: [{ recipient: 't01234', share: '1000000000000000000' }],
    payable: [{ recipient: 't01234', amountAttoFil: '7' }],
    claimedPeriod: [],
  })
  assert.equal(state.pendingWrites[0].op, 'StepWeightRecords')
  assert.equal(state.pendingWrites[0].streamId, null) // schedule-wide op
  assert.equal(state.pendingWrites[0].payload.updates[0].record.cap, '150000000000000000')
})

test('ComputeWeight clamps: the Q1 ramp from 5% to 10%', () => {
  const ramp = { vStart: (5n * PCT).toString(), slope: ((5n * PCT) / 2880n).toString(), tStart: 1000, floor: (5n * PCT).toString(), cap: (10n * PCT).toString() }
  assert.equal(computeWeight(ramp, 900), 5n * PCT) // before t_start: clamps at the band edge
  assert.equal(computeWeight(ramp, 1000), 5n * PCT)
  assert.equal(computeWeight(ramp, 1000 + 1440) / PCT, 7n) // half way: about 7.5%
  assert.equal(computeWeight(ramp, 99999), 10n * PCT) // rests at the cap
})

test('byte helpers', () => {
  assert.equal(bigFromBytes(new Uint8Array()), 0n)
  assert.equal(bigFromBytes(Uint8Array.from([1, 1, 0])), -256n)
  assert.equal(idToEthAddress(99), cfg.wallets['f099 (burn)'])
})

test('contract event: VolumePosted', () => {
  const orch = '0x97A90f5696be5E3C8d3752C92Adac287c2b4484e'
  const log = sampleLog('VolumePosted', { q: 6n, orchestrator: orch, volume: 4200n * 10n ** 18n })
  assert.deepEqual(decodeLog(log),{ name: 'VolumePosted', fields: { q: '6', orchestrator: orch, volume: '4200000000000000000000' } })
  assert.equal(decodeLog({ topics: ['0x' + 'ab'.repeat(32)], data: '0x' }).name, 'unknown(0xabababab)')
})

test('message: a direct call, and the same call sent through a Safe', () => {
  const input = encodeFunctionData({ abi, functionName: 'postVolume', args: [6n, 123n] })
  assert.deepEqual(decodeCall(input), { name: 'postVolume', fields: { q: '6', fpv: '123' } })

  const sra = '0x00000000000000000000000000000000000000aa'
  const zero = '0x0000000000000000000000000000000000000000'
  const viaSafe = encodeFunctionData({ abi, functionName: 'execTransaction', args: [sra, 0n, input, 0, 0n, 0n, 0n, zero, zero, '0x'] })
  const call = decodeCall(viaSafe)
  assert.equal(call.name, 'postVolume')
  assert.equal(call.innerTo, sra)
  assert.equal(call.innerData, input)
})

test('message: registerStream has two forms', () => {
  const record = { vStart: 1n, slope: 0n, tStart: 5n, floor: 1n, cap: 1n }
  const short = decodeCall(encodeFunctionData({ abi, functionName: 'registerStream', args: [9n, record, 4100720n] }))
  assert.deepEqual(Object.keys(short.fields), ['id', 'record', 'activationEpoch'])
  const long = decodeCall(encodeFunctionData({ abi, functionName: 'registerStream', args: [9n, record, '0x00000000000000000000000000000000000000aa', [], 4100720n] }))
  assert.deepEqual(Object.keys(long.fields), ['id', 'record', 'writer', 'shares', 'activationEpoch'])
})

test('revert reasons', () => {
  assert.equal(decodeRevert(encodeErrorResult({ abi, errorName: 'NotInPostingWindow', args: [6n] })), 'NotInPostingWindow(6)')
  assert.equal(decodeRevert(encodeErrorResult({ abi, errorName: 'StepsComplete' })), 'StepsComplete()')
  assert.equal(decodeRevert('0xdeadbeef'), 'unknown error 0xdeadbeef')
  assert.equal(decodeRevert(undefined), 'reverted (no reason given)')
})
