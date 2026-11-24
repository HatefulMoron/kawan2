//! Lightweight Markdown rendering for chat message bodies.
//!
//! Chat messages are authored in Markdown, so they should be rendered rather than
//! shown as raw text. This module parses CommonMark/GFM syntax with
//! `pulldown-cmark` and renders a compact subset that fits the Instrument Panel:
//! headings, paragraphs, emphasis, inline code, links, fenced code, lists,
//! block quotes, tables, horizontal rules, and inline artifact images.
//!
//! `![alt](kawan://artifact/<artifact_id>)` renders the artifact's bytes at column
//! width (capped height) and opens the artifact drawer on click. One renderer
//! serves chat messages and merge-queue proposals.

use std::iter::Peekable;
use std::ops::Range;
use std::sync::Arc;

use gpui::prelude::*;
use gpui::{
    AnyElement, App, ClickEvent, Div, FontStyle, FontWeight, HighlightStyle, Hsla, Image,
    ObjectFit, SharedString, StrikethroughStyle, StyledImage, StyledText, UnderlineStyle, Window,
    div, img, px,
};
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};

use crate::theme::{self, Theme};

/// Tallest an inline image may render inside a message column.
const INLINE_IMAGE_MAX_HEIGHT: f32 = 260.0;

/// A click handler bound to the artifact drawer.
pub type ArtifactClick = Box<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// Resolves inline image references against already-loaded artifact bytes and
/// opens the artifact lightbox when one is clicked.
pub struct InlineImages<'a> {
    /// Decoded bytes for an artifact id, when they have already arrived.
    pub resolve: &'a dyn Fn(&str) -> Option<Arc<Image>>,
    /// Click handler that opens the artifact drawer for an artifact id.
    pub open: &'a dyn Fn(&str) -> ArtifactClick,
}

