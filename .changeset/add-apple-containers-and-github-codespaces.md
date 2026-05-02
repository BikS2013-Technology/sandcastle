---
"@ai-hero/sandcastle": patch
---

Add apple-containers and github-codespaces sandbox providers.

The `apple-containers` provider drives Apple's native `container` CLI on Apple-Silicon macOS hosts via bind-mounts (mirroring docker/podman) and is exposed under `sandcastle apple-containers build-image|remove-image`. The `github-codespaces` provider drives a GitHub Codespace from outside via the `gh` CLI in either `existing` or `managed` mode, supporting `merge-to-head` and `branch` strategies; it ships with a `sandcastle github-codespaces verify` command. Both providers are registered as selectable options in `sandcastle init`.
