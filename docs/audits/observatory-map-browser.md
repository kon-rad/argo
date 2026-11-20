# Synthetic production Brain Map benchmark

Source before: 95c4bb2abaa001dd79f52e08e9fb6a05b0ec5aec
Source after: 95c4bb2abaa001dd79f52e08e9fb6a05b0ec5aec
App/web tree before: 0249f09134a498e96326549a2ef91fb00f27e02b
App/web tree after: 0249f09134a498e96326549a2ef91fb00f27e02b
Mode: existing production build served by Vite preview. No build is performed.
Browser: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/159.0.0.0 Safari/537.36
Renderer: ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max, Unspecified Version)
Viewport: 1280x900

| Check | Actual result |
|---|---|
| Workload | 500 map nodes, 1500 edges, 5000 synthetic events over ten pages |
| Actual UI seeks | 100 alternating forward/backward inputs |
| Seek p50 / p95 / max | 36.0 / 42.9 / 52.5 ms |
| DOM completion p95 | 39.5 ms |
| Awake RAF cadence | 60.00 fps |
| Idle native draw-call increase | 0 over 1500 ms |
| Mode roundtrips | 120 |
| Forced-GC JS heap baseline / final | 22800300 / 23803868 bytes |
| Retained heap difference | 1003568 bytes |
| JS errors | 0 |

These samples include real map route derivation, HTML updates and overlay rendering. They are not isolated Workspace renderer measurements or production data. RAF measures scheduling, not GPU completion. The 32 MiB serialized metadata budget is not a browser heap ceiling. Resource counts describe only the currently mounted context, not all GPU memory or leaked contexts. A finite GC series and stable live counts do not establish a flat plateau or prove no leak. Inspect all cycle samples and record competing host workloads before drawing conclusions.

The committed web tree identifies source; served hashes attest bytes match existing dist files. This script alone does not prove that dist was built from that source tree. Pair this receipt with an exact-source build receipt. Raw timings, device, transport offsets, heap/resource samples and hashes are in results.json. No personal data or credentials are requested.

## Served JavaScript attestation

| Asset | Served SHA-256 | Matches existing dist |
|---|---|---|
| /assets/jsx-runtime-B-hcVAMW.js | 6eab4df858048a4840a5d08754d84773f3f0de0ea0c4bb58e0e0abca99d1d973 | true |
| /assets/preload-helper-Czpn1I53.js | aba87f2a53e45ecdc9113fc30387d16e449d1676428cf5f82dd624c1df97d152 | true |
| /assets/useQuery-BcrDPy_9.js | 8ef8862bea7adcf0eaff954e07360e491fe8a0198b49ed315cd60db1902e8cbb | true |
| /assets/index-B0EEoC1S.js | c126cf574b9fb67c522b0b8f0a0b57103a89d8ba72c34a2ee5a501f16422e677 | true |
| /assets/mapData-kdsO1Bz_.js | a144f5d48db38c8129dc1aa6fbd28a8212df703910bb2b5c205213ab82bf7094 | true |
| /assets/Map-KeS0iWQD.js | 2d7d3036e10f3cc328e47de53656f09ead5bd194d68d3273e670b9deff560981 | true |
| /assets/model-DubFK2vM.js | 354d0384f4a6f96d91e3be3ccb33c90647468311a364d538bbd76272a93ddbcb | true |
| /assets/three.core-B-I1Uqpg.js | 8bcbcb02495eb182983e4d32a8b5425e368cf3e8a0b80aeed97bebf6fcf006bd | true |
| /assets/Observatory-Bh0odtZq.js | 90b3885d843fc5a7d0b0c15839a01097da430fc0375e905d2fad44195f8add04 | true |
| /assets/mapActivity-DEZ2SXp0.js | d3cccff18e1959d15411bf6db088a63b1a5da4c58aeaebdabc3933dad4fcb7a9 | true |
| /assets/BrainActivity-DGhXo5pJ.js | 0e9a0a6901f883601a7ab1d777260aec45ca33b77305c149f4026822bdbe43e9 | true |
| /assets/FullMap-B5M8TZS-.js | 5acfa27300def763101adf2cf1c34c881f02a5c927545a813ef791d827879f68 | true |
| /assets/three.module-CA3mRTJK.js | 909b8d7b87dae909dc91589397297e63acce6753a297dce0d7c8e59eaf8943ea | true |
| /assets/3d-force-graph-DfJIvYYB.js | 9f4781e10ca0ddbf8312871643697379c12a693d5f07671cdcf9ce4a0c999a79 | true |
| /assets/Workspace-BuszI_bl.js | 4a0fcaac2a9bcabf2a1694d80008d9a48c62a116331915d460a5e41a5b828cbe | true |

## Forced-GC cycle samples

