# scripts

Repository maintenance scripts. They are TypeScript files that Node 26 runs directly (built-in type stripping), started through `pnpm` scripts in the root `package.json`.

| Script | Command | What it does |
| ------ | ------- | ------------ |
| [check-licenses.ts](check-licenses.ts) | `pnpm licenses:check` | Fails if a dependency's license isn't allowed. Production dependencies must be permissive (MIT, ISC, BSD, Apache-2.0, 0BSD, BlueOak, CC0, Unlicense). Development dependencies may also be MPL-2.0. Runs in CI. |

To allow a package despite its license, add it to `EXCEPTIONS` in `check-licenses.ts` with the reason, and explain it in the pull request.
