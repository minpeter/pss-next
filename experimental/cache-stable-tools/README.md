# Cache-stable dynamic tools: live-provider benchmark

This benchmark tests a narrow provider premise behind PSS tool selection:
whether preserving an exact tool/prompt prefix correlates with
provider-reported prompt-cache reuse. It sends sequential OpenAI-compatible
chat-completion requests directly so sanitized usage telemetry remains
observable. PSS resolver and adapter wiring are tested separately; the live
script is not presented as an end-to-end runtime test.

The live runner emits an eager top-level `tools` array over raw Chat
Completions. The local wire smoke uses `@ai-sdk/openai-compatible` to reproduce
that generic eager shape. Neither path sends OpenAI Responses `tool_search`,
Anthropic `defer_loading`/`tool_reference`, OpenAI `additional_tools`, or Kimi
system-message tool declarations. A cache hit here therefore supports only the
eager exact-prefix premise; it does not show that FreeRouter preserves any
upstream native deferred-tool protocol.

## Design

The `all` scenario set runs three paired comparisons:

1. **Same set, different order.** Both arms warm with canonical order. The
   measurement preserves or reverses the same definitions.
2. **Changed active set.** Both arms warm with the full set. The measurement
   repeats it or removes a dynamic suffix while preserving the fixed prefix.
3. **Membership-only change.** The measurement repeats the full set or swaps
   one tool at the same position for a different, equal-byte definition. Tool
   count, tools-array bytes, and request-body bytes remain equal.

Equal bytes do not imply equal tokenizer output. The third scenario therefore
has a dedicated input-token parity audit, independent of cache-read reporting.
It records complete valid-input pairs, equal/control-higher/changed-higher
counts, each delta, and missing pairs. A difference is reported, not silently
normalized or treated as a benchmark failure; it limits interpretation of
absolute cache-token deltas. In the primary pair universe defined below, the
checked-in verifier requires all four planned pairs in each AB/BA order stratum;
any missing pair makes the directional result indeterminate.
`input-token-parity` is reserved for all eight planned primary model-level pairs
being present and exactly equal. The all-sample parity result remains
descriptive, and same-set and membership cache comparisons remain descriptive
when that exact primary parity is absent.

Every model/scenario/trial execution slot (`first` or `second`) has a unique
fixed-length prompt namespace and a unique, equal-shape inert canary before the
benchmark tools. Its warmup and measurement alone share those values. The
namespace and canary derive from execution slot, not control/changed identity;
alternating AB/BA order counterbalances every variant across both slots. A
measurement is eligible for cache aggregation only when its own warmup was a
recognized zero-tool-call response from the exact requested model with exactly
one choice, `finish_reason=stop`, and exact trimmed text `OK`. The verifier
checks that unchanged arms reuse both tools-array and request-body hashes,
changed arms change both hashes, and the same-set/membership swaps keep
serialized byte length equal.

Trial order is deterministic but counterbalanced. A SHA-256 bit of seed, model,
and scenario selects the first AB or BA order, then every trial alternates. With
eight trials, each model/scenario stratum has four control-first and four
changed-first assignments. Requests remain sequential to avoid benchmark-made
concurrency as a cache-affinity or latency variable. Every measured request
also records the monotonic warmup-to-measure settle elapsed by the
source-manifest-bound runner; the verifier requires both that value and the
sanitized wall-clock gap between warmup completion and measurement start to
meet the configured 1,500 ms.

Provider-reported raw cache-read-token differences and cache-read/input
coverage-ratio differences are parallel descriptive endpoints. Only pairs
with positive input counts contribute to the ratio endpoint; raw input-token
differences remain visible alongside both cache endpoints. The combined result
is indeterminate whenever the endpoints disagree. Opposite directions are
labeled `denominator-sensitive/indeterminate`, because changing input tokens
can reverse the ratio direction even when the raw cache-read-token direction
is unchanged. Neither endpoint estimates causal cache saving, cost, or net
economic effect. In the active-set scenario, removing tools mechanically
changes the denominator; same-set and membership results also remain
descriptive unless every planned input-token pair has exact parity.