| Cycle | JS used bytes | Live canvases |
|---|---|---|
| 1 | 22092276 | 1 |
| 2 | 22375308 | 1 |
| 3 | 22796672 | 1 |
| 4 | 23218068 | 1 |
| 5 | 23520160 | 1 |
| 6 | 23686136 | 1 |
| 7 | 24074136 | 1 |
| 8 | 24036920 | 1 |
| 9 | 24304216 | 1 |
| 10 | 24298160 | 1 |
| 11 | 24418596 | 1 |
| 12 | 24815924 | 1 |
| 13 | 24694096 | 1 |
| 14 | 24913028 | 1 |
| 15 | 25056116 | 1 |
| 16 | 25233820 | 1 |
| 17 | 25378472 | 1 |
| 18 | 25562172 | 1 |
| 19 | 25750820 | 1 |
| 20 | 25884048 | 1 |
| 21 | 26046020 | 1 |
| 22 | 26144896 | 1 |
| 23 | 26252884 | 1 |
| 24 | 26431556 | 1 |
| 25 | 26564624 | 1 |
| 26 | 26655536 | 1 |
| 27 | 27850008 | 1 |
| 28 | 27034412 | 1 |
| 29 | 27191828 | 1 |
| 30 | 27403128 | 1 |
| 31 | 27533128 | 1 |
| 32 | 27669548 | 1 |
| 33 | 27822012 | 1 |
| 34 | 27955812 | 1 |
| 35 | 28170520 | 1 |
| 36 | 28386856 | 1 |
| 37 | 28456428 | 1 |
| 38 | 28682400 | 1 |
| 39 | 28775232 | 1 |
| 40 | 28969872 | 1 |
| 41 | 29068128 | 1 |
| 42 | 29228580 | 1 |
| 43 | 29352760 | 1 |
| 44 | 29465980 | 1 |
| 45 | 29589296 | 1 |
| 46 | 29727744 | 1 |
| 47 | 29844564 | 1 |
| 48 | 29916344 | 1 |
| 49 | 30130624 | 1 |
| 50 | 30229936 | 1 |
| 51 | 30438376 | 1 |
| 52 | 30553028 | 1 |
| 53 | 30650256 | 1 |
| 54 | 30771284 | 1 |
| 55 | 30921532 | 1 |
| 56 | 31097056 | 1 |
| 57 | 31140320 | 1 |
| 58 | 31355752 | 1 |
| 59 | 31443928 | 1 |
| 60 | 31617928 | 1 |
| 61 | 31742564 | 1 |
| 62 | 31798412 | 1 |
| 63 | 32095768 | 1 |
| 64 | 32274112 | 1 |
| 65 | 32384040 | 1 |
| 66 | 32495476 | 1 |
| 67 | 32664816 | 1 |
| 68 | 32805404 | 1 |
| 69 | 32910676 | 1 |
| 70 | 33068404 | 1 |
| 71 | 33183360 | 1 |
| 72 | 33290032 | 1 |
| 73 | 24125296 | 1 |
| 74 | 24108868 | 1 |
| 75 | 24132388 | 1 |
| 76 | 24290036 | 1 |
| 77 | 24202304 | 1 |
| 78 | 24219080 | 1 |
| 79 | 24190124 | 1 |
| 80 | 24253120 | 1 |
| 81 | 24215696 | 1 |
| 82 | 24251408 | 1 |
| 83 | 24248620 | 1 |
| 84 | 24276692 | 1 |
| 85 | 24238176 | 1 |
| 86 | 24508808 | 1 |
| 87 | 24307152 | 1 |
| 88 | 24305504 | 1 |
| 89 | 24290804 | 1 |
| 90 | 24293096 | 1 |
| 91 | 24299604 | 1 |
| 92 | 24307048 | 1 |
| 93 | 24307068 | 1 |
| 94 | 24312048 | 1 |
| 95 | 24311948 | 1 |
| 96 | 24310108 | 1 |
| 97 | 24293988 | 1 |
| 98 | 24320280 | 1 |
| 99 | 24358036 | 1 |
| 100 | 24346444 | 1 |
| 101 | 24305644 | 1 |
| 102 | 24536044 | 1 |
| 103 | 24521444 | 1 |
| 104 | 24349200 | 1 |
| 105 | 24547128 | 1 |
| 106 | 24353480 | 1 |
| 107 | 24353376 | 1 |
| 108 | 24507040 | 1 |
| 109 | 24314580 | 1 |
| 110 | 24357844 | 1 |
| 111 | 24358544 | 1 |
| 112 | 24371188 | 1 |
| 113 | 24331648 | 1 |
| 114 | 24366124 | 1 |
| 115 | 24370564 | 1 |
| 116 | 24384904 | 1 |
| 117 | 24333592 | 1 |
| 118 | 24367316 | 1 |
| 119 | 24373976 | 1 |
| 120 | 24367988 | 1 |

