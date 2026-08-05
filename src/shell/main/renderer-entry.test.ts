// Codex MED「dev URL」対処のロック — dev エントリ URL の loopback 限定と、
// will-navigate の許可判定 (dev=同一オリジンのみ / 本番=全拒否)。

import { describe, expect, it } from 'vitest';

import { isAllowedNavigation, isTrustedDevServerUrl } from './renderer-entry';

describe('isTrustedDevServerUrl — loopback http のみを dev エントリとして受理', () => {
  it.each([
    'http://localhost:5173',
    'http://localhost:5173/sub/path',
    'http://127.0.0.1:5173',
    'http://[::1]:5173',
  ])('accepts %s', (url) => {
    expect(isTrustedDevServerUrl(url)).toBe(true);
  });

  it.each([
    undefined,
    '',
    'not a url',
    'https://localhost:5173', // https は electron-vite dev では使わない — 素通し禁止
    'http://evil.example.com:5173',
    'http://localhost.evil.example.com:5173',
    'file:///C:/anything.html',
    'http://192.168.1.10:5173', // LAN ですら不可 — loopback 限定
  ])('rejects %s', (url) => {
    expect(isTrustedDevServerUrl(url)).toBe(false);
  });
});

describe('isAllowedNavigation — dev は同一オリジンのみ / 本番は全拒否', () => {
  const dev = 'http://localhost:5173';

  it('allows a same-origin navigation in dev (HMR full reload)', () => {
    expect(isAllowedNavigation('http://localhost:5173/index.html', dev)).toBe(true);
  });

  it('denies a cross-origin navigation in dev', () => {
    expect(isAllowedNavigation('http://evil.example.com/', dev)).toBe(false);
    expect(isAllowedNavigation('http://localhost:9999/', dev)).toBe(false);
  });

  it('denies EVERY navigation in production (no trusted dev url)', () => {
    expect(isAllowedNavigation('file:///C:/app/out/renderer/index.html', undefined)).toBe(false);
    expect(isAllowedNavigation('https://example.com/', undefined)).toBe(false);
  });

  it('denies an unparsable target', () => {
    expect(isAllowedNavigation('not a url', dev)).toBe(false);
  });
});
