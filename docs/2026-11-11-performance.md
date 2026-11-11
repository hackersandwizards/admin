# Performance, 11 November 2026

Measured by the polish since d2481c6 on an Apple-silicon Mac with 16 cores, each pair back to back:
before is `4b0e37e` in a detached worktree, after is `96eed23`. The hub ran on its own port with
the invented `test/fixtures/spoke` as its one repository.

## The table step on committed text

`withElements` on one doc, in ms. The first three are a doc's raw HTML with tags that never close.

| Input                                    | Before, run 1 | After, run 1 | Before, run 2 | After, run 2 |
| ---------------------------------------- | ------------: | -----------: | ------------: | -----------: |
| 40,000 × `<table `                       |          4640 |            0 |          4680 |            0 |
| 40,000 × `<h2 `                          |           908 |            0 |           898 |            0 |
| `<h2>`, 160,000 × `<`, `</h2>`           |          3543 |           11 |          3548 |           10 |
| `<table><tr>`, 40,000 × `<td>` (control) |            13 |           13 |            14 |           13 |

1-minute load average: 14.5, 13.9, 13.9, 13.1.

## Routes

Median of five requests to a built hub, in ms. 1-minute load average 9.7 for both series.

| Route              | Before | After |
| ------------------ | -----: | ----: |
| `/`                |    8.0 |   8.0 |
| `/spoke/dashboard` |    8.5 |   7.5 |
| `/spoke/decisions` |    8.4 |   7.6 |
| `/spoke/work`      |    7.2 |   7.2 |
| `/spoke/reviews`   |    7.0 |   7.7 |
| `/spoke/docs`      |    7.2 |   6.6 |
| `/spoke/log`       |    7.4 |   7.1 |
| `/spoke/checks`    |    7.1 |   6.7 |
| `/architecture`    |    7.2 |   7.0 |

## Lighthouse

Lighthouse 13.6.0, Chrome for Testing 157, headless. Performance, accessibility and best practices
scored 100 before and after on the hub, a repository's decisions and dashboard, and a doc page.
First contentful paint was 1050 to 1200 ms on each, before and after. 1-minute load average 9.8
before, 29.1 after.
