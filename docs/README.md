# Tazamun documentation

| Folder | What's in it |
| ------ | ------------ |
| [srs/](srs/) | Software Requirements Specification (revision 2). Every requirement has an ID such as `TAB-7` or `SEC-3`. |
| [adr/](adr/README.md) | Architecture Decision Records (0001–0008): the hard-to-reverse decisions and why they were made. |
| [guides/](guides/) | [Server configuration reference](guides/server-configuration.md) (generated). User, self-hosting and contributor guides follow in P1. |

## SRS sections

1. [Introduction](<srs/1. Introduction.md>): purpose, product vision, scope, definitions
2. [Overall Description](<srs/2. Overall Description.md>): architecture, sync model, users, environment, constraints
3. [Software Features](<srs/3. Software Features.md>): functional requirements per feature
4. [External Interface Requirements](<srs/4. External Interface Requirements.md>): UI, browser APIs, HTTP API and record envelope
5. [Other Nonfunctional Requirements](<srs/5. Other Nonfunctional Requirements.md>): performance, security, privacy, reliability
6. [Other Requirements](<srs/6. Other Requirements.md>): licensing, i18n, known limitations, open questions

## Changing the docs

- If code and the SRS disagree, fix one of them in the same pull request.
- A change that contradicts an ADR needs a new ADR that supersedes it. Don't rewrite old ADRs.
- Settling a question an ADR left open is the exception: append a dated section to that ADR, as ADR-0004 does for Q1. Then mark the question decided in [SRS 6.5](<srs/6. Other Requirements.md#65-known-limitations-and-open-questions>).
- Documentation for one app or package lives in that folder's `README.md`, not here.
