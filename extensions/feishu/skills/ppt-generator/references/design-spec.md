# Detailed design specification

## Background

- Use `#000000` or `#0a0a0a` as the primary background.
- A restrained dark gradient is acceptable.
- Each slide may contain one to three blurred light spots.
- Respect `prefers-reduced-motion` and disable nonessential animations when requested by the browser.

```css
.light-spot {
  position: absolute;
  width: 300px;
  height: 300px;
  border-radius: 50%;
  filter: blur(100px);
  opacity: 0.3;
  animation: float 20s ease-in-out infinite;
}

.light-spot-1 {
  background: #3b82f6;
}
.light-spot-2 {
  background: #8b5cf6;
}
.light-spot-3 {
  background: #06b6d4;
}

@keyframes float {
  0%,
  100% {
    transform: translate(0, 0);
  }
  25% {
    transform: translate(50px, -30px);
  }
  50% {
    transform: translate(-30px, 50px);
  }
  75% {
    transform: translate(-50px, -20px);
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

## External fonts

The source template uses CDN-hosted fonts:

```html
<link
  href="https://fonts.loli.net/css2?family=Noto+Sans+SC:wght@300;400;700;900&display=swap"
  rel="stylesheet"
/>
<link
  href="https://fonts.loli.net/css2?family=Inter:wght@300;400;700;900&display=swap"
  rel="stylesheet"
/>
```

These requests disclose the viewer's IP address and user-agent metadata to third parties. Remove them and use system fonts for confidential, offline, or restricted presentations.

## Typography

```css
.slide-title {
  font-size: 3rem;
  font-weight: 900;
  line-height: 1.2;
  color: #ffffff;
}

.slide-subtitle {
  font-size: 1.5rem;
  font-weight: 700;
  color: #ffffff;
}

.slide-text {
  font-size: 1.125rem;
  font-weight: 300;
  color: #9ca3af;
}
```

## Spacing

- Use at least 32 px between primary content blocks.
- Use 32–48 px page padding.
- Center the primary message unless the content requires another hierarchy.
- Keep safe space around controls and page indicators.

## Page container

```css
.slide {
  width: 100%;
  height: 100vh;
  aspect-ratio: 9 / 16;
  max-width: 450px;
  margin: 0 auto;
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2rem;
}
```

## Transitions

```css
.slide {
  opacity: 0;
  transform: translateX(100%);
  transition:
    opacity 0.5s ease-out,
    transform 0.5s ease-out;
}

.slide.active {
  opacity: 1;
  transform: translateX(0);
}

.slide.prev {
  transform: translateX(-100%);
}
```

## Content safety

- Insert user text as escaped text content, not executable HTML or JavaScript.
- Do not interpolate user input into `<script>`, event-handler attributes, or remote URLs.
- Do not invent statistics, quotations, customer names, or business outcomes.
- For confidential content, remove every external script, stylesheet, font, image, and analytics request.
