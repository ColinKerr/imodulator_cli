# Coding style

- avoid generic file names like index.ts or app.ts except for their standard purpose like the main entry point for an application.
- prefer the use of the latest stable version of a package over an older version.
- Avoid odd numbered versions of Node.js.
- Rely on auth package to store auth tokens securely.
- Store the `--imodel-id` parameter in a variable named `imodelId`.
- Store the `--itwin-id` parameter in a variable named `itwinId`.
- Prefer use of ECSql over Sql where possible
- Do not put excessive explanatory comments in the code.  Instead use well defined function names and clean code with comments calling out exceptional things.  Use plan markdown files to describe architecture or theory if necessary.  