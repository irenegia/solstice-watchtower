# Solstice watchtower (PoC)

Reads what landed on chain in f02, the SWA and the SRA (FIP-0118) and shows it on one page.

> **Disclaimer: this is a vibe-coded PoC.** All the code, and OBSERVABILITY.md, were written by an AI agent
> (Claude Code). Irene directed the scope and the design. William (wjmelements) looked at it on 2026-09-19 and opened
> issue #1; nobody has done a full code review. Treat what the page shows as unverified until someone checks it. What
> has been checked: 12 automated tests on hand-written samples, two records compared by hand with a block explorer, and
> one day of butterflynet test data (2026-09-21) compared with the test plan of the person who ran it (see DESIGN.md).

- Live page, hosted on Filecoin (Filecoin Pin): https://inbrowser.link/ipfs/bafybeihk4odsbmor5dbsjtt5uk4d3yl6z4hi3nadjqtzdpqrqlp25uylye/
  This link is fixed to one version of the page; the data stays fresh because the page fetches the record from this repo.
- Scope and discussion: https://github.com/filecoin-project/solstice/issues/69
- Design and its decisions: [DESIGN.md](DESIGN.md)
- How each FIP-0118 action can be observed on chain, by anyone: [OBSERVABILITY.md](OBSERVABILITY.md)

![The page with SAMPLE data, 2026-09-17](screenshots/sample-view.png)

*The page with SAMPLE data, written by hand to test it. Nothing in this screenshot happened on chain. The SRA and
the SWA were deployed on calibnet on 2026-09-17; the network upgrade that activates FIP-0118 there is on
2026-09-23. Until then the real record holds the deployment events and the reads, and f02 has no queue. The
"sample" and "real test" views were removed from the page on 2026-09-22; the real views are calibnet and the two butterflynet test networks.*

A scheduled job (`.github/workflows/read.yml`) runs the reader every 10 minutes and commits the record to
`site/data/calibnet/`. It only reads from a public endpoint and holds no key.

Needs Node.js 22 or newer.

| Command | What it does |
|---|---|
| `npm install` | Installs the two libraries (`viem`, `@ipld/dag-cbor`). Once. |
| `npm run read` | One run of the reader against calibnet. Only reads from the public RPC endpoint. Appends to `site/data/calibnet/records.jsonl`. |
| `npm run sample` | Writes a SAMPLE record to `site/data/sample/` for local development (`?data=sample` is no longer linked from the page). |
| `npm run page` | Serves the page at http://localhost:8000 (sample view: http://localhost:8000/?data=sample). Stop with Ctrl+C. |
| `npm test` | Runs the decoder tests on hand-written sample inputs. |

The contract addresses and the activation epoch in `config/calibnet.json` come from solstice `deployments.json`.
