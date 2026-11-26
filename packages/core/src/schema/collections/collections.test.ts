import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodePayload, livePayload } from '../payload.ts';
import { extensions } from './extensions.ts';
import { MAX_VISITS, history } from './history.ts';
import { MAX_FAVICON_URL_LENGTH, tabs } from './tabs.ts';

const HLC = '001795000000000:00000000:dev-a';
const T = 1_795_000_000_000;
const decode = (collection: Parameters<typeof decodePayload>[0], data: unknown) =>
  decodePayload(collection, JSON.parse(JSON.stringify({ v: 1, deleted: false, hlc: HLC, data })));

const tab = (extra: object = {}) => ({
  url: 'https://example.org/',
  title: 'Example',
  pinned: false,
  active: true,
  ...extra,
});

describe('tabs', () => {
  it('accepts windows with tabs and optional fields', () => {
    const data = {
      windows: [
        {
          focused: true,
          tabs: [
            tab({ lastAccessed: T, groupTitle: 'Work', favIconUrl: 'https://example.org/f.ico' }),
          ],
        },
        { focused: false, tabs: [] },
      ],
    };
    expect(decode(tabs, data).status).toBe('ok');
  });

  it('accepts private windows and recently closed tabs, and records without them (TAB-2, TAB-10)', () => {
    const data = {
      windows: [{ focused: true, private: true, tabs: [] }],
      recent: [{ url: 'https://a.example/', title: 'A', closedAt: T, private: true }],
    };
    expect(decode(tabs, data).status).toBe('ok');
    expect(decode(tabs, { windows: [] }).status).toBe('ok');
    expect(
      decode(tabs, { ...data, recent: [{ url: 'https://a.example/', title: 'A' }] }).status,
    ).toBe('invalid');
  });

  it('rejects data: favicons and favicon URLs over 512 characters (TAB-4)', () => {
    const long = `https://example.org/${'a'.repeat(MAX_FAVICON_URL_LENGTH)}`;
    expect(
      decode(tabs, {
        windows: [{ focused: true, tabs: [tab({ favIconUrl: 'DATA:image/png;base64,AAAA' })] }],
      }).status,
    ).toBe('invalid');
    expect(
      decode(tabs, { windows: [{ focused: true, tabs: [tab({ favIconUrl: long })] }] }).status,
    ).toBe('invalid');
  });

  it('round-trips any valid tabs record', () => {
    const tabArb = fc.record(
      {
        url: fc.webUrl(),
        title: fc.string(),
        pinned: fc.boolean(),
        active: fc.boolean(),
        lastAccessed: fc.integer({ min: 0, max: 2 * T }),
        groupTitle: fc.string(),
      },
      { requiredKeys: ['url', 'title', 'pinned', 'active'] },
    );
    const dataArb = fc.record({
      windows: fc.array(
        fc.record({ focused: fc.boolean(), tabs: fc.array(tabArb, { maxLength: 5 }) }),
        { maxLength: 3 },
      ),
    });
    fc.assert(
      fc.property(dataArb, (data) => {
        const payload = livePayload(tabs, HLC, data);
        expect(decode(tabs, data)).toEqual({ status: 'ok', payload });
      }),
    );
  });
});

describe('history', () => {
  const visit = { deviceId: 'dev-a', time: T, transition: 'link' };

  it('accepts up to 50 visits (HIS-2)', () => {
    const visits = Array.from({ length: MAX_VISITS }, (_, i) => ({ ...visit, time: T + i }));
    expect(decode(history, { url: 'https://example.org/', title: 'Example', visits }).status).toBe(
      'ok',
    );
    expect(
      decode(history, { url: 'https://example.org/', title: 'Example', visits: [...visits, visit] })
        .status,
    ).toBe('invalid');
  });

  it('accepts transition types it has never seen', () => {
    const data = {
      url: 'https://example.org/',
      title: '',
      visits: [{ ...visit, transition: 'some_future_type' }],
    };
    expect(decode(history, data).status).toBe('ok');
  });
});

describe('extensions', () => {
  const item = {
    id: 'abcdefghijklmnopabcdefghijklmnop',
    name: 'Ext',
    version: '1.2.3',
    enabled: true,
    kind: 'extension',
    installType: 'normal',
  };

  it('accepts extensions and themes with every install type (EXT-1, EXT-2)', () => {
    for (const installType of ['normal', 'development', 'admin', 'sideload', 'other']) {
      expect(
        decode(extensions, {
          items: [
            { ...item, installType },
            { ...item, kind: 'theme' },
          ],
        }).status,
      ).toBe('ok');
    }
  });

  it('rejects unknown kinds', () => {
    expect(decode(extensions, { items: [{ ...item, kind: 'app' }] }).status).toBe('invalid');
  });
});
