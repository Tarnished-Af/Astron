# Describing your course

Everything specific to a college lives in one JSON file: the years, the subjects and labs in each, their units, and the syllabus. Point `CATALOG` in `.env` at your file and restart. No code changes.

Start by copying `config/catalog.example.json`. A full real one is in `config/catalog.btu-cse.json` if you'd rather see a finished version.

```
CATALOG=/opt/astron/catalog.json
```

The file has a few descriptive fields, then five parts: `current`, `years`, `palette`, `subjects` and `syllabus`.

---

## About the course

```json
"course": "B.Tech Computer Science",
"institution": "Your University",
"syllabusNote": "effective 2021-22"
```

All optional, all shown to people using the site:

| Field | Where it appears |
|---|---|
| `course` | Beside the site name on the year page, and in the AI's instructions so answers suit your course |
| `institution` | The syllabus pages, and the line under each syllabus |
| `syllabusNote` | Appended to that line, e.g. "effective 2021-22" |

They can be edited from the **Manage course** page, under "About this course".

## current

Which year and semester everyone is in right now. Later years show as "starts later" until you move this on.

```json
"current": { "y": 1, "sem": 1 }
```

## years

```json
"years": [
  { "y": 1, "label": "1st year", "sems": [1, 2], "c1": "#FF8A5B", "c2": "#FF5C8A" }
]
```

| Field | Meaning |
|---|---|
| `y` | Year number, used to group subjects |
| `label` | What's shown on screen |
| `sems` | The semesters in that year |
| `c1`, `c2` | Two colours for the year's banner. Optional. |

A three-year degree just has three entries. Semesters can be numbered however your college does it.

## groups

The categories subjects are filed under. Leave this out and you get Subjects and Labs.

```json
"groups": [
  { "id": "subjects", "label": "Subjects", "type": "theory", "word": "Unit" },
  { "id": "labs",     "label": "Labs",     "type": "lab",    "word": "Experiment" },
  { "id": "projects", "label": "Projects", "type": "theory", "word": "Milestone" }
]
```

| Field | Meaning |
|---|---|
| `id` | Short key, referenced by a subject's `group` |
| `label` | Heading shown in the sidebar and on the year page |
| `type` | `theory` gives Notes / Homework / Raw tabs; `lab` gives Lab work / Notes / Raw |
| `word` | What its parts are called: Unit, Experiment, Module, Session… |

Add, rename and remove them on the **Manage course** page, under Categories.

## palette

Named colour pairs that subjects pick from, so everything stays consistent:

```json
"palette": {
  "coral": ["#FF8A5B", "#FF5C8A"],
  "sky":   ["#4FB3FF", "#6C7BFF"]
}
```

Optional — leave it out and a built-in set is used.

## subjects

One entry per subject **and** per lab.

```json
{
  "id": "maths",
  "y": 1,
  "name": "Engineering Mathematics",
  "short": "Maths",
  "b": "M",
  "p": "coral",
  "code": "MA 101",
  "sems": [1, 2],
  "type": "theory",
  "units": ["Matrices", "Differential calculus", "Integral calculus"]
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Short unique key, lowercase letters and numbers. **Don't change it later** — uploaded files point at it. |
| `y` | yes | Which year |
| `name` | yes | Full name |
| `short` | no | Name in the sidebar. Defaults to `name`. |
| `b` | no | One or two letters for the badge. Labs show a flask instead. |
| `p` | no | Palette colour name |
| `code` | yes | Course code. Also links to the syllabus (see below). |
| `sems` | yes | Which semesters it runs in (1 to 20, so five-year and integrated courses work) |
| `type` | yes | `theory` or `lab` |
| `el` | no | Elective group name, e.g. `"Elective 1"`. Subjects sharing a name are shown as "pick one". |
| `group` | no | Which category it belongs to. Defaults by `type`. |
| `hidden` | no | `true` keeps it off the site without deleting it or its files |
| `sample` | no | `true` marks it as a placeholder you haven't filled in yet |
| `exam` | no | `["Mid-sem II", "24 Sep"]` shows in "Coming up" |
| `units` | no | The units, in order. Labs call these experiments. |

**Labs** use `"type": "lab"`, which changes three things: units are called experiments, the tabs become Lab work / Notes / Raw, and the badge is a flask.

### Units that differ by semester

If a subject runs across two semesters with different content, give `units` as an object keyed by semester:

```json
"units": {
  "1": ["Matrices", "Differential calculus"],
  "2": ["Laplace transforms", "Fourier series"]
}
```

Leave `units` out entirely and you get five numbered placeholders you can fill in later.

## syllabus

Keyed by course code, so a subject with `"code": "MA 101"` shows the entry under `"MA 101"`. A subject spanning two semesters can use `"code": "1FY1-01 / 2FY1-01"`, and each part is matched by its leading digit.

```json
"MA 101": {
  "title": "Engineering Mathematics-1",
  "credit": "4",
  "ltp": "3L + 1T + 0P",
  "marks": [30, 70],
  "exam": 3,
  "note": "Perform any eight, as your institute decides.",
  "co": ["Solve problems on partial differentiation.", "..."],
  "rows": [
    { "n": 1, "h": 8, "head": "Differential Calculus-I", "topics": "Asymptotes, curvature, curve tracing." },
    { "n": 2, "h": 6, "head": "Introduction", "topics": "Objective and scope.", "intro": true }
  ],
  "weeks": [["Week 1", "Projection of points", 2]],
  "books": ["Author, Title, Publisher."]
}
```

| Field | Meaning |
|---|---|
| `title` | Official course title |
| `credit` | Credits, as text |
| `ltp` | Weekly hours, e.g. `3L + 1T + 0P` |
| `marks` | `[internal, end-term]` |
| `exam` | Exam length in hours |
| `co` | Course outcomes, one per line |
| `rows` | Units: `n` number, `h` hours, `head` heading, `topics` the detail. `intro: true` greys out filler rows like "objective and scope". |
| `weeks` | Optional weekly exercise table: `[when, topic, marks]` |
| `books` | Suggested reading |
| `note` | A line shown in bold, e.g. how many experiments to perform |

For a **lab**, put each experiment as a row with just `head` and no `h`.

Any subject with no syllabus entry simply shows "Syllabus not added yet". You can add them one at a time.

---

## Starting from someone else's catalog

The **Manage course** page has Import and Export buttons. Export downloads your catalog as JSON, ready to share or commit; Import loads one in as a draft, so you can look it over before saving.

## A note on files

Notes, homework and lab work belong to a unit. **Question papers belong to the subject**, so they appear under the Question papers tab rather than inside any unit.

## Checking your file

```bash
node -e "const c=require('./config/catalog.json');
console.log(c.subjects.length,'subjects,',Object.keys(c.syllabus||{}).length,'syllabus entries');
const bad=c.subjects.filter(s=>!s.id||!s.code||!s.sems||!s.y);
console.log(bad.length?'missing fields in: '+bad.map(s=>s.name):'all subjects have the required fields');"
```

The server also prints how many subjects it loaded on startup, and says so plainly if the file can't be read:

```
Catalog: 12 subjects and labs from catalog.json
```

## Changing it later

Adding subjects, units or syllabus entries at any time is fine — restart and they appear.

Two things to be careful with, because uploaded files point at them:

- **Don't change a subject's `id`.** Its files will be orphaned.
- **Don't reorder units.** Files are attached to unit *numbers*, so inserting a unit at position 2 shifts everything below it. Add new units at the end.