Direction is order-robust, not merely pooled. Each AB/BA order must retain all
four planned eligible pairs, and both order-stratum medians must have the
same nonzero sign before the result says either arm was higher. Two zero medians
report only no observed median difference. Opposite signs, or a zero/nonzero
split, are reported as order-sensitive; one missing pair is enough to make the
result indeterminate. A pooled conclusion additionally requires all four pairs
in every model-by-order stratum and agreement with every model-level
conclusion, so aggregate volume cannot hide a missing, conflicting, or
order-sensitive model. Paired summaries record exact raw-cache-token,
input-token, and cache-read/input-ratio sign counts overall and by order. Ratio
pair signs, rational ordering, and even-sample median signs are computed with
`BigInt` cross-products rather than floating-point subtraction. Float ratio
medians remain display-only. The membership input-token audit uses the same
complete-coverage rule; cancelling nonzero deltas with zero medians is labeled
only as no observed median difference.

## What counts as evidence

The result deliberately separates several concepts:

- `captureSuccess`: HTTP success plus exactly one recognized choice/message,
  zero modern or legacy tool calls, `finish_reason=stop`, and exact trimmed
  text `OK`.
  `tool_calls: null` is a valid no-tool shape; array-valued choices/messages,
  missing/non-string/nonstandard finish reasons, `length`, `content_filter`,
  `function_call`, and `tool_calls` finishes fail closed.
  HTTP failures retain only `http-<status>` and local failures use a fixed
  allowlist, so a provider-reflected credential in `error.code`/`error.type`
  is neither stored nor logged. Serialized evidence also rejects bearer
  markers and recognized router- or OpenAI-style secret-key shapes.
- `finishReasonAudit`: per-choice sanitized status counts split into warmup,
  measurement, and all-request views. Raw finish-reason values are not retained.
- `cacheTelemetryEligible`: capture success, exact requested response-model
  attribution, a valid input/read/write usage envelope, and—for measurements—a
  successful exact-model warmup from the same arm.
- `outputComplianceAudit`: whether the sole returned choice was exact trimmed
  `OK`. Missing, malformed, multi-choice, and mismatched output fails capture
  and cache eligibility; no response text is stored.
- `responseModelAudit`: match, mismatch, and missing counts split into warmup,
  measurement, and all-request views.
- `usageFieldStatusAudit`: absent, valid, malformed, and conflicting alias
  counts for input, cache read, cache write, output, and total tokens.
- `backendMetadataAudit`: nullable `system_fingerprint` and `service_tier`
  values reduced to `absent`/`null`/`invalid`/`hashed` statuses and SHA-256
  digests. Multiple digests flag possible backend drift. These fields do not
  change per-request `cacheTelemetryEligible`, but they do gate paired primary
  sensitivity eligibility; raw metadata and provider payloads are never
  retained.
- `responseIdAudit`: reported, distinct, duplicate, and cross-request-body
  duplicate hash counts at both model and campaign scope. Any non-null response
  ID repeated anywhere in the campaign is treated as replay-suspect and
  excludes every affected primary pair, including same-body warmup/measurement
  replay. Cross-request-body reuse remains a separately reported stronger
  anomaly.
