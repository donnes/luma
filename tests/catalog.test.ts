import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appIdentity,
  defaultFavorites,
  normalizeApps,
  normalizeInputs,
  sortApps,
} from '../src/catalog.ts';
import { parsePreferences } from '../src/storage.ts';
import { nextFocus, type FocusRect } from '../src/navigation.ts';

test('inventory excludes internal/invisible apps and de-duplicates third-party apps', () => {
  const apps = normalizeApps([
    { id: 'com.luma.launcher', title: 'Luma', visible: true },
    { id: 'com.webos.app.home', title: 'Home', visible: true },
    { id: 'com.webos.app.livetv', title: 'Live TV' },
    { id: 'com.webos.service.secret', title: 'Internal' },
    { id: 'netflix', title: 'Netflix', visible: true },
    { id: 'netflix', title: 'Duplicate', visible: true },
    { id: 'com.example.hidden', title: 'Hidden', visible: false },
    { id: 'com.example.sideload', title: 'My sideloaded app' },
    { id: 'com.webos.app.hdmi1', title: 'HDMI 1', visible: true },
    { id: "bad'; rm -rf /", title: 'Bad', visible: true },
  ]);
  assert.deepEqual(apps.map((app) => app.id).sort(), [
    'com.example.sideload',
    'com.webos.app.livetv',
    'netflix',
  ]);
  assert.equal(apps.find((app) => app.id === 'netflix')?.brand, 'netflix');
  assert.equal(apps.find((app) => app.id === 'com.webos.app.livetv')?.brand, 'live-tv');
  assert.deepEqual(defaultFavorites(apps), [
    'com.webos.app.livetv',
    'netflix',
    'com.example.sideload',
  ]);
});

test('Live TV remains available when the TV inventory omits its system app', () => {
  assert.deepEqual(
    normalizeApps([]).map(({ id, title, brand }) => ({ id, title, brand })),
    [{ id: 'com.webos.app.livetv', title: 'Live TV', brand: 'live-tv' }],
  );
});

test('inputs require a consistent physical identity and never guess extra sockets', () => {
  const inputs = normalizeInputs([
    {
      appId: 'com.webos.app.hdmi1',
      id: 'HDMI_1',
      port: 1,
      label: 'PlayStation 5',
      connected: true,
    },
    { appId: 'com.webos.app.hdmi2', id: 'HDMI_3', label: 'Contradiction' },
    { appId: 'com.webos.app.hdmi3', port: '3', label: 'Computer' },
    { appId: 'com.webos.app.screenshare', label: 'Virtual input' },
  ]);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].kind, 'console');
  assert.equal(inputs[0].connected, true);
  assert.equal(inputs[1].connected, null);
  assert.equal(
    normalizeInputs([{ appId: 'com.webos.app.hdmi1' }, { appId: 'com.webos.app.hdmi1' }]).length,
    0,
  );
});

test('corrupt or foreign preferences recover, while intentionally empty favorites stay empty', () => {
  assert.equal(parsePreferences('{broken').favorites, null);
  assert.equal(parsePreferences('{"version":99}').favorites, null);
  assert.equal(parsePreferences('{"version":1}').favorites, null);
  assert.equal(parsePreferences('{"version":1,"language":"de"}').language, 'de');
  assert.equal(parsePreferences('{"version":1,"language":"zh"}').language, 'zh');
  assert.equal(parsePreferences('{"version":1,"language":"unknown"}').language, 'en');
  assert.deepEqual(parsePreferences('{"version":1,"favorites":[]}').favorites, []);
  const value = parsePreferences(
    JSON.stringify({
      version: 1,
      wallpaper: 'remote-url',
      recent: ['netflix', 'netflix', 4],
      hidden: ['foo', 'x;bad'],
      clock24: 'true',
    }),
  );
  assert.equal(value.wallpaper, 'dunes');
  assert.deepEqual(value.recent, ['netflix']);
  assert.deepEqual(value.hidden, ['foo']);
  assert.equal(value.clock24, false);
});

test('D-pad navigation prefers the current row and nearest aligned column', () => {
  const items: FocusRect[] = [
    { id: 'a', x: 0, y: 100, width: 200, height: 150 },
    { id: 'b', x: 230, y: 100, width: 200, height: 150 },
    { id: 'c', x: 0, y: 280, width: 200, height: 150 },
    { id: 'header', x: 230, y: 0, width: 100, height: 40 },
  ];
  assert.equal(nextFocus(items[0], items, 'right'), 'b');
  assert.equal(nextFocus(items[0], items, 'down'), 'c');
  assert.equal(nextFocus(items[1], items, 'left'), 'a');
  assert.equal(nextFocus(items[0], items, 'left'), null);
});

test('favorites sort first in saved order, with remaining apps alphabetical and source order intact', () => {
  const apps = [
    ['z', 'Zulu'],
    ['a', 'Alpha'],
    ['c', 'Charlie'],
    ['b', 'Beta'],
  ].map(([id, title]) => appIdentity(id, title));
  assert.deepEqual(
    sortApps(apps, ['c', 'missing', 'a']).map((app) => app.id),
    ['c', 'a', 'b', 'z'],
  );
  assert.deepEqual(
    apps.map((app) => app.id),
    ['z', 'a', 'c', 'b'],
  );
  assert.deepEqual(
    sortApps(apps, []).map((app) => app.title),
    ['Alpha', 'Beta', 'Charlie', 'Zulu'],
  );
});
