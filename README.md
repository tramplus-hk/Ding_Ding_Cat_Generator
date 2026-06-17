# Ding Ding Cat Sticker Generator — LLM Prompting Module

Python module for prompt refinement and sticker generation using Gemini via Vercel AI Gateway.

## What this module does

```
User Input → Input Validation → LLM Refinement (Gemini Flash) → Nano Banana 2 → Sticker PNG
```

## Quick Start

```bash
# 1. Create virtual environment
python3 -m venv venv
source venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Set your API key
export AI_GATEWAY_API_KEY="your-vercel-ai-gateway-key"

# 4. Run unit tests
python -m pytest tests/ --ignore=tests/test_live_refinement.py --ignore=tests/test_nano_banana.py --ignore=tests/test_full_pipeline.py

# 5. Run live integration test (uses real API — needs API key + reference images)
python tests/test_live_refinement.py
```

## Module Structure

```
src/llm/
├── refinement_engine.py      ← Main orchestrator
├── input_validator.py        ← Input validation + language detect + content filter
├── context_assembler.py      ← Builds Gemini prompt from festival data + history
├── gemini_client.py          ← Gemini Flash via Vercel AI Gateway (OpenAI SDK)
├── nano_banana_client.py     ← Nano Banana 2 image generation with reference images
├── sticker_generator.py      ← Full pipeline: refinement → image generation
├── safety_filter.py          ← 2-layer safety (keyword + LLM classifier)
├── output_parser.py          ← JSON parsing + trigger word enforcement
├── history_manager.py        ← Atomic JSON I/O for refinement records
└── cache_manager.py          ← In-memory 24h TTL cache

config/
├── festivals.json            ← 12 festivals with prompt templates
├── system_prompt.txt         ← Gemini system prompt (2D vector style, bell/DING DING enforcement)
├── safety_blocklist.yaml     ← Content moderation keywords
├── llm_settings.yaml         ← Model, retry, cache config
└── settings.yaml             ← General app settings
```

## API

```python
from src.llm.sticker_generator import StickerGenerator, find_reference_images_dir

gen = StickerGenerator(
    app_config_dir="./data",
    festivals_config=festivals,
    llm_settings=settings,
    blocklist_config=blocklist,
    ref_images_dir=find_reference_images_dir(),
    output_dir="./output",
)

# Generate a sticker
path, refined_result, warnings = gen.generate("mid-autumn", "cat eating mooncake")

# Generate a batch
paths, refined_result, warnings = gen.generate_batch("christmas", "cat with Santa hat", count=4)
```

## Tests

```bash
# Unit tests (no API key needed)
pytest tests/ --ignore=tests/test_live_refinement.py --ignore=tests/test_nano_banana.py --ignore=tests/test_full_pipeline.py

# Live integration tests (needs API key)
python tests/test_live_refinement.py   # LLM refinement only
python tests/test_nano_banana.py       # Nano Banana image generation only
python tests/test_full_pipeline.py     # Full pipeline: refinement + generation
```
