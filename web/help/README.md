# Vendored ECSql reference

`ecsqlreference/` is a verbatim copy of `docs/learning/ecsqlreference` from
[itwinjs-core](https://github.com/iTwin/itwinjs-core), published as
<https://www.itwinjs.org/learning/ecsqlreference/>. It is MIT licensed; the notice is in
`LICENSE.md` and the commit it was taken from is in `PROVENANCE.json`.

It is vendored rather than fetched so the console's help panel works with no network, which
is the normal case for a tool pointed at a local briefcase.

To refresh it from a local checkout:

```
npm run sync:ecsql-help -- ../itwinjs-core
npm run build:web
```

The build renders the markdown into `web/public/help/ecsql-reference.html` (generated, not
committed) and **fails if any link in the docs no longer resolves**, so a heading renamed
upstream is caught then rather than found later as a dead anchor. Links that are already
broken upstream are listed in `build/ecsql-help.ts`.
