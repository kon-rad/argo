# Brain Map browser measurement record

This is actual integrated map replay measurement, superseding the earlier standalone renderer-only evidence. This reference run used source `ce45642b90b5babd06ec6bcf1a820156f768cd4b` on 2026-11-20. Subsequent behavior changes require a fresh exact-head coordinator run; keep the current submitted revision's receipt with its review evidence.

## Workload and method

Built production Vite preview, native Chrome 159, ANGLE Metal Apple M1 Max, 1280x900. The real map route loaded all 5,000 synthetic events across ten 500-event pages, 500 map nodes and 1,500 links. The HTML list showed its latest 200 operations while the overlay retained all evidence. Each of 100 alternating seeks waited for the correct first visible source ID, then one animation frame. Timing includes URL/React replay derivation, operation HTML and map updates; it is not GPU-completion timing or production-data throughput.

| Measurement | Observed result |
|---|---|
| Seek p50 / p95 / maximum | 35.7 / 43.2 / 47.4 ms |
| Awake scheduling | 60.003 RAF frames/second, 120 samples |
| Idle native draw calls | Zero additional calls over 1.5 seconds |
| Initial / final live canvases | One / one |
| Live geometries / textures / programs | 1,504 / 12 / 12, unchanged over 30 map/workspace roundtrips |
| Forced-GC heap, initial / after 30 roundtrips | 22,807,916 / 26,935,088 bytes |
| JS errors | None |

The 30-roundtrip heap delta is an observation, not a browser heap ceiling. Live renderer counters do not measure total GPU allocation. All 15 served JavaScript response hashes matched the built dist files.

## Raw seek samples, milliseconds

26.2, 41.2, 39.7, 39.4, 39.4, 40.6, 37.5, 39.1, 37.6, 42.1, 40.0, 44.2, 39.1, 35.4, 33.4, 34.7, 33.9, 37.6, 33.9, 35.6, 33.9, 38.1, 34.6, 35.5, 35.0, 36.1, 34.5, 38.3, 34.6, 37.7, 35.5, 36.5, 37.6, 38.2, 42.2, 46.2, 34.4, 37.0, 45.1, 35.3, 33.9, 38.1, 35.3, 35.6, 33.6, 35.4, 36.0, 34.4, 33.4, 35.0, 33.2, 37.0, 38.2, 35.1, 34.3, 34.7, 35.8, 34.6, 33.1, 35.5, 34.2, 39.6, 43.2, 41.7, 34.6, 36.4, 33.3, 34.7, 40.8, 38.5, 34.2, 36.4, 34.5, 39.5, 34.9, 35.8, 34.8, 35.8, 36.0, 35.1, 38.1, 36.8, 34.7, 37.3, 34.7, 37.0, 37.4, 47.4, 39.8, 35.2, 34.4, 36.5, 34.6, 45.8, 33.9, 35.4, 33.8, 37.2, 34.7, 34.3

## Served production JavaScript attestation

