"""User input validation layer.

Checks: length, language detection, content policy (blocklist),
festival mismatch warnings, brand mention warnings.

No blocking minimum length — even 1-char Chinese/emoji is valid.
"""

import re
from dataclasses import dataclass, field

MAX_LENGTH = 500

POLITICS_PATTERNS: list[str] = [
    "protest", "riot", "revolution", "regime", "propaganda",
    "dictator", "coup", "uprising", "insurrect",
    "separatist", "independence",
]
VIOLENCE_PATTERNS: list[str] = [
    "kill", "murder", "blood", "gore", "weapon", "gun",
    "knife", "dead", "corpse", "brutal", "slaughter",
    "stab", "shoot", "explod", "bomb", "terrorist",
]
NSFW_PATTERNS: list[str] = [
    "nude", "naked", "sex", "porn", "erotic", "strip",
    "sexual", "explicit", "genital",
]
HATE_PATTERNS: list[str] = [
    "racist", "xenophobic", "homophobic", "transphobic",
    "hate group", "slur",
]
SELF_HARM_PATTERNS: list[str] = [
    "suicide", "self-harm", "self harm", "self injur",
    "cut myself", "overdose",
]
BRAND_PATTERNS: list[str] = [
    "hello kitty", "mickey mouse", "minnie mouse", "pokemon",
    "pikachu", "disney", "sanrio", "snoopy", "peanuts",
    "spongebob", "marvel", "dc comic", "batman", "superman",
    "harry potter", "star wars", "lego", "barbie",
    "nintendo", "mario", "sonic", "kirby",
]

FESTIVAL_KEYWORDS: dict[str, list[str]] = {
    "new-year": ["new year", "元旦", "countdown", "firework", "party hat", "sparkler"],
    "chinese-new-year": [
        "chinese new year", "cny", "農曆新年", "春節", "過年",
        "red envelope", "lai see", "利是", "dragon dance", "舞龍",
        "lion dance", "cheongsam", "lantern", "mandarin", "柑",
        "firecracker", "爆竹", "couplet", "對聯", "reunion dinner",
        "團年飯", "new year market", "年宵",
    ],
    "bun-festival": [
        "bun festival", "太平清醮", "cheung chau", "長洲",
        "bun", "包子", "drum", "parade",
    ],
    "easter": [
        "easter", "復活節", "bunny", "egg", "spring", "chocolate",
    ],
    "dragon-boat": [
        "dragon boat", "端午", "tuen ng", "zongzi", "rice dumpling",
        "粽子", "糉", "drum", "paddle", "race",
    ],
    "summer": [
        "summer", "夏天", "beach", "ice cream", "watermelon",
        "swim", "sunglasses", "hot", "sun",
    ],
    "hksar-day": [
        "hksar", "establishment day", "香港回歸", "七月一",
        "bauhinia", "firework", "flag",
    ],
    "qixi": [
        "qixi", "七夕", "magpie", "bridge", "romantic",
        "weaving girl", "cowherd",
    ],
    "mid-autumn": [
        "mid-autumn", "中秋", "mooncake", "月餅", "lantern",
        "燈籠", "full moon", "moon", "osmanthus", "pomelo",
        "chang'e", "jade rabbit", "玉兔",
    ],
    "national-day": [
        "national day", "國慶", "golden week", "flag", "firework",
    ],
    "halloween": [
        "halloween", "萬聖節", "pumpkin", "ghost", "witch",
        "vampire", "spooky", "costume", "trick or treat", "candy",
        "haunted", "bat", "skeleton", "cobweb",
    ],
    "chung-yeung": [
        "chung yeung", "重陽", "chrysanthemum", "菊花",
        "hiking", "hill", "autumn", "grave sweeping", "掃墓",
    ],
    "christmas": [
        "christmas", "聖誕", "xmas", "santa", "reindeer",
        "snow", "gift", "tree", "hotpot", "火鍋", "winter",
        "冬至", "winter solstice", "tangyuan", "湯圓",
    ],
}


