/** User input validation layer.
 *
 * Checks: length, language detection, content policy (blocklist),
 * festival mismatch warnings, brand mention warnings, protected features.
 *
 * Ported from src/llm/input_validator.py (Oscar branch).
 * Adapted to main-branch theme IDs (lunar, midautumn, dragonboat, etc.).
 */

const MAX_LENGTH = 500;

// ── Content policy patterns (case‑insensitive substring match) ──

const POLITICS_PATTERNS = [
  "protest", "riot", "revolution", "regime", "propaganda",
  "dictator", "coup", "uprising", "insurrect",
  "separatist", "independence",
];

const VIOLENCE_PATTERNS = [
  "kill", "murder", "blood", "gore", "weapon", "gun",
  "knife", "dead", "corpse", "brutal", "slaughter",
  "stab", "shoot", "explod", "bomb", "terrorist",
];

const NSFW_PATTERNS = [
  "nude", "naked", "sex", "porn", "erotic", "strip",
  "sexual", "explicit", "genital",
];

const HATE_PATTERNS = [
  "racist", "xenophobic", "homophobic", "transphobic",
  "hate group", "slur",
];

const SELF_HARM_PATTERNS = [
  "suicide", "self-harm", "self harm", "self injur",
  "cut myself", "overdose",
];

const BRAND_PATTERNS = [
  "hello kitty", "mickey mouse", "minnie mouse", "pokemon",
  "pikachu", "disney", "sanrio", "snoopy", "peanuts",
  "spongebob", "marvel", "dc comic", "batman", "superman",
  "harry potter", "star wars", "lego", "barbie",
  "nintendo", "mario", "sonic", "kirby",
];

// ── Theme → festival keywords for mismatch detection ──
// Uses main‑branch theme IDs with Oscar‑branch keyword data.

const THEME_KEYWORDS: Record<string, string[]> = {
  general: [
    "tram", "tramplus", "hong kong", "hk", "ding ding",
  ],
  lunar: [
    "chinese new year", "cny", "lunar new year", "農曆新年", "春節", "過年",
    "red envelope", "lai see", "利是", "dragon dance", "舞龍",
    "lion dance", "cheongsam", "lantern", "mandarin", "柑",
    "firecracker", "爆竹", "couplet", "對聯", "reunion dinner",
    "團年飯", "new year market", "年宵",
  ],
  christmas: [
    "christmas", "聖誕", "xmas", "santa", "reindeer",
    "snow", "gift", "tree", "hotpot", "火鍋", "winter",
    "冬至", "winter solstice", "tangyuan", "湯圓",
  ],
  halloween: [
    "halloween", "萬聖節", "pumpkin", "ghost", "witch",
    "vampire", "spooky", "costume", "trick or treat", "candy",
    "haunted", "bat", "skeleton", "cobweb",
  ],
  valentine: [
    "valentine", "情人節", "heart", "rose", "love", "cupid",
    "chocolate", "romantic",
  ],
  easter: [
    "easter", "復活節", "bunny", "egg", "spring", "chocolate",
  ],
  midautumn: [
    "mid-autumn", "midautumn", "中秋", "mooncake", "月餅",
    "lantern", "燈籠", "full moon", "moon", "osmanthus", "pomelo",
    "chang'e", "jade rabbit", "玉兔",
  ],
  dragonboat: [
    "dragon boat", "dragonboat", "端午", "tuen ng", "zongzi",
    "rice dumpling", "粽子", "糉", "drum", "paddle", "race",
  ],
  birthday: [
    "birthday", "生日", "cake", "candle", "party", "celebrate",
    "gift", "balloon", "confetti",
  ],
};

// ── Types ──

export interface ValidationResult {
  isValid: boolean;
  sanitizedInput: string;
  detectedLanguage: "en" | "zh" | "mixed" | "emoji";
  warnings: string[];
  errors: string[];
}

// ── Language detection ──

export function detectLanguage(text: string): ValidationResult["detectedLanguage"] {
  const hasEmoji = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(text);
  const hasChinese = /[\u4e00-\u9fff]/.test(text);
  const hasLatin = /[a-zA-Z]{2,}/.test(text);

  if (hasChinese && hasLatin) return "mixed";
  if (hasChinese) return "zh";
  if (hasLatin) return "en";
  if (hasEmoji) return "emoji";
  return "en";
}

// ── Main entry point ──