impl InlineImages<'_> {
    fn image(&self, dest: &str) -> Option<(String, Arc<Image>)> {
        let id = artifact_dest_id(dest)?;
        let bytes = (self.resolve)(id)?;
        Some((id.to_string(), bytes))
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct SpanStyle {
    bold: bool,
    italic: bool,
    strike: bool,
    code: bool,
    link: bool,
}

#[derive(Clone, Debug)]
struct Span {
    text: String,
    style: SpanStyle,
    /// `kawan://artifact/<id>` destination when this span is an inline image.
    image: Option<String>,
}

#[derive(Clone, Debug)]
enum Block {
    Paragraph(Vec<Span>),
    Heading(usize, Vec<Span>),
    Code {
        lang: Option<String>,
        text: String,
    },
    Quote(Vec<Block>),
    List {
        ordered: bool,
        start: u64,
        items: Vec<Vec<Block>>,
    },
    Table {
        headers: Vec<Vec<Span>>,
        rows: Vec<Vec<Vec<Span>>>,
    },
    Rule,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum InlineEnd {
    Paragraph,
    Heading,
    TableCell,
    Block,
}

fn options() -> Options {
    Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS
}

/// Render a Markdown chat message body into a vertical block of styled elements.
pub fn render(
    markdown: &str,
    size: f32,
    color: Hsla,
    theme: &Theme,
    images: Option<&InlineImages<'_>>,
) -> Div {
    render_block_list(
        &parse_blocks(&mut Parser::new_ext(markdown, options()).peekable()),
        size,
        color,
        theme,
        images,
    )
}

/// Render a Markdown body clipped after `max_blocks` top-level blocks.
///
/// Returns the element plus whether anything was dropped, so the caller can offer
/// a `View full …` link. Proposal rows in the Merge Queue use this to keep a long
/// changelog to a readable preview.
pub fn render_clipped(
    markdown: &str,
    size: f32,
    color: Hsla,
    theme: &Theme,
    images: Option<&InlineImages<'_>>,
    max_blocks: usize,
) -> (Div, bool) {
    let blocks = parse_blocks(&mut Parser::new_ext(markdown, options()).peekable());
    let truncated = blocks.len() > max_blocks;
    let shown = if truncated {
        &blocks[..max_blocks]
    } else {
        &blocks[..]
    };
    let col = render_block_list(shown, size, color, theme, images);
    (col, truncated)
}

fn render_block_list(
    blocks: &[Block],
    size: f32,
    color: Hsla,
    theme: &Theme,
    images: Option<&InlineImages<'_>>,
) -> Div {
    let mut col = div()
        .w_full()
        .min_w(px(0.0))
        .flex()
        .flex_col()
        .gap(px((size * 0.42).max(4.0)));

    for block in blocks {
        if let Some(element) = render_block(block, size, color, theme, images) {
            col = col.child(element);
        }
    }

    col
}

/// The artifact id of a `kawan://artifact/<id>` link destination.
fn artifact_dest_id(dest: &str) -> Option<&str> {
    let id = dest.trim().strip_prefix("kawan://artifact/")?.trim();
    (!id.is_empty()).then_some(id)
}

/// Alt text to show when an inline image has no bytes yet, or is not an artifact.
fn image_fallback_label(alt: &str, dest: &str) -> String {
    let alt = alt.trim();
    if !alt.is_empty() {
        return alt.to_string();
    }
    match artifact_dest_id(dest) {
        Some(id) => id.chars().take(8).collect(),
        None => dest.to_string(),
    }
}

/// Flatten Markdown to plain text, for one-line previews and search.
pub fn plain_text(markdown: &str) -> String {
    let mut out = String::new();
    for event in Parser::new_ext(markdown, options()) {
        match event {
            Event::Text(text)
            | Event::Code(text)
            | Event::InlineMath(text)
            | Event::DisplayMath(text) => out.push_str(&text),
            Event::SoftBreak | Event::HardBreak => out.push('\n'),
            Event::TaskListMarker(checked) => {
                out.push_str(if checked { "[x] " } else { "[ ] " });
            }
            Event::FootnoteReference(label) => {
                out.push('[');
                out.push_str(&label);
                out.push(']');
            }
            Event::End(
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::Item
                | TagEnd::CodeBlock
                | TagEnd::TableCell
                | TagEnd::TableRow,
            ) => out.push(' '),
            _ => {}
        }
    }
    out.trim().to_string()
}

fn parse_blocks<'a>(events: &mut Peekable<Parser<'a>>) -> Vec<Block> {
    let mut blocks = Vec::new();

    while let Some(event) = events.peek() {
        match event {
            Event::End(_) => break,
            Event::Start(Tag::Paragraph) => {
                events.next();
                blocks.push(Block::Paragraph(parse_inline(events, InlineEnd::Paragraph)));
            }
            Event::Start(Tag::Heading { level, .. }) => {
                let level = *level as usize;
                events.next();
                blocks.push(Block::Heading(
                    level,
                    parse_inline(events, InlineEnd::Heading),
                ));
            }
            Event::Start(Tag::BlockQuote(_)) => {
                events.next();
                let children = parse_blocks(events);
                consume_end(events, |end| matches!(end, TagEnd::BlockQuote(_)));
                blocks.push(Block::Quote(children));
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                let lang = match kind {
                    CodeBlockKind::Fenced(lang) if !lang.is_empty() => Some(lang.to_string()),
                    _ => None,
                };
                events.next();
                let mut text = String::new();
                for event in events.by_ref() {
                    match event {
                        Event::Text(chunk) | Event::Code(chunk) => text.push_str(&chunk),
                        Event::End(TagEnd::CodeBlock) => break,
                        _ => {}
                    }
                }
                blocks.push(Block::Code { lang, text });
            }
            Event::Start(Tag::List(start)) => {
                let ordered = start.is_some();
                let start = start.unwrap_or(1);
                events.next();
                let mut items = Vec::new();
                while matches!(events.peek(), Some(Event::Start(Tag::Item))) {
                    events.next();
                    items.push(parse_blocks(events));
                    consume_end(events, |end| matches!(end, TagEnd::Item));
                }
                consume_end(events, |end| matches!(end, TagEnd::List(_)));
                blocks.push(Block::List {
                    ordered,
                    start,
                    items,
                });
            }
            Event::Start(Tag::Table(_)) => {
                events.next();
                let mut headers = Vec::new();
                let mut rows = Vec::new();
                loop {
                    match events.next() {
                        Some(Event::Start(Tag::TableHead)) => {
                            headers = parse_table_row(events);
                        }
                        Some(Event::Start(Tag::TableRow)) => {
                            rows.push(parse_table_row(events));
                        }
                        Some(Event::End(TagEnd::Table)) | None => break,
                        _ => {}
                    }
                }
                blocks.push(Block::Table { headers, rows });
            }
            Event::Start(Tag::HtmlBlock) => {
                events.next();
                let mut text = String::new();
                for event in events.by_ref() {
                    match event {
                        Event::Text(chunk) | Event::Html(chunk) => text.push_str(&chunk),
                        Event::End(TagEnd::HtmlBlock) => break,
                        _ => {}
                    }
                }
                if !text.trim().is_empty() {
                    blocks.push(Block::Code { lang: None, text });
                }
            }
            Event::Start(Tag::Item) => {
                events.next();
                let children = parse_blocks(events);
                consume_end(events, |end| matches!(end, TagEnd::Item));
                blocks.extend(children);
            }
            Event::Start(_) => {
                events.next();
            }
            Event::Rule => {
                events.next();
                blocks.push(Block::Rule);
            }
            _ => {
                // Tight list items can contain inline events without a paragraph tag.
                let spans = parse_inline(events, InlineEnd::Block);
                if spans.iter().any(|span| !span.text.trim().is_empty()) {
                    blocks.push(Block::Paragraph(spans));
                }
            }
        }
    }

    blocks
}

fn parse_table_row<'a>(events: &mut Peekable<Parser<'a>>) -> Vec<Vec<Span>> {
    let mut cells = Vec::new();
    loop {
        match events.next() {
            Some(Event::Start(Tag::TableCell)) => {
                cells.push(parse_inline(events, InlineEnd::TableCell));
            }
            Some(Event::End(TagEnd::TableRow | TagEnd::TableHead | TagEnd::Table))
            | Some(Event::Start(_))
            | None => break,
            Some(_) => {}
        }
    }
    cells
}

