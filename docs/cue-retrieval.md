# Cue retrieval

Cue retrieval ranks recall documents (memory concepts, skills, and experiences) for a query. It lives in `rust/crates/core/src/resources/recall` and serves memory search, repository recall, and skill selection. The contract types (`document`, `candidate`) are shared by every producer and consumer of recall.

## Pipeline

1. **Lexical search.** Tantivy indexes each document into weighted text fields (id, title, tags, aliases, description, body, and related fields). Queries run through the `cue` analyzer: Unicode NFC normalization, lowercase word tokens that keep underscores and identifier characters, and an English function-word list that includes question words and auxiliaries. Exact id, title, tag, and body-phrase matches are found separately and rank above BM25 hits.
2. **Semantic search.** `BAAI/bge-small-en-v1.5` (384 dimensions, ONNX through FastEmbed) embeds documents and queries. Document vectors are L2-normalized and cached by content hash in `vectors.bin`; queries use the model's retrieval instruction. Cosine similarity ranks the cached vectors.
3. **Fusion.** Reciprocal rank fusion (`k = 60`) merges the BM25 list and the semantic list. Exact matches always lead.
4. **Abstention.** A BM25 score floor and a cosine floor drop weak candidates. When nothing clears a floor, the result is empty and the caller injects nothing.

Semantic search is skipped when an exact match exists or the top BM25 score reaches the lexical-sufficiency threshold, so most queries never run the embedding model. Each result carries its signals (query terms, matched terms, top and second BM25 score, top cosine, whether semantic search ran) so callers can apply their own policy.

## Calibration

`Calibration` holds the thresholds. Defaults:

| Field                | Default | Meaning                                                              |
| -------------------- | ------- | -------------------------------------------------------------------- |
| `bm25_floor`         | 3.1     | Minimum BM25 score, in IDF units, for a lexical candidate.           |
| `cosine_floor`       | 0.6     | Minimum cosine similarity for a semantic candidate.                  |
| `lexical_sufficient` | 3.7     | BM25 score above which semantic search is skipped.                   |
| `rrf_k`              | 60      | Reciprocal rank fusion constant.                                     |
| `pool`               | 50      | Candidates taken from each method before fusion.                     |

BM25 floors are multiplied by `ln(1 + (N - 0.5) / 1.5)` for an index of `N` documents, so one setting holds across corpus sizes. A calibration with `bm25_floor: 0`, `cosine_floor: -1`, and a very large `lexical_sufficient` yields a ranked list without abstention; the benchmark uses it for the `ranked` rows.

## Query and selection

A `Query` carries the text, a `limit`, and optional filters: `kinds` (concept, skill, experience), `scopes`, `tags`, `types`, `implicit`, and `now`. Three fields bound what a caller injects:

- `seen` lists content hashes already delivered in earlier turns. Candidates with those hashes are dropped.
- `budget` caps selection with `total_bytes`, `per_kind_bytes`, and `per_kind_candidates`. A candidate that would exceed a cap is skipped and later, smaller candidates can still fit. Unset caps mean unlimited.
- `implicit` marks automatic recall. Implicit queries skip manual-activation documents and collapse documents with identical content hashes into the best-ranked one, which lists the rest in `aliases`. Explicit queries return every matching document.

Each `Candidate` reports `bytes`, the size of the document's title, description, and body, so a caller can account for its own usage. Filtering, deduplication, and budgets run after ranking and before `limit` is applied.

## Index storage and lifecycle

- The Tantivy index is a rebuildable cache under the owner's data directory. Every document has a key (`scope`, `kind`, `id`) and a content hash; `sync` upserts changed documents, deletes removed ones, and rebuilds when the analyzer revision changes. A reopen with unchanged content does no work.
- Lifecycle metadata gates results: superseded, inactive, and stale documents are excluded from results.
- If the on-disk index cannot be opened or written, retrieval continues from an in-memory index.
- Filters cover kind, scope, tag, document type, implicit-recall eligibility, and the evaluation time.

