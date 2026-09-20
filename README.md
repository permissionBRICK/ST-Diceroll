# ST-Diceroll

A SillyTavern extension that lets probability—not the language model alone—steer each roleplay turn.

Before the visible reply, Diceroll asks the active model for 5–10 plausible continuations with probability weights, samples one outcome, injects that direction into the real generation, and removes the instruction afterward. The option request and final reply share the same prompt prefix, allowing provider prompt caches to do most of the expensive work only once.

## Install

In SillyTavern, open **Extensions → Install extension** and enter:

```text
https://github.com/permissionBRICK/ST-Diceroll
```

Requires SillyTavern 1.18.0 or newer. Enable and configure it under **Extensions → Diceroll**.

## Behavior

- Supports normal replies, swipes, and regenerations.
- Uses JSON Schema structured output when the active provider supports it, with a tolerant text parser as fallback.
- Normalizes malformed or non-100% probability sets before rolling.
- Can reuse a roll on swipe, show the roll under the message for debugging, and skip generations already steered by Guided Generations.
- In debug mode, click a choice under the latest reply to regenerate that reply with the selected direction. This reuses the displayed choices even when rerolling on swipes is enabled.
- Stores roll metadata with the chat; it does not store credentials or send data anywhere except the already configured model API.

## Development

```bash
npm test
```

Extracted from a SillyTavern customization and released under AGPL-3.0. See [LICENSE](LICENSE).
