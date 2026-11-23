//! Lightweight Markdown rendering for chat message bodies.
//!
//! Chat messages are authored in Markdown, so they should be rendered rather than
//! shown as raw text. This module parses CommonMark/GFM syntax with
//! `pulldown-cmark` and renders a compact subset that fits the Instrument Panel:
//! headings, paragraphs, emphasis, inline code, links, fenced code, lists,
//! block quotes, tables, and horizontal rules.

use std::iter::Peekable;
use std::ops::Range;

use gpui::prelude::*;
use gpui::{
    AnyElement, Div, FontStyle, FontWeight, HighlightStyle, Hsla, SharedString, StrikethroughStyle,
    StyledText, UnderlineStyle, div, px,
};
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};

use crate::theme::{self, Theme};

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
pub fn render(markdown: &str, size: f32, color: Hsla, theme: &Theme) -> Div {
    let blocks = parse_blocks(&mut Parser::new_ext(markdown, options()).peekable());
    let mut col = div()
        .w_full()
        .min_w(px(0.0))
        .flex()
        .flex_col()
        .gap(px((size * 0.42).max(4.0)));

    for block in &blocks {
        if let Some(element) = render_block(block, size, color, theme) {
            col = col.child(element);
        }
    }

    col
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
    let mut spans = Vec::new();
    let mut bold = 0u32;
    let mut italic = 0u32;
    let mut strike = 0u32;
    let mut link = 0u32;

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
            Event::Start(Tag::Link { .. }) | Event::Start(Tag::Image { .. }) => link += 1,
            Event::End(TagEnd::Link | TagEnd::Image) => link = link.saturating_sub(1),
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
    {
        last.text.push_str(text);
    } else {
        spans.push(Span {
            text: text.to_string(),
            style,
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

fn render_block(block: &Block, size: f32, color: Hsla, theme: &Theme) -> Option<AnyElement> {
    match block {
        Block::Paragraph(spans) => {
            render_inline(spans, size, size * 1.45, color, FontWeight::NORMAL, theme)
        }
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
                if let Some(element) = render_block(child, size, color, theme) {
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
                    if let Some(element) = render_block(child, size, color, theme) {
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
                table = table.child(table_row(headers, size, color, theme, true, false));
            }
            for (index, row) in rows.iter().enumerate() {
                table = table.child(table_row(row, size, color, theme, false, index > 0));
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

#[cfg(test)]
mod tests {
    use super::{plain_text, render};
    use crate::theme::Theme;

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
        let _ = render(markdown, 13.5, theme.ink, &theme);
    }
}
