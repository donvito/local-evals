# Configure providers and models

[← README](../README.md) · [Next: set up a run](runs.md)

A target is a named provider endpoint and model. Configure targets in **Providers**, then assign them to evaluation stages in Setup. Local Evals connects to models you supply; it does not download or start model servers.

## Add a target in the app

1. Open **Providers** and fill in the target name, provider type, base URL, and model ID.
2. Enter an API key if the endpoint requires one.
3. Set the capabilities supported by that model and endpoint: Vision, Structured JSON, or Tool calling.
4. Save the target and use its test action to check connectivity.

Choose a vision-capable target for document OCR. Extraction can use a separate text model or the same endpoint. Tool-call evaluations require a model that supports tools.

## Local servers

Start your OpenAI-compatible server first, such as llama.cpp or LM Studio, and use the base URL it exposes, typically ending in `/v1`. Enter the model ID reported by the server.

Example target file, with a placeholder model ID to replace:

```json
{
  "name": "local-vision",
  "provider": "openai-compatible",
  "baseUrl": "http://127.0.0.1:8080/v1",
  "model": "YOUR_MODEL_ID",
  "supportsVision": true,
  "supportsStructuredOutput": false,
  "supportsTools": false
}
```

For llama.cpp, the provider type can be `llama.cpp`. Document OCR also requires a loaded vision model and its matching multimodal projector.

## OpenRouter

Choose OpenRouter and use `https://openrouter.ai/api/v1`. Search the model catalog or enter a model ID manually. Catalog filters include Vision, Structured JSON, Tools, Free, and minimum context size.

Selecting a catalog result fills the model ID and advertised capabilities. Actual behavior still depends on the serving endpoint; schema-constrained JSON requires structured-output support. If runtime preflight indicates incompatibility, the run falls back to `prompted-json` and continues while logging a preflight warning.

For file-based configurations, reference an environment variable:

```json
{
  "name": "openrouter-model",
  "provider": "openrouter",
  "baseUrl": "https://openrouter.ai/api/v1",
  "model": "YOUR_OPENROUTER_MODEL_ID",
  "apiKeyEnv": "OPENROUTER_API_KEY"
}
```

Set that variable in the shell used to launch the app or CLI. Keys entered through the app are encrypted locally in the selected database's credential vault. Keep the database and its `.credentials.key` file together.

## Offline mock targets

Start the included mock in another terminal:

```bash
npm run mock
```

Use provider **OpenAI-compatible**, base URL `http://127.0.0.1:8099/v1`, and model `mock-text-json` or `mock-tool-calling`. Enable Tool calling for the latter. These targets are for the included synthetic fixtures.

## Target commands

```bash
npm run localevals -- target add target.json
npm run localevals -- target list
npm run localevals -- target test local-vision --vision true
```

All commands accept `--db path/to/results.db`. A target saved in one database is available to the dashboard using that database.