export function validateInput(
  rawInput: string | null | undefined,
  theme: string,
): ValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  const raw = rawInput ?? "";
  let sanitized = raw.trim();

  // Empty check
  if (!sanitized) {
    errors.push("No input provided. Please describe what you want.");
    return { isValid: false, sanitizedInput: "", detectedLanguage: "en", warnings, errors };
  }

  // Length truncation
  if (sanitized.length > MAX_LENGTH) {
    sanitized = sanitized.slice(0, MAX_LENGTH);
    warnings.push(
      `Input truncated to ${MAX_LENGTH} characters (was ${raw.trim().length}).`,
    );
  }

  const language = detectLanguage(sanitized);

  // Content policy
  errors.push(...checkContentPolicy(sanitized));

  // Festival mismatch (non‑blocking warning)
  const mismatch = checkThemeMismatch(sanitized, theme);
  if (mismatch) warnings.push(mismatch);

  // Brand mention (non‑blocking warning)
  const brand = checkBrandMentions(sanitized);
  if (brand) warnings.push(brand);

  // Protected features (bell / DING DING removal attempt)
  const protected_ = checkProtectedFeatures(sanitized);
  if (protected_) warnings.push(protected_);

  return {
    isValid: errors.length === 0,
    sanitizedInput: sanitized,
    detectedLanguage: language,
    warnings,
    errors,
  };
}

// ── Content policy checker ──

function checkContentPolicy(text: string): string[] {
  const errors: string[] = [];
  const lower = text.toLowerCase();

  const categories: Array<{ patterns: string[]; message: string }> = [
    { patterns: POLITICS_PATTERNS, message: "Input may contain political references which are not permitted." },
    { patterns: VIOLENCE_PATTERNS, message: "Input may contain violent references which are not permitted." },
    { patterns: NSFW_PATTERNS, message: "Input may contain adult/explicit references which are not permitted." },
    { patterns: HATE_PATTERNS, message: "Input may contain hate speech which is not permitted." },
    { patterns: SELF_HARM_PATTERNS, message: "Input may contain self-harm references which are not permitted." },
  ];

  for (const cat of categories) {
    if (cat.patterns.some((p) => lower.includes(p))) {
      errors.push(cat.message);
    }
  }

  return errors;
}

// ── Theme mismatch detection ──

function checkThemeMismatch(text: string, theme: string): string | null {
  const lower = text.toLowerCase();
  const targetKeywords = THEME_KEYWORDS[theme];
  if (!targetKeywords || targetKeywords.length === 0) return null;

  // Text already matches the selected theme → no warning
  if (targetKeywords.some((kw) => lower.includes(kw))) return null;

  // Check if text matches a different theme
  for (const [otherTheme, keywords] of Object.entries(THEME_KEYWORDS)) {
    if (otherTheme === theme) continue;
    if (keywords.some((kw) => lower.includes(kw))) {
      return (
        `Your input mentions terms associated with another theme ` +
        `('${otherTheme}'), but you selected '${theme}'. ` +
        `The generated sticker will follow your selected theme.`
      );
    }
  }
  return null;
}

// ── Brand mention detection ──

function checkBrandMentions(text: string): string | null {
  const lower = text.toLowerCase();
  const matched = BRAND_PATTERNS.filter((brand) => lower.includes(brand));

  if (matched.length === 0) return null;

  const names = matched.slice(0, 3).join(", ");
  const suffix = matched.length > 3 ? " and others" : "";
  return (
    `Your input references trademarked characters/brands (${names}${suffix}). ` +
    `The AI will be instructed to avoid direct IP references, but the ` +
    `generated image may still resemble protected characters. ` +
    `Please verify before publishing.`
  );
}

// ── Protected features detection (bell / DING DING text) ──

function checkProtectedFeatures(text: string): string | null {
  const lower = text.toLowerCase();

  const bellRemoval = [
    "remove the bell", "no bell", "without bell",
    "remove bell", "no golden bell", "without the bell",
    "take off the bell", "take off bell",
  ].some((phrase) => lower.includes(phrase));

  const textRemoval = [
    "remove the text", "no text", "without text",
    "remove DING DING", "no DING DING", "remove ding ding",
    "no ding ding", "without ding ding", "remove the DING DING",
    "change the text", "change DING DING", "change ding ding",
    "remove the wording", "no wording",
  ].some((phrase) => lower.includes(phrase));

  if (bellRemoval && textRemoval) {
    return (
      "The golden bell and 'DING DING' text are PERMANENT features of " +
      "Ding Ding Cat. They cannot be removed. Your request will be ignored " +
      "and both the bell and text will appear in the generated sticker."
    );
  }
  if (bellRemoval) {
    return (
      "The golden bell is a PERMANENT feature of Ding Ding Cat. " +
      "It cannot be removed. Your request will be ignored."
    );
  }
  if (textRemoval) {
    return (
      "The 'DING DING' text is a PERMANENT feature of Ding Ding Cat. " +
      "It cannot be removed or changed. Your request will be ignored."
    );
  }
  return null;
}