fn parse_inline<'a>(events: &mut Peekable<Parser<'a>>, end: InlineEnd) -> Vec<Span> {
    let mut spans: Vec<Span> = Vec::new();
    let mut bold = 0u32;
    let mut italic = 0u32;
    let mut strike = 0u32;
    let mut link = 0u32;
    let mut image_start: Option<(String, usize)> = None;

    loop {
        match events.peek() {
            None => break,
            Some(Event::End(tag)) => {
                let stop = match end {
                    InlineEnd::Paragraph => matches!(tag, TagEnd::Paragraph),
                    InlineEnd::Heading => matches!(tag, TagEnd::Heading(_)),
                    InlineEnd::TableCell => matches!(tag, TagEnd::TableCell),
                    InlineEnd::Block => is_block_end(tag),
                };
                if stop {
                    if end != InlineEnd::Block {
                        events.next();
                    }
                    break;
                }
            }
            Some(Event::Start(tag)) if end == InlineEnd::Block && is_block_start(tag) => {
                break;
            }
            Some(Event::Rule) if end == InlineEnd::Block => break,
            _ => {}
        }

        let style = SpanStyle {
            bold: bold > 0,
            italic: italic > 0,
            strike: strike > 0,
            code: false,
            link: link > 0,
        };

        let Some(event) = events.next() else {
            break;
        };

        match event {
            Event::Start(Tag::Strong) => bold += 1,
            Event::End(TagEnd::Strong) => bold = bold.saturating_sub(1),
            Event::Start(Tag::Emphasis) => italic += 1,
            Event::End(TagEnd::Emphasis) => italic = italic.saturating_sub(1),
            Event::Start(Tag::Strikethrough) => strike += 1,
            Event::End(TagEnd::Strikethrough) => strike = strike.saturating_sub(1),
            Event::Start(Tag::Link { .. }) => link += 1,
            Event::End(TagEnd::Link) => link = link.saturating_sub(1),
            Event::Start(Tag::Image { dest_url, .. }) => {
                link += 1;
                image_start = Some((dest_url.to_string(), spans.len()));
            }
            Event::End(TagEnd::Image) => {
                link = link.saturating_sub(1);
                if let Some((dest, start)) = image_start.take() {
                    // The alt text of an image arrives as ordinary text events;
                    // fold it into one image span so the renderer can place an
                    // actual image (or fall back to the link-styled alt text).
                    let alt: String = spans[start..].iter().map(|s| s.text.as_str()).collect();
                    spans.truncate(start);
                    spans.push(Span {
                        text: alt,
                        style,
                        image: Some(dest),
                    });
                }
            }
            Event::Text(text) => push_span(&mut spans, &text, style),
            Event::Code(code) => push_span(
                &mut spans,
                &code,
                SpanStyle {
                    code: true,
                    ..style
                },
            ),
            Event::InlineMath(math) | Event::DisplayMath(math) => push_span(
                &mut spans,
                &math,
                SpanStyle {
                    code: true,
                    ..style
                },
            ),
            Event::SoftBreak | Event::HardBreak => push_span(&mut spans, "\n", style),
            Event::TaskListMarker(checked) => {
                push_span(&mut spans, if checked { "[x] " } else { "[ ] " }, style);
            }
            Event::FootnoteReference(label) => {
                push_span(&mut spans, &format!("[{label}]"), style);
            }
            // Raw HTML has no place in a native text view; skip the tags but keep
            // any text that pulldown emitted around them.
            Event::Html(_) | Event::InlineHtml(_) => {}
            Event::Rule => {}
            Event::Start(_) | Event::End(_) => {}
        }
    }

    spans
}

