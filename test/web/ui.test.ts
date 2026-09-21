/**
 * What the page itself is made of.
 *
 * There is no DOM in these tests, so they assert the things a review of the
 * UX asked for and that a person would otherwise have to re-check by eye: no
 * mode toggle anywhere, a sort control, the smart-search line under the
 * results rather than above them, and a reader bar that is fixed with the
 * scroll margin that keeps a linked message out from under it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const staticDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'static');
const html = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(staticDir, 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(staticDir, 'app.js'), 'utf8');

describe('the search page', () => {
  it('has no keyword/semantic/hybrid control left', () => {
    expect(html).not.toContain('data-mode');
    expect(html).not.toContain('>keyword<');
    expect(html).not.toContain('>semantic<');
    expect(html).not.toContain('>hybrid<');
    expect(js).not.toContain("params.set('mode'");
  });

  it('offers best match and most recent, and puts the choice in the URL', () => {
    expect(html).toContain('data-sort="relevance"');
    expect(html).toContain('data-sort="recent"');
    expect(html).toContain('Best match');
    expect(html).toContain('Most recent');
    expect(js).toContain("params.set('sort', state.sort)");
    expect(js).toContain("params.get('sort')");
  });

  it('keeps the sort control next to Filters', () => {
    const controls = html.slice(html.indexOf('<div class="controls">'), html.indexOf('</div>', html.indexOf('filters-toggle')));
    expect(controls).toContain('data-sort="recent"');
    expect(controls).toContain('filters-toggle');
  });

  it('puts the smart-search line under the results, as a line and not a box', () => {
    expect(html.indexOf('id="setup-line"')).toBeGreaterThan(html.indexOf('id="results"'));
    expect(js).toContain('Setting up smart search…');
    expect(js).toContain('Results get better when this finishes.');
    // No enable button, and nothing that starts work from the page.
    expect(js).not.toContain('Enable');
    expect(js).not.toContain("'/api/embed'");
    const rule = css.slice(css.indexOf('.setup-line {'), css.indexOf('}', css.indexOf('.setup-line {')));
    expect(rule).not.toContain('border');
    expect(rule).not.toContain('background');
  });

  it('shows the server notice in the same quiet line style, as plain text', () => {
    // Its own element: the setup line is hidden and rewritten by the embed job,
    // which would take the notice down with it.
    expect(html).toContain('<p class="setup-line" id="notice-line" hidden></p>');
    expect(html.indexOf('id="notice-line"')).toBeGreaterThan(html.indexOf('id="results"'));
    expect(js).toContain('noticeLine.textContent');
    expect(js).toContain("statusInfo.notice === 'string'");
    // textContent, never innerHTML: the sentence carries a filesystem path.
    expect(js).not.toContain('noticeLine.innerHTML');
  });
});

describe('the reader', () => {
  it('has one fixed bar with back, title, folder and the single primary button', () => {
    const bar = html.slice(html.indexOf('<div class="reader-bar"'), html.indexOf('</div>', html.indexOf('copy-resume')));
    expect(bar).toContain('← Search');
    expect(bar).toContain('id="bar-title"');
    expect(bar).toContain('id="bar-cwd"');
    expect(bar).toContain('class="primary" id="copy-resume"');
    // Exactly one primary button on the whole page.
    expect(html.match(/class="primary"/g)).toHaveLength(1);

    const rule = css.slice(css.indexOf('.reader-bar {'), css.indexOf('}', css.indexOf('.reader-bar {')));
    expect(rule).toContain('position: fixed');
  });

  it('shortens the folder with ~ and truncates the title', () => {
    expect(js).toContain('shortPath(session.cwd)');
    expect(css).toContain('.reader-title');
    expect(css.slice(css.indexOf('.reader-title {'), css.indexOf('}', css.indexOf('.reader-title {')))).toContain(
      'text-overflow: ellipsis',
    );
  });

  it('scrolls a ?m= message clear of the bar', () => {
    expect(js).toContain("scrollIntoView({ block: 'start' })");
    const rule = css.slice(css.indexOf('.msg {'), css.indexOf('}', css.indexOf('.msg {')));
    expect(rule).toContain('scroll-margin-top: calc(var(--bar-height)');
    expect(css).toContain('--bar-height');
    // The view starts below the bar rather than under it.
    expect(css).toContain('#view-transcript {');
  });

  it('stays usable at 360px and in both colour schemes', () => {
    expect(css).toContain('@media (max-width: 560px)');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    // The bar's colours are the same four roles as everything else.
    const bar = css.slice(css.indexOf('.reader-bar {'), css.indexOf('}', css.indexOf('.reader-bar {')));
    expect(bar).toContain('var(--base)');
    expect(bar).toContain('var(--line)');
  });
});

describe('the page says ccfind', () => {
  it('in its title and in the document title it sets', () => {
    expect(html).toContain('<title>ccfind</title>');
    expect(js).toContain("' — ccfind'");
    expect(html).not.toContain('session-finder');
    expect(js).not.toContain('session-finder');
  });
});
