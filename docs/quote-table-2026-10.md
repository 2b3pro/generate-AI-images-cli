| Model | Provider | Billing | USD | Basis | vs routed | Source |
|---|---|---|---|---|---|---|
| nano-banana-2 | atlas | metered | 0.0800 | /calculate 1K 16:9 | 19% |  |
| nano-banana-2 | google (routed) | metered | 0.0670 | list price per image | routed | https://ai.google.dev/gemini-api/docs/pricing (1K, paid tier) (2026-10-04) |
| nano-banana-pro | atlas | metered | 0.1400 | /calculate 1K 16:9 | 4% |  |
| nano-banana-pro | google (routed) | metered | 0.1340 | list price per image | routed | https://ai.google.dev/gemini-api/docs/pricing (1K/2K, paid tier) (2026-10-04) |
| gpt-image-2 | atlas | metered | 0.0577 | /calculate 1K 16:9 | 9% |  |
| gpt-image-2 | codex | plan | 0 marginal (plan limits) | list price per plan limits | n/a |  |
| gpt-image-2 | openai (routed) | metered | 0.0530 | list price per image | routed | https://developers.openai.com/api/docs/guides/image-generation (1024x1024 medium, output only) (2026-10-04) |
| flux-2-pro | atlas | metered | 0.0300 | /calculate 1K 16:9 | 0% |  |
| flux-2-pro | replicate (routed) | metered | 0.0300 | list price per image | routed | https://replicate.com/black-forest-labs/flux-2-pro (0.015 per run + 0.015 per output MP, 1 MP) (2026-10-04) |
| veo-3.1 | atlas | metered | 3.2000 | /calculate 8s 720p | 0% |  |
| veo-3.1 | google (routed) | metered | 3.2000 | list price per second | routed | https://ai.google.dev/gemini-api/docs/pricing (720p/1080p with audio) (2026-10-04) |
| veo-3.1-fast | atlas | metered | 0.6400 | /calculate 8s 720p | -20% |  |
| veo-3.1-fast | google (routed) | metered | 0.8000 | list price per second | routed | https://ai.google.dev/gemini-api/docs/pricing (720p with audio; 1080p is 0.12) (2026-10-04) |