fn push_span(spans: &mut Vec<Span>, text: &str, style: SpanStyle) {
    if text.is_empty() {
        return;
    }
    if let Some(last) = spans.last_mut()
        && last.style == style
        && last.image.is_none()
    {
        last.text.push_str(text);
    } else {
        spans.push(Span {
            text: text.to_string(),
            style,
            image: None,
        });
    }
}

fn is_block_start(tag: &Tag<'_>) -> bool {
    matches!(
        tag,
        Tag::Paragraph
            | Tag::Heading { .. }
            | Tag::BlockQuote(_)
            | Tag::CodeBlock(_)
            | Tag::HtmlBlock
            | Tag::List(_)
            | Tag::Item
            | Tag::Table(_)
            | Tag::TableHead
            | Tag::TableRow
            | Tag::TableCell
            | Tag::FootnoteDefinition(_)
    )
}

fn is_block_end(tag: &TagEnd) -> bool {
    matches!(
        tag,
        TagEnd::Paragraph
            | TagEnd::Heading(_)
            | TagEnd::BlockQuote(_)
            | TagEnd::CodeBlock
            | TagEnd::HtmlBlock
            | TagEnd::List(_)
            | TagEnd::Item
            | TagEnd::Table
            | TagEnd::TableHead
            | TagEnd::TableRow
            | TagEnd::TableCell
            | TagEnd::FootnoteDefinition
    )
}

fn consume_end<'a>(events: &mut Peekable<Parser<'a>>, matches_end: impl Fn(&TagEnd) -> bool) {
    if matches!(events.peek(), Some(Event::End(end)) if matches_end(end)) {
        events.next();
    }
}

