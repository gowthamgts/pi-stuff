# AGENTS.md

This repository contains independently installable extensions for the pi coding agent. Detailed implementation, installation, testing, publishing, and licensing information belongs in the root README and each extension's own README.

## Extensions

### Codex fast mode

Location: `extensions/codex-fast-mode`

Enables OpenAI Codex fast mode by default and provides commands to switch between fast and standard modes. It uses the priority service tier in fast mode, leaves unsupported models and non-Codex providers unchanged, persists the selection in the current pi session, and surfaces the selected mode in pi.

Fast mode increases response speed and consumes credits or API tokens at a higher rate. The extension should remain aligned with OpenAI's current fast-mode documentation.

### Silicon Valley

Location: `extensions/silicon-valley`

Displays a random quote from HBO's *Silicon Valley* at the start of each pi session, except during extension reloads. It is an unofficial fan package and should retain its attribution and trademark disclaimer.
