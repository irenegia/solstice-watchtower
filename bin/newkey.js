#!/usr/bin/env node
// Prints a fresh f1 (secp256k1) account for the Claim step: the address, and the private key as hex for the
// CLAIM_KEY repo secret. Run it yourself in your own terminal: the key must not pass through anyone else.
import { create } from 'iso-filecoin/wallet'
const a = create('SECP256K1', process.argv[2] === 'mainnet' ? 'mainnet' : 'testnet')
console.log(`address   ${a.address.toString()}`)
console.log(`CLAIM_KEY ${Buffer.from(a.privateKey).toString('hex')}`)
