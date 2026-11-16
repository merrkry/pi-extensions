# DeepSeek Search

`web_search` and `web_fetch` use the official
[DeepSeek Search and Fetch API](https://api-docs.deepseek.com/guides/search/).
They are available with any selected chat model.

The tools are designed to match the behavior of the direct API providers in
DeepSeek Harness (DSH), including the tool interface and model-facing output.
Last checked against DSH
[commit 39163dd](https://github.com/deepseek-ai/deepseek-harness/tree/39163dd30f703a79079e2d2446545cff3c453738/packages/web).

Set `DEEPSEEK_API_KEY` or configure the `deepseek` provider in Pi's `auth.json`.