- `comparisons`: the all-sample descriptive paired view.
  `primaryComparisons` additionally requires the same non-null hashed
  `system_fingerprint` and `service_tier` across all four responses in a pair
  (both arms' warmups and measurements) and no campaign-global response-ID
  replay.
  Missing metadata is `unavailable`, not a match; each view records
  matched/mismatched/unavailable pair counts.
- `membershipInputTokenParityAudit` is the all-sample descriptive parity view.
  `primaryMembershipInputTokenParityAudit` uses exactly the same four-response
  backend-metadata and campaign-global response-ID pair universe as
  `primaryComparisons`. The verifier's headline `membershipInputParity`
  conclusion comes from that primary view and cannot claim exact parity when a
  planned pair is excluded; its report retains the all-sample result separately.

When multiple recognized aliases are present, they must contain the same
nonnegative safe integer. A malformed or conflicting field retains only its
audit status; source and value are nulled. Cache read/write must each be no
greater than input and their sum must not exceed input. Output/total conflicts
remain visible but do not reduce read/write eligibility. The per-request
read/write sum and every cross-request weighted aggregate must also remain a
safe integer; overflow aborts the campaign before evidence is written.

Read and write summaries are separate. Each reports field coverage, nonzero
coverage, median tokens, median read-or-write/input ratio, and a weighted ratio.
Each also exposes its own ratio-eligible count and ratio coverage, so a valid
reported field with zero input can contribute to field coverage without being
silently included in a ratio denominator. No cost is derived and
provider-normalized fields are not assumed comparable across models.

## Status: archived record

The benchmark runner, its independent and adversarial verifiers, and the
`pnpm benchmark:cache-stable-tools` / `test:cache-stable-tools-*` /
`verify:cache-stable-tools` scripts were removed in `ddfc72b`. This directory is
kept only as the dated record of the campaign that was run: the design and
evidence rules above, and the snapshot below. Nothing here is reproducible from
the current tree, and no verifier can re-check the snapshot.

## Artifacts and interpretation

[`latest-freerouter.json`](./latest-freerouter.json) is the campaign's
serialized evidence. It was authoritative only while its independent verifier
and runner-source hash could be re-run; both are gone, so read it as a dated
record. Snapshot results and SHA-256 are recorded below.

The router's upstream provider, retry behavior, backend affinity, cache policy,
load, and usage normalization remain opaque. Sanitized
`system_fingerprint`/`service_tier` statuses and hashes can reveal that more
than one reported value occurred, but cannot identify or control the backend
change. Primary paired results therefore require equality across each pair's
two warmup/measurement chains; the all-sample view remains descriptive.
Results are observational, dated, and provider-specific.
`not-reported` means no recognized valid field was exposed, not that no
upstream cache exists. Latency is supporting context only.

Native capability must be established separately for a precise
adapter/provider/model/version tuple. The 2026-07-17 dependency audit used
`ai@7.0.30`, `@ai-sdk/provider@4.0.3`,
`@ai-sdk/openai-compatible@3.0.11`, `@ai-sdk/openai@4.0.15`, and
`@ai-sdk/anthropic@4.0.15`; current package versions do not establish provider
or router capability. The audited
[`@ai-sdk/openai@4.0.15` tool-search implementation](https://github.com/vercel/ai/blob/b8241a6e5592066c0ee1772c32d3ef47d7d7595e/packages/openai/src/tool/tool-search.ts)
and
[`@ai-sdk/anthropic@4.0.15` tool preparation](https://github.com/vercel/ai/blob/6976682b5718f36425521816e6a8c2df8c07faa9/packages/anthropic/src/anthropic-prepare-tools.ts)
do not imply equivalent behavior in `@ai-sdk/openai-compatible` or a router.
Likewise, [Kimi's positioned system-message protocol](https://platform.kimi.ai/docs/guide/use-dynamic-tool-loading)
is a direct-provider, currently `kimi-k3`-specific extension. Any future native
path needs a wire canary for its expected request/replay items and an eager
fallback when the tuple is unknown or the canary fails.

For OpenAI hosted search, that canary must see a same-response
`tool_search_call`/`tool_search_output` pair with `execution: "server"` and a
null `call_id`. Client-executed search instead stops after a call with
`execution: "client"` and requires the application to echo its non-null
`call_id` in a later `tool_search_output`; PSS does not currently own that replay
path. A future client path must accept returned definitions only from a
host-owned allowlist or registry subset and reject unexpected names, types,
duplicates, and schemas. Manually replayed `additional_tools` items must also
retain their original input position and `role: "developer"`; the selector is
not an authorization decision. An individually deferred function still exposes
its name and description and mostly saves its parameter schema, while
namespaces or MCP servers can defer the contained function details. OpenAI
recommends those grouped surfaces where possible and fewer than ten functions
per namespace; documented savings are possible, not guaranteed.

That canary must also assert an explicit MCP approval policy. The OpenAI API
documents approval-before-sharing as its default, while the current AI SDK
OpenAI Responses adapter lowers an omitted setting to
`require_approval: "never"`; a provider-native integration must not rely on
either implicit default. OpenAI does not store MCP `authorization` or return it
in the Response, so a future durable path must re-inject it from a host
credential source on every request, never persist it in transcripts or
evidence, and canary-check `allowed_tools` with the explicit approval policy.
Returned tools and output remain untrusted input. The generic adapter used here
also does not normalize GPT-5.6 `cache_write_tokens`, so this benchmark's
separately audited raw write field is required and a read-hit ratio is never
presented as net cost savings. The current OpenAI prompt-caching guide says
cache reads consider the latest 50 breakpoints, while the Responses API
reference says the latest 80 without a content-block lookback limit. This raw
generic benchmark uses neither value and does not encode either disputed limit.

## Final checked-in snapshot

Output of the source-manifest-bound 480-request campaign, as recorded when it
ran on 2026-07-17.

<!-- cache-stable-tools-independent-verifier:start -->
```json
{
  "evidenceSha256": "c13576da8d604b6c8cbca72f04e37d5d03d543dcc7874ab3e082ece5cda24e67",
  "generatedAt": "2026-07-17T16:44:33.519Z",
  "campaignId": "pr208-cache-v3-20260717",
  "aggregate": {
    "expectedRequests": 480,
    "observedRequests": 480,
    "captureSuccess": 480,
    "cacheTelemetryEligible": 480,
    "measuredCacheTelemetryEligible": 240
  },
  "models": [
    {
      "model": "minimaxai/minimax-m2.7",
      "requests": 96,
      "captureSuccess": 96,
      "cacheTelemetryEligible": 96,
      "measuredCacheTelemetryEligible": 48,
      "cacheReporting": "reported-nonzero",
      "cacheWriteReporting": "not-reported",
      "backendMetadataAudit": {
        "serviceTier": {
          "statusCounts": {
            "absent": 96,
            "hashed": 0,
            "invalid": 0,
            "null": 0
          },
          "uniqueHashCount": 0,
          "driftObserved": false
        },
        "systemFingerprint": {
          "statusCounts": {
            "absent": 37,
            "hashed": 59,
            "invalid": 0,
            "null": 0
          },
          "uniqueHashCount": 1,
          "driftObserved": false
        }
      },
      "responseIdAudit": {
        "reported": 96,
        "distinct": 96,
        "duplicateHashes": 0,
        "duplicateObservations": 0,
        "crossRequestBodyDuplicateHashes": 0,
        "crossRequestBodyDuplicateObservations": 0
      }
    },
    {
      "model": "minimaxai/minimax-m3",
      "requests": 96,
      "captureSuccess": 96,
      "cacheTelemetryEligible": 96,
      "measuredCacheTelemetryEligible": 48,
      "cacheReporting": "reported-nonzero",
      "cacheWriteReporting": "not-reported",
      "backendMetadataAudit": {
        "serviceTier": {
          "statusCounts": {
            "absent": 96,
            "hashed": 0,
            "invalid": 0,
            "null": 0
          },
          "uniqueHashCount": 0,
          "driftObserved": false
        },
        "systemFingerprint": {
          "statusCounts": {
            "absent": 0,
            "hashed": 0,
            "invalid": 0,
            "null": 96
          },
          "uniqueHashCount": 0,
          "driftObserved": false
        }
      },
      "responseIdAudit": {
        "reported": 96,
        "distinct": 96,
        "duplicateHashes": 0,
        "duplicateObservations": 0,
        "crossRequestBodyDuplicateHashes": 0,
        "crossRequestBodyDuplicateObservations": 0
      }
    },
    {
      "model": "mistralai/ministral-14b-latest",
      "requests": 96,
      "captureSuccess": 96,
      "cacheTelemetryEligible": 96,
      "measuredCacheTelemetryEligible": 48,
      "cacheReporting": "reported-nonzero",
      "cacheWriteReporting": "not-reported",
      "backendMetadataAudit": {
        "serviceTier": {
          "statusCounts": {
            "absent": 96,
            "hashed": 0,
            "invalid": 0,
            "null": 0
          },
          "uniqueHashCount": 0,
          "driftObserved": false
        },
        "systemFingerprint": {
          "statusCounts": {
            "absent": 96,
            "hashed": 0,
            "invalid": 0,
            "null": 0
          },
          "uniqueHashCount": 0,
          "driftObserved": false
        }
      },
      "responseIdAudit": {
        "reported": 96,
        "distinct": 96,
        "duplicateHashes": 0,
        "duplicateObservations": 0,
        "crossRequestBodyDuplicateHashes": 0,
        "crossRequestBodyDuplicateObservations": 0
      }
    },
    {
      "model": "qwen/qwen2.5-7b-instruct",
      "requests": 96,
      "captureSuccess": 96,
      "cacheTelemetryEligible": 96,
      "measuredCacheTelemetryEligible": 48,
      "cacheReporting": "reported-zero-only",
      "cacheWriteReporting": "not-reported",
      "backendMetadataAudit": {
        "serviceTier": {
          "statusCounts": {
            "absent": 96,
            "hashed": 0,
            "invalid": 0,
            "null": 0
          },
          "uniqueHashCount": 0,
          "driftObserved": false
        },
        "systemFingerprint": {
          "statusCounts": {
            "absent": 96,
            "hashed": 0,
            "invalid": 0,
            "null": 0
          },
          "uniqueHashCount": 0,
          "driftObserved": false
        }
      },
      "responseIdAudit": {
        "reported": 96,
        "distinct": 96,
        "duplicateHashes": 0,
        "duplicateObservations": 0,
        "crossRequestBodyDuplicateHashes": 0,
        "crossRequestBodyDuplicateObservations": 0
      }
    },
    {
      "model": "zai-org/glm-4.7",
      "requests": 96,
      "captureSuccess": 96,
      "cacheTelemetryEligible": 96,
      "measuredCacheTelemetryEligible": 48,
      "cacheReporting": "reported-zero-only",
      "cacheWriteReporting": "not-reported",
      "backendMetadataAudit": {
        "serviceTier": {
          "statusCounts": {
            "absent": 96,
            "hashed": 0,
            "invalid": 0,
            "null": 0
          },
          "uniqueHashCount": 0,
          "driftObserved": false
        },
        "systemFingerprint": {
          "statusCounts": {
            "absent": 96,
            "hashed": 0,
            "invalid": 0,
            "null": 0
          },
          "uniqueHashCount": 0,
          "driftObserved": false
        }
      },
      "responseIdAudit": {
        "reported": 96,
        "distinct": 96,
        "duplicateHashes": 0,
        "duplicateObservations": 0,
        "crossRequestBodyDuplicateHashes": 0,
        "crossRequestBodyDuplicateObservations": 0
      }
    }
  ],
  "effects": [
    {
      "scope": "minimaxai/minimax-m2.7",
      "scenario": "same-set-order",
      "conclusion": "insufficient-coverage",
      "primary": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          }
        }
      },
      "allSampleDescriptive": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 1,
                "median": 4192,
                "direction": "control-higher"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 3,
                "median": 4192,
                "direction": "control-higher"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 1,
                "median": 0.24674652308997957,
                "direction": "control-higher"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 3,
                "median": 0.24721716613187794,
                "direction": "control-higher"
              }
            ]
          }
        }
      }
    },
    {
      "scope": "minimaxai/minimax-m2.7",
      "scenario": "active-set-change",
      "conclusion": "insufficient-coverage",
      "primary": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          }
        }
      },
      "allSampleDescriptive": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": 560,
                "direction": "control-higher"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 3,
                "median": 0,
                "direction": "equal"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": 0.002798803997943078,
                "direction": "control-higher"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 3,
                "median": 0,
                "direction": "equal"
              }
            ]
          }
        }
      }
    },
    {
      "scope": "minimaxai/minimax-m2.7",
      "scenario": "membership-only-change",
      "conclusion": "insufficient-coverage",
      "primary": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          }
        }
      },
      "allSampleDescriptive": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 2,
                "median": 808,
                "direction": "control-higher"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 2,
                "median": 800,
                "direction": "control-higher"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 2,
                "median": 0.04743166655740193,
                "direction": "control-higher"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 2,
                "median": 0.047094837228468855,
                "direction": "control-higher"
              }
            ]
          }
        }
      }
    },
    {
      "scope": "minimaxai/minimax-m3",
      "scenario": "same-set-order",
      "conclusion": "insufficient-coverage",
      "primary": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          }
        }
      },
      "allSampleDescriptive": {
        "conclusion": "endpoint-disagreement/indeterminate",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "order-sensitive/indeterminate",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": -8,
                "direction": "changed-higher"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "descriptive-changed-higher",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": -0.00046203435194617105,
                "direction": "changed-higher"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": -0.0000014592305821008178,
                "direction": "changed-higher"
              }
            ]
          }
        }
      }
    },
    {
      "scope": "minimaxai/minimax-m3",
      "scenario": "active-set-change",
      "conclusion": "insufficient-coverage",
      "primary": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          }
        }
      },
      "allSampleDescriptive": {
        "conclusion": "endpoint-disagreement/indeterminate",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "no-observed-median-difference",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "descriptive-changed-higher",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": -0.0005367730603383246,
                "direction": "changed-higher"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": -0.00053035742162364,
                "direction": "changed-higher"
              }
            ]
          }
        }
      }
    },
    {
      "scope": "minimaxai/minimax-m3",
      "scenario": "membership-only-change",
      "conclusion": "insufficient-coverage",
      "primary": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          }
        }
      },
      "allSampleDescriptive": {
        "conclusion": "order-sensitive/indeterminate",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "order-sensitive/indeterminate",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": 17040,
                "direction": "control-higher"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "order-sensitive/indeterminate",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": -0.0000014597395716475087,
                "direction": "changed-higher"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": 0.9906991341581763,
                "direction": "control-higher"
              }
            ]
          }
        }
      }
    },
    {
      "scope": "mistralai/ministral-14b-latest",
      "scenario": "same-set-order",
      "conclusion": "insufficient-coverage",
      "primary": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          }
        }
      },
      "allSampleDescriptive": {
        "conclusion": "order-sensitive/indeterminate",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "order-sensitive/indeterminate",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": 9344,
                "direction": "control-higher"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "order-sensitive/indeterminate",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": 0.4996257084803764,
                "direction": "control-higher"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              }
            ]
          }
        }
      }
    },
    {
      "scope": "mistralai/ministral-14b-latest",
      "scenario": "active-set-change",
      "conclusion": "insufficient-coverage",
      "primary": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          }
        }
      },
      "allSampleDescriptive": {
        "conclusion": "no-observed-median-difference",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "no-observed-median-difference",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "no-observed-median-difference",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              }
            ]
          }
        }
      }
    },
    {
      "scope": "mistralai/ministral-14b-latest",
      "scenario": "membership-only-change",
      "conclusion": "insufficient-coverage",
      "primary": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          }
        }
      },
      "allSampleDescriptive": {
        "conclusion": "no-observed-median-difference",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "no-observed-median-difference",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "no-observed-median-difference",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              }
            ]
          }
        }
      }
    },
    {
      "scope": "qwen/qwen2.5-7b-instruct",
      "scenario": "same-set-order",
      "conclusion": "insufficient-coverage",
      "primary": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          }
        }
      },
      "allSampleDescriptive": {
        "conclusion": "no-observed-median-difference",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "no-observed-median-difference",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "no-observed-median-difference",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              }
            ]
          }
        }
      }
    },
    {
      "scope": "qwen/qwen2.5-7b-instruct",
      "scenario": "active-set-change",
      "conclusion": "insufficient-coverage",
      "primary": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          }
        }
      },
      "allSampleDescriptive": {
        "conclusion": "no-observed-median-difference",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "no-observed-median-difference",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "no-observed-median-difference",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              }
            ]
          }
        }
      }
    },
    {
      "scope": "qwen/qwen2.5-7b-instruct",
      "scenario": "membership-only-change",
      "conclusion": "insufficient-coverage",
      "primary": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          }
        }
      },
      "allSampleDescriptive": {
        "conclusion": "no-observed-median-difference",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "no-observed-median-difference",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "no-observed-median-difference",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              }
            ]
          }
        }
      }
    },
    {
      "scope": "zai-org/glm-4.7",
      "scenario": "same-set-order",
      "conclusion": "insufficient-coverage",
      "primary": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          }
        }
      },
      "allSampleDescriptive": {
        "conclusion": "no-observed-median-difference",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "no-observed-median-difference",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "no-observed-median-difference",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              }
            ]
          }
        }
      }
    },
    {
      "scope": "zai-org/glm-4.7",
      "scenario": "active-set-change",
      "conclusion": "insufficient-coverage",
      "primary": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          }
        }
      },
      "allSampleDescriptive": {
        "conclusion": "no-observed-median-difference",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "no-observed-median-difference",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "no-observed-median-difference",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              }
            ]
          }
        }
      }
    },
    {
      "scope": "zai-org/glm-4.7",
      "scenario": "membership-only-change",
      "conclusion": "insufficient-coverage",
      "primary": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          }
        }
      },
      "allSampleDescriptive": {
        "conclusion": "no-observed-median-difference",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "no-observed-median-difference",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "no-observed-median-difference",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 4,
                "median": 0,
                "direction": "equal"
              }
            ]
          }
        }
      }
    },
    {
      "scope": "pooled",
      "scenario": "same-set-order",
      "conclusion": "insufficient-coverage",
      "primary": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          }
        }
      },
      "allSampleDescriptive": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 17,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 19,
                "median": 0,
                "direction": "equal"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 17,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 19,
                "median": 0,
                "direction": "equal"
              }
            ]
          }
        }
      }
    },
    {
      "scope": "pooled",
      "scenario": "active-set-change",
      "conclusion": "insufficient-coverage",
      "primary": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          }
        }
      },
      "allSampleDescriptive": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 20,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 19,
                "median": 0,
                "direction": "equal"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 20,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 19,
                "median": 0,
                "direction": "equal"
              }
            ]
          }
        }
      }
    },
    {
      "scope": "pooled",
      "scenario": "membership-only-change",
      "conclusion": "insufficient-coverage",
      "primary": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 0,
                "median": null,
                "direction": "unavailable"
              }
            ]
          }
        }
      },
      "allSampleDescriptive": {
        "conclusion": "insufficient-coverage",
        "endpoints": {
          "rawCacheReadTokens": {
            "metric": "provider-reported-raw-cache-read-tokens",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 18,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 18,
                "median": 0,
                "direction": "equal"
              }
            ]
          },
          "cacheReadInputCoverageRatio": {
            "metric": "provider-reported-cache-read/input-coverage-ratio",
            "conclusion": "insufficient-coverage",
            "orderStrata": [
              {
                "pairOrder": "control-first",
                "eligiblePairs": 18,
                "median": 0,
                "direction": "equal"
              },
              {
                "pairOrder": "changed-first",
                "eligiblePairs": 18,
                "median": 0,
                "direction": "equal"
              }
            ]
          }
        }
      }
    }
  ],
  "membershipInputParity": [
    {
      "scope": "minimaxai/minimax-m2.7",
      "conclusion": "insufficient-coverage",
      "primary": {
        "metric": "input-token-difference",
        "conclusion": "insufficient-coverage",
        "orderStrata": [
          {
            "pairOrder": "control-first",
            "eligiblePairs": 0,
            "median": null,
            "direction": "unavailable"
          },
          {
            "pairOrder": "changed-first",
            "eligiblePairs": 0,
            "median": null,
            "direction": "unavailable"
          }
        ]
      },
      "allSampleDescriptive": {
        "metric": "input-token-difference",
        "conclusion": "order-sensitive/indeterminate",
        "orderStrata": [
          {
            "pairOrder": "control-first",
            "eligiblePairs": 4,
            "median": -5,
            "direction": "changed-higher"
          },
          {
            "pairOrder": "changed-first",
            "eligiblePairs": 4,
            "median": 1.5,
            "direction": "control-higher"
          }
        ]
      }
    },
    {
      "scope": "minimaxai/minimax-m3",
      "conclusion": "insufficient-coverage",
      "primary": {
        "metric": "input-token-difference",
        "conclusion": "insufficient-coverage",
        "orderStrata": [
          {
            "pairOrder": "control-first",
            "eligiblePairs": 0,
            "median": null,
            "direction": "unavailable"
          },
          {
            "pairOrder": "changed-first",
            "eligiblePairs": 0,
            "median": null,
            "direction": "unavailable"
          }
        ]
      },
      "allSampleDescriptive": {
        "metric": "input-token-difference",
        "conclusion": "descriptive-control-higher-input",
        "orderStrata": [
          {
            "pairOrder": "control-first",
            "eligiblePairs": 4,
            "median": 3,
            "direction": "control-higher"
          },
          {
            "pairOrder": "changed-first",
            "eligiblePairs": 4,
            "median": 1.5,
            "direction": "control-higher"
          }
        ]
      }
    },
    {
      "scope": "mistralai/ministral-14b-latest",
      "conclusion": "insufficient-coverage",
      "primary": {
        "metric": "input-token-difference",
        "conclusion": "insufficient-coverage",
        "orderStrata": [
          {
            "pairOrder": "control-first",
            "eligiblePairs": 0,
            "median": null,
            "direction": "unavailable"
          },
          {
            "pairOrder": "changed-first",
            "eligiblePairs": 0,
            "median": null,
            "direction": "unavailable"
          }
        ]
      },
      "allSampleDescriptive": {
        "metric": "input-token-difference",
        "conclusion": "descriptive-changed-higher-input",
        "orderStrata": [
          {
            "pairOrder": "control-first",
            "eligiblePairs": 4,
            "median": -18.5,
            "direction": "changed-higher"
          },
          {
            "pairOrder": "changed-first",
            "eligiblePairs": 4,
            "median": -20.5,
            "direction": "changed-higher"
          }
        ]
      }
    },
    {
      "scope": "qwen/qwen2.5-7b-instruct",
      "conclusion": "insufficient-coverage",
      "primary": {
        "metric": "input-token-difference",
        "conclusion": "insufficient-coverage",
        "orderStrata": [
          {
            "pairOrder": "control-first",
            "eligiblePairs": 0,
            "median": null,
            "direction": "unavailable"
          },
          {
            "pairOrder": "changed-first",
            "eligiblePairs": 0,
            "median": null,
            "direction": "unavailable"
          }
        ]
      },
      "allSampleDescriptive": {
        "metric": "input-token-difference",
        "conclusion": "order-sensitive/indeterminate",
        "orderStrata": [
          {
            "pairOrder": "control-first",
            "eligiblePairs": 4,
            "median": 4,
            "direction": "control-higher"
          },
          {
            "pairOrder": "changed-first",
            "eligiblePairs": 4,
            "median": -2,
            "direction": "changed-higher"
          }
        ]
      }
    },
    {
      "scope": "zai-org/glm-4.7",
      "conclusion": "insufficient-coverage",
      "primary": {
        "metric": "input-token-difference",
        "conclusion": "insufficient-coverage",
        "orderStrata": [
          {
            "pairOrder": "control-first",
            "eligiblePairs": 0,
            "median": null,
            "direction": "unavailable"
          },
          {
            "pairOrder": "changed-first",
            "eligiblePairs": 0,
            "median": null,
            "direction": "unavailable"
          }
        ]
      },
      "allSampleDescriptive": {
        "metric": "input-token-difference",
        "conclusion": "descriptive-control-higher-input",
        "orderStrata": [
          {
            "pairOrder": "control-first",
            "eligiblePairs": 4,
            "median": 6,
            "direction": "control-higher"
          },
          {
            "pairOrder": "changed-first",
            "eligiblePairs": 4,
            "median": 4,
            "direction": "control-higher"
          }
        ]
      }
    },
    {
      "scope": "pooled",
      "conclusion": "insufficient-coverage",
      "primary": {
        "metric": "input-token-difference",
        "conclusion": "insufficient-coverage",
        "orderStrata": [
          {
            "pairOrder": "control-first",
            "eligiblePairs": 0,
            "median": null,
            "direction": "unavailable"
          },
          {
            "pairOrder": "changed-first",
            "eligiblePairs": 0,
            "median": null,
            "direction": "unavailable"
          }
        ]
      },
      "allSampleDescriptive": {
        "metric": "input-token-difference",
        "conclusion": "order-sensitive/indeterminate",
        "orderStrata": [
          {
            "pairOrder": "control-first",
            "eligiblePairs": 20,
            "median": 0,
            "direction": "equal"
          },
          {
            "pairOrder": "changed-first",
            "eligiblePairs": 20,
            "median": -0.5,
            "direction": "changed-higher"
          }
        ]
      }
    }
  ],
  "responseIdAudit": {
    "reported": 480,
    "distinct": 480,
    "duplicateHashes": 0,
    "duplicateObservations": 0,
    "crossRequestBodyDuplicateHashes": 0,
    "crossRequestBodyDuplicateObservations": 0
  }
}
```
<!-- cache-stable-tools-independent-verifier:end -->
