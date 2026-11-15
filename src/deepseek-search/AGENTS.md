# DeepSeek Search maintenance

During upgrades and maintenance, check the latest official
[Search API](https://api-docs.deepseek.com/api/search/),
[Fetch API](https://api-docs.deepseek.com/api/fetch/), and
[usage guide](https://api-docs.deepseek.com/guides/search/).
Also review the latest DeepSeek Harness
[tool-web](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/web/tool-web/src),
[web-deepseek-api](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/web/web-deepseek-api/src),
and [timeout policy](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/guard/timeout-policy/src).

Compare upstream changes against the version last checked in `README.md`.
Update that reference after verifying alignment with DSH. Keep authentication
integrated with Pi and update the contract tests when tool behavior changes.

For request or response changes, verify a real Search and Fetch call through
the built entry point using Pi's credentials. Keep credentials out of output.
