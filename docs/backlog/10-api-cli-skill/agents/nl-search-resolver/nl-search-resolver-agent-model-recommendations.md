# NL-Search Resolver — Model Recommendations

> Prices from `internal/research/openai/02-models.md` (measured 2026-07-18, our project key,
> Tier 4: 10 000 RPM; Luna 10M TPM, Sol/Terra 4M TPM). All three 5.6 tiers share a 1.05M context
> window, 128K max output and a 2026-02-16 cutoff — **tier choice here is about cost and
> instruction-following, not about context**.

## Token budget per call

| Component | Tokens | Note |
|---|---|---|
| System prompt | ~3 000 | Stable across every call — the cacheable prefix |
| `catalogue` block | ~900 | ~40 claim topics with counts, structural fill counts, 5 closed vocabularies, 12 metric kinds |
| `query` | ~30 | 1–500 chars |
| **Input total** | **~3 950** | |
| Output (plan, 4–6 attributes + unresolvable) | ~350 | Bounded by `maxItems: 12` on both arrays |

The catalogue is assembled fresh per call and therefore sits *after* the stable system prompt —
which is the right order for prefix caching.

## Cost per call

| Model | Input /1M | Cached /1M | Output /1M | Uncached | With prefix cache |
|---|---|---|---|---|---|
| **`gpt-5.6-luna`** ⭐ | $1.00 | $0.10 | $6.00 | **$0.0061** | **$0.0034** |
| `gpt-5.6-terra` | $2.50 | $0.25 | $15.00 | $0.0151 | $0.0084 |
| `gpt-5.6-sol` | $5.00 | $0.50 | $30.00 | $0.0303 | $0.0169 |

At the demo volume this feature will ever see (tens of calls), the entire line item is **well under
one dollar on any tier**. Cost is not the deciding factor; it is listed so the choice is auditable.

⚠️ **Cache write costs 1.25× uncached input** (changed in the 5.6 line — writing to cache used to
be free). With a stable system prefix and ~40 calls the cache pays for itself after roughly the
second call; below that, caching is a small net loss. Not worth engineering around at this volume.

## Recommendation: `gpt-5.6-luna`

The task is exactly what the Luna tier is documented for — *«чёткие повторяемые задачи: экстракция,
классификация, трансформация, структурированные сводки»*. This resolver classifies fragments and
maps them onto a closed catalogue; it does no open-ended reasoning, produces no prose, and its
output is schema-constrained. Luna also carries the highest TPM ceiling of the three (10M).

Do **not** read Luna as a weak nano-tier model: per the same research it outscores Opus 4.8 on the
Coding Agent Index, and its context and cutoff are identical to Sol.

### Parameters

| Parameter | Value | Why |
|---|---|---|
| `temperature` | **omit entirely** | ⚠️ `gpt-5.6-luna` returns **HTTP 400** for `temperature: 0` — *«Unsupported value: 'temperature' does not support 0 with this model»* (TRACKER tooling changelog, 2026-07-19 ~05:10). Do not send `0`, and do not send `1` "to be safe" — omit the parameter. Feature 03's agent specs still say "temperature 0" in prose; that prose is stale. |
| Structured output | **on**, against `nl-search-resolver-agent-json-schema.json` | The schema is the contract; validation at the tool-call layer means the model retries on mismatch instead of the executor receiving garbage |
| `reasoning_effort` | `low` | Classification against an explicit catalogue; higher effort buys nothing and costs latency in a webhook the CLI waits on |
| `max_output_tokens` | 1 200 | Comfortably above the ~350 typical; both output arrays are capped at 12 items |
| Retries | 1, then `resolver_failed` | Design §5.8. A second malformed response is a real failure, not noise to paper over |

### Determinism note

Because `temperature: 0` is unavailable, **the resolver is not bit-deterministic** — the same query
can yield slightly different `attributes`. This is precisely why the design moved ranking weights
out of the model and into a fixed table in `lib/f10/` (design §5.4, review finding B4): the plan may
vary at the margins, but the *scoring* of any given plan is fully reproducible, so a judge running
the demo query twice sees a stable ranking rather than two different orders.

### When to escalate to Terra

Only on evidence, not on suspicion. Escalate if QA finds the resolver systematically either
(a) inventing targets absent from the catalogue, or (b) resolving negatives whose subject matter the
corpus never records — the two failure modes the prompt's restriction section is built around, and
the two that damage output quality rather than merely degrading it. At ~$0.008/call Terra is
affordable; the reason to prefer Luna is latency inside a synchronous webhook, not money.
