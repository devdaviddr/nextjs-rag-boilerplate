# Person review of drafted grades

**What this covers:** how to review the Claude-drafted answer grades yourself,
and what the import does with that sheet. The grades are the gold labels for
the model judge.

29 answers in [`eval/graded/`](../eval/graded/) were graded by Claude and are
still unreviewed. Until a person imports a review, `pnpm rag:judge` has no
gold labels. The rubric is [Grading answers](rag.md#grading-answers).
Faithfulness is 0, 1 or 2 on each factual sentence. Completeness is 0, 1 or 2
for the whole answer.

The blank sheet is already in the repo:
[`eval/review/person-review.csv`](../eval/review/person-review.csv) and
[`eval/review/person-review.html`](../eval/review/person-review.html).

## How long

Most of the 29 are one source and one claim, about two minutes each. The
three summaries are longer. `summary-contractor-manual-closing` is the slow
one: 12 claims and 24 sources. Plan on about 90 minutes to two hours.

## Steps

1. Open `eval/review/person-review.html` in a browser. Each item has the
   question, the retrieved sources, the model answer, and Claude's draft
   grade and rationale. The HTML is for reading. It has no person grades.

2. Open `eval/review/person-review.csv` in a spreadsheet and save it as CSV
   (UTF-8). One row per item. These columns start empty, and they are the
   only ones to edit:

   - `agree` — `agree` or `disagree`
   - `person_faithfulness` and `person_completeness` — the person grade
   - `notes` — optional

3. For each row:

   - **agree** — you accept Claude's scores. Leave `person_faithfulness` and
     `person_completeness` empty.
   - **disagree** — set `person_completeness` to `0`, `1` or `2`. If
     `draft_claims` lists claims, set `person_faithfulness` to one score per
     claim, in that order (`2,0`) or with the sentence numbers
     (`S1:2,S2:0`). Copy `draft_claims` and change the scores. If
     `draft_claims` is empty, leave `person_faithfulness` empty too.

4. Do not edit `draft_claims` or `draft_completeness`. The import checks them
   against `eval/graded/` and stops if a row no longer matches its draft.

5. Save the CSV, then run:

```bash
pnpm rag:review:import
```

The default grader name is Daniel. Pass `--grader "Name"` to record someone
else.

## What the import checks

Every drafted item must appear once. `agree` must be `agree` or `disagree`.
A disagree row must have a completeness of 0, 1 or 2, and a faithfulness
score of 0, 1 or 2 for every drafted claim. An agree row must leave the
person-grade columns empty.

If anything fails, the command prints each problem and writes nothing.

## What happens after

A valid sheet does three things:

- Writes your grade to `personGrade` on each `eval/graded/<id>.json`, with
  `reviewed: true`. Agree copies the draft scores. Disagree stores the
  scores you typed. Your notes go in `reviewNotes`.
- Leaves Claude's draft in `grade`, including `reviewed: false`.
- Writes `eval/review/agreement-report.md`. The judge in that report is the
  Claude draft. The gold label is your grade. It gives percent agreement,
  Cohen's kappa, and a confusion table (your grade down the rows, the draft
  across the columns) for answer-level faithfulness, completeness, and
  claim-level faithfulness.

`personGrade` is what `pnpm rag:judge` reads. That command scores the model
judge against your grades and reports the same figures, against the 80%
target in [A model judge](rag.md#a-model-judge). It calls a model. The import
does not.

Commit the updated `eval/graded/*.json` files and the agreement report when
you are happy with them. Issues #119 and #120 stay open until this review is
done and the model judge has been checked against it.

To rebuild a blank sheet from the drafts:

```bash
pnpm rag:review:export
```

That refuses to overwrite a CSV that already has responses. `--force`
overwrites the sheet only. It does not change grades already imported.