## Raw seek samples, milliseconds

38.40, 43.90, 37.70, 40.70, 37.20, 39.10, 37.50, 38.80, 39.70, 42.90, 38.30, 38.70, 42.50, 37.00, 34.50, 39.80, 33.90, 36.10, 36.20, 34.60, 34.30, 37.20, 38.20, 35.70, 34.30, 37.40, 34.30, 36.10, 36.80, 35.50, 34.10, 35.70, 34.60, 39.70, 34.50, 38.40, 43.30, 47.40, 37.20, 42.00, 34.00, 35.30, 33.80, 42.40, 34.40, 36.20, 34.00, 34.80, 38.10, 35.80, 36.90, 35.50, 36.00, 37.70, 34.30, 34.20, 33.70, 34.30, 36.00, 35.10, 35.50, 37.00, 35.70, 38.20, 38.60, 52.50, 36.60, 35.00, 39.90, 42.40, 32.80, 34.30, 36.00, 34.20, 32.90, 34.40, 38.20, 34.60, 33.60, 35.20, 34.40, 34.40, 35.80, 35.20, 33.90, 35.60, 37.10, 36.20, 34.50, 35.40, 33.80, 35.40, 36.30, 44.30, 34.10, 36.20, 40.50, 41.70, 33.20, 37.50

## Raw awake frame intervals, milliseconds

16.70, 16.70, 16.60, 16.60, 16.80, 16.70, 16.50, 16.80, 16.60, 16.70, 16.70, 16.60, 16.60, 16.80, 16.60, 16.60, 16.70, 16.80, 16.60, 16.60, 16.70, 16.70, 16.60, 16.70, 16.70, 16.60, 16.70, 16.70, 16.70, 16.60, 16.60, 16.80, 16.60, 16.70, 16.60, 16.70, 16.70, 16.60, 16.70, 16.70, 16.60, 16.70, 16.60, 16.70, 16.70, 16.70, 16.60, 16.70, 16.70, 16.60, 16.70, 16.60, 16.70, 16.70, 16.60, 16.80, 16.50, 16.70, 16.80, 16.50, 16.70, 16.70, 16.70, 16.70, 16.60, 16.70, 16.70, 16.60, 16.70, 16.70, 16.60, 16.70, 16.60, 16.70, 16.60, 16.80, 16.60, 16.60, 16.80, 16.60, 16.70, 16.60, 16.70, 16.70, 16.60, 16.70, 16.70, 16.60, 16.70, 16.60, 16.70, 16.70, 16.60, 16.70, 16.70, 16.70, 16.60, 16.70, 16.60, 16.70, 16.70, 16.60, 16.70, 16.70, 16.70, 16.60, 16.70, 16.70, 16.60, 16.60, 16.80, 16.60, 16.70, 16.70, 16.60, 16.70, 16.60, 16.70, 16.70, 16.70

## Transport and live-resource scope

Serialized fixture bytes: 3329715. API response bytes over the entire run: 764453106, including repeated loads during mode switching. All ten initial offsets 0 through 4500 were checked. Source/tree before and after are identical, and the exact-source production build completed successfully before this measurement. Live resource counters stayed at 1,504 geometries, 12 textures, 12 programs and one canvas through 120 roundtrips. These are active-context counters, not a total GPU allocation measurement.

The measured frontend tree above remains the runtime identity across documentation-only commits. The coordinator reruns the committed harness on each final submitted HEAD and binds its fresh receipt to that revision. The earlier sandbox limitation and standalone workspace renderer benchmark are historical and do not replace this actual integrated-map workload.

## Reproduce against a production build

From `app/`, run `npm run build`, then `node web/e2e/observatory-map-benchmark.cjs`. Set the test-only `OBSERVATORY_CHROME` variable to a native browser executable for the agreed hardware baseline; otherwise Playwright uses its installed browser. The script starts only a loopback production preview and mocks every data API with synthetic records. It writes raw samples and a Markdown receipt to an OS temporary directory, checks source stability and served/dist hashes, and fails timing budgets instead of hiding a slow result. It never builds or changes application source.

Optional test controls: `OBSERVATORY_BENCH_PORT` defaults to 5206, `OBSERVATORY_BENCH_CYCLES` defaults to 30 (120 is supported), and `OBSERVATORY_BENCH_OUTPUT` selects an output directory outside the vault. Heap figures are observations, not a process or GPU memory guarantee. Source HEAD, frontend tree and build hashes accompany each run. Documentation-only commits may change HEAD while the runtime tree remains identical; each review submission still needs its own exact-head coordinator receipt.
