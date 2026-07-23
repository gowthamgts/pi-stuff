# Pi extensions

A collection of pi extensions. Each extension lives in its own independently installable package under [`extensions/`](./extensions).

## Extensions

| Extension | Description |
| --- | --- |
| [`codex-fast-mode`](./extensions/codex-fast-mode) | Controls fast and standard modes for supported OpenAI Codex models. |
| [`silicon-valley`](./extensions/silicon-valley) | Displays a random *Silicon Valley* quote when a pi session starts. |

## Install

Install every extension in this collection:

```sh
pi install .
```

Install one extension from this checkout:

```sh
pi install ./extensions/codex-fast-mode
pi install ./extensions/silicon-valley
```

Install a published extension from npm:

```sh
pi install npm:@gowthamgts/pi-codex-fast-mode
pi install npm:pi-silicon-valley
```

## Add an extension

Create a separate directory for every extension:

```text
extensions/
└── my-extension/
    ├── index.ts
    ├── package.json
    ├── README.md
    ├── LICENSE
    └── tests/
```

Name publishable packages `@gowthamgts/<package-name>`, configure public scoped publishing, include the repository metadata and Pi's required `pi-package` discovery keyword, use the MIT license by default, and add the extension package to the table above.

## Development

Run checks across all extension workspaces:

```sh
pnpm test
pnpm run check:load
```
