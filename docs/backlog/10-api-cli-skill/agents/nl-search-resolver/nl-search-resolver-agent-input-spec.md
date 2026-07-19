# NL-Search Resolver — Input Specification

> Agent type: **Extractor / pipeline step** (no tools). Runs inside n8n workflow
> `f10-nl-search`, between the webhook and the deterministic executor (`lib/f10/`).
> Design: `docs/backlog/10-api-cli-skill/design.md` §5.3.

## n8n variable

User message carries a single interpolated variable:

```
{{ $json.resolverInput }}
```

built by the Code node immediately upstream of the LLM node.

## Structure

```jsonc
{
  "query": "technical founder, Berlin, AI infra, no prior VC backing",

  // The live corpus catalogue, assembled fresh on every call. This is what
  // lets the resolver know what is answerable at all -- it is NOT static.
  "catalogue": {
    "claim_topics": [
      { "topic": "founder.leadership.written_communication", "rows": 124 },
      { "topic": "founder.expertise.unasked_work",           "rows": 98  },
      { "topic": "founder.expertise.vertical_tenure",        "rows": 73  },
      { "topic": "founder.execution.provenance",             "rows": 73  },
      { "topic": "founder.execution.live_product",           "rows": 71  },
      { "topic": "founder.expertise.insight_specificity",    "rows": 66  },
      { "topic": "founder.execution.external_usage",         "rows": 34  },
      { "topic": "founder.execution.merged_pr_foreign",      "rows": 33  },
      { "topic": "founder.execution.commit_consistency",     "rows": 25  },
      { "topic": "company.sector",                           "rows": 9   },
      { "topic": "company.geography_country",                "rows": 8   }
      // … every topic present in `claims`, with its live row count
    ],
    "structural_fields": [
      { "field": "companies.hq_country",       "filled": 0,  "total": 198 },
      { "field": "companies.category",         "filled": 7,  "total": 198 },
      { "field": "founders.location_country",  "filled": 0,  "total": 122 }
    ],
    "vocabularies": {
      "sector":            ["b2b-software","ai-infra","devtools","fintech","healthtech",
                            "consumer","marketplace","gambling","adtech","other"],
      "geography_region":  ["EU","US","UK","APAC","LATAM","MEA","other"],
      "stage":             ["pre_seed","seed"],
      "stage_evidence":    ["idea","prototype","early_revenue","scaling"],
      "business_model":    ["b2b","b2c","b2b2c","marketplace","open_source","unknown"]
    },
    "metric_kinds": ["gh_stars","gh_commit_weeks","gh_merged_prs","hn_points","site_updated",
                     "gh_followers","gh_notable_followers","gh_forks","gh_dependents",
                     "hn_karma","hn_comments","hn_author_replies"]
  }
}
```

## Field rules

| Field | Required | Constraint |
|---|---|---|
| `query` | yes | 1–500 chars, any language. Empty/whitespace → resolver returns the `empty_query` error shape. |
| `catalogue.claim_topics` | yes | Live. `rows` is the actual count; a topic absent from this list does not exist in the corpus. |
| `catalogue.structural_fields` | yes | `filled` is what makes a structural target viable — a field with `filled: 0` is unusable and its attributes must be `unresolvable`. |
| `catalogue.vocabularies` | yes | Closed sets from `lib/f07/vocabulary.js`. The resolver may only emit values from these sets for the matching attribute. |
| `catalogue.metric_kinds` | yes | Legal targets for `velocity` attributes. |

## Why the catalogue is passed, not memorised

The corpus changes as features 02 and 08 ingest. A resolver with a hard-coded topic list would keep
emitting targets that no longer exist (or miss ones that appeared), and the failure is silent —
an attribute quietly matching nothing looks identical to an attribute that legitimately found
nothing. Passing live counts makes "there is no data source for this" a decision the resolver can
make explicitly, and the executor re-checks it independently (design §5.4 rule 3b).

## Upstream / downstream

- **Upstream:** `f10-nl-search` webhook → Code node "build resolver input" (queries the catalogue
  via PostgREST, caches per execution).
- **Downstream:** the plan goes to the deterministic executor. The executor **re-validates every
  target** against the same catalogue and drops anything outside the documented taxonomy — the
  resolver is never trusted to be correct, only to be helpful.