fn render_block(
    block: &Block,
    size: f32,
    color: Hsla,
    theme: &Theme,
    images: Option<&InlineImages<'_>>,
) -> Option<AnyElement> {
    match block {
        Block::Paragraph(spans) => render_inline(
            spans,
            size,
            size * 1.45,
            color,
            FontWeight::NORMAL,
            theme,
            images,
        ),
        Block::Heading(level, spans) => {
            let heading_size = match level {
                1 => size + 7.0,
                2 => size + 5.0,
                3 => size + 3.0,
                4 => size + 1.5,
                _ => size + 0.5,
            };
            render_inline(
                spans,
                heading_size,
                heading_size * 1.25,
                theme.ink,
                FontWeight::SEMIBOLD,
                theme,
                images,
            )
        }
        Block::Code { lang, text } => {
            let code_size = (size - 1.0).max(9.0);
            let mut block = div()
                .w_full()
                .min_w(px(0.0))
                .rounded(px(2.0))
                .border_1()
                .border_color(theme.border_subtle)
                .bg(theme.strip)
                .overflow_hidden();

            if let Some(lang) = lang {
                block = block.child(div().px(px(8.0)).pt(px(5.0)).child(theme::micro(
                    lang.clone(),
                    8.0,
                    theme.fg_tertiary,
                )));
            }

            Some(
                block
                    .child(
                        div()
                            .w_full()
                            .min_w(px(0.0))
                            .px(px(8.0))
                            .py(px(6.0))
                            .font_family(theme::MONO)
                            .text_size(px(code_size))
                            .line_height(px(code_size * 1.5))
                            .text_color(theme.ink)
                            .child(text.trim_end_matches('\n').to_string()),
                    )
                    .into_any_element(),
            )
        }
        Block::Quote(children) => {
            let mut quote = div()
                .w_full()
                .min_w(px(0.0))
                .pl(px(10.0))
                .border_l_2()
                .border_color(theme::with_alpha(theme.palette.dark, 0.28))
                .flex()
                .flex_col()
                .gap(px((size * 0.36).max(3.0)));
            for child in children {
                if let Some(element) = render_block(child, size, color, theme, images) {
                    quote = quote.child(element);
                }
            }
            Some(quote.into_any_element())
        }
        Block::List {
            ordered,
            start,
            items,
        } => {
            let mut list = div().w_full().min_w(px(0.0)).flex().flex_col().gap(px(4.0));

            for (index, item) in items.iter().enumerate() {
                let marker = if *ordered {
                    format!("{}.", start + index as u64)
                } else {
                    "•".to_string()
                };
                let mut content = div()
                    .flex_1()
                    .min_w(px(0.0))
                    .flex()
                    .flex_col()
                    .gap(px((size * 0.3).max(2.0)));
                for child in item {
                    if let Some(element) = render_block(child, size, color, theme, images) {
                        content = content.child(element);
                    }
                }

                list = list.child(
                    div()
                        .w_full()
                        .min_w(px(0.0))
                        .flex()
                        .items_start()
                        .gap(px(7.0))
                        .child(
                            div()
                                .flex_none()
                                .min_w(px(18.0))
                                .font_family(theme::MONO)
                                .text_size(px((size * 0.9).max(9.0)))
                                .line_height(px(size * 1.45))
                                .text_color(theme.fg_secondary)
                                .child(marker),
                        )
                        .child(content),
                );
            }

            Some(list.into_any_element())
        }
        Block::Table { headers, rows } => {
            let mut table = div()
                .w_full()
                .min_w(px(0.0))
                .rounded(px(2.0))
                .border_1()
                .border_color(theme.border_subtle)
                .overflow_hidden()
                .flex()
                .flex_col();

            if !headers.is_empty() {
                table = table.child(table_row(headers, size, color, theme, true, false, images));
            }
            for (index, row) in rows.iter().enumerate() {
                table = table.child(table_row(row, size, color, theme, false, index > 0, images));
            }

            Some(table.into_any_element())
        }
        Block::Rule => Some(
            div()
                .w_full()
                .h(px(1.0))
                .bg(theme.border_subtle)
                .into_any_element(),
        ),
    }
}

fn table_row(
    cells: &[Vec<Span>],
    size: f32,
    color: Hsla,
    theme: &Theme,
    header: bool,
    separated: bool,
    images: Option<&InlineImages<'_>>,
) -> Div {
    let mut row = div()
        .w_full()
        .min_w(px(0.0))
        .flex()
        .items_stretch()
        .bg(if header { theme.strip } else { theme.surface });

    if header {
        row = row.border_b_1().border_color(theme.border_subtle);
    } else if separated {
        row = row.border_t_1().border_color(theme.border_subtle);
    }

    for cell in cells {
        let weight = if header {
            FontWeight::SEMIBOLD
        } else {
            FontWeight::NORMAL
        };
        row = row.child(
            div()
                .flex_1()
                .min_w(px(0.0))
                .px(px(7.0))
                .py(px(5.0))
                .border_r_1()
                .border_color(theme.border_subtle)
                .children(render_inline(
                    cell,
                    (size - 0.5).max(9.0),
                    (size - 0.5).max(9.0) * 1.4,
                    color,
                    weight,
                    theme,
                    images,
                )),
        );
    }

    row
}

fn render_inline(
    spans: &[Span],
    size: f32,
    line_height: f32,
    color: Hsla,
    weight: FontWeight,
    theme: &Theme,
    images: Option<&InlineImages<'_>>,
) -> Option<AnyElement> {
    let mut elements: Vec<AnyElement> = Vec::new();
    let mut run: Vec<Span> = Vec::new();

    for span in spans {
        let Some(dest) = span.image.as_deref() else {
            run.push(span.clone());
            continue;
        };

        match resolve_image_span(&span.text, dest, images) {
            ResolvedImage::Image { artifact_id, bytes } => {
                if let Some(element) =
                    render_text_run(&run, size, line_height, color, weight, theme)
                {
                    elements.push(element);
                }
                run.clear();
                let open = images.map(|images| (images.open)(&artifact_id));
                elements.push(inline_image_element(&artifact_id, bytes, open, theme));
            }
            // Unknown artifact ids, non-image artifacts, and bytes that have not
            // arrived yet keep the old link-styled alt text.
            ResolvedImage::AltText(text) => run.push(Span {
                text,
                style: SpanStyle {
                    link: true,
                    ..span.style
                },
                image: None,
            }),
        }
    }

    if let Some(element) = render_text_run(&run, size, line_height, color, weight, theme) {
        elements.push(element);
    }

    match elements.len() {
        0 => None,
        1 => elements.pop(),
        _ => Some(
            div()
                .w_full()
                .min_w(px(0.0))
                .flex()
                .flex_col()
                .gap(px((size * 0.42).max(4.0)))
                .children(elements)
                .into_any_element(),
        ),
    }
}

