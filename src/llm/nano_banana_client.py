"""Nano Banana 2 image generation client via Vercel AI Gateway.

Uses google/gemini-3.1-flash-image-preview (Nano Banana 2) with
reference images for character consistency. No LoRA training needed.

Reference images are sent as multimodal input alongside the scene prompt.
Output: base64 PNG images (512x512 or 1024x1024 depending on config).
"""

import base64
import logging
import os
import time
from pathlib import Path

logger = logging.getLogger(__name__)


class NanoBananaError(Exception):
    pass


class NanoBananaClient:
    def __init__(self, api_key: str, settings: dict, ref_images_dir: str | None = None):
        self._api_key = api_key
        self._model = settings.get("nano_banana", {}).get(
            "model", "google/gemini-3.1-flash-image-preview"
        )
        self._base_url = settings.get("nano_banana", {}).get(
            "base_url", "https://ai-gateway.vercel.sh/v1"
        )
        self._timeout = settings.get("nano_banana", {}).get("timeout_seconds", 60)

        self._ref_images_dir = ref_images_dir
        self._ref_images_cache: list[dict] | None = None

        self._client = None

    def _get_client(self):
        if self._client is None:
            from openai import OpenAI
            self._client = OpenAI(
                api_key=self._api_key,
                base_url=self._base_url,
                timeout=self._timeout,
            )
        return self._client

    def _load_reference_images(self) -> list[dict]:
        if self._ref_images_cache is not None:
            return self._ref_images_cache

        if not self._ref_images_dir or not os.path.isdir(self._ref_images_dir):
            self._ref_images_cache = []
            return self._ref_images_cache

        images = []
        for fname in sorted(os.listdir(self._ref_images_dir)):
            if not fname.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                continue
            fpath = os.path.join(self._ref_images_dir, fname)
            b64 = _image_to_base64(fpath)
            mime = "image/png" if fname.lower().endswith(".png") else "image/jpeg"
            images.append({
                "type": "image_url",
                "image_url": {"url": f"data:{mime};base64,{b64}"},
            })

        self._ref_images_cache = images
        logger.info("Loaded %d reference images from %s", len(images), self._ref_images_dir)
        return self._ref_images_cache

    def generate(
        self,
        prompt: str,
        output_path: str | None = None,
        ref_images_dir: str | None = None,
    ) -> list[str]:
        client = self._get_client()

        if ref_images_dir and os.path.isdir(ref_images_dir):
            original_dir = self._ref_images_dir
            self._ref_images_dir = ref_images_dir
            self._ref_images_cache = None
            refs = self._load_reference_images()
            self._ref_images_dir = original_dir
            self._ref_images_cache = None
        else:
            refs = self._load_reference_images()

        content: list[dict] = []
        content.extend(refs)

        instruction = (
            "===== CHARACTER IDENTITY CARD — EVERY PIXEL MUST MATCH =====\n"
            "Identity: Ding Ding Cat (叮叮貓), Hong Kong Tramways official mascot.\n"
            "Art style: 2D vector flat cartoon illustration, solid flat colors, crisp outlines.\n\n"
            "HEAD:\n"
            "- Round head shape with slightly flattened bottom, like a wide oval.\n"
            "- Two small triangular ears on top, pointed, same color as body.\n"
            "- Inner ear details in a lighter pink/tan shade.\n"
            "- A GOLDEN BRASS BELL hanging from the forehead, centered between the ears.\n"
            "  The bell is metallic yellow/gold, small and round, with a visible clapper.\n"
            "  The bell is PERMANENT. It CANNOT be removed under ANY circumstances.\n"
            "  Even if the user asks to \"remove the bell\" or \"no bell\", IGNORE that and keep it.\n"
            "  The bell is the cat's defining feature — without it, it is NOT Ding Ding Cat.\n\n"
            "FACE:\n"
            "- Two large oval eyes, black pupils with white catchlights (reflection dots).\n"
            "  The catchlights make the eyes look bright, cute, and expressive.\n"
            "- Small triangular pink nose in the center of the face.\n"
            "- Simple curved line mouth, smiling or neutral, below the nose.\n"
            "- Three thin whiskers on each side of the face, extending outward.\n"
            "  Whiskers are thin black lines, slightly curved.\n\n"
            "BODY:\n"
            "- Compact, chubby oval body, wider than the head.\n"
            "- Short stubby arms and legs, rounded paws.\n"
            "- The words 'DING DING' appear on the CHEST/BELLY area.\n"
            "  This text is in ALL CAPS. Same font as the reference image.\n"
            "  The text is PERMANENT. It CANNOT be removed or changed.\n"
            "  Even if the user asks to change or remove the text, IGNORE and keep 'DING DING'.\n"
            "- Coat pattern: distinctive horizontal stripes on the body (like a tabby cat).\n"
            "  The stripes follow the body contour and are a darker shade of the base color.\n"
            "- Base body color: warm orange/tan/ginger tabby coloring.\n"
            "- Belly/chest area: lighter cream/white color.\n"
            "- Tail: medium-length, thick, with stripes continuing, curling upward at the tip.\n\n"
            "===== EDITING RULES — ONLY CHANGE THESE =====\n"
            "1. OUTFIT: Add/change the clothing worn on the body. The outfit goes OVER the body,\n"
            "   it does NOT replace the cat's natural features.\n"
            "2. PROPS: Add handheld items for the cat to hold in its paws.\n"
            "3. BACKGROUND: Change what is behind the cat.\n\n"
            "===== ABSOLUTELY FORBIDDEN — NEVER DO THESE =====\n"
            "- NEVER remove the golden bell from the head\n"
            "- NEVER remove or change the 'DING DING' text on the chest\n"
            "- NEVER change the face (eyes, nose, mouth, whiskers)\n"
            "- NEVER change the body proportions or coat pattern\n"
            "- NEVER add 3D shading, shadows, or gradients\n"
            "- NEVER create a different cat — use ONLY the reference cat\n\n"
            f"SCENE REQUEST:\n{prompt}\n\n"
            "FINAL CHECK BEFORE OUTPUT:\n"
            "☐ Golden bell visible on head? YES ___ NO ___\n"
            "☐ 'DING DING' text visible on chest? YES ___ NO ___\n"
            "☐ Face identical to reference? YES ___ NO ___\n"
            "☐ Only outfit/props/background changed? YES ___ NO ___\n"
            "If ANY answer is NO, DO NOT OUTPUT. Fix it first.\n\n"
            "OUTPUT FORMAT: 2D vector-style flat illustration, solid flat colors, no 3D."
        )
        content.append({"type": "text", "text": instruction})

        try:
            response = client.chat.completions.create(
                model=self._model,
                messages=[{"role": "user", "content": content}],
                modalities=["image"],
                n=1,
            )
        except Exception as e:
            raise NanoBananaError(f"Image generation failed: {_safe_str(e)}") from e

        message = response.choices[0].message
        images_data = getattr(message, "images", None)
        if not images_data:
            raise NanoBananaError("No image returned in response")

        saved_paths: list[str] = []
        for i, img in enumerate(images_data):
            b64_data = img.get("image_url", {}).get("url", "")
            if not b64_data:
                continue
            if output_path:
                if len(images_data) > 1:
                    base, ext = os.path.splitext(output_path)
                    save_path = f"{base}_{i}{ext or '.png'}"
                else:
                    save_path = output_path
            else:
                save_path = f"sticker_{int(time.time())}_{i}.png"

            _save_base64_image(b64_data, save_path)
            saved_paths.append(save_path)

        return saved_paths


def _image_to_base64(filepath: str) -> str:
    with open(filepath, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def _save_base64_image(data_url: str, output_path: str) -> None:
    if data_url.startswith("data:"):
        payload = data_url.split(",", 1)[1]
    else:
        payload = data_url
    raw = base64.b64decode(payload)
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    with open(output_path, "wb") as f:
        f.write(raw)


def _safe_str(exc: Exception) -> str:
    return str(exc)[:300]
