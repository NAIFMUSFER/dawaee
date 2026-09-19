import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeWebPatientReport, showWebPatientReport } from '../src/privacy/web-patient-report.js';

/** DOM I/O boundary only: physical browser top-layer behavior is checked in the
 * manual audit. These tests execute cleanup and event handling synchronously. */
class Element extends EventTarget {
  id = ''; dir = ''; className = ''; textContent = ''; isConnected = true;
  style = { cssText: '' }; children: Element[] = []; parent: Element | null = null;
  shadow: Element | null = null;
  constructor(readonly tag: string) { super(); }
  setAttribute() {}
  append(...nodes: Element[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  attachShadow() { this.shadow = new Element('shadow'); return this.shadow; }
  replaceChildren() { this.children = []; }
  remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  showModal() {}
  focus() {}
}
let doc: EventTarget & { visibilityState: string; body: Element; head: Element; activeElement: Element; createElement: (tag: string) => Element };
let created: Element[];
beforeEach(() => {
  vi.useFakeTimers(); created = [];
  doc = Object.assign(new EventTarget(), {
    visibilityState: 'visible', body: new Element('body'), head: new Element('head'), activeElement: new Element('button'),
    createElement(tag: string) { const element = new Element(tag); created.push(element); return element; },
  });
  const secret = new Element('p'); secret.textContent = 'SYNTHETIC-PRIVATE-RECORD';
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { print: vi.fn() }));
  vi.stubGlobal('HTMLElement', Element);
  vi.stubGlobal('DOMParser', class { parseFromString() { return {
    documentElement: { lang: 'en' }, body: { childNodes: [secret] }, querySelector: () => ({ textContent: 'body{color:black}' }),
  }; } });
});
afterEach(() => { closeWebPatientReport(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('web report preview privacy lifecycle', () => {
  it('closes and clears sensitive nodes immediately when the document becomes hidden', () => {
    expect(showWebPatientReport('<p>record</p>', 'Summary', () => true)).toBe(true);
    const article = created.find(element => element.tag === 'article')!;
    expect(article.children).toHaveLength(1);
    doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'));
    expect(article.children).toEqual([]); expect(doc.body.children).toEqual([]); expect(doc.head.children).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('closes synchronously on app/area lock and stops its polling lifetime', () => {
    showWebPatientReport('<p>record</p>', 'Summary', () => true);
    closeWebPatientReport();
    expect(created.find(element => element.tag === 'article')!.children).toEqual([]);
    expect(doc.body.children).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects a hidden document and removes a mounted preview when its profile expires', () => {
    doc.visibilityState = 'hidden';
    expect(showWebPatientReport('<p>record</p>', 'Summary', () => true)).toBe(false);
    expect(created).toEqual([]);
    doc.visibilityState = 'visible'; let current = true;
    showWebPatientReport('<p>record</p>', 'Summary', () => current);
    current = false; vi.advanceTimersByTime(250);
    expect(doc.body.children).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });
});