| Asset | Bytes | SHA-256 |
|---|---:|---|
| jsx-runtime-B-hcVAMW.js | 8557 | `6eab4df858048a4840a5d08754d84773f3f0de0ea0c4bb58e0e0abca99d1d973` |
| preload-helper-Czpn1I53.js | 1196 | `aba87f2a53e45ecdc9113fc30387d16e449d1676428cf5f82dd624c1df97d152` |
| useQuery-BcrDPy_9.js | 23095 | `8ef8862bea7adcf0eaff954e07360e491fe8a0198b49ed315cd60db1902e8cbb` |
| index-BWR40A4o.js | 862281 | `013cee9a4e9822767d6bb76d3f49b72906cfb2ace69da37f574d502bbd3615d4` |
| mapData-keriWwNv.js | 2429 | `ea7c7689910b962a5fed3acd8f9f63b93e73d84c399fbffc1147cefa200c90de` |
| Map-BC6g7OcU.js | 8860 | `07bad66c0cddbd4d328e67eac2f6c058bf586c27966974adfe52f08f2b4d8734` |
| model-BG6fmXvQ.js | 5567 | `2adf44712a3190f9a53cba30347494b0b170337f10ab61d0db6ca2c1178b2bac` |
| three.core-B-I1Uqpg.js | 241566 | `8bcbcb02495eb182983e4d32a8b5425e368cf3e8a0b80aeed97bebf6fcf006bd` |
| Observatory-DZFuPiV_.js | 14468 | `38b299dd0f0603186623616e1d4d4d1a69ac402cba6f99a3312bfe375b14a0f6` |
| mapActivity-DEZ2SXp0.js | 629 | `d3cccff18e1959d15411bf6db088a63b1a5da4c58aeaebdabc3933dad4fcb7a9` |
| BrainActivity-BD7My3rq.js | 4468 | `e9120e3bf950e2aeaa9630c87e219462cd9fd8c4aafbd9d4cd01baab28edd358` |
| FullMap-BvLUR1Y_.js | 14385 | `8da95c0969109a1b3328e497676d99bccd7ab65163195710bcac3988446106d8` |
| three.module-CA3mRTJK.js | 352341 | `909b8d7b87dae909dc91589397297e63acce6753a297dce0d7c8e59eaf8943ea` |
| 3d-force-graph-DfJIvYYB.js | 806022 | `9f4781e10ca0ddbf8312871643697379c12a693d5f07671cdcf9ce4a0c999a79` |
| Workspace-BJ4x3dQN.js | 4352 | `daeeb1c7f9ce0c89e27c29d12873b36bf99f7187a36396ff3dd7757ca6c7fa69` |

## Longer lifecycle observation

An independent memory-only run used the same source/build, ten warmup roundtrips and continued to 120 total roundtrips. Renderer, controls and document listener counts remained one. The larger current-renderer numeric cache backing observed at cycle 70 shrank after its allocation threshold. Settled heap at cycle 120 was 692,460 bytes above warmup, with approximately stable late-cycle values. One additional React tree was observed in the final snapshot; this does not establish zero retention, a universal plateau or a total GPU-memory bound.

The demonstrated old-route leak was separately traced to document keyboard listeners retained when controls disconnected after canvas detachment. Renderer lifetime cleanup now runs before detachment. Two connected-root regression tests failed before this correction and pass afterward. See React's primary lifecycle references: [layout effects](https://react.dev/reference/react/useLayoutEffect) and [passive effects](https://react.dev/reference/react/useEffect).

## Required review handoff

Preserve the exact source revision, app/web tree hash, device/GPU, production asset hashes, full raw seek/frame samples, response byte count, forced-GC samples, mode-switch counts and caveats in the coordinator's revision-bound RESULT. The workload uses synthetic API data and does not establish production authorization or historical completeness. Re-run after current behavior changes. A sandbox worker's inability to run a browser is historical capability evidence, not a claim that coordinator measurements do not exist.

## Reproduce against a production build

From `app/`, run `npm run build`, then `node web/e2e/observatory-map-benchmark.cjs`. Set the test-only `OBSERVATORY_CHROME` variable to a native browser executable for the agreed hardware baseline; otherwise Playwright uses its installed browser. The script starts only a loopback production preview and mocks every data API with synthetic records. It writes raw samples and a Markdown receipt to an OS temporary directory, checks source stability and served/dist hashes, and fails timing budgets instead of hiding a slow result. It never builds or changes application source.

Optional test controls: `OBSERVATORY_BENCH_PORT` defaults to 5206, `OBSERVATORY_BENCH_CYCLES` defaults to 30 (120 is supported), and `OBSERVATORY_BENCH_OUTPUT` selects an output directory outside the vault. Heap figures are observations, not a process or GPU memory guarantee. Source HEAD, frontend tree and build hashes accompany each run. Documentation-only commits may change HEAD while the runtime tree remains identical; each review submission still needs its own exact-head coordinator receipt.