## Embedding model provisioning

`provision::provision` downloads the pinned `Xenova/bge-small-en-v1.5` revision (`model.onnx`, tokenizer, and config files, about 133 MB) from Hugging Face into the models directory, verifies each file's size and SHA-256, and writes a `.verified` marker. Downloads run only when a caller invokes provisioning. Until the model is provisioned and loaded, `Semantic::status()` is not `Ready` and retrieval returns lexical results with `semantic: Unavailable` in its signals.

Memory search, repository recall, and skill selection currently open the retriever without a semantic component, so they use Tantivy BM25 and the exact-match tiers.

## Build requirement on macOS

The prebuilt ONNX Runtime static library calls `__isPlatformVersionAtLeast`, which the Rust toolchain does not link by default. `crates/core/build.rs` links `clang_rt.osx` from the resource directory of the `cc` compiler (`cc --print-resource-dir`) so release and test binaries link.

## Benchmark

`cargo bench -p ycoding-core --bench cue_recall -- --variant <name> --scratch <dir> [--models <dir>]` runs one variant against `benches/cue-recall-labelled.json`: 144 labelled queries (124 positive, 20 negative) over 88 synthetic documents, split into development and holdout halves. Variants: `bm25`, `bge` (dense only), `hybrid`, `scale` (1000 documents), and `prefix` (prompt-prefix stability). `bge` and `hybrid` need `--models` pointing at a provisioned model directory.

Quality on the full query set (`auto` applies the default floors; `ranked` applies none):

| Variant                  | Mode   | Recall@5 | MRR  | nDCG@5 | Abstained negatives |
| ------------------------ | ------ | -------- | ---- | ------ | ------------------- |
| Previous custom BM25     | auto   | 0.75     | 0.72 | 0.72   | 4 of 20             |
| Tantivy BM25             | auto   | 0.74     | 0.74 | 0.74   | 19 of 20            |
| BGE only                 | auto   | 0.73     | 0.70 | 0.71   | 14 of 20            |
| BGE only                 | ranked | 0.90     | 0.84 | 0.85   | 0 of 20             |
| Hybrid (BM25 + BGE, RRF) | auto   | 0.82     | 0.81 | 0.81   | 14 of 20            |
| Hybrid (BM25 + BGE, RRF) | ranked | 0.94     | 0.89 | 0.90   | 0 of 20             |

Paraphrase queries with no lexical overlap are where the methods differ: BM25 recalls none of them, BGE alone and hybrid recall 0.75 in `ranked` mode, and the default cosine floor limits `auto` mode to 0.31 on that group because paraphrase cosines cluster between 0.5 and 0.6.

Cost on the same corpus (one process, Apple silicon, release profile; the previous BM25 row comes from a separate run on the original code):

| Variant        | Cold first pass | Warm p50 | Warm p95 | CPU     | Peak RSS | Index on disk | Notes                                                       |
| -------------- | --------------- | -------- | -------- | ------- | -------- | ------------- | ----------------------------------------------------------- |
| Previous BM25  | 130 ms          | 67.8 ms  | 444 ms   | 43.9 s  | 47 MB    | 46 KB         | Custom scorer; includes a 4.5 s setup.                      |
| Tantivy BM25   | 15 ms           | 0.09 ms  | 0.19 ms  | 0.17 s  | 28 MB    | 91 KB         | Reopen sync 32 µs.                                          |
| Hybrid         | 166 ms          | 0.14 ms  | 3.5 ms   | 5.1 s   | 429 MB   | 91 KB         | 96 of 144 queries skip inference; query embedding p50 2.7 ms. |

Embedding the 88 documents takes about 0.8 s and produces a 147 KB vector cache. A 1000-document corpus (8 MB of text) indexes in 0.5 s into 2.7 MB, answers queries in 0.6 ms at p50, and applies a single-document update in 96 ms. Latency varies with machine load; repeated runs of the same variant differed by up to 7x.
