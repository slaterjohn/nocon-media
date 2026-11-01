# @nocon/discovery

Deterministic recommendation scoring. No AI, no network; same input -> same output.

- `tokenize(text)` -> lowercase unicode letter/digit tokens, English stopwords and tokens under 3 chars dropped, deduped in order.
- `buildProfile(items)` -> `{termWeights, channelAffinity (0..1, relative to top channel), durationMedian, totalWeight}` from `{title,tags,categories,channelId,durationSeconds,weight}`.
- `scoreCandidate(candidate, profile, {now, preferredMaxDuration?, seed?})` -> `{score 0..1, components, explanation[]}`.
- `selectWithinBudget(scored, budget, estimateBytes, now?)` -> `{accepted, rejected:[{item, reason}]}`; order is score desc then id. Reasons: `below-min-score`, `too-long`, `too-old`, `max-items`, `max-bytes`.
- `nextDepth(seedDepth, maxDepth)` -> next depth or `null`; hard cap 2.
- `buildSearchQueries(seed, max=2)` -> short keyword queries.

## Score weights (`WEIGHTS`)

| Component | Weight | Meaning |
|---|---|---|
| topic | 0.35 | candidate tags/categories matching profile terms (three strong matches saturate) |
| channel | 0.20 | channel affinity from history |
| history | 0.15 | cosine similarity of title/description/meta terms to the whole profile |
| recency | 0.10 | `exp(-ageDays/180)`; unknown date = 0.5 |
| duration | 0.10 | 1 within [0.5x, 2x] of median, tapering outside; 0 above `preferredMaxDuration`; unknown = 0.5 |
| library | 0.10 | overlap with the seed item that led to the candidate (0 without a seed) |
