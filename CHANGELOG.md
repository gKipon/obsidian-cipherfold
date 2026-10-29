# Changelog

## 0.1.2

Cancel deferred startup when the plugin is disabled, including disk preflight, metadata preload/clear and lock-preference loading. Do not register late timers or listeners after unload. Persist the user's enabled-plugin list using a strict allowlist of installed plugin IDs, so disabling Cipherfold survives restart without permitting note metadata to leak. Clarify password-change recovery messaging.

## 0.1.1

Local-only password rotation with verified read-back; corrupt enrollment remains fail-closed. Replica response bodies are bounded during streaming and stalled requests are aborted after 90 seconds. Added cancellation/size/UTF-8 and password failure regression coverage.

## 0.1.0

Initial independent Cipherfold community codebase: standalone locked build, English interface and documentation, synthetic regression tests, explicit configuration and documented privacy boundaries. Desktop-only; mobile support is not claimed.
