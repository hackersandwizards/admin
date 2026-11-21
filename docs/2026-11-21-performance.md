# Performance, 21 November 2026

The blank-heading repair was measured against `7816d1fb9` in a detached worktree. Both local
servers used the same installed dependencies and the invented spoke fixture. The route series
started at a 1-minute load average of 3.25.

Each cell is the median of five warm samples, in milliseconds. Response time includes reading
the body. Render time runs from browser navigation through two animation frames after page load.

| Route                                                | Response before | Response after | Render before | Render after |
| ---------------------------------------------------- | --------------: | -------------: | ------------: | -----------: |
| `/`                                                  |             9.1 |            9.0 |          56.3 |         55.6 |
| `/architecture`                                      |             9.3 |            9.4 |          55.0 |         55.2 |
| `/missing-fixture-page`                              |             9.8 |           10.1 |          54.5 |         55.5 |
| `/spoke/dashboard`                                   |             8.9 |            8.9 |          55.9 |         55.8 |
| `/spoke/decisions`                                   |             9.0 |            9.3 |          69.8 |         56.3 |
| `/spoke/work`                                        |             9.0 |            8.5 |          57.4 |         55.4 |
| `/spoke/reviews`                                     |             8.9 |            8.7 |          57.7 |         72.6 |
| `/spoke/docs`                                        |             9.1 |            8.8 |          56.1 |         55.8 |
| `/spoke/catalog`                                     |             9.1 |            8.8 |          55.7 |         56.3 |
| `/spoke/products-1`                                  |             9.0 |            9.1 |          57.1 |         55.6 |
| `/spoke/architecture`                                |             8.8 |            8.8 |          56.0 |         56.7 |
| `/spoke/checks`                                      |             8.9 |            8.8 |          55.6 |         56.0 |
| `/spoke/log`                                         |             8.6 |            8.6 |          56.1 |         56.3 |
| `/spoke/doc/docs/agent-work/2026-01-15-sample-topic` |             9.1 |            8.9 |          56.7 |         55.2 |
| `/catalog/`                                          |             0.4 |            0.4 |         114.4 |        114.5 |

Lighthouse 13.6.0 on headless Chrome for Testing 157.0.8103.50 scored 100 for performance on
all 14 successful page types in both builds. First contentful paint rounded to 1,050 ms for
the hub and spoke pages and 1,200 ms for the engine catalog. The 1-minute load ranged from
3.61 to 5.42 across the paired audits. The missing-page route returned the expected HTTP 404
and has browser timings in the table.

The largest render differences were on decisions and reviews. One series on one fixture does
not establish whether those differences repeat. The warm response medians were within 0.5 ms.
