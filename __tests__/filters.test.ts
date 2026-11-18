import { describe, expect, it } from 'vitest';
import { FileFilter } from '../src/diff/filters.js';

describe('FileFilter', () => {
  it('ignores lockfiles, build directories, minified bundles, and binaries by default', () => {
    const filter = new FileFilter();
    expect(filter.isIgnored('package-lock.json')).toBe(true);
    expect(filter.isIgnored('apps/web/pnpm-lock.yaml')).toBe(true);
    expect(filter.isIgnored('Cargo.lock')).toBe(true);
    expect(filter.isIgnored('dist/index.js')).toBe(true);
    expect(filter.isIgnored('packages/ui/dist/bundle.js')).toBe(true);
    expect(filter.isIgnored('node_modules/pkg/index.js')).toBe(true);
    expect(filter.isIgnored('assets/app.min.js')).toBe(true);
    expect(filter.isIgnored('assets/app.js.map')).toBe(true);
    expect(filter.isIgnored('docs/diagram.PNG')).toBe(true);
    expect(filter.isIgnored('proto/service.pb.go')).toBe(true);

    expect(filter.isIgnored('src/main.ts')).toBe(false);
    expect(filter.isIgnored('.github/workflows/ci.yml')).toBe(false);
  });

  it('supports custom ignore globs and !negation rules (last rule wins)', () => {
    const filter = new FileFilter(['docs/**', '!docs/security.md', 'dist/**', '!dist/index.js']);
    expect(filter.isIgnored('docs/readme.md')).toBe(true);
    expect(filter.isIgnored('docs/security.md')).toBe(false);
    expect(filter.isIgnored('dist/other.js')).toBe(true);
    expect(filter.isIgnored('dist/index.js')).toBe(false);
  });

  it('can disable built-in default ignores', () => {
    const filter = new FileFilter(['*.md'], false);
    expect(filter.isIgnored('package-lock.json')).toBe(false);
    expect(filter.isIgnored('README.md')).toBe(true);
  });
});