@dataclass
class ValidationResult:
    is_valid: bool
    sanitized_input: str = ""
    detected_language: str = "en"
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def validate_input(
    raw_input: str | None,
    festival_id: str,
    blocklist_config: dict | None = None,
) -> ValidationResult:
    warnings: list[str] = []
    errors: list[str] = []

    if raw_input is None:
        raw_input = ""

    sanitized = raw_input.strip()

    if not sanitized:
        errors.append("No input provided. Please describe what you want.")
        return ValidationResult(
            is_valid=False,
            sanitized_input="",
            detected_language="en",
            errors=errors,
        )

    if len(sanitized) > MAX_LENGTH:
        sanitized = sanitized[:MAX_LENGTH]
        warnings.append(
            f"Input truncated to {MAX_LENGTH} characters (was {len(raw_input.strip())})."
        )

    language = detect_language(sanitized)

    content_errors = _check_content_policy(sanitized)
    errors.extend(content_errors)

    mismatch_warning = _check_festival_mismatch(sanitized, festival_id)
    if mismatch_warning:
        warnings.append(mismatch_warning)

    brand_warning = _check_brand_mentions(sanitized)
    if brand_warning:
        warnings.append(brand_warning)

    protected_warning = _check_protected_features(sanitized)
    if protected_warning:
        warnings.append(protected_warning)

    return ValidationResult(
        is_valid=len(errors) == 0,
        sanitized_input=sanitized,
        detected_language=language,
        warnings=warnings,
        errors=errors,
    )


def detect_language(text: str) -> str:
    has_emoji = bool(re.search(r"[\U0001F000-\U0001FFFF]", text))
    has_chinese = bool(re.search(r"[\u4e00-\u9fff]", text))
    has_latin = bool(re.search(r"[a-zA-Z]{2,}", text))

    if has_chinese and has_latin:
        base = "mixed"
    elif has_chinese:
        base = "zh"
    elif has_latin:
        base = "en"
    elif has_emoji:
        base = "emoji"
    else:
        base = "en"

    return base


def _check_content_policy(text: str) -> list[str]:
    errors: list[str] = []
    lower = text.lower()

    for pattern in POLITICS_PATTERNS:
        if pattern in lower:
            errors.append(
                f"Input may contain political references which are not permitted."
            )
            break

    for pattern in VIOLENCE_PATTERNS:
        if pattern in lower:
            errors.append(
                "Input may contain violent references which are not permitted."
            )
            break

    for pattern in NSFW_PATTERNS:
        if pattern in lower:
            errors.append(
                "Input may contain adult/explicit references which are not permitted."
            )
            break

    for pattern in HATE_PATTERNS:
        if pattern in lower:
            errors.append(
                "Input may contain hate speech which is not permitted."
            )
            break

    for pattern in SELF_HARM_PATTERNS:
        if pattern in lower:
            errors.append(
                "Input may contain self-harm references which are not permitted."
            )
            break

    return errors


def _check_festival_mismatch(text: str, festival_id: str) -> str | None:
    lower = text.lower()
    target_keywords = FESTIVAL_KEYWORDS.get(festival_id, [])

    if not target_keywords:
        return None

    text_matches_current = any(kw in lower for kw in target_keywords)

    if text_matches_current:
        return None

    for other_festival, keywords in FESTIVAL_KEYWORDS.items():
        if other_festival == festival_id:
            continue
        if any(kw in lower for kw in keywords):
            return (
                f"Your input mentions terms associated with another festival "
                f"('{other_festival}'), but you selected '{festival_id}'. "
                f"The generated prompt will follow your selected festival."
            )

    return None


def _check_brand_mentions(text: str) -> str | None:
    lower = text.lower()
    matched: list[str] = []
    for brand in BRAND_PATTERNS:
        if brand in lower:
            matched.append(brand)

    if matched:
        names = ", ".join(matched[:3])
        suffix = " and others" if len(matched) > 3 else ""
        return (
            f"Your input references trademarked characters/brands ({names}{suffix}). "
            f"The AI will be instructed to avoid direct IP references, but the "
            f"generated image may still resemble protected characters. "
            f"Please verify before publishing."
        )
    return None


def _check_protected_features(text: str) -> str | None:
    lower = text.lower()
    bell_removal = any(phrase in lower for phrase in [
        "remove the bell", "no bell", "without bell",
        "remove bell", "no golden bell", "without the bell",
        "take off the bell", "take off bell",
    ])
    text_removal = any(phrase in lower for phrase in [
        "remove the text", "no text", "without text",
        "remove DING DING", "no DING DING", "remove ding ding",
        "no ding ding", "without ding ding", "remove the DING DING",
        "change the text", "change DING DING", "change ding ding",
        "remove the wording", "no wording",
    ])
    if bell_removal and text_removal:
        return (
            "The golden bell and 'DING DING' text are PERMANENT features of "
            "Ding Ding Cat. They cannot be removed. Your request will be ignored "
            "and both the bell and text will appear in the generated sticker."
        )
    if bell_removal:
        return (
            "The golden bell is a PERMANENT feature of Ding Ding Cat. "
            "It cannot be removed. Your request will be ignored."
        )
    if text_removal:
        return (
            "The 'DING DING' text is a PERMANENT feature of Ding Ding Cat. "
            "It cannot be removed or changed. Your request will be ignored."
        )
    return None
