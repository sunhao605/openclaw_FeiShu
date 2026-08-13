# Slide types

## Cover

Use for the opening slide.

- Very large centered title.
- Light-weight subtitle in a muted color.
- Optional series label or logo supplied by the user.

```html
<div class="slide cover">
  <h1 class="text-5xl font-black text-white mb-6">重新定义效率</h1>
  <p class="text-xl font-light text-gray-400">AI 时代的工作方式</p>
</div>
```

## Impact title

Use at a section boundary or for one key assertion.

- One- or two-line headline.
- At most one short supporting line.

```html
<div class="slide impact">
  <h1 class="text-4xl font-black text-white text-center">不是更努力<br />而是更聪明</h1>
</div>
```

## Quote

Use for a verified quotation or a clearly labeled key statement.

- Large quotation mark.
- Bold statement.
- Source line when a real source is known.

Never invent a quotation or attribution.

```html
<div class="slide quote">
  <span class="text-6xl text-gray-600">&quot;</span>
  <p class="text-2xl font-bold text-white my-6">金句内容</p>
  <span class="text-lg font-light text-gray-500">— 来源</span>
</div>
```

## Step

Use for a process, method, or instruction.

- Action-oriented title.
- One or two explanatory lines.
- Optional step number.

```html
<div class="slide step">
  <span class="text-6xl font-black text-blue-500 mb-4">01</span>
  <h2 class="text-3xl font-bold text-white mb-4">明确目标</h2>
  <p class="text-lg font-light text-gray-400">先确认最重要的结果。</p>
</div>
```

## Comparison

Use for before-and-after states or a meaningful contrast.

- Split content horizontally or vertically.
- Use restrained color differences.
- Keep each side concise.

```html
<div class="slide compare">
  <div class="text-center mb-8">
    <span class="text-red-400 line-through text-xl">传统方式</span>
  </div>
  <div class="text-center">
    <span class="text-green-400 text-3xl font-bold">全新体验</span>
  </div>
</div>
```

## Key metric

Use only for a number present in the user's source or otherwise verified.

- Very large number.
- Unit or label.
- One short explanation.

```html
<div class="slide data">
  <span class="text-7xl font-black text-white">10x</span>
  <p class="text-xl font-light text-gray-400 mt-4">示例指标</p>
</div>
```

## List

Use for a small set of parallel points.

- One title.
- Three to five points.
- Keep every point short.

```html
<div class="slide list">
  <h2 class="text-2xl font-bold text-white mb-8">三个原则</h2>
  <ul class="space-y-6 text-xl">
    <li class="text-gray-300">• 少即是多</li>
    <li class="text-gray-300">• 专注核心</li>
    <li class="text-gray-300">• 持续迭代</li>
  </ul>
</div>
```

## Closing action

Use for the final summary and call to action.

- One concluding statement.
- One clear action.
- Optional user-provided contact information or QR code.

```html
<div class="slide ending">
  <h1 class="text-3xl font-bold text-white mb-8">现在就开始改变</h1>
  <p class="text-xl font-light text-gray-400">下一步行动</p>
</div>
```

## Selection guide

| Content                         | Recommended type |
| ------------------------------- | ---------------- |
| Opening                         | Cover            |
| Section boundary                | Impact title     |
| Verified quote or key statement | Quote            |
| Procedure                       | Step             |
| Before and after                | Comparison       |
| Verified number                 | Key metric       |
| Three to five parallel points   | List             |
| Summary and action              | Closing action   |