/// What an inline image span renders as.
#[derive(Debug)]
enum ResolvedImage {
    /// Bytes are loaded: draw the image and open the drawer on click.
    Image {
        artifact_id: String,
        bytes: Arc<Image>,
    },
    /// No bytes (unknown id, non-image artifact, still loading): alt text link.
    AltText(String),
}

fn resolve_image_span(alt: &str, dest: &str, images: Option<&InlineImages<'_>>) -> ResolvedImage {
    match images.and_then(|images| images.image(dest)) {
        Some((artifact_id, bytes)) => ResolvedImage::Image { artifact_id, bytes },
        None => ResolvedImage::AltText(image_fallback_label(alt, dest)),
    }
}

/// A run of styled text as one `StyledText` element.
fn render_text_run(
    spans: &[Span],
    size: f32,
    line_height: f32,
    color: Hsla,
    weight: FontWeight,
    theme: &Theme,
) -> Option<AnyElement> {
    let mut text = String::new();
    let mut highlights: Vec<(Range<usize>, HighlightStyle)> = Vec::new();
    let mut mono_ranges: Vec<(Range<usize>, SharedString)> = Vec::new();

    for span in spans {
        let start = text.len();
        text.push_str(&span.text);
        let end = text.len();
        if start == end {
            continue;
        }

        let mut highlight = HighlightStyle::default();
        let mut styled = false;

        if span.style.bold {
            highlight.font_weight = Some(FontWeight::BOLD);
            styled = true;
        }
        if span.style.italic {
            highlight.font_style = Some(FontStyle::Italic);
            styled = true;
        }
        if span.style.strike {
            highlight.strikethrough = Some(StrikethroughStyle {
                thickness: px(1.0),
                color: Some(color),
            });
            styled = true;
        }
        if span.style.code {
            highlight.background_color = Some(theme::with_alpha(theme.palette.dark, 0.07));
            highlight.color = Some(theme.ink);
            mono_ranges.push((start..end, theme::MONO.into()));
            styled = true;
        }
        if span.style.link {
            highlight.color = Some(theme.vivid);
            highlight.underline = Some(UnderlineStyle {
                thickness: px(1.0),
                color: Some(theme.vivid),
                wavy: false,
            });
            styled = true;
        }

        if styled {
            highlights.push((start..end, highlight));
        }
    }

    if text.is_empty() {
        return None;
    }

    let mut styled_text = StyledText::new(text).with_highlights(highlights);
    if !mono_ranges.is_empty() {
        styled_text = styled_text.with_font_family_overrides(mono_ranges);
    }

    Some(
        div()
            .w_full()
            .min_w(px(0.0))
            .font_family(theme::SANS)
            .font_weight(weight)
            .text_size(px(size))
            .line_height(px(line_height))
            .text_color(color)
            .child(styled_text)
            .into_any_element(),
    )
}

