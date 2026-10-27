# Ventures

A venture is a thing you run: a product, a program, a community, a brand, a platform. It is a row in the tracker plus a folder in your vault.

| Piece | Where | Notes |
|---|---|---|
| The row | `ventures` table, `cli-projects venture`, `/api/ventures`, `/ventures` | slug, name, kind, summary, optional parent, optional division, `home_path`, goal codes, links |
| The folder | `home_path`, under `Areas/` (ongoing) or `Projects/` (a new startup) | The database is the source of truth for where it is, so a venture can move buckets without a migration |
| Projects | `projects.venture_slug` (`cli-projects set <project> --venture <slug>`) | A project builds one venture |

## Folder layout

```
<home_path>/
  README.md     front page; the only required file
  brand/        brand.md (tokens + voice), logo/, fonts/, images/
  kpis.md       generated from the database; never edit by hand
  docs/         design, research, strategy
```

`cli-projects venture-scaffold <slug>` (or the button on the venture page) creates `README.md` and `brand/brand.md` from a template and never overwrites a file.

## Rules that keep the engine generic

1. The engine names no venture or division. Slugs are data.
2. `kind` comes from `ventures.kinds` in `secondbrain.json`; the defaults are product, program, community, brand, platform.
3. Divisions are optional. A venture may have none.
4. Ventures nest one level: an umbrella and its children. A child cannot have children.
5. Brand is a file, not a schema. `brand.md` frontmatter holds plain keys (a `palette` map, `fonts`, `voice`, anything). The engine reads what is there and requires none.

## For skills and scripts

`cli-projects venture-brand <slug>` prints the brand tokens, body and asset paths as JSON (`--format md` for text). A skill that needs colors or fonts for "whichever venture it is working on" should read this, not hardcode values.

## KPIs

Add `"venture": "<slug>"` to a metric in `secondbrain.json`. `cli-projects venture-kpis` writes `<home_path>/kpis.md` from the latest samples, only when the numbers changed.
