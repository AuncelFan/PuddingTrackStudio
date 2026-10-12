import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appPath } from '../frontend/app-path.js';

test('server download links and API resources stay inside the deployment directory', () => {
  for (const page of ['https://example.test/', 'https://example.test/tools/trace/', 'https://example.test/tools/trace/index.html?view=1#/preview']) {
    const directory = new URL('./', page).href;
    for (const resource of ['/api/health', 'api/tracks', './api/exports/job/download']) {
      assert.equal(new URL(appPath(resource), directory).href, directory + resource.replace(/^\/+/, '').replace(/^\.\//, ''));
    }
  }
});

test('relative tile URLs preserve OpenLayers coordinate placeholders', () => {
  assert.equal(appPath('/api/tiles/osm/{z}/{x}/{y}.png'), './api/tiles/osm/{z}/{x}/{y}.png');
});