/// An inline artifact image: column width, capped height, aspect preserved, and
/// a click that opens the artifact drawer.
fn inline_image_element(
    artifact_id: &str,
    image: Arc<Image>,
    open: Option<ArtifactClick>,
    theme: &Theme,
) -> AnyElement {
    let mut frame = div()
        .id(format!("md-image-{artifact_id}"))
        .w_full()
        .min_w(px(0.0))
        .max_h(px(INLINE_IMAGE_MAX_HEIGHT))
        .rounded(px(2.0))
        .border_1()
        .border_color(theme.border_subtle)
        .overflow_hidden();
    if open.is_some() {
        frame = frame.cursor_pointer().hover(|s| s.opacity(0.9));
    }
    frame = frame.child(
        img(image)
            .w_full()
            .max_h(px(INLINE_IMAGE_MAX_HEIGHT))
            .object_fit(ObjectFit::Contain),
    );
    if let Some(open) = open {
        frame = frame.on_click(open);
    }
    frame.into_any_element()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use gpui::{Image, ImageFormat};

    use super::{
        ArtifactClick, InlineImages, ResolvedImage, plain_text, render, render_clipped,
        resolve_image_span,
    };
    use crate::theme::Theme;

    fn fake_image(tag: &str) -> Arc<Image> {
        Arc::new(Image::from_bytes(ImageFormat::Svg, tag.as_bytes().to_vec()))
    }

    fn no_click(_: &str) -> ArtifactClick {
        Box::new(|_, _, _| {})
    }

    #[test]
    fn plain_text_drops_inline_syntax() {
        let text = plain_text("**bold** and `code` with [a link](https://example.com)");
        assert_eq!(text, "bold and code with a link");
    }

    #[test]
    fn plain_text_keeps_block_text_separate() {
        let text = plain_text("# Goal\n\n- first\n- second");
        assert_eq!(text, "Goal first second");
    }

    #[test]
    fn renders_mixed_markdown() {
        let theme = Theme::green();
        let markdown = "\
# Summary\n\n\
Fixed **teardown** and `WorkerPty` cleanup — see [the report](https://example.com).\n\n\
- kill the process group\n\
- stress the timeout path\n\n\
> 200 simulated timeouts passed.\n\n\
```rust\nfn main() {\n    println!(\"ok\");\n}\n```\n\n\
| check | result |\n| --- | --- |\n| fmt | pass |\n\n\
---\n";
        let _ = render(markdown, 13.5, theme.ink, &theme, None);
    }

    #[test]
    fn renders_resolvable_inline_artifact_image() {
        let theme = Theme::green();
        let bytes = fake_image("chart");
        let resolve = |id: &str| (id == "art-1").then(|| bytes.clone());
        let images = InlineImages {
            resolve: &resolve,
            open: &no_click,
        };
        let markdown =
            "Proposed: ![token budget chart](kawan://artifact/art-1)\n\nReady for review.";

        let _ = render(markdown, 13.5, theme.ink, &theme, Some(&images));

        match resolve_image_span(
            "token budget chart",
            "kawan://artifact/art-1",
            Some(&images),
        ) {
            ResolvedImage::Image {
                artifact_id,
                bytes: resolved,
            } => {
                assert_eq!(artifact_id, "art-1");
                assert_eq!(resolved.as_ref(), bytes.as_ref());
            }
            ResolvedImage::AltText(text) => panic!("expected image bytes, got alt text {text:?}"),
        }
    }

    #[test]
    fn unknown_artifact_image_falls_back_to_alt_text() {
        let theme = Theme::green();
        let resolve = |_: &str| None;
        let images = InlineImages {
            resolve: &resolve,
            open: &no_click,
        };
        let markdown = "Before ![missing chart](kawan://artifact/gone) after";

        let _ = render(markdown, 13.5, theme.ink, &theme, Some(&images));

        match resolve_image_span("missing chart", "kawan://artifact/gone", Some(&images)) {
            ResolvedImage::AltText(text) => assert_eq!(text, "missing chart"),
            ResolvedImage::Image { .. } => panic!("expected the alt-text fallback"),
        }
        // Non-artifact images and ids without alt text also fall back cleanly.
        match resolve_image_span("", "https://example.com/x.png", Some(&images)) {
            ResolvedImage::AltText(text) => assert_eq!(text, "https://example.com/x.png"),
            ResolvedImage::Image { .. } => panic!("expected the alt-text fallback"),
        }
        // Without a resolver inline images never render bytes.
        assert!(matches!(
            resolve_image_span("missing chart", "kawan://artifact/gone", None),
            ResolvedImage::AltText(_)
        ));
    }

    #[test]
    fn plain_text_ignores_inline_image_urls() {
        let text = plain_text("Before ![chart](kawan://artifact/art-1) after");
        assert_eq!(text, "Before chart after");
        assert!(!text.contains("kawan://"));
    }

    #[test]
    fn clipped_render_reports_dropped_blocks() {
        let theme = Theme::green();
        let long = "# Title\n\nOne.\n\nTwo.\n\nThree.\n\nFour.\n";
        let (_el, truncated) = render_clipped(long, 13.0, theme.ink, &theme, None, 2);
        assert!(truncated, "expected the preview to drop trailing blocks");

        let (_el, truncated) =
            render_clipped("# Title\n\nOne.\n", 13.0, theme.ink, &theme, None, 2);
        assert!(!truncated, "a short body must render whole");
    }
}
