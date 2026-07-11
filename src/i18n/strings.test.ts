import { describe, it, expect, afterEach } from 'vitest';
import { t, setLocale, getLocale, translationCoverage } from './strings';

afterEach(() => setLocale('en'));

describe('i18n scaffold (O-5)', () => {
  it('returns the English string by default', () => {
    expect(t('role.label')).toBe('Role');
  });

  it('interpolates variables', () => {
    expect(t('connectors.headline', { n: 2 })).toBe('System complete · awaiting 2 credentials');
  });

  it('falls back to English for untranslated locales, never blank', () => {
    setLocale('hi');
    expect(getLocale()).toBe('hi');
    expect(t('role.label')).toBe('Role'); // hi stub is empty → en fallback
  });

  it('falls back to the key itself for an unknown key', () => {
    expect(t('does.not.exist')).toBe('does.not.exist');
  });

  it('reports translation coverage per locale', () => {
    const cov = translationCoverage();
    expect(cov.en).toBeGreaterThan(0);
    expect(cov.hi).toBe(0); // stub
    expect(cov.mr).toBe(0);
  });
});
