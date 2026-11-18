/**
 * File exclusion rules.
 *
 * Built-in defaults skip content that is expensive and rarely useful to review
 * (lock files, build output, minified/generated code, binaries). Users can add
 * patterns and re-include files with a leading `!` (last matching rule wins,
 * like .gitignore).
 */
import { minimatch, type MinimatchOptions } from 'minimatch';

export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  // Dependency lock files
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'composer.lock',
  'go.sum',
  'packages.lock.json',
  'pubspec.lock',
  'Podfile.lock',
  'gradle.lockfile',
  'mix.lock',
  'flake.lock',
  '*.lock',
  // Build output and vendored dependencies
  '**/node_modules/**',
  '**/vendor/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/obj/**',
  '**/target/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/coverage/**',
  '**/__pycache__/**',
  // Minified, generated and snapshot files
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.snap',
  '*.generated.*',
  '*.g.cs',
  '*.Designer.cs',
  '*.pb.go',
  '*_pb2.py',
  '*_pb2_grpc.py',
  // Binary and media assets
  '*.{png,jpg,jpeg,gif,bmp,ico,webp,avif,tif,tiff,psd,svg}',
  '*.{woff,woff2,ttf,otf,eot}',
  '*.{zip,tar,gz,tgz,bz2,xz,7z,rar,jar,war,ear,nupkg}',
  '*.{exe,dll,so,dylib,a,o,obj,lib,class,pyc,pyo,wasm,bin,dat}',
  '*.{mp3,mp4,mov,avi,wav,ogg,webm,flac}',
  '*.{pdf,doc,docx,xls,xlsx,ppt,pptx}',
  '*.{db,sqlite,sqlite3}',
];

const MATCH_OPTIONS: MinimatchOptions = {
  dot: true, // match dotfiles and dot-directories
  matchBase: true, // patterns without "/" match against the basename
  nocase: true, // extension matching should be case-insensitive (e.g. .PNG)
  nocomment: true,
};

interface Rule {
  pattern: string;
  negate: boolean;
}

export class FileFilter {
  private readonly rules: Rule[];

  constructor(customPatterns: readonly string[] = [], useDefaults = true) {
    const all = [...(useDefaults ? DEFAULT_IGNORE_PATTERNS : []), ...customPatterns];
    this.rules = all.map((raw) => {
      const negate = raw.startsWith('!');
      const pattern = (negate ? raw.slice(1) : raw).trim().replace(/^\.\//, '');
      return { pattern, negate };
    });
  }

  /** Returns true when the path should be excluded from review. */
  isIgnored(path: string): boolean {
    const normalized = path.replace(/^\.?\//, '');
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.pattern && minimatch(normalized, rule.pattern, MATCH_OPTIONS)) {
        ignored = !rule.negate;
      }
    }
    return ignored;
  }
}
