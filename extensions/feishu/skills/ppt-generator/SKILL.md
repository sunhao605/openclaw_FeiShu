---
name: ppt-generator
description: Generate a minimalist 9:16 HTML slide deck from a speech draft when the user explicitly requests a presentation, slides, or PPT-style HTML output.
homepage: https://clawhub.ai/wwlyzzyorg/skills/ppt-generator
---

# PPT Generator

Turn a user-provided speech draft into a Steve Jobs-style minimalist, technology-focused vertical HTML presentation.

This skill produces a single HTML file, not a native `.pptx` file. If the user specifically requires PowerPoint format, state this limitation before proceeding and use a native presentation tool instead when one is available.

## Before generating

1. Preserve the user's requested language. Do not force Chinese output when the source or request uses another language.
2. Keep the original draft unchanged as source material. Create a separate condensed version for the presentation.
3. Ask for clarification only when a missing choice would materially change the result. Otherwise use the defaults below.
4. Warn before using confidential material: the supplied template loads JavaScript and fonts from third-party CDNs and is not offline or fully self-contained.

## Design principles

- Minimalism: one idea per screen.
- Strong visual contrast: dark background and white primary text.
- Generous whitespace: avoid dense layouts.
- Clear rhythm: each page should motivate the audience to continue.

## Generation workflow

### 1. Read the draft

Read the user's original draft without rewriting it in place.

### 2. Prepare a condensed draft

Condense the content, strengthen its presentation impact, and produce a Markdown version. Preserve important facts, qualifications, names, and numbers. Do not invent claims or metrics.

### 3. Create section titles

Each title should normally be no more than 12 Chinese characters or a similarly concise length in the user's language. Prefer one of these forms:

- contrast;
- question;
- assertion;
- number;
- metaphor.

### 4. Plan the slide structure

Read `{baseDir}/references/slide-types.md`, then choose a page type for each idea.

### 5. Generate the HTML file

Read `{baseDir}/assets/template.html` and use it as the structural base. Read `{baseDir}/references/design-spec.md` for detailed visual rules.

Create one complete `.html` file in the current workspace. Do not merely paste a partial code fragment when file-writing tools are available.

### 6. Validate the result

Check that:

- every slide contains one primary idea;
- all navigation controls work;
- the page count and progress indicator agree;
- user-provided facts remain accurate;
- HTML text is escaped where needed;
- no user-supplied content is inserted as executable JavaScript;
- CDN dependencies are disclosed to the user.

## Delivery order

Return:

1. the condensed draft in Markdown;
2. the slide structure outline;
3. the path to the generated HTML file;
4. a short note that the file is HTML rather than `.pptx` and uses external CDN resources.

## Visual defaults

| Item           | Default                                                   |
| -------------- | --------------------------------------------------------- |
| Aspect ratio   | 9:16 vertical                                             |
| Background     | `#000000` or `#0a0a0a`, with blurred animated light spots |
| Primary text   | `#ffffff`                                                 |
| Secondary text | `#9ca3af`                                                 |
| Chinese fonts  | HarmonyOS Sans SC / Noto Sans SC                          |
| Latin fonts    | Inter / Roboto                                            |
| Title weight   | bold or black                                             |
| Body weight    | light or normal                                           |

## Interaction defaults

- Left and right arrow keys change slides.
- A bottom progress indicator shows the current position.
- Slide transitions are smooth.
- Touch swipes are supported.

## Avoid

- dense blocks of text;
- decorative color overload;
- unnecessary complex charts;
- changing the user's requested format or visual style without explanation;
- presenting generated or condensed claims as verified facts.

## Defaults when unspecified

- Generate 8–20 slides according to content length.
- Use the minimalist technology style described above.
- Use 9:16 vertical layout.
