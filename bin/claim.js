#!/usr/bin/env node
// Daily Claim keeper: once a day, sends f02 `Claim(id, wallets)` for every wallet f02 owes something to. The wallets
// are read from the f02 state: the share map and payable rows of each live stream, the payable rows of each tombstone.
// Each batch is simulated first (Filecoin.StateCall returns the amounts); a batch that would pay nothing is not sent.
// Claim is permissionless and the FIL always goes to the wallet in the map (FIP-0118 §2.4.5), so this key only pays
// gas. It must be an f1 account (an f410 account cannot send a native f02 message): repository secret CLAIM_KEY, whose
// address must match cfg.wallets["claimer (watchtower backup)"]; without the secret the run is a dry run.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import * as dagCbor from '@ipld/dag-cbor'
import { RPC } from 'iso-filecoin/rpc'
import { Message } from 'iso-filecoin/message'
import { accountFromPrivateKey, signMessage } from 'iso-filecoin/wallet'
import { fromString } from 'iso-filecoin/address'
import { makeRpc } from '../lib/chain.js'
import { decodeStreamsState, bigFromBytes } from '../site/lib/f02.js'

const cfg = JSON.parse(readFileSync(process.argv[2] ?? 'config/calibnet.json', 'utf8'))
const CLAIM = 4045527845 // f02 method number of Claim (FRC-0042), as in bin/reader.js
const DAY_MS = 24 * 3600 * 1000
const claimer = cfg.wallets?.['claimer (watchtower backup)']
const network = cfg.network === 'mainnet' ? 'mainnet' : 'testnet'
const key = process.env.CLAIM_KEY?.replace(/^0x/, '')
const account = key ? accountFromPrivateKey(Buffer.from(key, 'hex'), 'SECP256K1', network) : null
if (account && account.address.toString() !== claimer) throw new Error(`CLAIM_KEY is the key of ${account.address}, not of the configured claimer ${claimer}`)
const statePath = join(cfg.dataDir, 'claim.json')
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}
if (state.lastRun && Date.now() - Date.parse(state.lastRun) < DAY_MS && !process.argv.includes('--now')) { console.log(`claim: last run ${state.lastRun}, once a day`); process.exit(0) }

const rpc = makeRpc(cfg.rpcUrl)
const { State } = await rpc('Filecoin.StateReadState', [cfg.f02, null])
const root = Object.values(State).find((v) => v && typeof v === 'object' && '/' in v)?.['/']
if (!root) { console.log(`${cfg.network} claim: f02 has no stream state yet (before activation)`); process.exit(0) }
const st = decodeStreamsState(Buffer.from(await rpc('Filecoin.ChainReadObj', [{ '/': root }]), 'base64'), cfg.addressPrefix)
const wallets = (rows) => [...new Set(rows.map((r) => r.recipient))]
const batches = [
  ...st.streams.filter((s) => s.distribution).map((s) => ({ id: s.id, wallets: wallets([...s.distribution.shares, ...s.distribution.payable]) })),
  ...st.tombstones.map((t) => ({ id: t.id, wallets: wallets(t.payable) })),
].filter((b) => b.wallets.length)
console.log(`${cfg.network} claim · ${batches.length} stream(s) with wallets · ${account ? 'key ' + claimer : 'DRY RUN, no key'}`)

const fil = (atto) => (Number(atto / 10n ** 14n) / 10_000).toFixed(4)
const iso = new RPC({ api: cfg.rpcUrl, network })
const sent = []
for (const b of batches) {
  const params = Buffer.from(dagCbor.encode([b.id, b.wallets.map((w) => fromString(w).toBytes())])).toString('base64')
  const msg = { Version: 0, To: cfg.f02, From: claimer, Nonce: 0, Value: '0', GasLimit: 0, GasFeeCap: '0', GasPremium: '0', Method: CLAIM, Params: params }
  const { MsgRct } = await rpc('Filecoin.StateCall', [msg, null])
  if (MsgRct.ExitCode !== 0) { console.log(`claim(${b.id}): simulation exit code ${MsgRct.ExitCode}, not sent`); continue }
  const amounts = dagCbor.decode(Buffer.from(MsgRct.Return, 'base64'))[0].map(bigFromBytes) // the return is a one-field tuple holding amounts[]
  const due = b.wallets.map((w, i) => `${w} ${fil(amounts[i])} FIL`).filter((_, i) => amounts[i] > 0n)
  if (!due.length) { console.log(`claim(${b.id}): nothing to pay for ${b.wallets.join(', ')}`); continue }
  console.log(`claim(${b.id}): due ${due.join(', ')}`)
  if (!account) continue
  const m = await new Message({ to: cfg.f02, from: claimer, value: '0', method: CLAIM, params }).prepare(iso)
  const res = await iso.pushMessage({ msg: m, signature: signMessage(account.privateKey, 'SECP256K1', m) })
  if (res.error) throw res.error
  console.log(`claim(${b.id}): sent ${res.result['/']}`)
  sent.push({ id: b.id, cid: res.result['/'], due })
}
writeFileSync(statePath, JSON.stringify({ lastRun: new Date().toISOString(), sent }, null, 2))
