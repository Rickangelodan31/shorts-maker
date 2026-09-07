// Visual style presets (section 8) — each description is the actual text fed into image/
// scene generation prompts. Every preset ends with the same originality guardrail so no
// preset can accidentally steer toward copying an existing show's designs.
const ORIGINALITY_CLAUSE = 'Fully original character and background designs — do not reference, copy, or imitate any existing show, franchise, logo, or proprietary character designs.';

const PRESETS = {
  'warm-preschool-3d': {
    label: 'Warm Preschool Family (default)',
    description: `A warm, simple, expressive preschool family cartoon style: rounded character designs, bright cheerful environments, expressive readable faces, playful bouncy movement, simple clean shapes, friendly family-oriented storytelling tone. ${ORIGINALITY_CLAUSE}`,
  },
  'stylized-3d': {
    label: "Stylized 3D children's animation",
    description: `Stylized 3D children's animation, smooth rounded modeling, soft studio lighting, vibrant saturated colors. ${ORIGINALITY_CLAUSE}`,
  },
  'soft-3d': {
    label: 'Soft 3D cartoon',
    description: `Soft 3D cartoon look, gentle pastel lighting, plush rounded shapes, cozy inviting mood. ${ORIGINALITY_CLAUSE}`,
  },
  'colorful-preschool': {
    label: 'Colorful preschool cartoon',
    description: `Bold colorful preschool cartoon, thick clean outlines, high contrast bright palette, big expressive eyes. ${ORIGINALITY_CLAUSE}`,
  },
  storybook: {
    label: 'Storybook cartoon',
    description: `Storybook illustration style, soft painterly textures, warm inviting color palette, gentle whimsical linework. ${ORIGINALITY_CLAUSE}`,
  },
  '2d-childrens': {
    label: "2D children's animation",
    description: `Classic flat 2D children's animation, clean vector shapes, bright flat colors, simple bold outlines. ${ORIGINALITY_CLAUSE}`,
  },
  '2-5d': {
    label: '2.5D animation',
    description: `2.5D animation look — flat 2D character illustration with subtle layered depth and parallax, soft shading. ${ORIGINALITY_CLAUSE}`,
  },
  'clay-like': {
    label: 'Clay-like cartoon',
    description: `Clay-like stop-motion-inspired cartoon texture, soft matte surfaces, tactile handmade feel, warm lighting. ${ORIGINALITY_CLAUSE}`,
  },
  'hand-drawn': {
    label: 'Hand-drawn cartoon',
    description: `Hand-drawn traditional cartoon style, visible sketchy linework, warm textured coloring. ${ORIGINALITY_CLAUSE}`,
  },
  cinematic: {
    label: 'Cinematic family animation',
    description: `Cinematic family animation style, richer lighting and depth, polished modern animated-feature look, still friendly and approachable. ${ORIGINALITY_CLAUSE}`,
  },
};

const DEFAULT_PRESET = 'warm-preschool-3d';

function listPresets() {
  return Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label }));
}

// style: { preset, customPrompt, locked }. A custom prompt is appended (not a replacement)
// so the originality guardrail always applies even for a fully custom style request.
function styleDescription(style) {
  const preset = PRESETS[style?.preset] || PRESETS[DEFAULT_PRESET];
  const custom = style?.customPrompt ? ` Additional style direction: ${style.customPrompt}.` : '';
  return `${preset.description}${custom}`;
}

module.exports = { PRESETS, DEFAULT_PRESET, listPresets, styleDescription };
